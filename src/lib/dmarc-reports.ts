import { db } from '@/lib/db';
export interface DmarcReportSummary {
  domain: string; reports: number; messages: number;
  spf_pass: number; dkim_pass: number; dmarc_pass: number;
  policy: string | null; latest: string | null;
}
export async function listDmarcReportSummary(): Promise<DmarcReportSummary[]> {
  const r = await db.query<DmarcReportSummary>(`
    SELECT r.domain,
      COUNT(DISTINCT r.id)::int AS reports,
      COALESCE(SUM(rec.message_count),0)::int AS messages,
      COALESCE(SUM(rec.message_count) FILTER (WHERE rec.spf_eval='pass'),0)::int AS spf_pass,
      COALESCE(SUM(rec.message_count) FILTER (WHERE rec.dkim_eval='pass'),0)::int AS dkim_pass,
      COALESCE(SUM(rec.message_count) FILTER (WHERE rec.spf_eval='pass' OR rec.dkim_eval='pass'),0)::int AS dmarc_pass,
      (ARRAY_AGG(r.policy_p ORDER BY r.date_end DESC) FILTER (WHERE r.policy_p IS NOT NULL))[1] AS policy,
      MAX(r.date_end)::text AS latest
    FROM dmarc_reports r LEFT JOIN dmarc_report_records rec ON rec.report_id = r.id
    GROUP BY r.domain ORDER BY r.domain
  `);
  return r.rows;
}
