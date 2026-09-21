import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireUser, HttpError } from '@/lib/rbac';
import { listServerBackups, listBackupJobs } from '@/lib/backups';

// GET /api/backups/servers/:id — backup detail for one server: live dump history (over SSH),
// on-demand job history, and the latest recorded health snapshot. Read-only; any signed-in user.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    const { id } = await ctx.params;
    const sid = parseInt(id, 10);
    if (!Number.isFinite(sid)) throw new HttpError(400, 'Invalid server ID');

    const sRes = await db.query(
      'SELECT id, name, fqdn, role, COALESCE(backup_max_age_hours, 36) AS backup_max_age_hours FROM servers WHERE id = $1',
      [sid]);
    const server = sRes.rows[0];
    if (!server) throw new HttpError(404, 'Server not found');

    const healthRes = await db.query(
      `SELECT last_backup_at::text, last_backup_status, last_backup_size_mb, disk_usage_pct, disk_total_gb,
              (raw->>'dumps_mounted')::boolean AS dumps_mounted, captured_at::text
         FROM server_health WHERE server_id = $1 ORDER BY captured_at DESC LIMIT 1`, [sid]);

    const [backups, jobs] = await Promise.all([listServerBackups(sid), listBackupJobs(sid)]);
    return NextResponse.json({ server, health: healthRes.rows[0] || null, backups, jobs });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error)?.message ?? 'Internal' }, { status: 500 });
  }
}
