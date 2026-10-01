import { db } from '@/lib/db';
import { sshExec } from '@/lib/ssh';
import { lookupWpInstanceId, shellQ } from '@/lib/onboarding';
import type { PendingItem } from '@/lib/wp-patch-policy';

export interface PendingCounts {
  plugins: number;
  themes:  number;
  core:    boolean;
  scanned_at: Date;
}

export interface WpUpdateJob {
  id: number;
  site_id: number;
  instance_id: number;
  kind: 'plugins' | 'themes' | 'core' | 'all';
  status: 'pending' | 'running' | 'success' | 'failed' | 'rolled_back';
  backup_filename: string | null;
  pre_update: any | null;
  post_update: any | null;
  output: string | null;
  error: string | null;
  progress_pct: number | null;
  started_at: string;
  completed_at: string | null;
  triggered_by_user_id: number | null;
}

// The server a site actually lives on, from the servers table. This used to be hard-coded (server 1 = staging1,
// EVERYTHING else = live1), which sent scans/updates/rollbacks for mosohouse, embroideryinhouse, stag-sports and
// tripaid sites over SSH to the wrong box. No fallback host: if we don't know where it lives, we don't touch it.
async function hostForServerId(server_id: number | null): Promise<string> {
  if (!server_id) throw new Error('Site has no host server recorded');
  const r = await db.query<{ fqdn: string | null }>(`SELECT fqdn FROM servers WHERE id = $1`, [server_id]);
  const fqdn = r.rows[0]?.fqdn;
  if (!fqdn) throw new Error(`No FQDN recorded for server ${server_id}`);
  return fqdn;
}

// Resolve (host, WP Toolkit instance id) for a site, VERIFIED on the site's own server. A domain can exist on two
// boxes (e.g. migrated staging1 -> live1), so a cached id is never trusted on its own: we ask that host's
// wp-toolkit which instance serves https://<domain>. Discovery's raw.wp_instance_id (found on the right host) is
// the fallback only if the live lookup can't run. The verified id is written back to sites.wp_instance_id.
async function resolveTarget(siteId: number): Promise<{ domain: string; host: string; instId: number } | { error: string }> {
  const s = await db.query<{ domain: string; host_server_id: number | null; raw: { wp_instance_id?: number } | null }>(
    `SELECT domain, host_server_id, raw FROM sites WHERE id = $1 AND is_wordpress = true`, [siteId]);
  if (s.rows.length === 0) return { error: 'Site not found or not WordPress' };
  const { domain, host_server_id, raw } = s.rows[0];
  let host: string;
  try { host = await hostForServerId(host_server_id); } catch (e) { return { error: (e as Error).message }; }
  const lk = await lookupWpInstanceId(host, domain);
  const instId = lk.id ?? (lk.error?.startsWith('No instance found') ? null : (raw?.wp_instance_id ? Number(raw.wp_instance_id) : null));
  if (instId === null) return { error: `No WP Toolkit instance for ${domain} on ${host}${lk.error ? `: ${lk.error}` : ''}` };
  await db.query(`UPDATE sites SET wp_instance_id = $1 WHERE id = $2`, [instId, siteId]);
  return { domain, host, instId };
}

// wp-toolkit sometimes prints PHP notices/warnings before (or after) wp-cli's JSON. wp-cli emits its JSON on one
// line, so try each line that looks like JSON first, then fall back to scanning from each '[' / '{'.
function parseJsonLoose(out: string): unknown {
  const s = out || '';
  for (const line of s.split('\n')) {
    const t = line.trim();
    if (t.startsWith('[') || t.startsWith('{')) { try { return JSON.parse(t); } catch {} }
  }
  for (let i = 0, tries = 0; i < s.length && tries < 50; i++) {
    const ch = s[i];
    if (ch !== '[' && ch !== '{') continue;
    tries++;
    const end = s.lastIndexOf(ch === '[' ? ']' : '}');
    if (end <= i) continue;
    try { return JSON.parse(s.slice(i, end + 1)); } catch {}
  }
  return undefined;
}

const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));

function toItems(kind: 'plugin' | 'theme', parsed: unknown[]): PendingItem[] {
  return parsed
    .filter((r: any) => r && r.name)
    .map((r: any) => ({ kind, slug: String(r.name), name: str(r.title) ?? String(r.name),
                        current_version: str(r.version), new_version: str(r.update_version) }));
}

const snip = (r: { stdout: string; stderr: string; error?: string }) =>
  (r.stderr || r.error || r.stdout || '(no output)').trim().slice(0, 300);

// Itemised scan: which plugin/theme/core updates are available on one site. Replaces that site's rows in
// wp_pending_updates and keeps the sites.pending_* count columns in step (the updates table reads those).
// Returns null if the site can't be resolved to a host + instance; THROWS if wp-cli output can't be read, so a
// broken scan never overwrites good data with zeros.
export async function scanSite(siteId: number): Promise<PendingCounts | null> {
  const t = await resolveTarget(siteId);
  if ('error' in t) return null;
  const { host, instId } = t;
  const wpcli = `plesk ext wp-toolkit --wp-cli -instance-id ${instId} --`;

  const pluginsR = await sshExec(host, `${wpcli} plugin list --update=available --format=json --fields=name,title,version,update_version`, 60);
  const themesR  = await sshExec(host, `${wpcli} theme list --update=available --format=json --fields=name,title,version,update_version`, 60);
  const coreR    = await sshExec(host, `${wpcli} core check-update --format=json`, 60);

  const pluginsJ = parseJsonLoose(pluginsR.stdout);
  const themesJ  = parseJsonLoose(themesR.stdout);
  if (!Array.isArray(pluginsJ)) throw new Error(`plugin list unreadable: ${snip(pluginsR)}`);
  if (!Array.isArray(themesJ))  throw new Error(`theme list unreadable: ${snip(themesR)}`);

  // core check-update prints "Success: WordPress is at the latest version." (no JSON) when there's nothing to do,
  // otherwise a JSON array of {version, update_type, package_url}, newest first. One core row: the newest.
  let coreItems: PendingItem[] = [];
  if (!/at the latest version/i.test(`${coreR.stdout}\n${coreR.stderr}`)) {
    const coreJ = parseJsonLoose(coreR.stdout);
    if (!Array.isArray(coreJ)) throw new Error(`core check-update unreadable: ${snip(coreR)}`);
    const newest = coreJ.find((c: any) => c && c.version) as { version: unknown } | undefined;
    if (newest) {
      // Current version (needed to tell a core major from a minor). Fall back to inventory's wp_version.
      const verR = await sshExec(host, `${wpcli} core version`, 30);
      const live = (verR.stdout || '').split('\n').map(l => l.trim()).reverse().find(l => /^\d+\.\d+/.test(l)) ?? null;
      const inv = live ? null : (await db.query<{ wp_version: string | null }>(
        `SELECT wp_version FROM sites WHERE id = $1`, [siteId])).rows[0]?.wp_version ?? null;
      coreItems = [{ kind: 'core', slug: 'wordpress', name: 'WordPress', current_version: live ?? inv, new_version: String(newest.version) }];
    }
  }

  const pluginItems = toItems('plugin', pluginsJ);
  const themeItems  = toItems('theme', themesJ);
  const items = [...pluginItems, ...themeItems, ...coreItems];
  const counts = { plugins: pluginItems.length, themes: themeItems.length, core: coreItems.length > 0 };

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM wp_pending_updates WHERE site_id = $1`, [siteId]);
    for (const it of items) {
      await client.query(
        `INSERT INTO wp_pending_updates (site_id, kind, slug, name, current_version, new_version)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (site_id, kind, slug) DO NOTHING`,
        [siteId, it.kind, it.slug, it.name, it.current_version, it.new_version]);
    }
    await client.query(
      `UPDATE sites
         SET pending_plugin_updates = $1,
             pending_theme_updates  = $2,
             pending_core_update    = $3,
             last_update_scan_at    = NOW()
       WHERE id = $4`,
      [counts.plugins, counts.themes, counts.core, siteId]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  return { ...counts, scanned_at: new Date() };
}

// A job left 'pending'/'running' means the Console process died mid-job (runUpdateJob runs in-process and never
// resumes). Nothing legitimately runs that long (backup 10 min + 3 x update 10 min worst case), so after 2 hours
// mark it failed so the UI stops showing it as in progress.
export async function sweepOrphanedUpdateJobs(): Promise<number> {
  const r = await db.query(
    `UPDATE wp_update_jobs
        SET status = 'failed', error = 'Orphaned (Console restarted mid-job)', completed_at = NOW()
      WHERE status IN ('running', 'pending') AND started_at < NOW() - INTERVAL '2 hours'`);
  return r.rowCount ?? 0;
}

export interface FleetScanResult {
  sites: number; servers: number; scanned: number; failed: number;
  plugins: number; themes: number; core: number; orphaned: number;
}

const SCAN_CONCURRENCY_PER_SERVER = 2;

// Scan every WP site: servers in parallel, at most SCAN_CONCURRENCY_PER_SERVER sites at once on any one server.
export async function scanFleet(): Promise<FleetScanResult> {
  const orphaned = await sweepOrphanedUpdateJobs();
  const sites = await db.query<{ id: number; host_server_id: number | null }>(
    `SELECT id, host_server_id FROM sites WHERE is_wordpress = true ORDER BY id`);
  const byServer = new Map<string, number[]>();
  for (const s of sites.rows) {
    const k = String(s.host_server_id ?? 'none');
    const list = byServer.get(k) ?? [];
    list.push(s.id);
    byServer.set(k, list);
  }
  const res: FleetScanResult = { sites: sites.rows.length, servers: byServer.size, scanned: 0, failed: 0, plugins: 0, themes: 0, core: 0, orphaned };

  await Promise.all([...byServer.values()].map(async (ids) => {
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const id = ids[next++];
        try {
          const r = await scanSite(id);
          if (!r) { res.failed++; continue; }
          res.scanned++; res.plugins += r.plugins; res.themes += r.themes; if (r.core) res.core++;
        } catch (e) {
          res.failed++;
          console.error(`wp update scan failed for site ${id}:`, (e as Error)?.message ?? e);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY_PER_SERVER, ids.length) }, () => worker()));
  }));
  return res;
}

export async function triggerUpdate(
  siteId: number,
  kind: 'plugins' | 'themes' | 'core' | 'all',
  userId: number,
): Promise<{ jobId: number } | { error: string }> {
  const t = await resolveTarget(siteId);
  if ('error' in t) return { error: t.error };
  const { instId } = t;

  const j = await db.query<{ id: number }>(
    `INSERT INTO wp_update_jobs (site_id, instance_id, kind, status, progress_pct, triggered_by_user_id)
     VALUES ($1, $2, $3, 'pending', 0, $4) RETURNING id`,
    [siteId, instId, kind, userId]);
  const jobId = j.rows[0].id;

  // background — don't await
  void runUpdateJob(jobId).catch(async (e) => {
    await db.query(
      `UPDATE wp_update_jobs SET status='failed', error=$1, completed_at=NOW() WHERE id=$2`,
      [String(e?.message ?? e), jobId]);
  });

  return { jobId };
}

async function setJob(jobId: number, fields: Partial<WpUpdateJob>) {
  const sets: string[] = []; const vals: any[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = $${i}`); vals.push(v); i++;
  }
  vals.push(jobId);
  await db.query(`UPDATE wp_update_jobs SET ${sets.join(', ')} WHERE id = $${i}`, vals);
}

export async function runUpdateJob(jobId: number): Promise<void> {
  const j = await db.query<WpUpdateJob & { domain: string; host_server_id: number | null }>(
    `SELECT j.*, s.domain, s.host_server_id
       FROM wp_update_jobs j JOIN sites s ON s.id = j.site_id WHERE j.id = $1`, [jobId]);
  if (j.rows.length === 0) throw new Error('Job not found');
  const job = j.rows[0];
  const host = await hostForServerId(job.host_server_id);
  const inst = job.instance_id; // verified on this host by resolveTarget when the job was created

  await setJob(jobId, { status: 'running', progress_pct: 10 });

  // 1. Backup
  const filename = `pre-update-${jobId}-${Date.now()}`;
  const b = await sshExec(host,
    `plesk ext wp-toolkit --backup -instance-id ${inst} -operation backup -filename ${shellQ(filename)} 2>&1`,
    600);
  if (!b.ok) {
    await setJob(jobId, { status: 'failed', error: `Backup failed:\n${b.stdout || b.stderr || b.error}`, completed_at: new Date() as any });
    return;
  }
  await setJob(jobId, { backup_filename: filename, progress_pct: 30 });

  // 2. Pre-update snapshot
  const pre = await snapshotVersions(host, inst);
  await setJob(jobId, { pre_update: pre as any, progress_pct: 40 });

  // 3. Run updates
  const cmds: string[] = [];
  if (job.kind === 'plugins' || job.kind === 'all') cmds.push(`plesk ext wp-toolkit --wp-cli -instance-id ${inst} -- plugin update --all 2>&1`);
  if (job.kind === 'themes'  || job.kind === 'all') cmds.push(`plesk ext wp-toolkit --wp-cli -instance-id ${inst} -- theme update --all 2>&1`);
  if (job.kind === 'core'    || job.kind === 'all') cmds.push(`plesk ext wp-toolkit --wp-cli -instance-id ${inst} -- core update 2>&1`);

  let outputs = '';
  for (const c of cmds) {
    const r = await sshExec(host, c, 600);
    outputs += `\n$ ${c}\n${r.stdout}\n`;
    if (!r.ok) {
      await setJob(jobId, { status: 'failed', output: outputs, error: r.stdout || r.stderr || r.error, completed_at: new Date() as any });
      return;
    }
  }
  await setJob(jobId, { output: outputs, progress_pct: 70 });

  // 4. Post-update snapshot
  const post = await snapshotVersions(host, inst);
  await setJob(jobId, { post_update: post as any, progress_pct: 80 });

  // 5. Clear cache
  await sshExec(host, `plesk ext wp-toolkit --clear-cache -instance-id ${inst} 2>&1`, 30).catch(() => {});
  await setJob(jobId, { progress_pct: 90 });

  // 6. Healthcheck
  const hc = await healthcheck(job.domain);
  if (!hc.ok) {
    await setJob(jobId, { status: 'failed', error: `Healthcheck failed: ${hc.reason}`, completed_at: new Date() as any });
    return;
  }

  // 7. Rescan to refresh cached counts
  try { await scanSite(job.site_id); } catch {}

  await setJob(jobId, { status: 'success', progress_pct: 100, completed_at: new Date() as any });
}

export async function rollbackJob(jobId: number, userId: number): Promise<{ ok: boolean; error?: string }> {
  const j = await db.query<WpUpdateJob & { host_server_id: number | null }>(
    `SELECT j.*, s.host_server_id
       FROM wp_update_jobs j JOIN sites s ON s.id = j.site_id WHERE j.id = $1`, [jobId]);
  if (j.rows.length === 0) return { ok: false, error: 'Job not found' };
  const job = j.rows[0];
  if (!job.backup_filename) return { ok: false, error: 'No backup recorded for this job' };
  let host: string;
  try { host = await hostForServerId(job.host_server_id); } catch (e) { return { ok: false, error: (e as Error).message }; }

  const r = await sshExec(host,
    `plesk ext wp-toolkit --backup -instance-id ${job.instance_id} -operation restore -filename ${shellQ(job.backup_filename)} 2>&1`,
    900);
  if (!r.ok) return { ok: false, error: r.stdout || r.stderr || r.error };

  await db.query(
    `UPDATE wp_update_jobs SET status='rolled_back', error=$1 WHERE id = $2`,
    [`Rolled back by user ${userId} at ${new Date().toISOString()}`, jobId]);
  try { await scanSite(job.site_id); } catch {}
  return { ok: true };
}

async function snapshotVersions(host: string, inst: number) {
  const p = await sshExec(host, `plesk ext wp-toolkit --wp-cli -instance-id ${inst} -- plugin list --format=json --fields=name,version,status 2>&1`, 30);
  const t = await sshExec(host, `plesk ext wp-toolkit --wp-cli -instance-id ${inst} -- theme  list --format=json --fields=name,version,status 2>&1`, 30);
  const c = await sshExec(host, `plesk ext wp-toolkit --wp-cli -instance-id ${inst} -- core version 2>&1 | tail -1`, 30);
  let plugins: any[] = [], themes: any[] = [];
  try { plugins = JSON.parse(p.stdout.trim()); } catch {}
  try { themes  = JSON.parse(t.stdout.trim()); } catch {}
  return { plugins, themes, core: (c.stdout || '').trim() };
}

async function healthcheck(domain: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const url = `https://${domain}/`;
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
    const body = await r.text();
    if (body.length < 500) return { ok: false, reason: `Body too small (${body.length} bytes)` };
    if (/Fatal error/i.test(body)) return { ok: false, reason: 'Body contains "Fatal error"' };
    if (/(<title>|wp-content)/i.test(body) === false) return { ok: false, reason: 'No WP markers in body' };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}
