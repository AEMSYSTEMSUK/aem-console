import { db } from '@/lib/db';
import { cookies } from 'next/headers';
import { getSession } from '@/lib/sessions';

export type UserRole = 'admin' | 'web';

// Cookie name — defensive: try the configured name, then common fallbacks.
// If your middleware uses a different name, edit SESSION_COOKIE or set env var.
const SESSION_COOKIE = process.env.AEM_SESSION_COOKIE_NAME || 'aem_session';

export class HttpError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

export async function getSessionUserId(): Promise<number | null> {
  const c = await cookies();
  const id = c.get(SESSION_COOKIE)?.value
    ?? c.get('aem_session')?.value
    ?? c.get('session')?.value;
  if (!id) return null;
  const s = await getSession(id);
  return s?.user_id ?? null;
}

export async function getUserRole(userId: number): Promise<UserRole | null> {
  const r = await db.query<{ role: UserRole }>(
    'SELECT role FROM users WHERE id = $1',
    [userId]
  );
  return r.rows[0]?.role ?? null;
}

export async function requireUser(): Promise<{ userId: number; role: UserRole }> {
  const userId = await getSessionUserId();
  if (!userId) throw new HttpError(401, 'Not signed in');
  const role = await getUserRole(userId);
  if (!role) throw new HttpError(403, 'User has no role');
  return { userId, role };
}

export async function requireAdmin(): Promise<{ userId: number; role: UserRole }> {
  const u = await requireUser();
  if (u.role !== 'admin') throw new HttpError(403, 'Admin role required');
  return u;
}
