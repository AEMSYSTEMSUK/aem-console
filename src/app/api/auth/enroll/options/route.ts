import { NextRequest, NextResponse } from 'next/server';
import { generateRegistrationOptions } from '@simplewebauthn/server';
import type { AuthenticatorTransportFuture } from '@simplewebauthn/server';
import { rpName, rpID, CHALLENGE_TTL_MS } from '@/lib/webauthn';
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
    return NextResponse.json({ error: 'user not found' }, { status: 404 });
  }

  const existing = await getCredentialsForUser(user.id);

  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userID: new TextEncoder().encode(String(user.id)),
    userName: user.email,
    userDisplayName: user.display_name ?? user.email,
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({
      id: c.credential_id,
      transports: (c.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });

  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
  await db.query(
    `INSERT INTO webauthn_challenges (user_id, challenge, type, expires_at)
     VALUES ($1, $2, 'registration', $3)`,
    [user.id, options.challenge, expiresAt]
  );

  return NextResponse.json(options);
}
