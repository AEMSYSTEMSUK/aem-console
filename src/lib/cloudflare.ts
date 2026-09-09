import { db } from '@/lib/db';
import { decrypt } from '@/lib/crypto';

const CF_API = 'https://api.cloudflare.com/client/v4';

interface CfResult<T> { success: boolean; errors: Array<{ code: number; message: string }>; result: T; }

export async function getCloudflareToken(): Promise<string | null> {
  const r = await db.query<{ encrypted_token: string }>(
    `SELECT encrypted_token FROM integration_tokens WHERE type = 'cloudflare' ORDER BY id DESC LIMIT 1`
  );
  if (r.rows.length === 0) return null;
  try {
    return decrypt(r.rows[0].encrypted_token);
  } catch (e) {
    throw new Error(`Failed to decrypt Cloudflare token: ${(e as Error).message}`);
  }
}

async function cfRequest<T>(path: string, init: RequestInit = {}, token: string): Promise<T> {
  const r = await fetch(`${CF_API}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(20000),
  });
  const data = await r.json() as CfResult<T>;
  if (!r.ok || !data.success) {
    // A 403/authentication error on a write (e.g. purge_cache) almost always means the API token is
    // missing the matching permission group rather than being wrong. Make that actionable.
    const codes = Array.isArray(data.errors) ? data.errors.map((e: any) => e?.code).filter(Boolean) : [];
    const authIssue = r.status === 403 || r.status === 401 || codes.includes(9109) || codes.includes(10000);
    if (authIssue && path.includes('/purge_cache')) {
      throw new Error(`Cloudflare 403 on cache purge — the API token is missing the "Cache Purge" permission for this zone. Rotate/edit the token to add Zone → Cache Purge (Purge), then retry. (${JSON.stringify(data.errors)})`);
    }
    if (authIssue) {
      throw new Error(`Cloudflare ${r.status} — the API token lacks a required permission for ${path}. Check the token's zone/account permission groups. (${JSON.stringify(data.errors)})`);
    }
    throw new Error(`Cloudflare API ${r.status}: ${JSON.stringify(data.errors)}`);
  }
  return data.result;
}

export interface CfZone { id: string; name: string; status: string; }

export async function findZoneForDomain(domain: string, token: string): Promise<CfZone | null> {
  let candidate = domain.toLowerCase();
  while (candidate.includes('.')) {
    const zones = await cfRequest<CfZone[]>(`/zones?name=${encodeURIComponent(candidate)}`, {}, token);
    if (zones.length > 0) return zones[0];
    const i = candidate.indexOf('.');
    candidate = candidate.substring(i + 1);
  }
  return null;
}

export interface CfRecord { id: string; type: string; name: string; content: string; proxied: boolean; ttl: number; priority?: number; }

export interface UpsertResult { action: 'no_change' | 'updated' | 'created'; record: CfRecord; }

export async function upsertARecord(
  zoneId: string,
  fqdn: string,
  ip: string,
  token: string,
  proxied: boolean = false,
): Promise<UpsertResult> {
  const existing = await cfRequest<CfRecord[]>(
    `/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(fqdn)}`,
    {}, token
  );
  if (existing.length > 0) {
    const rec = existing[0];
    if (rec.content === ip && rec.proxied === proxied) {
      return { action: 'no_change', record: rec };
    }
    const updated = await cfRequest<CfRecord>(
      `/zones/${zoneId}/dns_records/${rec.id}`,
      {
        method: 'PUT',
        body: JSON.stringify({ type: 'A', name: fqdn, content: ip, proxied, ttl: 300 }),
      },
      token
    );
    return { action: 'updated', record: updated };
  } else {
    const created = await cfRequest<CfRecord>(
      `/zones/${zoneId}/dns_records`,
      {
        method: 'POST',
        body: JSON.stringify({ type: 'A', name: fqdn, content: ip, proxied, ttl: 300 }),
      },
      token
    );
    return { action: 'created', record: created };
  }
}

export async function verifyToken(token: string): Promise<{ ok: boolean; status?: string; error?: string }> {
  try {
    const r = await fetch(`${CF_API}/user/tokens/verify`, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    const data = await r.json() as CfResult<{ status: string }>;
    if (!r.ok || !data.success) {
      return { ok: false, error: JSON.stringify(data.errors) };
    }
    return { ok: true, status: data.result.status };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function purgeZone(zoneId: string, token: string): Promise<void> {
  await cfRequest(`/zones/${zoneId}/purge_cache`, {
    method: 'POST',
    body: JSON.stringify({ purge_everything: true }),
  }, token);
}

// =========================================================
// TXT records
// CF stores TXT content with literal " at start/end per RFC 1035.
// Without these, the CF UI renders a triangle warning and strict
// resolvers may reject the record. Always wrap before sending.
// =========================================================
export function quoteTxt(content: string): string {
  if (content.startsWith('"') && content.endsWith('"')) return content;
  return `"${content}"`;
}

/**
 * Upsert a single-instance TXT record (e.g. SPF, DMARC).
 * Pass `content` UNQUOTED — this function wraps it.
 * Do NOT use for multi-record names like ownership verifications
 * (Google site verification, MS=, apple-domain-verification, etc.) —
 * for those, use `createTxtRecord` directly.
 */
export async function upsertTxtRecord(
  zoneId: string,
  fqdn: string,
  content: string,
  token: string,
  ttl: number = 300,
): Promise<UpsertResult> {
  const quoted = quoteTxt(content);
  const existing = await cfRequest<CfRecord[]>(
    `/zones/${zoneId}/dns_records?type=TXT&name=${encodeURIComponent(fqdn)}`,
    {}, token
  );
  if (existing.length === 1) {
    const rec = existing[0];
    if (rec.content === quoted) return { action: 'no_change', record: rec };
    const updated = await cfRequest<CfRecord>(
      `/zones/${zoneId}/dns_records/${rec.id}`,
      { method: 'PUT', body: JSON.stringify({ type: 'TXT', name: fqdn, content: quoted, ttl }) },
      token
    );
    return { action: 'updated', record: updated };
  } else if (existing.length === 0) {
    const created = await cfRequest<CfRecord>(
      `/zones/${zoneId}/dns_records`,
      { method: 'POST', body: JSON.stringify({ type: 'TXT', name: fqdn, content: quoted, ttl }) },
      token
    );
    return { action: 'created', record: created };
  } else {
    // Multiple TXT records on this name. Caller must disambiguate by content prefix.
    throw new Error(`upsertTxtRecord: ${existing.length} TXT records exist on ${fqdn}; refusing to guess. Use createTxtRecord or delete duplicates first.`);
  }
}

/** Create a TXT record. Content is wrapped in literal quotes automatically. */
export async function createTxtRecord(
  zoneId: string,
  fqdn: string,
  content: string,
  token: string,
  ttl: number = 300,
): Promise<CfRecord> {
  return cfRequest<CfRecord>(
    `/zones/${zoneId}/dns_records`,
    { method: 'POST', body: JSON.stringify({ type: 'TXT', name: fqdn, content: quoteTxt(content), ttl }) },
    token
  );
}

// =========================================================
// MX records (mail exchange)
// Multiple MX can coexist on the same name (different priorities/targets).
// Match by target host: same target+priority = no_change; same target diff
// priority = update; otherwise create.
// =========================================================
export async function upsertMxRecord(
  zoneId: string,
  fqdn: string,
  target: string,
  priority: number,
  token: string,
  ttl: number = 300,
): Promise<UpsertResult> {
  const existing = await cfRequest<CfRecord[]>(
    `/zones/${zoneId}/dns_records?type=MX&name=${encodeURIComponent(fqdn)}`,
    {}, token
  );
  const match = existing.find(r => r.content === target);
  if (match) {
    if (match.priority === priority) return { action: 'no_change', record: match };
    const updated = await cfRequest<CfRecord>(
      `/zones/${zoneId}/dns_records/${match.id}`,
      { method: 'PUT', body: JSON.stringify({ type: 'MX', name: fqdn, content: target, priority, ttl }) },
      token
    );
    return { action: 'updated', record: updated };
  }
  const created = await cfRequest<CfRecord>(
    `/zones/${zoneId}/dns_records`,
    { method: 'POST', body: JSON.stringify({ type: 'MX', name: fqdn, content: target, priority, ttl }) },
    token
  );
  return { action: 'created', record: created };
}

// =========================================================
// SPF (special-case TXT)
// An apex name may carry many TXTs (SPF, MS-verify, Google site-verify, …)
// but RFC allows only ONE v=spf1 record. Caller passes the FULL SPF string
// (unquoted) — we find the existing SPF among other TXTs and PUT it, else POST.
// =========================================================
export async function upsertSpfRecord(
  zoneId: string,
  fqdn: string,
  content: string,
  token: string,
  ttl: number = 300,
): Promise<UpsertResult> {
  const quoted = quoteTxt(content);
  const existing = await cfRequest<CfRecord[]>(
    `/zones/${zoneId}/dns_records?type=TXT&name=${encodeURIComponent(fqdn)}`,
    {}, token
  );
  const spf = existing.find(r => r.content.replace(/^"|"$/g, '').toLowerCase().startsWith('v=spf1'));
  if (spf) {
    if (spf.content === quoted) return { action: 'no_change', record: spf };
    const updated = await cfRequest<CfRecord>(
      `/zones/${zoneId}/dns_records/${spf.id}`,
      { method: 'PUT', body: JSON.stringify({ type: 'TXT', name: fqdn, content: quoted, ttl }) },
      token
    );
    return { action: 'updated', record: updated };
  }
  const created = await cfRequest<CfRecord>(
    `/zones/${zoneId}/dns_records`,
    { method: 'POST', body: JSON.stringify({ type: 'TXT', name: fqdn, content: quoted, ttl }) },
    token
  );
  return { action: 'created', record: created };
}

/**
 * Merge an ip4 mechanism into an existing SPF, preserving existing
 * include/ip4/redirect mechanisms. Idempotent — if newIp is already
 * present, returns the input unchanged. If no SPF exists, returns a
 * minimal v=spf1 ip4:<ip> -all.
 */
export function mergeSpf(current: string | null, newIp: string): string {
  if (!current) return `v=spf1 ip4:${newIp} -all`;
  const s = current.replace(/^"|"$/g, '').trim();
  if (!s.toLowerCase().startsWith('v=spf1')) return `v=spf1 ip4:${newIp} -all`;
  if (s.includes(`ip4:${newIp}`)) return s;
  const m = s.match(/^(.*?)(\s+)([+\-~?]?all)\s*$/);
  if (m) return `${m[1]}${m[2]}ip4:${newIp}${m[2]}${m[3]}`;
  return `${s} ip4:${newIp} -all`;
}
