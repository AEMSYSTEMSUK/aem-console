import { db } from '@/lib/db';
import { sshExec } from '@/lib/ssh';
import { dnsTxtLookup } from '@/lib/dns';

export interface DriftCheckResult {
  standard_id: number;
  standard_name: string;
  server_id?: number;
  site_id?: number;
  status: 'compliant' | 'drift' | 'error' | 'not-applicable';
  current_value?: unknown;
  notes?: string;
}

interface StandardRow { id: number; name: string; severity: string; }

async function loadStandard(name: string): Promise<StandardRow | null> {
  const r = await db.query<StandardRow>('SELECT id, name, severity FROM standards WHERE name = $1 AND enabled = true', [name]);
  return r.rows[0] ?? null;
}

async function recordDrift(result: DriftCheckResult): Promise<void> {
  // Idempotent: resolve any prior open record for this standard+target before inserting new
  await db.query(`
    UPDATE drift_records SET resolved_at = now()
    WHERE standard_id = $1 AND resolved_at IS NULL
      AND COALESCE(server_id, -1) = COALESCE($2, -1)
      AND COALESCE(site_id, -1) = COALESCE($3, -1)
  `, [result.standard_id, result.server_id ?? null, result.site_id ?? null]);
  if (result.status === 'compliant' || result.status === 'not-applicable') return;
  await db.query(`
    INSERT INTO drift_records (server_id, site_id, standard_id, current_value, status, notes)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [
    result.server_id ?? null,
    result.site_id ?? null,
    result.standard_id,
    result.current_value !== undefined ? JSON.stringify(result.current_value) : null,
    result.status,
    result.notes ?? null,
  ]);
}

async function getServerFqdn(serverId: number): Promise<string | null> {
  const r = await db.query<{ fqdn: string }>('SELECT fqdn FROM servers WHERE id = $1', [serverId]);
  return r.rows[0]?.fqdn ?? null;
}

// A site is "AEM-mail-managed" iff it has a per-domain config at
// /etc/aem-mail-sender/<domain>.conf on its host. Only managed sites are
// evaluated for the mu-plugin (std-1) and SPF-relay (std-2) standards; all
// others use their own mail path and are reported not-applicable.
async function managedMailDomains(fqdn: string): Promise<Set<string>> {
  const r = await sshExec(fqdn, "ls -1 /etc/aem-mail-sender/*.conf 2>/dev/null | xargs -r -n1 basename | sed 's/\\.conf$//'", 10);
  if (!r.ok) return new Set();
  return new Set(r.stdout.split('\n').map((s) => s.trim()).filter(Boolean));
}

// Check 1: mu-plugin presence per WP site
export async function checkMuPluginPresence(serverId: number): Promise<DriftCheckResult[]> {
  const standard = await loadStandard('aem-mail-sender-mu-plugin');
  if (!standard) return [];
  const meta = await db.query<{ fqdn: string; role: string }>('SELECT fqdn, role FROM servers WHERE id = $1', [serverId]);
  const fqdn = meta.rows[0]?.fqdn;
  const role = meta.rows[0]?.role;
  if (!fqdn) return [];

  const sites = await db.query<{ id: number; domain: string; raw: { full_path?: string } | null }>(
    `SELECT id, domain, raw FROM sites WHERE host_server_id = $1 AND is_wordpress = true`, [serverId]
  );
  const managed = await managedMailDomains(fqdn);
  const results: DriftCheckResult[] = [];

  for (const site of sites.rows) {
    if (!managed.has(site.domain)) {
      results.push({ standard_id: standard.id, standard_name: standard.name, server_id: serverId, site_id: site.id, status: 'not-applicable', notes: 'not AEM-mail-managed (no /etc/aem-mail-sender conf)' });
      continue;
    }
    const docroot = site.raw?.full_path;
    if (!docroot) {
      results.push({ standard_id: standard.id, standard_name: standard.name, server_id: serverId, site_id: site.id, status: 'error', notes: 'no docroot known' });
      continue;
    }
    const muPath = `${docroot}/wp-content/mu-plugins/aem-mail-sender.php`;
    const r = await sshExec(fqdn, `[ -f '${muPath}' ] && echo yes || echo no`, 10);
    if (!r.ok) {
      results.push({ standard_id: standard.id, standard_name: standard.name, server_id: serverId, site_id: site.id, status: 'error', notes: r.error?.slice(0, 200) });
      continue;
    }
    const exists = r.stdout.trim() === 'yes';
    await db.query('UPDATE sites SET has_mu_plugin = $1 WHERE id = $2', [exists, site.id]);
    results.push({
      standard_id: standard.id,
      standard_name: standard.name,
      server_id: serverId,
      site_id: site.id,
      status: exists ? 'compliant' : 'drift',
      current_value: { exists, path: muPath },
    });
  }
  for (const r of results) await recordDrift(r);
  return results;
}

// Check 2: SPF includes AEM relay per domain
export async function checkSpfIncludes(serverId: number): Promise<DriftCheckResult[]> {
  const standard = await loadStandard('spf-includes-aem-relay');
  if (!standard) return [];

  const meta = await db.query<{ fqdn: string }>('SELECT fqdn FROM servers WHERE id = $1', [serverId]);
  const fqdn = meta.rows[0]?.fqdn;
  if (!fqdn) return [];
  const managed = await managedMailDomains(fqdn);

  const sites = await db.query<{ id: number; domain: string }>(
    `SELECT id, domain FROM sites WHERE host_server_id = $1`, [serverId]
  );
  const results: DriftCheckResult[] = [];
  for (const site of sites.rows) {
    if (!managed.has(site.domain)) {
      results.push({ standard_id: standard.id, standard_name: standard.name, server_id: serverId, site_id: site.id, status: 'not-applicable', notes: 'not AEM-mail-managed (no /etc/aem-mail-sender conf)' });
      continue;
    }
    const txts = await dnsTxtLookup(site.domain);
    const spf = txts.find((t) => t.toLowerCase().startsWith('v=spf1'));
    const hasRelay = !!spf && (spf.includes('ip4:217.174.245.2') || spf.includes('spf.protection.outlook.com'));
    results.push({
      standard_id: standard.id,
      standard_name: standard.name,
      server_id: serverId,
      site_id: site.id,
      status: hasRelay ? 'compliant' : 'drift',
      current_value: { spf: spf ?? null },
    });
  }
  for (const r of results) await recordDrift(r);
  return results;
}

// Check 3: Postfix myhostname matches fleet pattern
export async function checkPostfixMyhostname(serverId: number): Promise<DriftCheckResult[]> {
  const standard = await loadStandard('postfix-myhostname-fleet-standard');
  if (!standard) return [];
  const meta = await db.query<{ fqdn: string; role: string }>('SELECT fqdn, role FROM servers WHERE id = $1', [serverId]);
  const fqdn = meta.rows[0]?.fqdn;
  const role = meta.rows[0]?.role;
  if (!fqdn) return [];
  const r = await sshExec(fqdn, 'postconf -h myhostname', 10);
  if (!r.ok) {
    const result: DriftCheckResult = { standard_id: standard.id, standard_name: standard.name, server_id: serverId, status: 'error', notes: r.error?.slice(0, 200) };
    await recordDrift(result);
    return [result];
  }
  const hostname = r.stdout.trim();
  const matches = hostname.endsWith('.infra.aemsystems.co.uk');
  const result: DriftCheckResult = {
    standard_id: standard.id,
    standard_name: standard.name,
    server_id: serverId,
    status: matches ? 'compliant' : 'drift',
    current_value: { myhostname: hostname },
  };
  await recordDrift(result);
  return [result];
}

// Check 4: sender_canonical configured
export async function checkSenderCanonical(serverId: number): Promise<DriftCheckResult[]> {
  const standard = await loadStandard('sender-canonical-configured');
  if (!standard) return [];
  const meta = await db.query<{ fqdn: string; role: string }>('SELECT fqdn, role FROM servers WHERE id = $1', [serverId]);
  const fqdn = meta.rows[0]?.fqdn;
  const role = meta.rows[0]?.role;
  if (!fqdn) return [];
  if (role === 'plesk-mail') {
    const result: DriftCheckResult = { standard_id: standard.id, standard_name: standard.name, server_id: serverId, status: 'not-applicable', notes: 'mail.infra is the relay itself' };
    await recordDrift(result);
    return [result];
  }
  const r = await sshExec(fqdn, `[ -f /etc/postfix/sender_canonical ] && postconf -h sender_canonical_maps 2>/dev/null || echo missing`, 10);
  if (!r.ok) {
    const result: DriftCheckResult = { standard_id: standard.id, standard_name: standard.name, server_id: serverId, status: 'error', notes: r.error?.slice(0, 200) };
    await recordDrift(result);
    return [result];
  }
  const out = r.stdout.trim();
  const configured = out !== 'missing' && out.length > 0;
  const result: DriftCheckResult = {
    standard_id: standard.id,
    standard_name: standard.name,
    server_id: serverId,
    status: configured ? 'compliant' : 'drift',
    current_value: { sender_canonical_maps: out },
  };
  await recordDrift(result);
  return [result];
}

// Check 5: Hetzner backup is SSHFS not rclone
export async function checkBackupSshfs(serverId: number): Promise<DriftCheckResult[]> {
  const standard = await loadStandard('backup-via-sshfs-not-rclone');
  if (!standard) return [];
  const meta = await db.query<{ fqdn: string; role: string }>('SELECT fqdn, role FROM servers WHERE id = $1', [serverId]);
  const fqdn = meta.rows[0]?.fqdn;
  const role = meta.rows[0]?.role;
  if (!fqdn) return [];
  const r = await sshExec(fqdn, `mount | grep -E 'hetzner|psa/dumps' | head -3`, 10);
  if (!r.ok) {
    const result: DriftCheckResult = { standard_id: standard.id, standard_name: standard.name, server_id: serverId, status: 'error', notes: r.error?.slice(0, 200) };
    await recordDrift(result);
    return [result];
  }
  const mountOutput = r.stdout.trim();
  const hasSshfs = mountOutput.includes('fuse.sshfs');
  const hasRclone = mountOutput.toLowerCase().includes('rclone') || mountOutput.toLowerCase().includes('fuse.rclone');
  let status: DriftCheckResult['status'];
  if (hasRclone) status = 'drift';
  else if (hasSshfs) status = 'compliant';
  else if (mountOutput.length === 0) status = 'not-applicable';
  else status = 'drift';
  const result: DriftCheckResult = {
    standard_id: standard.id,
    standard_name: standard.name,
    server_id: serverId,
    status,
    current_value: { mounts: mountOutput.split('\n') },
  };
  if (status !== 'not-applicable') await recordDrift(result);
  return [result];
}

export async function runAllChecksForServer(serverId: number): Promise<DriftCheckResult[]> {
  const all: DriftCheckResult[] = [];
  all.push(...await checkMuPluginPresence(serverId));
  all.push(...await checkSpfIncludes(serverId));
  all.push(...await checkPostfixMyhostname(serverId));
  all.push(...await checkSenderCanonical(serverId));
  all.push(...await checkBackupSshfs(serverId));
  return all;
}

export async function runAllChecksAllServers(): Promise<{ server_id: number; results: DriftCheckResult[] }[]> {
  const scanStart = new Date().toISOString();
  const r = await db.query<{ id: number; role: string }>(
    `SELECT id, role FROM servers WHERE enabled = true AND role LIKE 'plesk-%'`
  );
  const out = [];
  for (const row of r.rows) {
    const results = await runAllChecksForServer(row.id);
    out.push({ server_id: row.id, results });
  }
  await resolveOrphanedDrifts(scanStart);
  return out;
}

export async function resolveOrphanedDrifts(since: string): Promise<number> {
  const r = await db.query("UPDATE drift_records SET resolved_at = now(), notes = COALESCE(notes, '') || ' [auto-resolved: out of scan scope]' WHERE resolved_at IS NULL AND detected_at < $1", [since]);
  return r.rowCount ?? 0;
}

export async function listOpenDrifts() {
  const r = await db.query(`
    SELECT d.id, d.server_id, d.standard_id, st.name AS standard_name, st.severity, sv.name AS server_name,
           si.domain AS site_domain, d.status, d.detected_at::text, d.notes
      FROM drift_records d
        LEFT JOIN standards st ON st.id = d.standard_id
        LEFT JOIN servers sv ON sv.id = d.server_id
        LEFT JOIN sites si ON si.id = d.site_id
      WHERE d.resolved_at IS NULL AND d.status IN ('drift', 'error')
        AND NOT EXISTS (SELECT 1 FROM server_exceptions se WHERE se.server_id = d.server_id AND se.standard_id = d.standard_id AND (se.expires_at IS NULL OR se.expires_at > now()))
      ORDER BY
        CASE st.severity WHEN 'critical' THEN 1 WHEN 'warn' THEN 2 ELSE 3 END,
        d.detected_at DESC
      LIMIT 500
  `);
  return r.rows as Array<{
    id: number; server_id: number; standard_id: number; standard_name: string; severity: string;
    server_name: string | null; site_domain: string | null;
    status: string; detected_at: string; notes: string | null;
  }>;
}

export async function listActiveExceptions() {
  const r = await db.query(`
    SELECT se.id, se.server_id, se.standard_id, se.reason, se.expires_at::text,
           se.created_at::text, sv.name AS server_name, st.name AS standard_name, st.severity
      FROM server_exceptions se
        LEFT JOIN servers sv ON sv.id = se.server_id
        LEFT JOIN standards st ON st.id = se.standard_id
      WHERE se.expires_at IS NULL OR se.expires_at > now()
      ORDER BY sv.name, st.name
  `);
  return r.rows as Array<{
    id: number; server_id: number; standard_id: number; reason: string;
    expires_at: string | null; created_at: string;
    server_name: string | null; standard_name: string | null; severity: string | null;
  }>;
}
export async function addServerException(serverId: number, standardId: number, reason: string, ownerUserId: number | null, expiresAt: string | null): Promise<void> {
  await db.query(
    `INSERT INTO server_exceptions (server_id, standard_id, reason, owner_user_id, expires_at) VALUES ($1, $2, $3, $4, $5)`,
    [serverId, standardId, reason.slice(0, 1000), ownerUserId, expiresAt]
  );
}
export async function removeServerException(id: number): Promise<void> {
  await db.query('DELETE FROM server_exceptions WHERE id = $1', [id]);
}

