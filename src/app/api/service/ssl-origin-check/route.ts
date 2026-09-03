import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { sshExec } from '@/lib/ssh';

// Origin cert probe for AEM One's Auto-SSL page. For a Cloudflare-PROXIED domain, ONE's public probe
// only sees Cloudflare's edge cert — never the origin cert ONE installed. This reads the cert the ORIGIN
// Plesk server actually serves for the domain (openssl against localhost:443 with SNI, over the fleet
// SSH key), so ONE can show + verify the cert it manages.
//
// Auth:  Authorization: Bearer <AEM_ONE_SERVICE_TOKEN>
// Body:  { domain }
// Returns: { ok, issuer, validFrom, validTo, server } or { ok:false, error }

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export async function POST(req: NextRequest) {
  const expected = process.env.AEM_ONE_SERVICE_TOKEN;
  if (!expected) return NextResponse.json({ ok: false, error: 'service token not configured' }, { status: 503 });
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token || token !== expected) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  let body: { domain?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid body' }, { status: 400 }); }
  const domain = (body.domain || '').trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  if (!domain) return NextResponse.json({ ok: false, error: 'domain required' }, { status: 400 });

  const r = await db.query<{ fqdn: string; name: string }>(
    `SELECT sv.fqdn, sv.name FROM sites s JOIN servers sv ON sv.id = s.host_server_id
      WHERE LOWER(REGEXP_REPLACE(s.domain, '^www\\.', '')) = $1 AND sv.fqdn IS NOT NULL AND COALESCE(sv.enabled, true)
      LIMIT 1`, [domain]);
  const server = r.rows[0];
  if (!server) return NextResponse.json({ ok: false, error: `no hosted site/server for ${domain}` }, { status: 404 });

  // Read the cert the origin serves for this SNI. First try a direct :443 probe against the server's own
  // fqdn (Plesk's nginx binds HTTPS to the real IP, not loopback) — bypasses Cloudflare. Dedicated boxes
  // often firewall :443 to Cloudflare IPs only, so that probe can be silently dropped even though the cert
  // IS installed. Since these are our own servers reached over the fleet SSH key (as root), fall back to
  // reading the exact cert nginx is configured to serve from the Plesk vhost config — no network probe,
  // works regardless of the origin firewall. Only if BOTH fail do we report unverifiable/error.
  const cmd =
    `d=${sq(domain)}; ` +
    `o=$(echo | timeout 8 openssl s_client -servername "$d" -connect ${sq(server.fqdn)}:443 2>&1); ` +
    `c=$(printf '%s' "$o" | openssl x509 -noout -issuer -startdate -enddate 2>/dev/null); ` +
    `if [ -z "$c" ]; then for dir in "/var/www/vhosts/system/$d" "/var/www/vhosts/system/www.$d"; do f="$dir/conf/last_nginx.conf"; [ -f "$f" ] || continue; p=$(grep -hoE 'ssl_certificate[[:space:]]+[^;]+' "$f" | head -1 | awk '{print $2}'); if [ -n "$p" ] && [ -f "$p" ]; then c=$(openssl x509 -in "$p" -noout -issuer -startdate -enddate 2>/dev/null); [ -n "$c" ] && break; fi; done; fi; ` +
    `printf '%s\\n' "$c"; ` +
    `if [ -z "$c" ]; then printf '%s' "$o" | grep -aioE 'connection refused|connection timed out|no route to host|network is unreachable|operation timed out|connect:errno=[0-9]+|timeout' | head -1; fi`;
  const res = await sshExec(server.fqdn, cmd, 30);
  const out = res.stdout || '';
  const issuer = (out.match(/issuer=.*?(?:O\s*=\s*|CN\s*=\s*)([^,\n/]+)/i)?.[1] || out.match(/issuer=(.*)/)?.[1] || '').trim() || null;
  const nb = out.match(/notBefore=(.+)/)?.[1]?.trim();
  const na = out.match(/notAfter=(.+)/)?.[1]?.trim();
  const validFrom = nb ? new Date(nb) : null;
  const validTo = na ? new Date(na) : null;
  if (!validTo || Number.isNaN(validTo.getTime())) {
    const blocked = /connection refused|timed out|no route to host|network is unreachable|operation timed out|connect:errno|timeout/i.test(out + ' ' + (res.stderr || ''));
    if (blocked) {
      return NextResponse.json({ ok: false, unverifiable: true, reason: `origin ${server.fqdn} refused a direct :443 probe (likely Cloudflare-only origin firewall) — install reported success`, server: server.fqdn }, { status: 200 });
    }
    return NextResponse.json({ ok: false, error: `could not read origin cert on ${server.fqdn}: ${(res.stderr || out).slice(-200)}`, server: server.fqdn }, { status: 200 });
  }
  return NextResponse.json({ ok: true, issuer, validFrom: validFrom?.toISOString() ?? null, validTo: validTo.toISOString(), server: server.fqdn });
}
