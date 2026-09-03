import { NextRequest, NextResponse } from 'next/server';
import { verifyRegistrationResponse } from '@simplewebauthn/server';
import { rpID, origin } from '@/lib/webauthn';
import { getUserByEmail } from '@/lib/users';
import { db } from '@/lib/db';
import { createSession } from '@/lib/sessions';
import { audit } from '@/lib/audit';
import { serialize } from 'cookie';
import { SESSION_TTL_MS } from '@/lib/webauthn';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  const credential = body.credential;
  if (!email || !credential) {
    return NextResponse.json({ error: 'email and credential required' }, { status: 400 });
  }

  const user = await getUserByEmail(email);
  if (!user) {
    return NextResponse.json({ error: 'user not found' }, { status: 404 });
  }

  const chRes = await db.query<{ challenge: string }>(
    `SELECT challenge FROM webauthn_challenges
     WHERE user_id = $1 AND type = 'registration' AND expires_at > now()
     ORDER BY id DESC LIMIT 1`,
    [user.id]
  );
  const expectedChallenge = chRes.rows[0]?.challenge;
  if (!expectedChallenge) {
    return NextResponse.json({ error: 'no active challenge' }, { status: 400 });
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });
  } catch (e) {
    return NextResponse.json({ error: 'verification failed', detail: String(e) }, { status: 400 });
  }

  if (!verification.verified || !verification.registrationInfo) {
    return NextResponse.json({ error: 'not verified' }, { status: 400 });
  }

  const { credential: cred, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

  await db.query(
    `INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, transports, name)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      user.id,
      cred.id,
      Buffer.from(cred.publicKey).toString('base64'),
      String(cred.counter),
      cred.transports ?? null,
      `Passkey added ${new Date().toISOString().slice(0, 10)}`,
    ]
  );

  await db.query(`DELETE FROM webauthn_challenges WHERE user_id = $1 AND type = 'registration'`, [user.id]);

  const session = await createSession(user.id);

  await audit({
    actor_user_id: user.id,
    action: 'credential.added',
    target_type: 'credential',
    target_id: cred.id,
    after_state: { credentialDeviceType, credentialBackedUp },
    ip_address: req.headers.get('x-forwarded-for') ?? null,
    user_agent: req.headers.get('user-agent') ?? null,
  });
  await audit({
    actor_user_id: user.id,
    action: 'user.enroll.complete',
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
