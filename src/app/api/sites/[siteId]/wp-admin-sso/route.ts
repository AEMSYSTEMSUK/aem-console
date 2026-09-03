import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import { readFileSync } from 'fs';
import { db } from '@/lib/db';

export async function POST(_req: NextRequest, ctx: { params: Promise<{ siteId: string }> }) {
  const { siteId: id } = await ctx.params;
  const sid = parseInt(id, 10);
  if (!Number.isFinite(sid)) return NextResponse.json({ error: 'bad id' }, { status: 400 });
  const r = await db.query<{ domain: string; wp_admin_user_id: number | null; has_sso_plugin: boolean }>(
    `SELECT domain, wp_admin_user_id, COALESCE(has_sso_plugin,false) AS has_sso_plugin
     FROM sites WHERE id = $1`, [sid]);
  if (!r.rows.length) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const s = r.rows[0];
  if (!s.has_sso_plugin) return NextResponse.json({ error: 'mu-plugin not installed' }, { status: 400 });
  if (!s.wp_admin_user_id) return NextResponse.json({ error: 'no wp_admin_user_id' }, { status: 400 });
  const secret = readFileSync('/etc/aem-console/auto-login.key', 'utf8').trim();
  const expiry = Math.floor(Date.now() / 1000) + 120;
  const payload = `${s.wp_admin_user_id}.${expiry}`;
  const hmac = createHmac('sha256', secret).update(payload).digest('hex');
  return NextResponse.json({ url: `https://${s.domain}/?aem_login=${payload}.${hmac}` });
}
