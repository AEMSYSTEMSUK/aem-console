import { db } from '@/lib/db';
import { getPleskClient } from '@/lib/plesk';
import { sshExec } from '@/lib/ssh';
import { upsertSite } from '@/lib/sites';

export interface InventorySyncResult {
  server_id: number;
  server_name: string;
  ok: boolean;
  domains_seen: number;
  wp_seen: number;
  error?: string;
}

interface WpToolkitInstance {
  id: number;
  mainDomainId?: number;
  siteUrl?: string;
  fullPath?: string;
  version?: string;
  alive?: boolean;
  stateText?: string;
}

function siteUrlToDomain(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

async function sshListWpInstances(serverFqdn: string): Promise<WpToolkitInstance[]> {
  const res = await sshExec(serverFqdn, 'plesk ext wp-toolkit --list -format json', 30);
  if (!res.ok) return [];
  try {
    const parsed = JSON.parse(res.stdout);
    if (Array.isArray(parsed)) return parsed as WpToolkitInstance[];
    return [];
  } catch {
    return [];
  }
}

export async function syncServerInventory(serverId: number): Promise<InventorySyncResult> {
  const sRes = await db.query<{ id: number; name: string; fqdn: string; role: string }>(
    'SELECT id, name, fqdn, role FROM servers WHERE id = $1 AND enabled = true', [serverId]
  );
  const server = sRes.rows[0];
  if (!server) return { server_id: serverId, server_name: 'unknown', ok: false, domains_seen: 0, wp_seen: 0, error: 'not found' };

  const client = await getPleskClient(serverId);
  if (!client) return { server_id: serverId, server_name: server.name, ok: false, domains_seen: 0, wp_seen: 0, error: 'no token' };

  try {
    const [domains, serverInfo] = await Promise.all([
      client.listDomains(),
      client.serverInfo(),
    ]);

    const wpInstances = server.role.startsWith('plesk-')
      ? await sshListWpInstances(server.fqdn)
      : [];

    const wpByDomain = new Map<string, { wp_version?: string; instance_id: number; full_path?: string }>();
    for (const wp of wpInstances) {
      const domain = siteUrlToDomain(wp.siteUrl);
      if (domain) {
        wpByDomain.set(domain, { wp_version: wp.version, instance_id: wp.id, full_path: wp.fullPath });
      }
    }

    for (const d of domains) {
      const wp = wpByDomain.get(d.name) || wpByDomain.get(d.name.replace(/^www\./, ''));
      await upsertSite({
        domain: d.name,
        host_server_id: serverId,
        is_wordpress: !!wp,
        wp_version: wp?.wp_version ?? null,
        lifecycle_stage: (d.name.endsWith('.aemstaging.co.uk') || d.name.endsWith('.plesk.page')) ? 'staging' : 'live',
        raw: { domain: d, wp_instance_id: wp?.instance_id ?? null, full_path: wp?.full_path ?? null } as object,
      });
    }

    await db.query(`
      INSERT INTO server_health (server_id, plesk_version, raw)
      VALUES ($1, $2, $3)
    `, [serverId, serverInfo.version ?? null, JSON.stringify({ serverInfo })]);

    return { server_id: serverId, server_name: server.name, ok: true, domains_seen: domains.length, wp_seen: wpInstances.length };
  } catch (e) {
    return { server_id: serverId, server_name: server.name, ok: false, domains_seen: 0, wp_seen: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function syncAllServers(): Promise<InventorySyncResult[]> {
  const rs = await db.query<{ id: number }>(
    `SELECT s.id FROM servers s
     WHERE s.enabled = true AND s.plesk_api_url IS NOT NULL
       AND EXISTS(SELECT 1 FROM integration_tokens t WHERE t.server_id = s.id AND t.type = 'plesk-api')`
  );
  const results: InventorySyncResult[] = [];
  for (const row of rs.rows) results.push(await syncServerInventory(row.id));
  return results;
}
