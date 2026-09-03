import { db } from '@/lib/db';

export interface User {
  id: number;
  email: string;
  display_name: string | null;
}

export interface WebAuthnCredentialRow {
  id: number;
  user_id: number;
  credential_id: string;
  public_key: string;
  counter: string;
  transports: string[] | null;
  name: string | null;
}

export async function getUserByEmail(email: string): Promise<User | null> {
  const r = await db.query<User>(
    'SELECT id, email, display_name FROM users WHERE email = $1',
    [email]
  );
  return r.rows[0] ?? null;
}

export async function getUserById(id: number): Promise<User | null> {
  const r = await db.query<User>(
    'SELECT id, email, display_name FROM users WHERE id = $1',
    [id]
  );
  return r.rows[0] ?? null;
}

export async function getCredentialsForUser(userId: number): Promise<WebAuthnCredentialRow[]> {
  const r = await db.query<WebAuthnCredentialRow>(
    'SELECT id, user_id, credential_id, public_key, counter::text, transports, name FROM webauthn_credentials WHERE user_id = $1',
    [userId]
  );
  return r.rows;
}

export async function getCredentialById(credentialId: string): Promise<WebAuthnCredentialRow | null> {
  const r = await db.query<WebAuthnCredentialRow>(
    'SELECT id, user_id, credential_id, public_key, counter::text, transports, name FROM webauthn_credentials WHERE credential_id = $1',
    [credentialId]
  );
  return r.rows[0] ?? null;
}

export async function updateCredentialCounter(credentialId: string, newCounter: bigint): Promise<void> {
  await db.query(
    'UPDATE webauthn_credentials SET counter = $1, last_used_at = now() WHERE credential_id = $2',
    [newCounter.toString(), credentialId]
  );
}

export async function getOrCreateUser(
  email: string, displayName: string | null, role: 'admin' | 'web'
): Promise<User> {
  const r = await db.query<User>(
    `INSERT INTO users (email, display_name, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE
       SET display_name = COALESCE(EXCLUDED.display_name, users.display_name),
           updated_at = now()
     RETURNING id, email, display_name`,
    [email, displayName, role]
  );
  return r.rows[0];
}
