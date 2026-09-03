import { db } from '@/lib/db';
import { sshExec } from '@/lib/ssh';
import { lookupWpInstanceId, LIVE1, STAGING1, shellQ } from '@/lib/onboarding';

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

function hostForServerId(server_id: number | null): string {
  // Hardcoded for now; expand when more servers in the fleet.
  if (server_id === 1) return STAGING1;
  return LIVE1;
}

async function ensureInstanceId(siteId: number, host: string, domain: string): Promise<number | null> {
  const cur = await db.query<{ wp_instance_id: number | null }>(
    `SELECT wp_instance_id FROM sites WHERE id = $1`, [siteId]);
  if (cur.rows[0]?.wp_instance_id) return cur.rows[0].wp_instance_id;
  const lk = await lookupWpInstanceId(host, domain);
  if (lk.id === null) return null;
  await db.query(`UPDATE sites SET wp_instance_id = $1 WHERE id = $2`, [lk.id, siteId]);
  return lk.id;
}

export async function scanSite(siteId: number): Promise<PendingCounts | null> {
  const s = await db.query<{ domain: string; host_server_id: number | null }>(
    `SELECT domain, host_server_id FROM sites WHERE id = $1 AND is_wordpress = true`, [siteId]);
  if (s.rows.length === 0) return null;
  const { domain, host_server_id } = s.rows[0];
  const host = hostForServerId(host_server_id);
  const instId = await ensureInstanceId(siteId, host, domain);
  if (instId === null) return null;

  const pluginsR = await sshExec(host,
    `plesk ext wp-toolkit --wp-cli -instance-id ${instId} -- plugin list --update=available --format=count 2>&1`, 30);
  const themesR = await sshExec(host,
    `plesk ext wp-toolkit --wp-cli -instance-id ${instId} -- theme list --update=available --format=count 2>&1`, 30);
  const coreR = await sshExec(host,
    `plesk ext wp-toolkit --wp-cli -instance-id ${instId} -- core check-update --format=count 2>&1`, 30);

  const plugins = parseInt((pluginsR.stdout || '').trim().match(/^\d+/)?.[0] || '0', 10);
  const themes  = parseInt((themesR.stdout  || '').trim().match(/^\d+/)?.[0] || '0', 10);
  const core    = !/at the latest version/.test(coreR.stdout || '') && parseInt((coreR.stdout || '').trim().match(/^\d+/)?.[0] || '0', 10) > 0;

  await db.query(
    `UPDATE sites
       SET pending_plugin_updates = $1,
           pending_theme_updates  = $2,
           pending_core_update    = $3,
           last_update_scan_at    = NOW()
     WHERE id = $4`,
    [plugins, themes, core, siteId]);

  return { plugins, themes, core, scanned_at: new Date() };
}

export async function scanFleet(): Promise<{ scanned: number; failed: number }> {
  const sites = await db.query<{ id: number }>(
    `SELECT id FROM sites WHERE is_wordpress = true ORDER BY id`);
  let scanned = 0, failed = 0;
  for (const s of sites.rows) {
    try { await scanSite(s.id); scanned++; } catch { failed++; }
  }
  return { scanned, failed };
}

export async function triggerUpdate(
  siteId: number,
  kind: 'plugins' | 'themes' | 'core' | 'all',
  userId: number,
): Promise<{ jobId: number } | { error: string }> {
  const s = await db.query<{ domain: string; host_server_id: number | null; wp_instance_id: number | null }>(
    `SELECT domain, host_server_id, wp_instance_id FROM sites WHERE id = $1 AND is_wordpress = true`, [siteId]);
  if (s.rows.length === 0) return { error: 'Site not found or not WordPress' };
  const { domain, host_server_id } = s.rows[0];
  const host = hostForServerId(host_server_id);
  const instId = s.rows[0].wp_instance_id ?? await ensureInstanceId(siteId, host, domain);
  if (instId === null) return { error: `Could not resolve wp-toolkit instance-id for ${domain}` };

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
  const host = hostForServerId(job.host_server_id);
  const inst = job.instance_id;

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
  const host = hostForServerId(job.host_server_id);

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
