import { db } from '@/lib/db';
import { resolveTarget } from '@/lib/wp-updates';
import { getAllPolicies, getPolicy, defaultPolicy, type PatchPolicy } from '@/lib/wp-patch-policy';
import { instancePath, installedVersion } from './remote';
import { planSite, needsApproval, isMajor, type PlannedItem } from './plan';
import { checkCapacity, createProtectedSubdomain, cloneToSubdomain, deleteClone, stagingLabel, genPassword, assertProtected } from './staging';
import { sanitiseClone, detectWoo } from './sanitise';
import { smokeTest, errorLogMark } from './smoke';
import { applyItems } from './apply';
import { runLiveForPatchSite } from './live';
import {
  createRun, finishRun, runningRunOfKind, createPatchSite, recordSkippedSite, getPatchSite, getItems, insertItem,
  updateItem, deleteItem, updatePatchSite, setState, appendLog,
  TRANSITIONAL_STATES, OPEN_STATES, LIVE_STATES, type RunKind, type PatchState,
} from './store';

// #220 phase 2 — staged WordPress patching engine (orchestration). Plain TypeScript, no Next.js imports.
//
//   Monday 06:00   startStagingRun()   every eligible site with pending non-held items: clone -> sanitise ->
//                                      patch exact versions -> smoke -> awaiting_approval | approved
//   Tuesday 06:00  startLiveRun()      every approved site staged in the last 8 days: backup -> same versions
//                                      -> smoke -> done | auto-rollback       (see live.ts)
//   after the nightly scan  startFastTrack()  sites with a SECURITY item: stage now, and go live as soon as
//                                      staging passes (if approval isn't needed; otherwise as soon as it's approved)
//
// A run executes in the background inside the Console process; every step is written to wp_patch_sites.log and
// .state as it happens, and sweepOrphanedPatchSites() fails anything left mid-step for > 2 h by a restart
// (runs left 'running' for > 24 h are failed too).

// Safety valve for the first weeks: only sites with a SAVED policy row are patched automatically (the default
// policy for every other WP site is approve/enabled, which would otherwise clone the whole fleet on the first
// Monday). Flip to false once the pilot ring has run cleanly.
export const REQUIRE_SAVED_POLICY = true;
// Automatic security fast-track after the nightly scan. OFF until the pilot sites have been through a manual
// staging + live run (2 Oct 2026) - fast-track can take an auto-mode site live without anyone watching.
export const FASTTRACK_AFTER_SCAN = false;

const STAGE_FRESH_HOURS = 24;     // an open staged row younger than this is not re-staged
const LIVE_WINDOW_DAYS = 8;       // approved rows older than this aren't promoted (re-staged next Monday)
const CLONE_MAX_AGE_DAYS = 7;     // clones of rows that never went live are deleted after this
const OPEN_EXPIRY_DAYS = 9;       // approved/awaiting rows older than this are expired (> LIVE_WINDOW_DAYS, so a
                                  // Monday-approved row can't expire in a race with the next Monday's run)

type StartResult = { ok: true; runId: number } | { ok: false; reason: string };

// ---------------------------------------------------------------------------------------------------------------
// Recovery + housekeeping
// ---------------------------------------------------------------------------------------------------------------

export async function sweepOrphanedPatchSites(): Promise<{ sites: number; runs: number }> {
  const stagingStates = TRANSITIONAL_STATES.filter(s => !LIVE_STATES.includes(s));
  const a = await db.query(
    `UPDATE wp_patch_sites
        SET state = 'staged_failed', error = 'Orphaned (Console restarted mid-step: ' || state || ')',
            log = log || to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS') || ' [staged_failed] orphaned in ' || state || E'\\n',
            updated_at = NOW()
      WHERE state = ANY($1::text[]) AND updated_at < NOW() - INTERVAL '2 hours'
        -- a 'pending' row is just queued behind other sites on its server while its run is still going
        AND (state <> 'pending' OR NOT EXISTS (SELECT 1 FROM wp_patch_runs r WHERE r.id = wp_patch_sites.run_id AND r.status = 'running'))`,
    [stagingStates]);
  const b = await db.query(
    `UPDATE wp_patch_sites
        SET state = 'failed',
            error = 'Orphaned in ' || state || ' (Console restarted). LIVE MAY BE PARTIALLY PATCHED — restore WP Toolkit backup '
                    || COALESCE(backup_ref, '(none taken)') || ' if the site is broken.',
            log = log || to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS') || ' [failed] orphaned in ' || state || E'\\n',
            updated_at = NOW()
      WHERE state = ANY($1::text[]) AND updated_at < NOW() - INTERVAL '2 hours'`, [LIVE_STATES]);
  const r = await db.query(
    `UPDATE wp_patch_runs SET status = 'failed', finished_at = NOW(),
            summary = COALESCE(summary, '{}'::jsonb) || '{"error":"orphaned (Console restarted mid-run)"}'::jsonb
      WHERE status = 'running' AND started_at < NOW() - INTERVAL '24 hours'`);
  return { sites: (a.rowCount ?? 0) + (b.rowCount ?? 0), runs: r.rowCount ?? 0 };
}

// Delete staging clones that are finished with: after the live run (done / rolled back / failed live), when
// rejected or superseded (skipped), or CLONE_MAX_AGE_DAYS after creation for anything else that never went live
// (staging failed, skipped). Open (awaiting/approved) rows past OPEN_EXPIRY_DAYS are expired first.
export async function cleanupStagingClones(): Promise<{ expired: number; deleted: number; failed: number }> {
  const exp = await db.query<{ id: number }>(
    `UPDATE wp_patch_sites SET state = 'skipped', error = 'Expired: not promoted within ${OPEN_EXPIRY_DAYS} days',
            log = log || to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS') || ' [skipped] expired' || E'\\n', updated_at = NOW()
      WHERE state = ANY($1::text[]) AND created_at < NOW() - INTERVAL '${OPEN_EXPIRY_DAYS} days' RETURNING id`, [OPEN_STATES]);
  const due = await db.query<{ id: number; staging_host: string; staging_domain: string; staging_instance_id: number | null; live_inst: number | null }>(
    `SELECT p.id, p.staging_host, p.staging_domain, p.staging_instance_id, s.wp_instance_id AS live_inst
       FROM wp_patch_sites p JOIN sites s ON s.id = p.site_id
      WHERE p.staging_domain IS NOT NULL AND p.staging_host IS NOT NULL AND p.staging_deleted_at IS NULL
        AND NOT (p.state = ANY($1::text[]))
        AND (p.state IN ('done', 'rolled_back', 'skipped')
             OR (p.state = 'failed' AND p.live_run_id IS NOT NULL)
             OR p.created_at < NOW() - INTERVAL '${CLONE_MAX_AGE_DAYS} days')`,
    [[...TRANSITIONAL_STATES, ...OPEN_STATES]]);
  let deleted = 0, failed = 0;
  for (const row of due.rows) {
    const ok = await deleteCloneFor(row.id, row.staging_host, row.staging_domain, row.staging_instance_id, row.live_inst);
    if (ok) deleted++; else failed++;
  }
  return { expired: exp.rowCount ?? 0, deleted, failed };
}

async function deleteCloneFor(psId: number, host: string, fqdn: string, stagingInst: number | null, liveInst: number | null): Promise<boolean> {
  const log = (l: string) => appendLog(psId, l);
  try {
    await log(`deleting staging clone ${fqdn} on ${host}`);
    const r = await deleteClone(host, fqdn, stagingInst, liveInst, log);
    if (r.ok) {
      await updatePatchSite(psId, { staging_deleted_at: new Date().toISOString(), staging_password: null });
      await log('staging clone deleted');
      return true;
    }
    await log(`staging clone delete FAILED: ${r.error}`);
  } catch (e) {
    await log(`staging clone delete crashed: ${(e as Error)?.message ?? e}`);
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------------------------------------------

interface Candidate { siteId: number; domain: string; serverKey: string; policy: PatchPolicy; items: PlannedItem[] }

async function eligibleSites(): Promise<Array<{ id: number; domain: string; host_server_id: number | null; policy: PatchPolicy }>> {
  const sites = await db.query<{ id: number; domain: string; host_server_id: number | null }>(
    `SELECT id, domain, host_server_id FROM sites WHERE is_wordpress = true ORDER BY id`);
  const policies = await getAllPolicies();
  return sites.rows
    .map(s => ({ ...s, policy: policies.get(s.id) ?? defaultPolicy(s.id) }))
    .filter(s => s.policy.enabled && s.policy.mode !== 'report' && (!REQUIRE_SAVED_POLICY || !s.policy.is_default));
}

async function rowsForSite(siteId: number): Promise<Array<{ id: number; state: PatchState; created_at: Date; run_id: number }>> {
  const r = await db.query<{ id: number; state: PatchState; created_at: Date; run_id: number }>(
    `SELECT id, state, created_at, run_id FROM wp_patch_sites
      WHERE site_id = $1 AND state = ANY($2::text[]) ORDER BY id DESC`,
    [siteId, [...TRANSITIONAL_STATES, ...OPEN_STATES]]);
  return r.rows;
}

// Decide whether a site can be staged now. Returns a skip reason, or null (and supersedes a stale row that is
// still awaiting approval, so it's re-staged with the newest versions). An APPROVED row is left alone: it goes
// live in the next live run with the versions that were tested.
async function clearToStage(siteId: number, runId: number): Promise<string | null> {
  const rows = await rowsForSite(siteId);
  const busy = rows.find(r => TRANSITIONAL_STATES.includes(r.state));
  if (busy) return `already in progress (patch #${busy.id}, ${busy.state})`;
  const approved = rows.find(r => r.state === 'approved');
  if (approved) return `approved and waiting for the live run (patch #${approved.id})`;
  for (const r of rows) {
    const ageH = (Date.now() - new Date(r.created_at).getTime()) / 3_600_000;
    if (ageH < STAGE_FRESH_HOURS) return `staged recently (patch #${r.id}, ${r.state})`;
  }
  for (const r of rows) {
    await setState(r.id, 'skipped', { error: `Superseded by run #${runId}` }, `superseded by run #${runId}`);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Staging (one site)
// ---------------------------------------------------------------------------------------------------------------

async function stageSite(psId: number, siteId: number, policy: PatchPolicy): Promise<PatchState> {
  const log = (l: string) => appendLog(psId, l);
  const stagedFail = async (msg: string): Promise<PatchState> => {
    await setState(psId, 'staged_failed', { error: msg }, msg);
    return 'staged_failed';
  };
  try {
    // Atomic claim (pending -> cloning) so a swept or duplicate row is never worked twice.
    const claim = await db.query(
      `UPDATE wp_patch_sites SET state = 'cloning', updated_at = NOW() WHERE id = $1 AND state = 'pending'`, [psId]);
    if (claim.rowCount !== 1) return (await getPatchSite(psId))?.state ?? 'staged_failed';
    await appendLog(psId, '[cloning] resolving live site');
    const t = await resolveTarget(siteId);
    if ('error' in t) return await stagedFail(`cannot resolve site: ${t.error}`);
    const { domain, host, instId: liveInst } = t;
    await updatePatchSite(psId, { staging_host: host });
    const livePath = await instancePath(host, liveInst);
    if (!livePath) return await stagedFail('could not read the live instance path from wp-toolkit --info');

    // Disk capacity — too big / too full -> needs_staging1 (later phase), skipped this cycle.
    const cap = await checkCapacity(host, liveInst, livePath, log);
    if (!cap.ok) {
      await setState(psId, 'skipped', { needs_staging1: true, error: cap.reason ?? 'capacity' }, cap.reason ?? 'capacity check failed');
      return 'skipped';
    }

    // Protected subdomain first (recorded before creation so cleanup can always find it), then the clone.
    const label = stagingLabel(psId);
    const fqdn = `${label}.${domain}`;
    const user = 'aemstaging';
    const pass = genPassword();
    await updatePatchSite(psId, { staging_domain: fqdn, staging_user: user, staging_password: pass });
    const sub = await createProtectedSubdomain(host, domain, label, user, pass, log);
    if (!sub.ok) return await stagedFail(sub.error ?? 'subdomain setup failed');

    const inst = await cloneToSubdomain(host, liveInst, fqdn, log);
    if ('error' in inst) return await stagedFail(inst.error);
    const sInst = inst.id;
    await updatePatchSite(psId, { staging_instance_id: sInst, staging_url: inst.siteUrl });
    if (!await assertProtected(host, inst.siteUrl, log)) {
      return await stagedFail(`staging clone ${inst.siteUrl} answers without the password — stopped before sanitising/patching`);
    }
    const sPath = await instancePath(host, sInst);
    if (!sPath || sPath === livePath) return await stagedFail(`bad staging path (${sPath || 'unknown'})`);

    // Sanitise BEFORE any update.
    const isWoo = policy.is_woocommerce || await detectWoo(host, sInst);
    await setState(psId, 'sanitising', { is_woocommerce: isWoo }, `sanitising clone${isWoo ? ' (WooCommerce)' : ''}`);
    const san = await sanitiseClone(host, sInst, sPath, isWoo, log);
    if (!san.ok) return await stagedFail(`sanitise failed: ${san.error}`);

    // Re-read versions on the clone (= live right now): the nightly scan may be stale.
    for (const it of await getItems(psId)) {
      const cur = await installedVersion(host, sInst, it.kind, it.slug);
      if (cur === it.to_version) { await log(`${it.kind} ${it.slug}: already at ${cur}, dropped`); await deleteItem(it.id); continue; }
      if (cur === null) { await log(`${it.kind} ${it.slug}: not installed / unreadable on clone, dropped`); await deleteItem(it.id); continue; }
      if (cur !== it.from_version) {
        await log(`${it.kind} ${it.slug}: clone is at ${cur} (scan said ${it.from_version}); updating from ${cur}`);
        await updateItem(it.id, { from_version: cur, is_major: isMajor(it.kind, cur, it.to_version) });
      }
    }
    const items = await getItems(psId);
    if (!items.length) {
      await setState(psId, 'skipped', { error: 'nothing left to update' }, 'nothing left to update');
      return 'skipped';
    }
    await updatePatchSite(psId, { needs_approval: needsApproval(policy, items), security: items.some(i => i.security) });

    const target = { baseUrl: inst.siteUrl, host, vhost: fqdn, auth: { user, pass } };
    const base = await smokeTest(target, policy, null);
    await log(`pre-patch staging smoke:\n  ${base.lines.join('\n  ')}`);
    if (!base.ok) return await stagedFail('staging clone failed its smoke test BEFORE patching (clone problem, not the updates)');

    await setState(psId, 'patching', {}, `applying ${items.length} update(s) on staging`);
    const mark = await errorLogMark(host, fqdn);
    const ap = await applyItems(host, sInst, items, 'staging', log);
    if (!ap.ok) return await stagedFail(`update failed on staging: ${ap.error}`);

    await setState(psId, 'smoke', {}, 'running staging smoke test');
    const sm = await smokeTest(target, policy, mark);
    await log(`staging smoke:\n  ${sm.lines.join('\n  ')}`);
    if (!sm.ok) return await stagedFail('staging smoke test failed after updates');

    await setState(psId, 'staged_ok', { staged_at: new Date().toISOString(), error: null }, 'staging passed');
    const ps = await getPatchSite(psId);
    if (ps?.needs_approval) {
      await setState(psId, 'awaiting_approval', {}, 'waiting for staff approval');
      return 'awaiting_approval';
    }
    await setState(psId, 'approved', {}, 'auto-approved (policy auto; minor/patch/security only)');
    return 'approved';
  } catch (e) {
    return await stagedFail(`crashed: ${(e as Error)?.message ?? e}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------------------------------------------

// Servers in parallel, one site at a time per server (a clone is disk/CPU heavy).
async function perServer<T extends { serverKey: string }>(list: T[], fn: (x: T) => Promise<void>): Promise<void> {
  const by = new Map<string, T[]>();
  for (const x of list) { const l = by.get(x.serverKey) ?? []; l.push(x); by.set(x.serverKey, l); }
  await Promise.all([...by.values()].map(async (l) => { for (const x of l) { try { await fn(x); } catch (e) { console.error('wp-patch:', e); } } }));
}

async function startRun(kind: RunKind, triggeredBy: string, exec: (runId: number) => Promise<Record<string, unknown>>): Promise<StartResult> {
  const busy = await runningRunOfKind(kind);
  if (busy) return { ok: false, reason: `a ${kind} run is already in progress (#${busy})` };
  const runId = await createRun(kind, triggeredBy);
  void (async () => {
    try {
      const extra = await exec(runId);
      await finishRun(runId, 'done', extra);
    } catch (e) {
      console.error(`wp-patch ${kind} run #${runId} crashed:`, e);
      await finishRun(runId, 'failed', { error: String((e as Error)?.message ?? e) }).catch(() => {});
    }
  })();
  return { ok: true, runId };
}

async function stageCandidates(runId: number, cands: Candidate[], promoteImmediately: boolean): Promise<void> {
  const queued: Array<{ psId: number; siteId: number; policy: PatchPolicy; serverKey: string }> = [];
  for (const c of cands) {
    const psId = await createPatchSite(runId, c.siteId, {
      needs_approval: needsApproval(c.policy, c.items), security: c.items.some(i => i.security),
      is_woocommerce: c.policy.is_woocommerce,
    });
    for (const it of c.items) await insertItem(psId, it);
    await appendLog(psId, `[pending] queued in run #${runId}: ${c.items.map(i => `${i.slug} ${i.from_version ?? '?'} -> ${i.to_version}${i.security ? ' [security]' : ''}${i.is_major ? ' [major]' : ''}`).join(', ')}`);
    queued.push({ psId, siteId: c.siteId, policy: c.policy, serverKey: c.serverKey });
  }
  await perServer(queued, async (q) => {
    const st = await stageSite(q.psId, q.siteId, q.policy);
    if (promoteImmediately && st === 'approved') {
      const final = await runLiveForPatchSite(q.psId, runId);
      if (final === 'done' || final === 'rolled_back' || final === 'failed') await cleanupOne(q.psId);
    }
  });
}

async function cleanupOne(psId: number): Promise<void> {
  const ps = await getPatchSite(psId);
  if (!ps || !ps.staging_domain || !ps.staging_host || ps.staging_deleted_at) return;
  const live = await db.query<{ wp_instance_id: number | null }>(`SELECT wp_instance_id FROM sites WHERE id = $1`, [ps.site_id]);
  await deleteCloneFor(psId, ps.staging_host, ps.staging_domain, ps.staging_instance_id, live.rows[0]?.wp_instance_id ?? null);
}

// Monday: stage every eligible site with pending non-held items.
export async function startStagingRun(triggeredBy: string): Promise<StartResult> {
  return startRun('staging', triggeredBy, async (runId) => {
    await sweepOrphanedPatchSites();
    const cleaned = await cleanupStagingClones();
    const cands: Candidate[] = [];
    let skipped = 0;
    for (const s of await eligibleSites()) {
      const plan = await planSite(s.id, s.policy);
      if (!plan.items.length) continue;
      const why = await clearToStage(s.id, runId);
      if (why) { await recordSkippedSite(runId, s.id, why); skipped++; continue; }
      cands.push({ siteId: s.id, domain: s.domain, serverKey: String(s.host_server_id ?? 'none'), policy: s.policy, items: plan.items });
    }
    await stageCandidates(runId, cands, false);
    return { candidates: cands.length, skipped, cleaned };
  });
}

// Tuesday: promote every approved, recently staged site.
export async function startLiveRun(triggeredBy: string): Promise<StartResult> {
  return startRun('live', triggeredBy, async (runId) => {
    await sweepOrphanedPatchSites();
    const rows = await db.query<{ id: number; host_server_id: number | null }>(
      `SELECT p.id, s.host_server_id FROM wp_patch_sites p JOIN sites s ON s.id = p.site_id
        WHERE p.state = 'approved' AND p.staged_at > NOW() - INTERVAL '${LIVE_WINDOW_DAYS} days'
        ORDER BY p.id`);
    await perServer(rows.rows.map(r => ({ id: r.id, serverKey: String(r.host_server_id ?? 'none') })), async (r) => {
      await runLiveForPatchSite(r.id, runId);
    });
    const cleaned = await cleanupStagingClones();
    return { promoted: rows.rows.length, cleaned };
  });
}

// After the nightly scan: sites with a pending SECURITY item that isn't held. The fast-track stages security items
// plus any minor/patch items (non-security majors wait for the normal Monday run so they can't hold a security fix
// back behind an approval); live follows straight after staging if no approval is needed.
export async function startFastTrack(triggeredBy: string): Promise<StartResult | { ok: true; runId: null; reason: string }> {
  await sweepOrphanedPatchSites();
  const cands: Candidate[] = [];
  const promoteNow: Array<{ id: number; serverKey: string }> = [];
  for (const s of await eligibleSites()) {
    const plan = await planSite(s.id, s.policy);
    const sec = plan.items.filter(i => i.security);
    if (!sec.length) continue;

    // Already staged with these exact security fixes? Approved -> promote now; waiting/in progress -> leave it.
    const open = await db.query<{ id: number; state: PatchState; slugs: string[] }>(
      `SELECT p.id, p.state, ARRAY_AGG(i.kind || ':' || i.slug || '@' || i.to_version) AS slugs
         FROM wp_patch_sites p JOIN wp_patch_items i ON i.patch_site_id = p.id
        WHERE p.site_id = $1 AND p.state = ANY($2::text[])
        GROUP BY p.id, p.state ORDER BY p.id DESC`,
      [s.id, [...TRANSITIONAL_STATES, ...OPEN_STATES]]);
    const key = (i: PlannedItem) => `${i.kind}:${i.slug}@${i.to_version}`;
    const covering = open.rows.find(r => sec.every(i => r.slugs.includes(key(i))));
    if (covering) {
      if (covering.state === 'approved') promoteNow.push({ id: covering.id, serverKey: String(s.host_server_id ?? 'none') });
      continue;
    }
    if (open.rows.some(r => TRANSITIONAL_STATES.includes(r.state))) continue;

    // Don't retry the same security fix every night after it failed in the last week.
    const tried = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM wp_patch_sites p JOIN wp_patch_items i ON i.patch_site_id = p.id
        WHERE p.site_id = $1 AND p.created_at > NOW() - INTERVAL '7 days'
          AND p.state IN ('staged_failed', 'failed', 'rolled_back')
          AND (i.kind || ':' || i.slug || '@' || i.to_version) = ANY($2::text[])`,
      [s.id, sec.map(key)]);
    if ((tried.rows[0]?.n ?? 0) > 0) continue;

    const items = plan.items.filter(i => i.security || !i.is_major);
    cands.push({ siteId: s.id, domain: s.domain, serverKey: String(s.host_server_id ?? 'none'), policy: s.policy, items });
  }
  if (!cands.length && !promoteNow.length) return { ok: true, runId: null, reason: 'no security updates to fast-track' };

  return startRun('fasttrack', triggeredBy, async (runId) => {
    for (const c of cands) {
      // Supersede any stale open row for the site (anything still in progress was excluded above).
      for (const r of await rowsForSite(c.siteId)) {
        if (OPEN_STATES.includes(r.state)) await setState(r.id, 'skipped', { error: `Superseded by fast-track run #${runId}` }, `superseded by fast-track run #${runId}`);
      }
    }
    await perServer(promoteNow, async (p) => {
      const final = await runLiveForPatchSite(p.id, runId);
      if (final === 'done' || final === 'rolled_back' || final === 'failed') await cleanupOne(p.id);
    });
    await stageCandidates(runId, cands, true);
    return { candidates: cands.length, promoted_existing: promoteNow.length };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------------------------------------------

export async function approvePatchSite(psId: number, userId: number): Promise<{ ok: boolean; error?: string; promoting?: boolean }> {
  const r = await db.query<{ run_id: number; site_id: number }>(
    `UPDATE wp_patch_sites SET state = 'approved', approved_by = $2, approved_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND state = 'awaiting_approval' RETURNING run_id, site_id`, [psId, userId]);
  if (r.rowCount !== 1) return { ok: false, error: 'Not awaiting approval' };
  await appendLog(psId, `[approved] approved by user ${userId}`);
  const run = await db.query<{ kind: RunKind }>(`SELECT kind FROM wp_patch_runs WHERE id = $1`, [r.rows[0].run_id]);
  const policy = await getPolicy(r.rows[0].site_id);
  // Fast-track sites go live as soon as they're approved; everything else waits for the Tuesday live run.
  if (run.rows[0]?.kind === 'fasttrack' && policy.enabled && policy.mode !== 'report') {
    const runId = r.rows[0].run_id;
    void (async () => {
      try {
        const final = await runLiveForPatchSite(psId, runId);
        if (final === 'done' || final === 'rolled_back' || final === 'failed') await cleanupOne(psId);
      } catch (e) { console.error(`wp-patch live after approval #${psId}:`, e); }
    })();
    return { ok: true, promoting: true };
  }
  return { ok: true, promoting: false };
}

export async function rejectPatchSite(psId: number, userId: number): Promise<{ ok: boolean; error?: string }> {
  const r = await db.query(
    `UPDATE wp_patch_sites SET state = 'skipped', error = $2, updated_at = NOW()
      WHERE id = $1 AND state IN ('awaiting_approval', 'approved')`, [psId, `Rejected by user ${userId}`]);
  if (r.rowCount !== 1) return { ok: false, error: 'Not awaiting approval' };
  await appendLog(psId, `[skipped] rejected by user ${userId}`);
  void cleanupOne(psId).catch((e) => console.error(`wp-patch clone delete #${psId}:`, e));
  return { ok: true };
}
