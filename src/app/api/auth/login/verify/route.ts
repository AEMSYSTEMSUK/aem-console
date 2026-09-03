import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import { rpID, origin, SESSION_TTL_MS } from '@/lib/webauthn';
import { getUserByEmail, getCredentialById, updateCredentialCounter } from '@/lib/users';
import { db } from '@/lib/db';
import { createSession } from '@/lib/sessions';
import { audit } from '@/lib/audit';
import { serialize } from 'cookie';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  const credential = body.credential;
  if (!email || !credential?.id) {
    return NextResponse.json({ error: 'email and credential required' }, { status: 400 });
  }

  const user = await getUserByEmail(email);
  if (!user) {
    return NextResponse.json({ error: 'invalid login' }, { status: 401 });
  }

  const cred = await getCredentialById(credential.id);
  if (!cred || cred.user_id !== user.id) {
    return NextResponse.json({ error: 'invalid login' }, { status: 401 });
  }

  const chRes = await db.query<{ challenge: string }>(
    `SELECT challenge FROM webauthn_challenges
     WHERE user_id = $1 AND type = 'authentication' AND expires_at > now()
     ORDER BY id DESC LIMIT 1`,
    [user.id]
  );
  const expectedChallenge = chRes.rows[0]?.challenge;
  if (!expectedChallenge) {
    return NextResponse.json({ error: 'no active challenge' }, { status: 400 });
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: cred.credential_id,
        publicKey: new Uint8Array(Buffer.from(cred.public_key, 'base64')),
        counter: Number(cred.counter),
        transports: (cred.transports ?? undefined) as never,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: 'verification failed', detail: String(e) }, { status: 400 });
  }

  if (!verification.verified) {
    return NextResponse.json({ error: 'not verified' }, { status: 401 });
  }

  await updateCredentialCounter(cred.credential_id, BigInt(verification.authenticationInfo.newCounter));
  await db.query(`DELETE FROM webauthn_challenges WHERE user_id = $1 AND type = 'authentication'`, [user.id]);

  const session = await createSession(user.id);

  await audit({
    actor_user_id: user.id,
    action: 'user.login.complete',
    target_type: 'credential',
    target_id: cred.credential_id,
    ip_address: req.headers.get('x-forwarded-for') ?? null,
    user_agent: req.headers.get('user-agent') ?? null,
  });

  const cookie = serialize('aem_session', session.id, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });

  return NextResponse.json({ verified: true, redirect: '/dashboard' }, {
    headers: { 'Set-Cookie': cookie },
  });
}
