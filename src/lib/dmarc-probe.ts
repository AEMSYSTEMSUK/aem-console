import { db } from '@/lib/db';
import { checkSpf, checkDkim, checkDmarc, deriveSeverity } from '@/lib/dmarc';
export interface ProbeResult {
  domain: string;
  site_id: number | null;
  severity: string;
  notes: string;
}
const DMARC_ALERT_SOURCE = 'dmarc-health';
async function hasOpenDmarcAlert(domain: string): Promise<boolean> {
  const r = await db.query('SELECT 1 FROM alerts WHERE source = $1 AND site_domain = $2 AND acknowledged_at IS NULL LIMIT 1', [DMARC_ALERT_SOURCE, domain]);
  return (r.rowCount ?? 0) > 0;
}
// Alert only on a REGRESSION to red (posture was better, now no SPF / no DMARC) — not on the
// standing red backlog (those are visible on /dmarc). De-dup one open alert per domain;
// auto-resolve when the domain recovers to non-red. Mirrors evaluateBackupAlerts.
async function evaluateDmarcAlerts(domain: string, severity: string, prevSeverity: string | null, notes: string): Promise<void> {
  if (severity === 'red' && prevSeverity && prevSeverity !== 'red') {
    if (!(await hasOpenDmarcAlert(domain))) {
      await db.query('INSERT INTO alerts (source, severity, subject, site_domain, received_at) VALUES ($1, $2, $3, $4, now())',
        [DMARC_ALERT_SOURCE, 'high', ('Mail-auth posture dropped to RED for ' + domain + ' (' + notes + ')').slice(0, 500), domain]);
    }
  } else if (severity !== 'red') {
    await db.query('UPDATE alerts SET acknowledged_at = now() WHERE source = $1 AND site_domain = $2 AND acknowledged_at IS NULL', [DMARC_ALERT_SOURCE, domain]);
  }
}
export async function probeAllDomains(): Promise<ProbeResult[]> {
  const r = await db.query<{ id: number; domain: string }>(`
    SELECT id, domain FROM sites
    WHERE domain NOT LIKE '%.plesk.page'
      AND domain NOT LIKE '%.aemstaging.co.uk'
      AND domain NOT LIKE '%-api.%'
      AND split_part(domain, '.', 1) NOT IN ('api','app','admin','beta','mockup','staging','dev','test','dist','cdn','autodiscover','autoconfig','webmail')
      AND domain NOT IN ('aemstaging.co.uk','aemfruitydatabases.co.uk')
    UNION SELECT NULL::int AS id, domain FROM managed_domains
    ORDER BY domain`);
  const out: ProbeResult[] = [];
  for (const row of r.rows) {
    const prev = await db.query<{ severity: string }>('SELECT severity FROM dmarc_health WHERE domain = $1 ORDER BY captured_at DESC LIMIT 1', [row.domain]);
    const prevSeverity = prev.rows[0] ? prev.rows[0].severity : null;
    const [spf, dkim, dmarc] = await Promise.all([
      checkSpf(row.domain),
      checkDkim(row.domain),
      checkDmarc(row.domain),
    ]);
    const { severity, notes } = deriveSeverity(spf, dkim, dmarc);
    await db.query(`
      INSERT INTO dmarc_health (site_id, domain, has_spf, spf_record, spf_includes_aem_relay, spf_qualifier,
                                has_dkim_default, dkim_default_record, has_dmarc, dmarc_record, dmarc_policy, dmarc_pct,
                                severity, notes, raw)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    `, [
      row.id, row.domain,
      spf.has, spf.record, spf.includesAemRelay, spf.qualifier,
      dkim.hasDefault, dkim.defaultRecord,
      dmarc.has, dmarc.record, dmarc.policy, dmarc.pct,
      severity, notes.join('; '),
      JSON.stringify({ spf, dkim, dmarc }),
    ]);
    await evaluateDmarcAlerts(row.domain, severity, prevSeverity, notes.join('; '));
    out.push({ domain: row.domain, site_id: row.id, severity, notes: notes.join('; ') });
  }
  return out;
}
export interface LatestRow {
  site_id: number | null;
  domain: string;
  severity: string | null;
  notes: string | null;
  has_spf: boolean | null;
  spf_includes_aem_relay: boolean | null;
  has_dkim_default: boolean | null;
  has_dmarc: boolean | null;
  dmarc_policy: string | null;
  captured_at: string | null;
}
export async function listLatestDmarcHealth(): Promise<LatestRow[]> {
  const r = await db.query<LatestRow>(`
    SELECT DISTINCT ON (domain)
      site_id, domain, severity, notes,
      has_spf, spf_includes_aem_relay, has_dkim_default, has_dmarc, dmarc_policy,
      captured_at::text
    FROM dmarc_health
    ORDER BY domain, captured_at DESC
  `);
  return r.rows;
}
