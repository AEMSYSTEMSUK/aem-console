import { NextRequest, NextResponse } from 'next/server';
import { triggerUpdate } from '@/lib/wp-updates';
import { requireUser, HttpError } from '@/lib/rbac';

export async function POST(req: NextRequest, ctx: { params: Promise<{ siteId: string }> }) {
  try {
    const { userId, role } = await requireUser();
    if (role !== 'admin') throw new HttpError(403, 'Admin role required');
    const { siteId } = await ctx.params;
    const sid = parseInt(siteId, 10);
    if (!Number.isFinite(sid)) throw new HttpError(400, 'Invalid site ID');
    const body = await req.json().catch(() => ({}));
    const kind = String(body.kind ?? 'all');
    if (!['plugins','themes','core','all'].includes(kind)) throw new HttpError(400, 'Invalid kind');
    const r = await triggerUpdate(sid, kind as any, userId);
    if ('error' in r) return NextResponse.json({ error: r.error }, { status: 400 });
    return NextResponse.json(r);
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error)?.message ?? 'Internal' }, { status: 500 });
  }
}
