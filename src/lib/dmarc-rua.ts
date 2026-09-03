import { db } from '@/lib/db';
import { XMLParser } from 'fast-xml-parser';

export interface AggRecord {
  source_ip: string;
  count: number;
  disposition: string | null;
  dkim: string | null;
  spf: string | null;
  header_from: string | null;
}
export interface AggReport {
  org_name: string | null;
  report_id: string | null;
  email: string | null;
  domain: string | null;
  policy_p: string | null;
  policy_sp: string | null;
  policy_pct: number | null;
  date_begin: number | null;
  date_end: number | null;
  records: AggRecord[];
}

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: true });

function asStr(v: unknown): string | null { return v === null || v === undefined ? null : String(v); }
function asInt(v: unknown): number | null { const n = parseInt(String(v ?? ''), 10); return Number.isFinite(n) ? n : null; }

// Parse a DMARC aggregate (RUA) report XML into a structured object.
export function parseAggregateReport(xml: string): AggReport {
  const obj = parser.parse(xml) as Record<string, unknown>;
  const fb = (obj.feedback ?? {}) as Record<string, unknown>;
  const meta = (fb.report_metadata ?? {}) as Record<string, unknown>;
  const pol = (fb.policy_published ?? {}) as Record<string, unknown>;
  const range = (meta.date_range ?? {}) as Record<string, unknown>;
  let recs = fb.record as unknown;
  if (!Array.isArray(recs)) recs = recs ? [recs] : [];
  const records: AggRecord[] = (recs as Record<string, unknown>[]).map((r) => {
    const row = (r.row ?? {}) as Record<string, unknown>;
    const pe = (row.policy_evaluated ?? {}) as Record<string, unknown>;
    const ids = (r.identifiers ?? {}) as Record<string, unknown>;
    return {
      source_ip: asStr(row.source_ip) ?? '',
      count: asInt(row.count) ?? 0,
      disposition: asStr(pe.disposition),
      dkim: asStr(pe.dkim),
      spf: asStr(pe.spf),
      header_from: asStr(ids.header_from),
    };
  });
  return {
    org_name: asStr(meta.org_name),
    report_id: asStr(meta.report_id),
    email: asStr(meta.email),
    domain: asStr(pol.domain),
    policy_p: asStr(pol.p),
    policy_sp: asStr(pol.sp),
    policy_pct: asInt(pol.pct),
    date_begin: asInt(range.begin),
    date_end: asInt(range.end),
    records,
  };
}

// Persist a parsed report (idempotent on org_name + report_id). Returns whether it was new.
export async function storeAggregateReport(rep: AggReport): Promise<{ inserted: boolean; reportRowId: number | null; recordCount: number }> {
  const existing = await db.query<{ id: number }>('SELECT id FROM dmarc_reports WHERE org_name = $1 AND report_id = $2', [rep.org_name, rep.report_id]);
  if (existing.rows[0]) return { inserted: false, reportRowId: existing.rows[0].id, recordCount: 0 };
  const ins = await db.query<{ id: number }>(`
    INSERT INTO dmarc_reports (org_name, report_id, email, domain, policy_p, policy_sp, policy_pct, date_begin, date_end)
    VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8), to_timestamp($9))
    ON CONFLICT (org_name, report_id) DO NOTHING
    RETURNING id`,
    [rep.org_name, rep.report_id, rep.email, rep.domain, rep.policy_p, rep.policy_sp, rep.policy_pct, rep.date_begin, rep.date_end]);
  if (!ins.rows[0]) {
    const e2 = await db.query<{ id: number }>('SELECT id FROM dmarc_reports WHERE org_name = $1 AND report_id = $2', [rep.org_name, rep.report_id]);
    return { inserted: false, reportRowId: e2.rows[0]?.id ?? null, recordCount: 0 };
  }
  const rid = ins.rows[0].id;
  for (const rec of rep.records) {
    await db.query(
      'INSERT INTO dmarc_report_records (report_id, source_ip, message_count, disposition, dkim_eval, spf_eval, header_from) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [rid, rec.source_ip || null, rec.count, rec.disposition, rec.dkim, rec.spf, rec.header_from]);
  }
  return { inserted: true, reportRowId: rid, recordCount: rep.records.length };
}
