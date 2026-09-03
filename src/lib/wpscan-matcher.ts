import { db } from '@/lib/db';

interface WpScanVuln {
  id?: string;
  title?: string;
  vuln_type?: string;
  fixed_in?: string | null;
  cvss?: { score?: number; severity?: string };
  references?: { cve?: string[] };
  published_date?: string;
}

function compareVersions(a: string, b: string): number {
  const aps = a.split(/[.+-]/).map((p) => /^\d+$/.test(p) ? parseInt(p, 10) : p);
  const bps = b.split(/[.+-]/).map((p) => /^\d+$/.test(p) ? parseInt(p, 10) : p);
  const len = Math.max(aps.length, bps.length);
  for (let i = 0; i < len; i++) {
    const ap = aps[i] ?? 0;
    const bp = bps[i] ?? 0;
    if (typeof ap === 'number' && typeof bp === 'number') {
      if (ap !== bp) return ap - bp;
    } else {
      const c = String(ap).localeCompare(String(bp));
      if (c !== 0) return c;
    }
  }
  return 0;
}

export async function matchWpScanInstalled(): Promise<{ matches: number; cleaned: number }> {
  // Reset open wpscan matches (kept ack'd records intact)
  const cleanRes = await db.query(`DELETE FROM cve_matches WHERE target_type = 'plugin' AND acknowledged_at IS NULL AND cve_id LIKE 'WPSCAN-%'`);
  const cleaned = cleanRes.rowCount ?? 0;

  let matches = 0;

  // For each installed plugin with a known WPScan entry
  const rows = await db.query<{ site_id: number; slug: string; version: string | null; vulnerabilities: WpScanVuln[] | null; friendly_name: string | null }>(
    `SELECT p.site_id, p.slug, p.version, w.vulnerabilities, w.friendly_name
       FROM installed_plugins p
       JOIN wpscan_plugin_data w ON w.slug = p.slug
       WHERE (p.status = 'active' OR p.status IS NULL) AND w.not_found = false`
  );

  for (const r of rows.rows) {
    const vulns = r.vulnerabilities ?? [];
    for (const v of vulns) {
      // If fixed_in known and installed >= fixed_in, NOT vulnerable
      if (v.fixed_in && r.version) {
        try {
          if (compareVersions(r.version, v.fixed_in) >= 0) continue;
        } catch { /* version compare failed - treat as vulnerable */ }
      }
      // Use first CVE ref or fallback to WPScan ID
      const cveId = v.references?.cve?.[0] ?? `WPSCAN-${v.id ?? r.slug + '-' + (v.title?.slice(0, 30).replace(/\W/g, '-') ?? 'unknown')}`;
      const severity = v.cvss?.severity ?? (v.cvss?.score ? (v.cvss.score >= 9 ? 'CRITICAL' : v.cvss.score >= 7 ? 'HIGH' : v.cvss.score >= 4 ? 'MEDIUM' : 'LOW') : null);

      // Ensure cve_records has this entry (so the matcher's join works)
      await db.query(`
        INSERT INTO cve_records (cve_id, published, description, cvss_score, severity, keyword_match, raw, fetched_at)
        VALUES ($1, $2, $3, $4, $5, 'wpscan', $6, now())
        ON CONFLICT (cve_id) DO UPDATE SET
          severity = EXCLUDED.severity,
          cvss_score = EXCLUDED.cvss_score,
          description = EXCLUDED.description,
          fetched_at = now()
      `, [cveId, v.published_date ?? null, v.title ?? null, v.cvss?.score ?? null, severity, JSON.stringify(v)]);

      await db.query(`
        INSERT INTO cve_matches (site_id, cve_id, target_type, target_slug, installed_version, severity, detected_at)
        VALUES ($1, $2, 'plugin', $3, $4, $5, now())
        ON CONFLICT (site_id, cve_id, target_slug) DO NOTHING
      `, [r.site_id, cveId, r.slug, r.version, severity]);
      matches++;
    }
  }
  return { matches, cleaned };
}
