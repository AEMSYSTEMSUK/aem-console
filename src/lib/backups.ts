import { db } from '@/lib/db';
import { sshExec } from '@/lib/ssh';

// Backups & Restore — Phase 1. Read the live Plesk dump repository over SSH for a server's backup
// history, and trigger an on-demand full server backup (detached), tracked in backup_jobs. Restore
// is deliberately NOT here (Phase 2, with typed-confirmation guardrails).

// The remote command used to run an on-demand server backup. Overridable per environment so a Plesk
// build that wants different flags can be adjusted without a code change. Default writes into the
// standard Plesk repository (/var/lib/psa/dumps) so it shows up alongside the scheduled backups.
const BACKUP_CMD = process.env.AEM_PLESK_BACKUP_CMD || 'plesk bin pleskbackup server';

export interface ServerBackup { at: string | null; status: string; sizeMb: number | null }
export interface BackupJob {
  id: number; server_id: number; kind: string; status: string; pid: number | null;
  log_path: string | null; triggered_by: string | null; started_at: string; finished_at: string | null; output: string | null;
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
    out.push({ at: tsToIso(ts), status: status || 'unknown', sizeMb: bytes > 0 ? Math.round(bytes / (1024 * 1024)) : null });
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
