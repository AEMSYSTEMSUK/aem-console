import { db } from '@/lib/db';
import { CustomerSitesGrid } from './grid';
import { DiscoverSitesButton } from './discover-button';

export const dynamic = 'force-dynamic';

type Row = {
  card_id: string;
  source_id: number;
  source: 'live' | 'staging';
  domain: string;
  server_label: string | null;
  parent_company: string | null;
  customer_name: string | null;
  has_sso_plugin: boolean;
  wp_admin_user_id: number | null;
  preview_url: string;
  is_eol: boolean;
};

export default async function CustomerSitesPage() {
  const sql = `
    WITH live1_domains AS (
      SELECT domain FROM sites WHERE host_server_id = 1 AND is_wordpress
    ),
    live_rows AS (
      SELECT
        ('s' || s.id) AS card_id,
        s.id AS source_id,
        'live'::text AS source,
        s.domain,
        sv.name AS server_label,
        s.parent_company, s.customer_name,
        COALESCE(s.has_sso_plugin, false) AS has_sso_plugin,
        s.wp_admin_user_id,
        s.domain AS preview_url,
        (s.host_server_id = 2 AND s.domain != 'aemstaging.co.uk'
        AND s.domain NOT LIKE '%.aemstaging.co.uk') AS is_eol
      FROM sites s
      JOIN servers sv ON sv.id = s.host_server_id
      WHERE s.host_server_id IN (1,2,5,6,7,9)
        AND (s.is_wordpress OR s.domain IN ('spectaculareyewear.co.uk'))
        AND s.domain NOT LIKE '%.plesk.page'
        AND s.domain NOT LIKE '%.aemstaging.co.uk'
        AND NOT (s.host_server_id = 2 AND s.domain IN (SELECT domain FROM live1_domains))
        AND s.last_seen_at > now() - interval '24 hours'
    ),
    staging_rows AS (
      SELECT
        ('w' || w.id) AS card_id,
        w.id AS source_id,
        'staging'::text AS source,
        w.real_domain AS domain,
        COALESCE(w.target_live_server, 'staging1') || ' · ' || COALESCE(
          (regexp_match(w.staging_url_override, 'https?://([^/]+)'))[1],
          w.staging_slug || '.aemstaging.co.uk'
        ) AS server_label,
        w.parent_company, w.customer_name,
        true AS has_sso_plugin,
        w.wp_admin_user_id,
        COALESCE(
          (regexp_match(w.staging_url_override, 'https?://([^/]+)'))[1],
          w.staging_slug || '.aemstaging.co.uk'
        ) AS preview_url,
        false AS is_eol
      FROM onboarding_wizards w
      WHERE w.customer_name IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM live_rows lr WHERE lr.domain = w.real_domain
        )
    )
    SELECT * FROM (
      SELECT * FROM live_rows
      UNION ALL
      SELECT * FROM staging_rows
    ) all_rows
    ORDER BY COALESCE(parent_company, customer_name, 'zzz'), customer_name, domain
  `;
  const { rows } = await db.query<Row>(sql);

  const parentCounts = new Map<string, number>();
  for (const r of rows) {
    if (r.parent_company) parentCounts.set(r.parent_company, (parentCounts.get(r.parent_company) ?? 0) + 1);
  }
  const groupedParents = [...parentCounts.entries()].filter(([, n]) => n >= 2).map(([p]) => p);
  const stagingCount = rows.filter(r => r.source === 'staging').length;

  return (
    <main style={{ padding: '2rem', maxWidth: 1800, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>Customer Sites</h1>
        <DiscoverSitesButton />
      </div>
      <p style={{ color: '#666' }}>
        {rows.length} sites · {groupedParents.length} grouped customers · {stagingCount} in staging/sandbox.
        Coloured borders mark sites in the same customer group. Yellow STAGING badge = onboarding/test site.
      </p>
      <CustomerSitesGrid rows={rows} groupedParents={groupedParents} />
    </main>
  );
}
