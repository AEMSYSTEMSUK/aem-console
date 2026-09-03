import { db } from '@/lib/db';
import { randomBytes } from 'crypto';
import { SESSION_TTL_MS } from '@/lib/webauthn';

export interface Session {
  id: string;
  user_id: number;
  expires_at: Date;
}

export function newSessionId(): string {
  return randomBytes(32).toString('hex');
}

export async function createSession(userId: number): Promise<Session> {
  const id = newSessionId();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const r = await db.query<Session>(
    'INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3) RETURNING id, user_id, expires_at',
    [id, userId, expiresAt]
  );
  return r.rows[0];
}

export async function getSession(id: string): Promise<Session | null> {
  const r = await db.query<Session>(
    'SELECT id, user_id, expires_at FROM sessions WHERE id = $1 AND expires_at > now()',
    [id]
  );
  return r.rows[0] ?? null;
}

export async function destroySession(id: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE id = $1', [id]);
}
