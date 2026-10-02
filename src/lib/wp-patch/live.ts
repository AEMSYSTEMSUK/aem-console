import { db } from '@/lib/db';
import { sshExec } from '@/lib/ssh';
import { resolveTarget, scanSite } from '@/lib/wp-updates';
import { getPolicy, heldReason } from '@/lib/wp-patch-policy';
import { shellQ, out, tail, installedVersion } from './remote';
import { applyItems } from './apply';
import { smokeTest, errorLogMark } from './smoke';
import { appendLog, getItems, getPatchSite, setState, updateItem, deleteItem, type PatchSite, type PatchItem } from './store';

// #220 phase 2 — the ONLY code path that changes a live site.
// Preconditions (all enforced here, not by the caller):
//   * the row is atomically claimed from state 'approved' (so it can't run twice, and never without approval)
//   * every item was applied on the staging clone (applied_staging) and is pinned to that exact version
//   * the live site still has each item at the version staging updated FROM (else that item is dropped)
//   * the live site passes the smoke test BEFORE anything changes (else nothing is touched)
//   * a WP Toolkit backup of the live instance succeeds BEFORE any update
// Then: apply exact versions -> live smoke -> on failure restore that backup automatically.

type Log = (line: string) => Promise<void>;

export async function runLiveForPatchSite(patchSiteId: number, liveRunId: number): Promise<PatchSite['state']> {
  // Atomic claim: approved -> live_backup. Nothing else may move a row into a live state.
  const claim = await db.query<{ id: number }>(
    `UPDATE wp_patch_sites SET state = 'live_backup', live_run_id = $2, updated_at = NOW()
      WHERE id = $1 AND state = 'approved' RETURNING id`, [patchSiteId, liveRunId]);
  if (claim.rowCount !== 1) return (await getPatchSite(patchSiteId))?.state ?? 'failed';
  const ps = (await getPatchSite(patchSiteId))!;
  const log: Log = (l) => appendLog(patchSiteId, l);
  await log(`[live_backup] live run #${liveRunId} picked this site up`);

  const fail = async (msg: string): Promise<PatchSite['state']> => {
    await setState(patchSiteId, 'failed', { error: msg }, msg);
    return 'failed';
  };

  try {
    const t = await resolveTarget(ps.site_id);
    if ('error' in t) return await fail(`cannot resolve live site: ${t.error}`);
    const { domain, host, instId } = t;
    if (ps.staging_instance_id && ps.staging_instance_id === instId) return await fail('live instance id equals the staging instance id — refusing');
    if (ps.staging_host && ps.staging_host !== host) return await fail(`site moved host since staging (${ps.staging_host} -> ${host}); re-stage`);
    const policy = await getPolicy(ps.site_id);
    if (!policy.enabled || policy.mode === 'report') return await fail(`policy is now ${policy.enabled ? policy.mode : 'disabled'} — not patching`);
    // Auto-approved under an 'auto' policy that has since been tightened: back to the approval queue.
    if ((ps.needs_approval || policy.mode === 'approve' || policy.client_approval) && !ps.approved_by) {
      await setState(patchSiteId, 'awaiting_approval', { needs_approval: true, live_run_id: null },
        'policy now requires approval; returned to the approval queue');
      return 'awaiting_approval';
    }

    // 1. Exactly the versions tested on staging, and only if live still matches what staging started from.
    const all = await getItems(patchSiteId);
    const items: PatchItem[] = [];
    for (const it of all) {
      const held = heldReason({ kind: it.kind, slug: it.slug, name: it.name, current_version: it.from_version, new_version: it.to_version }, policy);
      if (held) { await log(`${it.kind} ${it.slug}: now held by policy (${held}) — skipped`); continue; }
      if (!it.applied_staging) { await log(`${it.kind} ${it.slug}: not applied on staging — skipped`); await deleteItem(it.id); continue; }
      const cur = await installedVersion(host, instId, it.kind, it.slug);
      if (cur === it.to_version) { await log(`${it.kind} ${it.slug}: live already at ${cur}`); await updateItem(it.id, { applied_live: true }); continue; }
      if (cur !== it.from_version) {
        await log(`${it.kind} ${it.slug}: live is at ${cur ?? 'unknown'}, staging tested ${it.from_version} -> ${it.to_version}; skipped`);
        continue;
      }
      items.push(it);
    }
    if (!items.length) {
      await setState(patchSiteId, 'done', {}, 'nothing left to apply on live');
      return 'done';
    }

    // 2. Live must be healthy BEFORE we touch it (otherwise a failing smoke afterwards proves nothing).
    const target = { baseUrl: `https://${domain}`, host, vhost: domain };
    const pre = await smokeTest(target, policy, null);
    await log(`pre-patch live smoke:\n  ${pre.lines.join('\n  ')}`);
    if (!pre.ok) return await fail('live site failed its smoke test BEFORE patching — nothing changed');

    // 3. Backup (same WP Toolkit command as the manual update flow in wp-updates.ts).
    const filename = `aem-patch-${patchSiteId}-${Date.now()}`;
    const bcmd = `plesk ext wp-toolkit --backup -instance-id ${instId} -operation backup -filename ${shellQ(filename)} 2>&1`;
    await log(`$ ${bcmd}`);
    const b = await sshExec(host, bcmd, 1800);
    await log(tail(out(b), 800) || '(no output)');
    if (!b.ok) return await fail('live backup failed — nothing changed');
    await setState(patchSiteId, 'live_patching', { backup_ref: filename }, `backup ${filename} taken`);

    // 4. Apply.
    const mark = await errorLogMark(host, domain);
    const ap = await applyItems(host, instId, items, 'live', log);
    await sshExec(host, `plesk ext wp-toolkit --clear-cache -instance-id ${instId} 2>&1`, 60).catch(() => null);

    // 5. Smoke (or straight to restore if an update failed).
    let reason = ap.ok ? '' : `update failed: ${ap.error}`;
    if (ap.ok) {
      await setState(patchSiteId, 'live_smoke', {}, 'running live smoke test');
      const sm = await smokeTest(target, policy, mark);
      await log(`live smoke:\n  ${sm.lines.join('\n  ')}`);
      if (sm.ok) {
        await setState(patchSiteId, 'done', { error: null }, `live patched: ${items.map(i => `${i.slug} ${i.to_version}`).join(', ')}`);
        try { await scanSite(ps.site_id); } catch { /* counts refresh on the next nightly scan */ }
        return 'done';
      }
      reason = 'live smoke test failed';
    }

    // 6. Auto-rollback from the backup taken in step 3.
    const rcmd = `plesk ext wp-toolkit --backup -instance-id ${instId} -operation restore -filename ${shellQ(filename)} 2>&1`;
    await log(`${reason} — restoring backup\n$ ${rcmd}`);
    const rr = await sshExec(host, rcmd, 1800);
    await log(tail(out(rr), 800) || '(no output)');
    await sshExec(host, `plesk ext wp-toolkit --clear-cache -instance-id ${instId} 2>&1`, 60).catch(() => null);
    if (!rr.ok) {
      return await fail(`${reason}; RESTORE FAILED — live may be partially patched. Restore WP Toolkit backup ${filename} on ${host} by hand.`);
    }
    for (const it of items) await updateItem(it.id, { applied_live: false });
    const after = await smokeTest(target, policy, null);
    await log(`post-restore smoke:\n  ${after.lines.join('\n  ')}`);
    await setState(patchSiteId, 'rolled_back', { error: `${reason}; restored backup ${filename}${after.ok ? '' : ' (site still failing smoke after restore — check it)'}` },
      'rolled back');
    try { await scanSite(ps.site_id); } catch { /* ignore */ }
    return 'rolled_back';
  } catch (e) {
    const cur = await getPatchSite(patchSiteId);
    const msg = (e as Error)?.message ?? String(e);
    if (cur && (cur.state === 'live_patching' || cur.state === 'live_smoke')) {
      return await fail(`crashed during ${cur.state}: ${msg} — live may be partially patched; backup ${cur.backup_ref ?? '(none)'}`);
    }
    return await fail(`crashed: ${msg}`);
  }
}
