import { listLatestDmarcHealth } from '@/lib/dmarc-probe';
import { listDmarcReportSummary } from '@/lib/dmarc-reports';
import { db } from '@/lib/db';
export interface DomainSecurity {
  domain: string; score: number; grade: string;
  has_spf: boolean | null; has_dkim: boolean | null; has_dmarc: boolean | null; dmarc_policy: string | null;
  mta_sts: boolean; bimi: boolean;
  messages: number; dmarc_pass: number; spf_pass: number; dkim_pass: number; captured_at: string | null;
}
const grade = (s: number) => (s >= 92 ? 'A+' : s >= 87 ? 'A' : s >= 82 ? 'B+' : s >= 77 ? 'B' : s >= 68 ? 'C' : s >= 55 ? 'D' : 'F');
export async function listDomainSecurity(): Promise<DomainSecurity[]> {
  const [posture, reports, extras] = await Promise.all([
    listLatestDmarcHealth(),
    listDmarcReportSummary(),
    db.query<{ domain: string; mta_sts: boolean; has_bimi: boolean }>('SELECT domain, mta_sts, has_bimi FROM domain_extras'),
  ]);
  const rep = new Map(reports.map((r) => [r.domain, r]));
  const ex = new Map(extras.rows.map((e) => [e.domain, e]));
  return posture.map((p) => {
    const pol = (p.dmarc_policy || '').toLowerCase();
    const e = ex.get(p.domain);
    const mta = !!e?.mta_sts; const bimi = !!e?.has_bimi;
    let s = 0;
    s += p.has_spf ? 24 : 0;
    s += p.has_dkim_default ? 24 : 0;
    s += p.has_dmarc ? (pol === 'reject' ? 40 : pol === 'quarantine' ? 32 : 10) : 0;
    s += mta ? 6 : 0;
    s += bimi ? 4 : 0;
    s = Math.min(s, 100);
    const r = rep.get(p.domain);
    return {
      domain: p.domain, score: s, grade: grade(s),
      has_spf: p.has_spf, has_dkim: p.has_dkim_default, has_dmarc: p.has_dmarc, dmarc_policy: p.dmarc_policy,
      mta_sts: mta, bimi,
      messages: r?.messages ?? 0, dmarc_pass: r?.dmarc_pass ?? 0, spf_pass: r?.spf_pass ?? 0, dkim_pass: r?.dkim_pass ?? 0,
      captured_at: p.captured_at,
    };
  }).sort((a, b) => a.score - b.score || a.domain.localeCompare(b.domain));
}
