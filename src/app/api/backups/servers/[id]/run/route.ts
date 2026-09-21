import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAdmin, HttpError } from '@/lib/rbac';
import { runServerBackup } from '@/lib/backups';

// POST /api/backups/servers/:id/run — trigger an on-demand full Plesk server backup (Phase 1).
// Admin only. Non-destructive (creates a new backup); still gated + attributed to the operator.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireAdmin();
    const { id } = await ctx.params;
    const sid = parseInt(id, 10);
    if (!Number.isFinite(sid)) throw new HttpError(400, 'Invalid server ID');

    const who = await db.query<{ email: string | null }>('SELECT email FROM users WHERE id = $1', [userId]);
    const triggeredBy = who.rows[0]?.email || `user:${userId}`;

    const r = await runServerBackup(sid, triggeredBy);
    if (!r.ok) return NextResponse.json({ error: r.error || 'Failed to start backup' }, { status: 400 });
    return NextResponse.json({ ok: true, job: r.job });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error)?.message ?? 'Internal' }, { status: 500 });
  }
}
