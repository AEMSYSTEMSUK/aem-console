import { db } from '@/lib/db';

export type AuditAction =
  | 'user.enroll.start'
  | 'user.enroll.complete'
  | 'user.login.start'
  | 'user.login.complete'
  | 'user.logout'
  | 'session.expired'
  | 'credential.added'
  | 'credential.removed';

export interface AuditLogEntry {
  actor_user_id: number | null;
  action: AuditAction;
  target_type?: string | null;
  target_id?: string | null;
  before_state?: object | null;
  after_state?: object | null;
  ip_address?: string | null;
  user_agent?: string | null;
}

export async function audit(entry: AuditLogEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_log
       (actor_user_id, action, target_type, target_id, before_state, after_state, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.actor_user_id,
      entry.action,
      entry.target_type ?? null,
      entry.target_id ?? null,
      entry.before_state ? JSON.stringify(entry.before_state) : null,
      entry.after_state ? JSON.stringify(entry.after_state) : null,
      entry.ip_address ?? null,
      entry.user_agent ?? null,
    ]
  );
}

export async function recentAuditLog(limit = 20): Promise<Array<{
  id: number;
  actor_user_id: number | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  created_at: string;
}>> {
  const r = await db.query(
    `SELECT id, actor_user_id, action, target_type, target_id, created_at::text
       FROM audit_log
       ORDER BY id DESC
       LIMIT $1`,
    [limit]
  );
  return r.rows;
}
