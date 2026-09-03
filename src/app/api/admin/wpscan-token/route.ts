import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSession } from '@/lib/sessions';
import { db } from '@/lib/db';
import { encrypt } from '@/lib/crypto';
import { audit } from '@/lib/audit';

function baseUrl(req: NextRequest): string {
  const proto = req.headers.get('x-forwarded-proto') || 'https';
  const host = req.headers.get('host') || 'bastion.infra.aemsystems.co.uk';
  return `${proto}://${host}`;
}

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get('aem_session')?.value;
  if (!sessionId) return NextResponse.redirect(`${baseUrl(req)}/auth/login`);
  const sess = await getSession(sessionId);
  if (!sess) return NextResponse.redirect(`${baseUrl(req)}/auth/login`);
  const form = await req.formData();
  const token = String(form.get('token') || '').trim();
  if (!token) return NextResponse.redirect(`${baseUrl(req)}/admin/wpscan?err=missing`);
  await db.query(`INSERT INTO integration_tokens (server_id, type, encrypted_token) VALUES (NULL, 'wpscan', $1)`, [encrypt(token)]);
  await audit({ actor_user_id: sess.user_id, action: 'credential.added', target_type: 'wpscan', target_id: 'api-key' });
  return NextResponse.redirect(`${baseUrl(req)}/admin/wpscan?ok=1`);
}
