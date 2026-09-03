import { db } from '@/lib/db';

export interface SiteRow {
  id: number;
  domain: string;
  host_server_id: number | null;
  host_server_name: string | null;
  lifecycle_stage: string;
  is_wordpress: boolean;
  wp_version: string | null;
  has_mu_plugin: boolean | null;
  last_seen_at: string | null;
  notes: string | null;
}

export async function listSites(): Promise<SiteRow[]> {
  const r = await db.query<SiteRow>(`
    SELECT s.id, s.domain, s.host_server_id,
           sv.name AS host_server_name,
           s.lifecycle_stage, s.is_wordpress, s.wp_version, s.has_mu_plugin,
           s.last_seen_at::text, s.notes
      FROM sites s
      LEFT JOIN servers sv ON sv.id = s.host_server_id
      ORDER BY sv.name NULLS LAST, s.domain
  `);
  return r.rows;
}

export async function listSitesByServer(serverId: number): Promise<SiteRow[]> {
  const r = await db.query<SiteRow>(`
    SELECT s.id, s.domain, s.host_server_id,
           sv.name AS host_server_name,
           s.lifecycle_stage, s.is_wordpress, s.wp_version, s.has_mu_plugin,
           s.last_seen_at::text, s.notes
      FROM sites s
      LEFT JOIN servers sv ON sv.id = s.host_server_id
      WHERE s.host_server_id = $1
      ORDER BY s.domain
  `, [serverId]);
  return r.rows;
}

export async function upsertSite(params: {
  domain: string;
  host_server_id: number;
  subscription_id?: number | null;
  is_wordpress?: boolean;
  wp_version?: string | null;
  lifecycle_stage?: string;
  raw?: object | null;
}): Promise<void> {
  await db.query(`
    INSERT INTO sites (domain, host_server_id, subscription_id, is_wordpress, wp_version, lifecycle_stage, last_seen_at, raw, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, now(), $7, now())
    ON CONFLICT (domain, host_server_id) DO UPDATE SET
      subscription_id = EXCLUDED.subscription_id,
      is_wordpress = EXCLUDED.is_wordpress,
      wp_version = EXCLUDED.wp_version,
      lifecycle_stage = EXCLUDED.lifecycle_stage,
      last_seen_at = EXCLUDED.last_seen_at,
      raw = EXCLUDED.raw,
      updated_at = now()
  `, [
    params.domain,
    params.host_server_id,
    params.subscription_id ?? null,
    params.is_wordpress ?? false,
    params.wp_version ?? null,
    params.lifecycle_stage ?? 'live',
    params.raw ? JSON.stringify(params.raw) : null,
  ]);
}

export async function countSites(): Promise<{ total: number; wordpress: number; with_mu_plugin: number }> {
  const r = await db.query<{ total: string; wordpress: string; with_mu_plugin: string }>(`
    SELECT
      count(*)::text AS total,
      count(*) FILTER (WHERE is_wordpress)::text AS wordpress,
      count(*) FILTER (WHERE has_mu_plugin)::text AS with_mu_plugin
    FROM sites
  `);
  const row = r.rows[0];
  return {
    total: Number(row.total),
    wordpress: Number(row.wordpress),
    with_mu_plugin: Number(row.with_mu_plugin),
  };
}
