import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import { readFileSync } from 'fs';
import { db } from '@/lib/db';

// Server-to-server autologin broker for AEM One (the CRM/portal). Unlike /api/sites/[siteId]/wp-admin-sso
// this is NOT passkey/session gated — it authenticates with a shared bearer service token so ONE's
// backend can request a one-time WP-admin login URL for a client's site.
//
// Auth:  Authorization: Bearer <AEM_ONE_SERVICE_TOKEN>
// Body:  { domain?: string, qboCustomerId?: string }   (domain preferred)
// Returns: { url } — a 120s HMAC-signed WP-admin auto-login URL.
//
// NOTE: /api/service/* is intentionally absent from middleware.ts matcher, so this route is reached
// without the aem_session cookie; the token check below is the only gate.

type SiteRow = { domain: string; wp_admin_user_id: number | null; has_sso_plugin: boolean };

function mintUrl(s: SiteRow): string {
  const secret = readFileSync('/etc/aem-console/auto-login.key', 'utf8').trim();
  const expiry = Math.floor(Date.now() / 1000) + 120;
  const payload = `${s.wp_admin_user_id}.${expiry}`;
  const hmac = createHmac('sha256', secret).update(payload).digest('hex');
  return `https://${s.domain}/?aem_login=${payload}.${hmac}`;
}

export async function POST(req: NextRequest) {
  const expected = process.env.AEM_ONE_SERVICE_TOKEN;
  if (!expected) return NextResponse.json({ error: 'service token not configured' }, { status: 503 });
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token || token !== expected) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: { domain?: string; qboCustomerId?: string; name?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  const domain = (body.domain || '').trim().toLowerCase().replace(/^www\./, '');
  const qbo = (body.qboCustomerId || '').trim();
  const name = (body.name || '').trim();
  if (!domain && !qbo && !name) return NextResponse.json({ error: 'domain, qboCustomerId or name required' }, { status: 400 });

  let site: SiteRow | undefined;
  if (domain) {
    const r = await db.query<SiteRow>(
      `SELECT domain, wp_admin_user_id, COALESCE(has_sso_plugin,false) AS has_sso_plugin
       FROM sites
       WHERE LOWER(REGEXP_REPLACE(domain, '^www\\.', '')) = $1
       ORDER BY (wp_admin_user_id IS NOT NULL) DESC, COALESCE(has_sso_plugin,false) DESC
       LIMIT 1`, [domain]);
    site = r.rows[0];
  }
  // No domain (or no match): resolve by customer. qbo_customer holds the NAME, so match the client name;
  // still try the raw qbo value in case a numeric id was stored. Prefer an SSO-ready site.
  if (!site && (qbo || name)) {
    const r = await db.query<SiteRow>(
      `SELECT s.domain, s.wp_admin_user_id, COALESCE(s.has_sso_plugin,false) AS has_sso_plugin
       FROM sites s JOIN customers c ON c.id = s.customer_id
       WHERE ($1 <> '' AND c.qbo_customer = $1)
          OR ($2 <> '' AND LOWER(btrim(c.qbo_customer)) = LOWER($2))
       ORDER BY (s.wp_admin_user_id IS NOT NULL) DESC, COALESCE(s.has_sso_plugin,false) DESC
       LIMIT 1`, [qbo, name]);
    site = r.rows[0];
  }

  if (!site) return NextResponse.json({ error: 'no matching site' }, { status: 404 });
  if (!site.has_sso_plugin) return NextResponse.json({ error: 'sso mu-plugin not installed on this site' }, { status: 409 });
  if (!site.wp_admin_user_id) return NextResponse.json({ error: 'no wp_admin_user_id on this site' }, { status: 409 });

  return NextResponse.json({ url: mintUrl(site) });
}
