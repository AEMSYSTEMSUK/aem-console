import { NextRequest, NextResponse } from 'next/server';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import type { AuthenticatorTransportFuture } from '@simplewebauthn/server';
import { rpID, CHALLENGE_TTL_MS } from '@/lib/webauthn';
import { getUserByEmail, getCredentialsForUser } from '@/lib/users';
import { db } from '@/lib/db';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  if (!email) {
    return NextResponse.json({ error: 'email required' }, { status: 400 });
  }

  const user = await getUserByEmail(email);
  if (!user) {
    // Don't leak whether user exists: still generate options with empty allowed list
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'preferred',
      allowCredentials: [],
    });
    return NextResponse.json(options);
  }

  const creds = await getCredentialsForUser(user.id);
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'preferred',
    allowCredentials: creds.map((c) => ({
      id: c.credential_id,
      transports: (c.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
    })),
  });

  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
  await db.query(
    `INSERT INTO webauthn_challenges (user_id, challenge, type, expires_at)
     VALUES ($1, $2, 'authentication', $3)`,
    [user.id, options.challenge, expiresAt]
  );

  return NextResponse.json(options);
}
