import { NextRequest, NextResponse } from 'next/server';
import { rollbackJob } from '@/lib/wp-updates';
import { requireUser, HttpError } from '@/lib/rbac';
export async function POST(_req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  try {
    const { userId, role } = await requireUser();
    if (role !== 'admin') throw new HttpError(403, 'Admin role required');
    const { jobId } = await ctx.params;
    const jid = parseInt(jobId, 10);
    if (!Number.isFinite(jid)) throw new HttpError(400, 'Invalid job ID');
    const r = await rollbackJob(jid, userId);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    return NextResponse.json(r);
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error)?.message ?? 'Internal' }, { status: 500 });
  }
}
