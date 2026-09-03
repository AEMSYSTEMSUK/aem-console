import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSession } from '@/lib/sessions';
import { storePleskToken, getPleskClient } from '@/lib/plesk';
import { audit } from '@/lib/audit';

function baseUrl(req: NextRequest): string {
  const proto = req.headers.get('x-forwarded-proto') || 'https';
  const host = req.headers.get('host') || 'bastion.infra.aemsystems.co.uk';
  return `${proto}://${host}`;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get('aem_session')?.value;
  if (!sessionId) return NextResponse.redirect(`${baseUrl(req)}/auth/login`);
  const sess = await getSession(sessionId);
  if (!sess) return NextResponse.redirect(`${baseUrl(req)}/auth/login`);

  const { id } = await ctx.params;
  const serverId = Number(id);
  const form = await req.formData();
  const token = String(form.get('token') || '').trim();
  if (!token) return NextResponse.redirect(`${baseUrl(req)}/admin/servers/${serverId}?err=empty`);

  await storePleskToken(serverId, token);

  await audit({
    actor_user_id: sess.user_id,
    action: 'credential.added',
    target_type: 'server',
    target_id: String(serverId),
    after_state: { type: 'plesk-api' },
    ip_address: req.headers.get('x-forwarded-for') ?? null,
    user_agent: req.headers.get('user-agent') ?? null,
  });

  const client = await getPleskClient(serverId);
  let test: { ok: boolean; version?: string; error?: string } = { ok: false };
  if (client) test = await client.testConnection();

  const p = new URLSearchParams({
    test: test.ok ? 'ok' : 'fail',
    ...(test.error ? { err: test.error.slice(0, 100) } : {}),
    ...(test.version ? { v: test.version } : {}),
  });
  return NextResponse.redirect(`${baseUrl(req)}/admin/servers/${serverId}?${p.toString()}`);
}
