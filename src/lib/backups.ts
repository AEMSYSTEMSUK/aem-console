import { db } from '@/lib/db';
import { sshExec } from '@/lib/ssh';

// Backups & Restore — Phase 1. Read the live Plesk dump repository over SSH for a server's backup
// history, and trigger an on-demand full server backup (detached), tracked in backup_jobs. Restore
// is deliberately NOT here (Phase 2, with typed-confirmation guardrails).

// The remote command used to run an on-demand server backup. Overridable per environment so a Plesk
// build that wants different flags can be adjusted without a code change. Default writes into the
// standard Plesk repository (/var/lib/psa/dumps) so it shows up alongside the scheduled backups.
const BACKUP_CMD = process.env.AEM_PLESK_BACKUP_CMD || 'plesk bin pleskbackup server';
// Per-subscription safety backup taken right before a restore. {domain} is substituted.
const SAFETY_BACKUP_CMD = process.env.AEM_PLESK_SAFETY_BACKUP_CMD || 'plesk bin pleskbackup domains-name {domain}';
// Whole-subscription in-place restore from a discovered dump. {domain} + {dump} substituted. The default
// restores just the named domain from the dump the operator picked. OVERRIDE per Plesk version if needed,
// and pilot on one non-critical site before trusting it fleet-wide (restore is destructive).
const RESTORE_CMD = process.env.AEM_PLESK_RESTORE_CMD
  || 'plesk bin pleskrestore --restore {dump} -level domains -filter-domain-name {domain} -verbose';

export interface ServerBackup { at: string | null; status: string; sizeMb: number | null; ref: string | null }
export interface BackupJob {
  id: number; server_id: number; kind: string; status: string; pid: number | null;
  log_path: string | null; triggered_by: string | null; started_at: string; finished_at: string | null; output: string | null;
  target_domain?: string | null; source_dump?: string | null;
}

async function getServer(serverId: number): Promise<{ fqdn: string; role: string; name: string } | null> {
  const r = await db.query<{ fqdn: string; role: string; name: string }>(
    'SELECT fqdn, role, name FROM servers WHERE id = $1', [serverId]);
  return r.rows[0] || null;
}

// Convert Plesk's yymmddHHMM dump-dir timestamp to an ISO string.
function tsToIso(ts: string): string | null {
  if (!/^\d{10}$/.test(ts)) return null;
  return `20${ts.slice(0, 2)}-${ts.slice(2, 4)}-${ts.slice(4, 6)}T${ts.slice(6, 8)}:${ts.slice(8, 10)}:00`;
}

// List the discovered Plesk backups for a server (newest first), read live over SSH.
export async function listServerBackups(serverId: number, limit = 40): Promise<ServerBackup[]> {
  const server = await getServer(serverId);
  if (!server || !server.role.startsWith('plesk-')) return [];
  const cmd = `for d in $(ls -1dt /var/lib/psa/dumps/.discovered/backup_info_* 2>/dev/null | head -${limit}); do R=$(ls -1 "$d"/dumpresult_* 2>/dev/null | head -1); ST=$([ -n "$R" ] && basename "$R" | sed 's/^dumpresult_//' || echo unknown); BASE=$(basename "$d"); TS=$(echo "$BASE" | grep -oE '[0-9]{10}' | tail -1); SZ=$(du -scb /var/lib/psa/dumps/*"$TS"* 2>/dev/null | tail -1 | awk '{print $1}'); echo "$TS|$ST|$SZ"; done`;
  const r = await sshExec(server.fqdn, cmd, 25);
  if (!r.ok || !r.stdout.trim()) return [];
  const out: ServerBackup[] = [];
  for (const line of r.stdout.trim().split('\n')) {
    const [ts, status, sz] = line.split('|');
    const bytes = parseInt(sz || '0', 10);
    out.push({ at: tsToIso(ts), status: status || 'unknown', sizeMb: bytes > 0 ? Math.round(bytes / (1024 * 1024)) : null, ref: ts || null });
  }
  return out;
}

// Trigger an on-demand full server backup, detached, logging to a remote file. Records a backup_jobs
// row (status 'running') and returns it. Non-destructive — creates a new backup, touches nothing else.
export async function runServerBackup(serverId: number, triggeredBy: string): Promise<{ ok: boolean; job?: BackupJob; error?: string }> {
  const server = await getServer(serverId);
  if (!server) return { ok: false, error: 'Unknown server' };
  if (!server.role.startsWith('plesk-')) return { ok: false, error: 'Not a Plesk server' };
  // Guard: refuse if a run is already in flight for this server (avoid two concurrent pleskbackups).
  const inflight = await db.query('SELECT 1 FROM backup_jobs WHERE server_id = $1 AND status = $2 LIMIT 1', [serverId, 'running']);
  if ((inflight.rowCount ?? 0) > 0) return { ok: false, error: 'A backup is already running on this server' };

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const logPath = `/var/log/aem-console-backup-${stamp}.log`;
  // Launch detached so the SSH call returns immediately; echo the PID so we can poll for completion.
  const cmd = `nohup ${BACKUP_CMD} >${logPath} 2>&1 & echo $!`;
  const r = await sshExec(server.fqdn, cmd, 20);
  if (!r.ok) return { ok: false, error: r.error || r.stderr || 'Failed to start backup' };
  const pid = parseInt(r.stdout.trim(), 10) || null;
  const ins = await db.query<BackupJob>(
    `INSERT INTO backup_jobs (server_id, kind, status, pid, log_path, triggered_by)
     VALUES ($1, 'server', 'running', $2, $3, $4) RETURNING *`,
    [serverId, pid, logPath, triggeredBy?.slice(0, 200) || null]);
  return { ok: true, job: ins.rows[0] };
}

// Restore a whole subscription in place from a chosen dump (Phase 2). Destructive — overwrites the live
// site's files/DBs/mail. Safety-first: takes a fresh per-subscription backup and ABORTS if that fails, so
// a bad restore is itself recoverable; then launches the restore detached + logged, tracked in backup_jobs.
export async function restoreSubscription(serverId: number, domain: string, ref: string, triggeredBy: string): Promise<{ ok: boolean; job?: BackupJob; error?: string }> {
  const server = await getServer(serverId);
  if (!server) return { ok: false, error: 'Unknown server' };
  if (!server.role.startsWith('plesk-')) return { ok: false, error: 'Not a Plesk server' };
  const dom = domain.trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  if (!dom || !/^[a-z0-9.-]+$/.test(dom)) return { ok: false, error: 'Invalid domain' };
  if (!/^\d{10}$/.test(ref)) return { ok: false, error: 'Invalid dump reference' };
  const inflight = await db.query("SELECT 1 FROM backup_jobs WHERE server_id = $1 AND status = 'running' LIMIT 1", [serverId]);
  if ((inflight.rowCount ?? 0) > 0) return { ok: false, error: 'A backup or restore is already running on this server' };

  // 1) SAFETY BACKUP of the subscription — blocking, must succeed before we touch anything.
  const safetyCmd = SAFETY_BACKUP_CMD.replace(/\{domain\}/g, dom);
  const sb = await sshExec(server.fqdn, `${safetyCmd} 2>&1; echo "AEM_SAFETY_RC=$?"`, 600);
  const safeOk = sb.ok && /AEM_SAFETY_RC=0\b/.test(sb.stdout);
  await db.query(
    `INSERT INTO backup_jobs (server_id, kind, status, triggered_by, target_domain, finished_at, output)
     VALUES ($1, 'safety-backup', $2, $3, $4, now(), $5)`,
    [serverId, safeOk ? 'success' : 'failed', triggeredBy?.slice(0, 200) || null, dom, (sb.stdout || sb.error || '').slice(-4000)],
  ).catch(() => {});
  if (!safeOk) return { ok: false, error: `Safety backup failed — restore aborted (nothing was changed). ${(sb.stdout || sb.error || '').slice(-300)}` };

  // 2) RESTORE detached + logged. Resolve the dump file on the box by its timestamp ref.
  const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
  const logPath = `/var/log/aem-console-restore-${dom}-${stamp}.log`;
  const restore = RESTORE_CMD.replace(/\{domain\}/g, dom).replace(/\{dump\}/g, '"$DUMP"');
  const script = `DUMP=$(ls -1t /var/lib/psa/dumps/*${ref}* 2>/dev/null | head -1); if [ -z "$DUMP" ]; then echo AEM_NO_DUMP; exit 0; fi; nohup ${restore} >${logPath} 2>&1 & echo $!`;
  const r = await sshExec(server.fqdn, script, 30);
  if (!r.ok) return { ok: false, error: r.error || r.stderr || 'Failed to start restore' };
  if (/AEM_NO_DUMP/.test(r.stdout)) return { ok: false, error: `No dump file found on the server for backup ${ref}` };
  const pid = parseInt(r.stdout.trim(), 10) || null;
  const ins = await db.query<BackupJob>(
    `INSERT INTO backup_jobs (server_id, kind, status, pid, log_path, triggered_by, target_domain, source_dump)
     VALUES ($1, 'restore', 'running', $2, $3, $4, $5, $6) RETURNING *`,
    [serverId, pid, logPath, triggeredBy?.slice(0, 200) || null, dom, ref]);
  return { ok: true, job: ins.rows[0] };
}

// Recent backup jobs for a server, refreshing any that are still 'running' by checking the remote PID.
export async function listBackupJobs(serverId: number, limit = 15): Promise<BackupJob[]> {
  const r = await db.query<BackupJob>(
    'SELECT * FROM backup_jobs WHERE server_id = $1 ORDER BY started_at DESC LIMIT $2', [serverId, limit]);
  const jobs = r.rows;
  await Promise.all(jobs.filter((j) => j.status === 'running').map((j) => refreshBackupJob(j)));
  return jobs.every((j) => j.status !== 'running') ? jobs
    : (await db.query<BackupJob>('SELECT * FROM backup_jobs WHERE server_id = $1 ORDER BY started_at DESC LIMIT $2', [serverId, limit])).rows;
}

// Check a running job: if the remote PID is gone, tail the log and mark success/failed.
export async function refreshBackupJob(job: BackupJob): Promise<void> {
  if (job.status !== 'running' || !job.pid || !job.log_path) return;
  const server = await getServer(job.server_id);
  if (!server) return;
  const check = await sshExec(server.fqdn, `if kill -0 ${job.pid} 2>/dev/null; then echo alive; else echo dead; fi; echo '---'; tail -c 4000 ${job.log_path} 2>/dev/null`, 20);
  if (!check.ok) return; // couldn't reach the host this cycle — leave it running, try again later
  const [state, ...rest] = check.stdout.split('---');
  if (state.trim() !== 'dead') return; // still running
  const tail = rest.join('---').trim();
  // pleskbackup prints a clear failure marker on error; treat absence of "error"/"fail" as success.
  const failed = /\b(error|failed|failure|exception)\b/i.test(tail);
  await db.query(
    `UPDATE backup_jobs SET status = $1, finished_at = now(), output = $2 WHERE id = $3`,
    [failed ? 'failed' : 'success', tail.slice(0, 8000), job.id]);
}
