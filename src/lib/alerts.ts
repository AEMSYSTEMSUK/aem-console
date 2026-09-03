import { db } from '@/lib/db';
import { spawn } from 'child_process';

export interface AlertRow {
  id: number;
  source: string;
  severity: string;
  subject: string | null;
  from_address: string | null;
  site_domain: string | null;
  server_id: number | null;
  server_name: string | null;
  received_at: string;
  acknowledged_at: string | null;
}

export async function listAlerts(opts: { limit?: number; source?: string; severity?: string; ack?: 'all' | 'open' | 'acked' } = {}): Promise<AlertRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (opts.source) {
    params.push(opts.source);
    conditions.push(`a.source = $${params.length}`);
  }
  if (opts.severity) {
    params.push(opts.severity);
    conditions.push(`a.severity = $${params.length}`);
  }
  if (opts.ack === 'open') conditions.push('a.acknowledged_at IS NULL');
  if (opts.ack === 'acked') conditions.push('a.acknowledged_at IS NOT NULL');
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  params.push(opts.limit ?? 200);
  const limitParam = `$${params.length}`;

  const r = await db.query<AlertRow>(`
    SELECT a.id, a.source, a.severity, a.subject, a.from_address, a.site_domain,
           a.server_id, sv.name AS server_name,
           a.received_at::text, a.acknowledged_at::text
    FROM alerts a
    LEFT JOIN servers sv ON sv.id = a.server_id
    ${where}
    ORDER BY a.received_at DESC
    LIMIT ${limitParam}
  `, params);
  return r.rows;
}

export async function countOpenAlerts(): Promise<{ critical: number; high: number; medium: number; low: number; info: number }> {
  const r = await db.query<{ severity: string; count: string }>(`
    SELECT severity, count(*)::text AS count
    FROM alerts
    WHERE acknowledged_at IS NULL
    GROUP BY severity
  `);
  const out = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const row of r.rows) {
    if (row.severity in out) (out as Record<string, number>)[row.severity] = Number(row.count);
  }
  return out;
}

export async function acknowledgeAlert(id: number, userId: number): Promise<void> {
  await db.query('UPDATE alerts SET acknowledged_at = now(), acknowledged_by_user_id = $1 WHERE id = $2 AND acknowledged_at IS NULL', [userId, id]);
}

function sendAlertMail(opts: { to: string; from: string; subject: string; body: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('mail', ['-r', opts.from, '-s', opts.subject, opts.to]);
    child.stdin.write(opts.body);
    child.stdin.end();
    let err = '';
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`mail exit ${code}: ${err}`))));
    child.on('error', reject);
  });
}

export async function forwardCriticalAlerts(): Promise<{ sent: number; ids: number[] }> {
  const r = await db.query<{ id: number; source: string; subject: string | null; server_name: string | null; site_domain: string | null; received_at: string }>(`
    SELECT a.id, a.source, a.subject, sv.name AS server_name, a.site_domain, a.received_at::text AS received_at
    FROM alerts a
    LEFT JOIN servers sv ON sv.id = a.server_id
    WHERE a.severity = 'critical' AND a.acknowledged_at IS NULL AND a.forwarded_at IS NULL
    ORDER BY a.received_at ASC
    LIMIT 50
  `);
  if (r.rows.length === 0) return { sent: 0, ids: [] };
  const to = process.env.ALERT_NOTIFY_TO || 'support@aemsystems.co.uk';
  const from = process.env.ALERT_NOTIFY_FROM || 'noreply@aemtech.co.uk';
  const lines = r.rows.map((a) => `- [${a.source}] ${a.subject ?? '(no subject)'}\n    server: ${a.server_name ?? '—'}   site: ${a.site_domain ?? '—'}   at: ${a.received_at}`);
  const body = `${r.rows.length} unacknowledged CRITICAL alert(s) on the AEM fleet:\n\n${lines.join('\n')}\n\nReview + acknowledge: https://portal.aemsystems.co.uk/alerts\n`;
  const subject = `[AEM] ${r.rows.length} critical alert(s)`;
  await sendAlertMail({ to, from, subject, body });
  const ids = r.rows.map((a) => a.id);
  await db.query('UPDATE alerts SET forwarded_at = now() WHERE id = ANY($1::int[])', [ids]);
  return { sent: r.rows.length, ids };
}
