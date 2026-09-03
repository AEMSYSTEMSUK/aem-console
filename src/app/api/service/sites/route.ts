import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

// List all websites for a client (customer), for AEM One's "Log in to website" picker.
// Auth: Authorization: Bearer <AEM_ONE_SERVICE_TOKEN>
// Body: { domain?, qboCustomerId? } — resolves the customer (by one of its site domains, or its QBO id),
//        then returns every site under that customer with SSO-readiness.
// Returns: { sites: [{ domain, ssoReady }] }

type Row = { domain: string; has_sso_plugin: boolean; wp_admin_user_id: number | null };

export async function POST(req: NextRequest) {
  const expected = process.env.AEM_ONE_SERVICE_TOKEN;
  if (!expected) return NextResponse.json({ error: 'service token not configured' }, { status: 503 });
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token || token !== expected) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: { domain?: string; qboCustomerId?: string; name?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid body' }, { status: 400 }); }
  const domain = (body.domain || '').trim().toLowerCase().replace(/^www\./, '');
  const qbo = (body.qboCustomerId || '').trim();
  const name = (body.name || '').trim();
  if (!domain && !qbo && !name) return NextResponse.json({ error: 'domain, qboCustomerId or name required' }, { status: 400 });

  // Resolve the customer id. Console keys businesses by qbo_customer, which holds the customer NAME,
  // so match on the name too (ONE sends a numeric QBO id that won't match a name).
  let customerId: number | null = null;
  if (qbo) {
    const r = await db.query<{ id: number }>(`SELECT id FROM customers WHERE qbo_customer = $1 LIMIT 1`, [qbo]);
    customerId = r.rows[0]?.id ?? null;
  }
  if (customerId == null && domain) {
    const r = await db.query<{ customer_id: number | null }>(
      `SELECT customer_id FROM sites WHERE LOWER(REGEXP_REPLACE(domain, '^www\\.', '')) = $1 AND customer_id IS NOT NULL LIMIT 1`,
      [domain]);
    customerId = r.rows[0]?.customer_id ?? null;
  }
  if (customerId == null && name) {
    const r = await db.query<{ id: number }>(
      `SELECT id FROM customers WHERE LOWER(btrim(qbo_customer)) = LOWER($1) LIMIT 1`, [name]);
    customerId = r.rows[0]?.id ?? null;
  }

  let rows: Row[] = [];
  if (customerId != null) {
    // The same business can be split across several Console customer rows that share one QBO mapping
    // (e.g. Embroideryinhouse → customers 22 and 71). Gather every customer with the same non-empty
    // qbo_customer so all their sites appear in one picker.
    const grp = await db.query<{ id: number }>(
      `SELECT id FROM customers
       WHERE id = $1
          OR (qbo_customer IS NOT NULL AND btrim(qbo_customer) <> ''
              AND qbo_customer = (SELECT qbo_customer FROM customers WHERE id = $1))`,
      [customerId]);
    const ids = grp.rows.map((x) => x.id);
    const r = await db.query<Row>(
      `SELECT domain, COALESCE(has_sso_plugin,false) AS has_sso_plugin, wp_admin_user_id
       FROM sites
       WHERE customer_id = ANY($1::int[])
         -- hide AEM-owned staging/infra/test domains from the client picker
         AND domain !~* '(aemstaging\\.co\\.uk|infra\\.aemsystems\\.co\\.uk|aemfruitydatabases\\.co\\.uk|aemtech\\.co\\.uk)$'
       ORDER BY domain`, [ids]);
    rows = r.rows;
  } else if (domain) {
    // No customer link — fall back to just the matched domain itself.
    const r = await db.query<Row>(
      `SELECT domain, COALESCE(has_sso_plugin,false) AS has_sso_plugin, wp_admin_user_id
       FROM sites WHERE LOWER(REGEXP_REPLACE(domain, '^www\\.', '')) = $1 ORDER BY domain`, [domain]);
    rows = r.rows;
  }

  const sites = rows.map((s) => ({ domain: s.domain, ssoReady: !!s.has_sso_plugin && s.wp_admin_user_id != null }));
  return NextResponse.json({ sites });
}
