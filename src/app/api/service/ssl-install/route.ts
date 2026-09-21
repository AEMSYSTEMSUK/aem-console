import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { sshExec } from '@/lib/ssh';

// Server-to-server SSL install for AEM One (Phase 3 of the Auto-SSL module). ONE issues/renews a Let's
// Encrypt cert (validated via Cloudflare DNS-01) and hands it here; Console — which owns the server
// topology + fleet SSH key — resolves which Plesk box hosts the domain and installs the cert on it.
//
// Auth:  Authorization: Bearer <AEM_ONE_SERVICE_TOKEN>   (same token as the other /api/service/* routes)
// Body:  { domain: string, certPem: string, keyPem: string }   (certPem = full LE chain)
// Returns: { ok: true, installedOn } on success, or { ok:false, error } with the Plesk output.
//
// /api/service/* is deliberately absent from middleware.ts, so the token check below is the only gate.

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`; // shell single-quote

export async function POST(req: NextRequest) {
  const expected = process.env.AEM_ONE_SERVICE_TOKEN;
  if (!expected) return NextResponse.json({ ok: false, error: 'service token not configured' }, { status: 503 });
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token || token !== expected) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  let body: { domain?: string; certPem?: string; keyPem?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid body' }, { status: 400 }); }
  const domain = (body.domain || '').trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  const certPem = String(body.certPem || '');
  const keyPem = String(body.keyPem || '');
  if (!domain || !certPem || !keyPem) return NextResponse.json({ ok: false, error: 'domain, certPem and keyPem required' }, { status: 400 });

  // Resolve the domain to the Plesk server that hosts it (sites.host_server_id → servers.fqdn).
  const r = await db.query<{ fqdn: string; name: string }>(
    `SELECT sv.fqdn, sv.name
       FROM sites s JOIN servers sv ON sv.id = s.host_server_id
      WHERE LOWER(REGEXP_REPLACE(s.domain, '^www\\.', '')) = $1
        AND sv.fqdn IS NOT NULL AND COALESCE(sv.enabled, true)
      ORDER BY (s.host_server_id IS NOT NULL) DESC
      LIMIT 1`, [domain]);
  let server: { fqdn: string; name: string } | undefined = r.rows[0];
  let probedServerId: number | null = null;
  if (!server) {
    // Fallback: the domain isn't in Console's `sites` (site discovery never captured it — the cause of the
    // whole "install failed" backlog). Ask each Plesk box directly which one hosts it, so a monitored-but-
    // undiscovered site still gets its cert installed instead of 404-ing. Self-heals the `sites` row on a
    // successful install so the fast DB lookup hits next time.
    const cand = await db.query<{ id: number; fqdn: string; name: string }>(
      `SELECT id, fqdn, name FROM servers WHERE role LIKE 'plesk-%' AND COALESCE(enabled, true) = true AND fqdn IS NOT NULL ORDER BY id`);
    for (const c of cand.rows) {
      const probe = await sshExec(c.fqdn, `plesk bin domain --info ${sq(domain)} >/dev/null 2>&1 && echo AEM_HOST_YES || echo AEM_HOST_NO`, 30);
      if (probe.ok && probe.stdout.includes('AEM_HOST_YES')) { server = { fqdn: c.fqdn, name: c.name }; probedServerId = c.id; break; }
    }
    if (!server) return NextResponse.json({ ok: false, error: `No hosted site found for ${domain} (not in Console sites, and no Plesk server reports hosting it)` }, { status: 404 });
  }

  const certB64 = Buffer.from(certPem, 'utf8').toString('base64');
  const keyB64 = Buffer.from(keyPem, 'utf8').toString('base64');
  const certName = `AEM-ONE ${domain}`;

  // Install via Plesk CLI over the fleet SSH key: drop the PEMs in a temp dir, (re)create the cert in the
  // domain's repository, then assign it and enable SSL. Idempotent — removes any prior AEM-ONE cert first.
  const script = [
    `TMP=$(mktemp -d)`,
    `printf %s ${sq(certB64)} | base64 -d > "$TMP/cert.pem"`,
    `printf %s ${sq(keyB64)} | base64 -d > "$TMP/key.pem"`,
    `plesk bin certificate --remove ${sq(certName)} -domain ${sq(domain)} >/dev/null 2>&1 || true`,
    `CREATE=$(plesk bin certificate --create ${sq(certName)} -domain ${sq(domain)} -cert-file "$TMP/cert.pem" -key-file "$TMP/key.pem" 2>&1); CRC=$?`,
    `ASSIGN=$(plesk bin site --update ${sq(domain)} -ssl true -certificate-name ${sq(certName)} 2>&1); ARC=$?`,
    `rm -rf "$TMP"`,
    `echo "--CREATE(rc=$CRC): $CREATE"`,
    `echo "--ASSIGN(rc=$ARC): $ASSIGN"`,
    `if [ $CRC -eq 0 ] && [ $ARC -eq 0 ]; then echo AEM_SSL_INSTALL_OK; else echo AEM_SSL_INSTALL_FAIL; fi`,
  ].join('\n');

  const res = await sshExec(server.fqdn, script, 120);
  const out = `${res.stdout}\n${res.stderr}`.trim();
  const ok = res.ok && res.stdout.includes('AEM_SSL_INSTALL_OK');
  if (!ok) return NextResponse.json({ ok: false, error: out.slice(-800) || res.error || 'install failed', installedOn: server.fqdn }, { status: 200 });
  // If we resolved the host by probing (domain wasn't in `sites`), cache it so future lookups hit the DB
  // fast-path. Best-effort — a schema/NOT NULL mismatch must never fail an otherwise-successful install.
  if (probedServerId != null) {
    await db.query(
      `INSERT INTO sites (domain, host_server_id) VALUES ($1, $2)
       ON CONFLICT (domain) DO UPDATE SET host_server_id = EXCLUDED.host_server_id`,
      [domain, probedServerId],
    ).catch(() => { /* caching is a bonus; the cert is already installed */ });
  }
  return NextResponse.json({ ok: true, installedOn: server.fqdn, server: server.name, output: out.slice(-400) });
}
