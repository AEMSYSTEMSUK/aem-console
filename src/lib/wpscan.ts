import { db } from '@/lib/db';
import { decrypt } from '@/lib/crypto';

interface WpScanVuln {
  id?: string;
  title?: string;
  vuln_type?: string;
  fixed_in?: string | null;
  cvss?: { score?: number; severity?: string };
  references?: { cve?: string[]; url?: string[] };
  published_date?: string;
}

interface WpScanPluginData {
  friendly_name?: string;
  latest_version?: string;
  popular?: boolean;
  vulnerabilities?: WpScanVuln[];
}

async function getApiKey(): Promise<string | null> {
  const r = await db.query<{ encrypted_token: string }>(
    `SELECT encrypted_token FROM integration_tokens WHERE type = 'wpscan' ORDER BY id DESC LIMIT 1`
  );
  if (r.rows.length === 0) return null;
  try { return decrypt(r.rows[0].encrypted_token); } catch { return null; }
}

export async function fetchWpScanPlugin(slug: string): Promise<{ ok: boolean; data?: WpScanPluginData; notFound?: boolean; error?: string }> {
  const apiKey = await getApiKey();
  if (!apiKey) return { ok: false, error: 'no WPScan API key configured' };
  try {
    const res = await fetch(`https://wpscan.com/api/v3/plugins/${encodeURIComponent(slug)}`, {
      signal: AbortSignal.timeout(30000),
      headers: { 'Authorization': `Token token=${apiKey}` },
    });
    if (res.status === 404) return { ok: true, notFound: true };
    if (!res.ok) return { ok: false, error: `WPScan ${res.status}` };
    const body = await res.json() as Record<string, WpScanPluginData>;
    const data = body[slug];
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function refreshSlugs(slugs: string[], maxFetches: number = 75): Promise<{ slug: string; status: string; vuln_count?: number }[]> {
  // Only refresh entries that don't exist or are >7 days stale, or were not_found older than 30 days
  const r = await db.query<{ slug: string; fetched_at: string | null; not_found: boolean | null }>(
    `SELECT slug, fetched_at::text, not_found FROM wpscan_plugin_data WHERE slug = ANY($1::text[])`,
    [slugs]
  );
  const existing = new Map(r.rows.map((x) => [x.slug, x]));
  const needsRefresh: string[] = [];
  const now = Date.now();
  for (const s of slugs) {
    const e = existing.get(s);
    if (!e) { needsRefresh.push(s); continue; }
    const age = (now - new Date(e.fetched_at!).getTime()) / (1000 * 60 * 60 * 24);
    if (e.not_found && age > 30) needsRefresh.push(s);
    else if (!e.not_found && age > 7) needsRefresh.push(s);
  }

  const toFetch = needsRefresh.slice(0, maxFetches);
  const results = [];
  for (const slug of toFetch) {
    const r = await fetchWpScanPlugin(slug);
    if (!r.ok) {
      results.push({ slug, status: `error: ${r.error}` });
      // If rate-limited, stop
      if (r.error?.includes('429') || r.error?.includes('401')) break;
      continue;
    }
    if (r.notFound) {
      await db.query(`
        INSERT INTO wpscan_plugin_data (slug, not_found, raw, fetched_at)
        VALUES ($1, true, '{}'::jsonb, now())
        ON CONFLICT (slug) DO UPDATE SET not_found = true, fetched_at = now()
      `, [slug]);
      results.push({ slug, status: 'not-found' });
      continue;
    }
    const data = r.data!;
    await db.query(`
      INSERT INTO wpscan_plugin_data (slug, friendly_name, latest_version, popular, vulnerabilities, raw, not_found, fetched_at)
      VALUES ($1, $2, $3, $4, $5, $6, false, now())
      ON CONFLICT (slug) DO UPDATE SET
        friendly_name = EXCLUDED.friendly_name,
        latest_version = EXCLUDED.latest_version,
        popular = EXCLUDED.popular,
        vulnerabilities = EXCLUDED.vulnerabilities,
        raw = EXCLUDED.raw,
        not_found = false,
        fetched_at = now()
    `, [slug, data.friendly_name ?? null, data.latest_version ?? null, data.popular ?? null, JSON.stringify(data.vulnerabilities ?? []), JSON.stringify(data)]);
    results.push({ slug, status: 'updated', vuln_count: data.vulnerabilities?.length ?? 0 });
    await new Promise((rs) => setTimeout(rs, 1200));
  }
  return results;
}

export async function uniqueInstalledSlugs(): Promise<string[]> {
  const r = await db.query<{ slug: string }>(
    `SELECT DISTINCT slug FROM installed_plugins WHERE status = 'active' OR status IS NULL ORDER BY slug`
  );
  return r.rows.map((x) => x.slug);
}
