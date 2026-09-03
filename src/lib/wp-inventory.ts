import { db } from '@/lib/db';
import { sshExec } from '@/lib/ssh';

export interface WpToolkitListItem { name: string; status?: string; update?: string; version?: string; title?: string; }

export async function probePluginsForSite(siteId: number): Promise<number> {
  const sRes = await db.query<{ id: number; domain: string; raw: { wp_instance_id?: number } | null; host_server_id: number }>(
    `SELECT id, domain, raw, host_server_id FROM sites WHERE id = $1 AND is_wordpress = true`, [siteId]
  );
  const site = sRes.rows[0];
  if (!site || !site.raw?.wp_instance_id) return 0;
  const srvRes = await db.query<{ fqdn: string }>('SELECT fqdn FROM servers WHERE id = $1', [site.host_server_id]);
  const fqdn = srvRes.rows[0]?.fqdn;
  if (!fqdn) return 0;

  const r = await sshExec(fqdn, `plesk ext wp-toolkit --wp-cli -instance-id ${site.raw.wp_instance_id} -- plugin list --format=json 2>/dev/null`, 30);
  if (!r.ok) return 0;
  let plugins: WpToolkitListItem[] = [];
  try { plugins = JSON.parse(r.stdout); } catch { return 0; }
  let count = 0;
  for (const p of plugins) {
    await db.query(`
      INSERT INTO installed_plugins (site_id, slug, name, version, status, update_available, last_seen_at)
      VALUES ($1, $2, $3, $4, $5, $6, now())
      ON CONFLICT (site_id, slug) DO UPDATE SET
        name = EXCLUDED.name,
        version = EXCLUDED.version,
        status = EXCLUDED.status,
        update_available = EXCLUDED.update_available,
        last_seen_at = now()
    `, [siteId, p.name, p.title ?? p.name, p.version ?? null, p.status ?? null, p.update ?? null]);
    count++;
  }
  return count;
}

export async function probeAllSites(): Promise<{ site_id: number; domain: string; ok: boolean; plugins_seen: number; error?: string }[]> {
  const r = await db.query<{ id: number; domain: string }>(
    `SELECT id, domain FROM sites WHERE is_wordpress = true ORDER BY id`
  );
  const out = [];
  for (const row of r.rows) {
    try {
      const n = await probePluginsForSite(row.id);
      out.push({ site_id: row.id, domain: row.domain, ok: true, plugins_seen: n });
    } catch (e) {
      out.push({ site_id: row.id, domain: row.domain, ok: false, plugins_seen: 0, error: String(e).slice(0, 200) });
    }
  }
  return out;
}
