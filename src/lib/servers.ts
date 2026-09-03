import { db } from '@/lib/db';

export interface ServerRow {
  id: number;
  name: string;
  fqdn: string;
  role: string;
  plesk_api_url: string | null;
  notes: string | null;
  enabled: boolean;
  has_token: boolean;
  last_health_at: string | null;
}

export async function listServers(): Promise<ServerRow[]> {
  const r = await db.query<ServerRow>(`
    SELECT
      s.id, s.name, s.fqdn, s.role, s.plesk_api_url, s.notes, s.enabled,
      EXISTS(SELECT 1 FROM integration_tokens t WHERE t.server_id = s.id AND t.type = 'plesk-api') AS has_token,
      (SELECT MAX(captured_at)::text FROM server_health h WHERE h.server_id = s.id) AS last_health_at
    FROM servers s
    ORDER BY s.role, s.name
  `);
  return r.rows;
}

export async function getServer(id: number): Promise<ServerRow | null> {
  const r = await db.query<ServerRow>(`
    SELECT
      s.id, s.name, s.fqdn, s.role, s.plesk_api_url, s.notes, s.enabled,
      EXISTS(SELECT 1 FROM integration_tokens t WHERE t.server_id = s.id AND t.type = 'plesk-api') AS has_token,
      (SELECT MAX(captured_at)::text FROM server_health h WHERE h.server_id = s.id) AS last_health_at
    FROM servers s
    WHERE s.id = $1
  `, [id]);
  return r.rows[0] ?? null;
}
