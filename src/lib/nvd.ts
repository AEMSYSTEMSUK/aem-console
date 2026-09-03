import { db } from '@/lib/db';

interface NvdCvssMetric { cvssData?: { baseScore?: number }; baseSeverity?: string }
interface NvdMetrics { cvssMetricV31?: NvdCvssMetric[]; cvssMetricV30?: NvdCvssMetric[]; cvssMetricV2?: NvdCvssMetric[]; }
interface NvdCpeMatch {
  vulnerable?: boolean;
  criteria?: string;
  versionStartIncluding?: string;
  versionStartExcluding?: string;
  versionEndIncluding?: string;
  versionEndExcluding?: string;
}
interface NvdNode { cpeMatch?: NvdCpeMatch[]; }
interface NvdConfig { nodes?: NvdNode[]; }
interface NvdCve {
  id: string;
  published?: string;
  lastModified?: string;
  descriptions?: Array<{ lang: string; value: string }>;
  metrics?: NvdMetrics;
  configurations?: NvdConfig[];
}
interface NvdVulnerability { cve: NvdCve }
interface NvdResponse { vulnerabilities?: NvdVulnerability[]; totalResults?: number; resultsPerPage?: number; startIndex?: number; }

function extractCvss(cve: NvdCve): { score: number | null; severity: string | null } {
  const m31 = cve.metrics?.cvssMetricV31?.[0];
  const m30 = cve.metrics?.cvssMetricV30?.[0];
  const m2 = cve.metrics?.cvssMetricV2?.[0];
  const m = m31 ?? m30 ?? m2;
  if (!m) return { score: null, severity: null };
  return { score: m.cvssData?.baseScore ?? null, severity: m.baseSeverity ?? null };
}

function extractCpeProducts(cve: NvdCve): { products: string[]; versions: Record<string, NvdCpeMatch[]> } {
  const products = new Set<string>();
  const versions: Record<string, NvdCpeMatch[]> = {};
  for (const cfg of cve.configurations ?? []) {
    for (const node of cfg.nodes ?? []) {
      for (const m of node.cpeMatch ?? []) {
        if (!m.vulnerable || !m.criteria) continue;
        // cpe:2.3:a:vendor:product:version:...
        const parts = m.criteria.split(':');
        if (parts.length < 5) continue;
        const product = parts[4]?.toLowerCase();
        if (!product || product === '*') continue;
        products.add(product);
        if (!versions[product]) versions[product] = [];
        versions[product].push(m);
      }
    }
  }
  return { products: Array.from(products), versions };
}

export async function fetchWordPressCves(keyword: string, max: number = 2000): Promise<number> {
  let inserted = 0;
  const pages = 5;
  for (let i = 0; i < pages; i++) {
    const url = `https://services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch=${encodeURIComponent(keyword)}&resultsPerPage=200&startIndex=${i * 200}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (!res.ok) { if (i > 0) break; continue; }
      const data = await res.json() as NvdResponse;
      if (!data.vulnerabilities || data.vulnerabilities.length === 0) break;
    for (const v of data.vulnerabilities ?? []) {
      const cve = v.cve;
      const desc = cve.descriptions?.find((d) => d.lang === 'en')?.value ?? '';
      const { score, severity } = extractCvss(cve);
      const { products, versions } = extractCpeProducts(cve);
      const r = await db.query<{ id: number }>(`
        INSERT INTO cve_records (cve_id, published, last_modified, description, cvss_score, severity, keyword_match, raw, cpe_products, affected_versions, fetched_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
        ON CONFLICT (cve_id) DO UPDATE SET
          last_modified = EXCLUDED.last_modified,
          description = EXCLUDED.description,
          cvss_score = EXCLUDED.cvss_score,
          severity = EXCLUDED.severity,
          cpe_products = EXCLUDED.cpe_products,
          affected_versions = EXCLUDED.affected_versions,
          fetched_at = now()
        RETURNING id
      `, [
        cve.id,
        cve.published ?? null,
        cve.lastModified ?? null,
        desc.slice(0, 4000),
        score,
        severity ?? null,
        keyword,
        JSON.stringify(cve),
        products,
        JSON.stringify(versions),
      ]);
      if (r.rows.length > 0) inserted++;
    }
    } catch {
      continue;
    }
    await new Promise((r) => setTimeout(r, 6500));
  }
  return inserted;
}

export async function refreshCveCache(): Promise<{ keyword: string; inserted: number }[]> {
  const keywords = ['wordpress plugin', 'wordpress theme', 'wordpress core'];
  const results = [];
  for (const kw of keywords) {
    const n = await fetchWordPressCves(kw, 2000);
    results.push({ keyword: kw, inserted: n });
    await new Promise((r) => setTimeout(r, 6500));
  }
  return results;
}
