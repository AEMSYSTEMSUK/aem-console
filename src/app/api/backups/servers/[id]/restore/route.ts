import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAdmin, HttpError } from '@/lib/rbac';
import { restoreSubscription } from '@/lib/backups';

// POST /api/backups/servers/:id/restore  { domain, ref, confirm } — Phase 2, whole-subscription in-place
// restore from a chosen dump. Admin only. DESTRUCTIVE: overwrites the live subscription. Guardrails:
//  - `confirm` must exactly equal the domain being restored (typed-to-arm, server-enforced).
//  - restoreSubscription() takes a safety backup first and aborts if it fails.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireAdmin();
    const { id } = await ctx.params;
    const sid = parseInt(id, 10);
    if (!Number.isFinite(sid)) throw new HttpError(400, 'Invalid server ID');

    const body = await req.json().catch(() => ({}));
    const domain = String(body.domain || '').trim().toLowerCase();
    const ref = String(body.ref || '').trim();
    const confirm = String(body.confirm || '').trim().toLowerCase();
    if (!domain || !ref) throw new HttpError(400, 'domain and ref are required');
    if (confirm !== domain) throw new HttpError(400, `Confirmation must match the domain exactly (type "${domain}" to confirm)`);

    const who = await db.query<{ email: string | null }>('SELECT email FROM users WHERE id = $1', [userId]);
    const triggeredBy = who.rows[0]?.email || `user:${userId}`;

    const r = await restoreSubscription(sid, domain, ref, triggeredBy);
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error || 'Restore failed to start' }, { status: 400 });
    return NextResponse.json({ ok: true, job: r.job, note: 'Safety backup taken; restore running in background.' });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error)?.message ?? 'Internal' }, { status: 500 });
  }
}
