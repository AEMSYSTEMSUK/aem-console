import { db } from '@/lib/db';
import { sshExec } from '@/lib/ssh';
import { upsertSite } from '@/lib/sites';

export interface DiscoverServerResult { server: string; found: number; upserted: number; skipped: number; error?: string }

// List the WordPress installs Plesk WP-Toolkit knows about on one server and register/refresh each as a
// site (so it's login-ready via wp-admin SSO), keyed on (domain, host_server_id). No-op on non-Plesk boxes.
export async function discoverServerSites(serverId: number): Promise<DiscoverServerResult | null> {
  const s = await db.query<{ fqdn: string; name: string }>(
    `SELECT fqdn, name FROM servers WHERE id = $1 AND enabled = true`, [serverId]);
  if (s.rows.length === 0) return null;
  const { fqdn, name } = s.rows[0];

  const r = await sshExec(fqdn, `plesk ext wp-toolkit --list -format json 2>/dev/null`, 60);
  if (!r.ok || !r.stdout.trim()) {
    return { server: name, found: 0, upserted: 0, skipped: 0, error: r.ok ? 'no WP-Toolkit output (not a Plesk server?)' : (r.error || 'ssh failed') };
  }

  let parsed: unknown;
  try { parsed = JSON.parse(r.stdout); } catch { return { server: name, found: 0, upserted: 0, skipped: 0, error: 'unparseable WP-Toolkit output' }; }
  const instances: any[] = Array.isArray(parsed) ? parsed : ((parsed as any)?.instances || (parsed as any)?.data || []);

  let upserted = 0, skipped = 0;
  for (const it of instances) {
    const id = it.id ?? it.instanceId ?? it.wpInstanceId ?? it.instance_id;
    let domain = String(it.mainDomain || it.domainName || it.domain || '').trim();
    if (!domain && it.siteUrl) { try { domain = new URL(it.siteUrl).host; } catch { /* ignore */ } }
    domain = domain.replace(/^www\./i, '').toLowerCase();
    const version = it.version || it.wpVersion || it.wp_version || null;
    if (!id || !domain) { skipped++; continue; }
    try {
      await upsertSite({ domain, host_server_id: serverId, is_wordpress: true, wp_version: version, lifecycle_stage: 'live', raw: { wp_instance_id: Number(id) } });
      upserted++;
    } catch { skipped++; }
  }
  return { server: name, found: instances.length, upserted, skipped };
}

// Discover across the whole enabled fleet; skips non-Plesk boxes gracefully.
export async function discoverAllSites(): Promise<{ servers: DiscoverServerResult[]; totalUpserted: number }> {
  const ss = await db.query<{ id: number }>(`SELECT id FROM servers WHERE enabled = true ORDER BY id`);
  const servers: DiscoverServerResult[] = [];
  let totalUpserted = 0;
  for (const s of ss.rows) {
    try {
      const res = await discoverServerSites(s.id);
      if (res) { servers.push(res); totalUpserted += res.upserted; }
    } catch (e) {
      servers.push({ server: `#${s.id}`, found: 0, upserted: 0, skipped: 0, error: String(e).slice(0, 200) });
    }
  }
  return { servers, totalUpserted };
}
