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
  const creds = {
    host: String(form.get('host') || '').trim(),
    port: Number(form.get('port') || 993),
    user: String(form.get('user') || '').trim(),
    password: String(form.get('password') || ''),
    secure: true,
  };
  if (!creds.host || !creds.user || !creds.password) {
    return NextResponse.redirect(`${baseUrl(req)}/admin/alert-sink?err=missing`);
  }

  const enc = encrypt(JSON.stringify(creds));
  await db.query(
    `INSERT INTO integration_tokens (server_id, type, encrypted_token)
     VALUES ((SELECT id FROM servers WHERE role = 'plesk-mail' LIMIT 1), 'imap-alerts', $1)`,
    [enc]
  );

  await audit({
    actor_user_id: sess.user_id,
    action: 'credential.added',
    target_type: 'imap-alerts',
    target_id: creds.user,
    ip_address: req.headers.get('x-forwarded-for') ?? null,
    user_agent: req.headers.get('user-agent') ?? null,
  });

  return NextResponse.redirect(`${baseUrl(req)}/admin/alert-sink?ok=1`);
}
