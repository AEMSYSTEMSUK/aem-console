import { db } from '@/lib/db';
import { sshExec } from '@/lib/ssh';

export interface BackupHealthSnapshot {
  server_id: number;
  last_backup_at: string | null;
  last_backup_status: string | null;
  last_backup_size_mb: number | null;
  hetzner_used_pct: number | null;
  hetzner_used_gb: number | null;
  hetzner_total_gb: number | null;
  dumps_mounted: boolean | null;
  notes: string | null;
}

export async function probeServerBackup(serverId: number): Promise<BackupHealthSnapshot> {
  const sRes = await db.query<{ fqdn: string; role: string }>(
    'SELECT fqdn, role FROM servers WHERE id = \$1', [serverId]
  );
  const server = sRes.rows[0];
  const empty: BackupHealthSnapshot = {
    server_id: serverId,
    last_backup_at: null, last_backup_status: null, last_backup_size_mb: null,
    hetzner_used_pct: null, hetzner_used_gb: null, hetzner_total_gb: null,
    dumps_mounted: null,
    notes: null,
  };
  if (!server || !server.role.startsWith('plesk-')) return empty;

  // Latest plesk backup - parse from filesystem at /var/lib/psa/dumps/.discovered/
  const backupQuery = `LATEST=\$(ls -1t /var/lib/psa/dumps/.discovered/backup_info_*/dumpresult_* 2>/dev/null | head -1); if [ -n "\$LATEST" ]; then STATUS=\$(basename "\$LATEST" | sed 's/^dumpresult_//'); DIR=\$(dirname "\$LATEST"); BASE=\$(basename "\$DIR"); TS=\$(echo "\$BASE" | grep -oE '[0-9]{10}' | tail -1); SIZE=\$(du -scb /var/lib/psa/dumps/*\${TS}* 2>/dev/null | tail -1 | awk '{print \$1}'); YEAR=20\${TS:0:2}; MONTH=\${TS:2:2}; DAY=\${TS:4:2}; HOUR=\${TS:6:2}; MIN=\${TS:8:2}; echo "\$YEAR-\$MONTH-\$DAY \$HOUR:\$MIN|\$STATUS|\$SIZE"; else echo "none||"; fi`;
  const br = await sshExec(server.fqdn, backupQuery, 15);
  if (br.ok && br.stdout.trim() && !br.stdout.startsWith('none')) {
    const cols = br.stdout.trim().split('|');
    empty.last_backup_at = cols[0] || null;
    empty.last_backup_status = cols[1] || null;
    const sizeBytes = parseInt(cols[2] || '0', 10);
    empty.last_backup_size_mb = sizeBytes > 0 ? Math.round(sizeBytes / (1024 * 1024)) : null;
  } else if (!br.ok) {
    empty.notes = `backup probe failed: ${br.error?.slice(0, 100) ?? 'unknown'}`;
  } else {
    empty.notes = 'no plesk backups found (may use out-of-band backup)';
  }

  // Hetzner mount usage
  const dfQuery = `df -BG /var/lib/psa/dumps 2>/dev/null | tail -1 | awk '{print $2"|"$3"|"$5}'`;
  const dr = await sshExec(server.fqdn, dfQuery, 10);
  if (dr.ok && dr.stdout.trim()) {
    const parts = dr.stdout.trim().split('|');
    if (parts.length === 3) {
      empty.hetzner_total_gb = parseInt(parts[0].replace('G', ''), 10);
      empty.hetzner_used_gb = parseInt(parts[1].replace('G', ''), 10);
      empty.hetzner_used_pct = parseInt(parts[2].replace('%', ''), 10);
    }
  }

  const mpr = await sshExec(server.fqdn, 'mountpoint -q /var/lib/psa/dumps && echo 1 || echo 0', 10);
  if (mpr.ok) empty.dumps_mounted = mpr.stdout.trim() === '1';
  return empty;
}

const BACKUP_ALERT_SOURCE = 'backup-health';
async function hasOpenBackupAlert(serverId: number): Promise<boolean> {
  const r = await db.query('SELECT 1 FROM alerts WHERE source = $1 AND server_id = $2 AND acknowledged_at IS NULL LIMIT 1', [BACKUP_ALERT_SOURCE, serverId]);
  return (r.rowCount ?? 0) > 0;
}
async function raiseBackupAlert(serverId: number, severity: string, subject: string): Promise<void> {
  if (await hasOpenBackupAlert(serverId)) return; // dedup: one open backup-health alert per server
  await db.query('INSERT INTO alerts (source, severity, subject, server_id, received_at) VALUES ($1, $2, $3, $4, now())', [BACKUP_ALERT_SOURCE, severity, subject.slice(0, 500), serverId]);
}
export async function evaluateBackupAlerts(snap: BackupHealthSnapshot): Promise<void> {
  if (snap.dumps_mounted === false) { await raiseBackupAlert(snap.server_id, 'critical', 'Backup bind-mount DOWN: /var/lib/psa/dumps not mounted - Plesk backups would write to local disk and fail (db1 silent-failure mode)'); return; }
  if (snap.last_backup_status && snap.last_backup_status.toLowerCase().includes('fail')) { await raiseBackupAlert(snap.server_id, 'critical', 'Last backup FAILED (status: ' + snap.last_backup_status + ')'); return; }
  if (!snap.last_backup_at) { await raiseBackupAlert(snap.server_id, 'high', 'No Plesk backup found on backup-managed server'); return; }
  const ageH = (Date.now() - new Date(snap.last_backup_at).getTime()) / 3600000;
  const maxRow = await db.query<{ m: number }>('SELECT COALESCE(backup_max_age_hours, 36) AS m FROM servers WHERE id = $1', [snap.server_id]);
  const maxAge = maxRow.rows[0]?.m ?? 36;
  if (ageH > maxAge) { await raiseBackupAlert(snap.server_id, 'high', 'Last good backup is ' + Math.round(ageH) + 'h old (> ' + maxAge + 'h expected) - a scheduled backup was missed'); return; }
  // Healthy -> auto-resolve (acknowledge) any open backup-health alert for this server.
  await db.query('UPDATE alerts SET acknowledged_at = now() WHERE source = $1 AND server_id = $2 AND acknowledged_at IS NULL', [BACKUP_ALERT_SOURCE, snap.server_id]);
}

export async function recordBackupHealth(snapshot: BackupHealthSnapshot): Promise<void> {
  await db.query(`
    INSERT INTO server_health
      (server_id, captured_at, last_backup_at, last_backup_status, last_backup_size_mb, disk_usage_pct, disk_total_gb, raw)
    VALUES (\$1, now(), $2, $3, $4, $5, $6, $7)
  `, [
    snapshot.server_id,
    snapshot.last_backup_at,
    snapshot.last_backup_status,
    snapshot.last_backup_size_mb,
    snapshot.hetzner_used_pct,
    snapshot.hetzner_total_gb,
    JSON.stringify(snapshot),
  ]);
}

export async function probeAllServers(): Promise<BackupHealthSnapshot[]> {
  const r = await db.query<{ id: number }>(
    `SELECT id FROM servers WHERE enabled = true AND role LIKE 'plesk-%'`
  );
  const out: BackupHealthSnapshot[] = [];
  for (const row of r.rows) {
    const snap = await probeServerBackup(row.id);
    await recordBackupHealth(snap);
    await evaluateBackupAlerts(snap);
    out.push(snap);
  }
  return out;
}

export interface BackupHealthRow {
  server_id: number;
  server_name: string;
  fqdn: string;
  role: string;
  last_backup_at: string | null;
  last_backup_status: string | null;
  last_backup_size_mb: number | null;
  disk_usage_pct: number | null;
  disk_total_gb: number | null;
  dumps_mounted: boolean | null;
  captured_at: string | null;
}

export async function listLatestBackupHealth(): Promise<BackupHealthRow[]> {
  const r = await db.query<BackupHealthRow>(`
    SELECT
      s.id AS server_id, s.name AS server_name, s.fqdn, s.role,
      sh.last_backup_at::text,
      sh.last_backup_status,
      sh.last_backup_size_mb,
      sh.disk_usage_pct,
      sh.disk_total_gb,
      (sh.raw->>'dumps_mounted')::boolean AS dumps_mounted,
      sh.captured_at::text
    FROM servers s
    LEFT JOIN LATERAL (
      SELECT * FROM server_health
        WHERE server_id = s.id AND last_backup_at IS NOT NULL
        ORDER BY captured_at DESC LIMIT 1
    ) sh ON TRUE
    WHERE s.enabled = true AND s.role LIKE 'plesk-%'
    ORDER BY s.role, s.name
  `);
  return r.rows;
}
