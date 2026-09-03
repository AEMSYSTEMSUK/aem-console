import { dnsTxtLookup } from '@/lib/dns';
export interface SpfAnalysis {
  has: boolean;
  record: string | null;
  includesAemRelay: boolean;
  qualifier: string | null;
}
export interface DkimAnalysis {
  hasDefault: boolean;
  defaultRecord: string | null;
  selector: string | null;
}
export interface DmarcAnalysis {
  has: boolean;
  record: string | null;
  policy: string | null;
  pct: number | null;
  rua: string | null;
}
export async function checkSpf(domain: string): Promise<SpfAnalysis> {
  const txts = await dnsTxtLookup(domain);
  const spf = txts.find((t) => t.toLowerCase().startsWith('v=spf1'));
  if (!spf) return { has: false, record: null, includesAemRelay: false, qualifier: null };
  const includesAemRelay = spf.includes('ip4:217.174.245.2') || spf.includes('spf.protection.outlook.com');
  const qmatch = spf.match(/\s([~?\-+])all\s*$/);
  const qualifier = qmatch ? qmatch[1] : null;
  return { has: true, record: spf, includesAemRelay, qualifier };
}
// DKIM is published under provider-specific selectors, not a single 'default':
// M365 -> selector1/selector2 (CNAMEs to *.dkim.mail.microsoft / onmicrosoft.com),
// Google -> 'google', relay/Plesk -> 'default'. Probe a candidate set and report which
// selector matched. (Before 30 Jun the check only looked at 'default' -> mass false amber.)
export const DKIM_SELECTORS = ['default', 'selector1', 'selector2', 'google', 'k1', 'k2', 's1', 's2', 'mail', 'smtp', 'dkim', 'mxvault'];
export async function checkDkim(domain: string): Promise<DkimAnalysis> {
  const hits = await Promise.all(DKIM_SELECTORS.map(async (sel) => {
    try {
      const txts = await dnsTxtLookup(`${sel}._domainkey.${domain}`);
      const rec = txts.find((t) => t.toLowerCase().includes('v=dkim1') || t.toLowerCase().includes('p='));
      return rec ? { sel, rec } : null;
    } catch { return null; }
  }));
  const hit = hits.find((h) => h !== null) as { sel: string; rec: string } | undefined;
  return { hasDefault: !!hit, defaultRecord: hit ? hit.rec : null, selector: hit ? hit.sel : null };
}
export async function checkDmarc(domain: string): Promise<DmarcAnalysis> {
  const txts = await dnsTxtLookup(`_dmarc.${domain}`);
  const dmarc = txts.find((t) => t.toLowerCase().startsWith('v=dmarc1'));
  if (!dmarc) return { has: false, record: null, policy: null, pct: null, rua: null };
  const pMatch = dmarc.match(/p=(none|quarantine|reject)/i);
  const pctMatch = dmarc.match(/pct=(\d+)/i);
  const ruaMatch = dmarc.match(/rua=([^;\s]+)/i);
  return {
    has: true,
    record: dmarc,
    policy: pMatch ? pMatch[1].toLowerCase() : null,
    pct: pctMatch ? parseInt(pctMatch[1], 10) : 100,
    rua: ruaMatch ? ruaMatch[1] : null,
  };
}
export function deriveSeverity(spf: SpfAnalysis, dkim: DkimAnalysis, dmarc: DmarcAnalysis): { severity: string; notes: string[] } {
  const notes: string[] = [];
  let severity = 'green';
  if (!spf.has) { notes.push('no SPF record'); severity = 'red'; }
  else if (!spf.includesAemRelay) { notes.push('SPF missing AEM relay'); severity = severity === 'red' ? 'red' : 'amber'; }
  if (!dkim.hasDefault) { notes.push('no DKIM record (no common selector)'); severity = severity === 'red' ? 'red' : 'amber'; }
  if (!dmarc.has) { notes.push('no DMARC record'); severity = 'red'; }
  else if (dmarc.policy === 'none') { notes.push('DMARC p=none (monitor only)'); if (severity !== 'red') severity = 'amber'; }
  else if (dmarc.policy === 'quarantine' && (dmarc.pct ?? 100) < 100) { notes.push(`DMARC quarantine partial pct=${dmarc.pct}`); if (severity === 'green') severity = 'amber'; }
  return { severity, notes };
}
