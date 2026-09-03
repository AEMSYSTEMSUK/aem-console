import { NextRequest, NextResponse } from 'next/server';
import { triggerUpgrade } from '@/lib/server-updates';
import { requireUser, HttpError } from '@/lib/rbac';
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { userId, role } = await requireUser();
    if (role !== 'admin') throw new HttpError(403, 'Admin role required');
    const { id } = await ctx.params;
    const sid = parseInt(id, 10);
    if (!Number.isFinite(sid)) throw new HttpError(400, 'Invalid server ID');
    const body = await req.json().catch(() => ({}));
    const kind = String(body.kind ?? 'upgrade');
    if (!['upgrade','upgrade-and-reboot','reboot'].includes(kind)) throw new HttpError(400, 'Invalid kind');
    const r = await triggerUpgrade(sid, kind as any, userId);
    if ('error' in r) return NextResponse.json({ error: r.error }, { status: 400 });
    return NextResponse.json(r);
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error)?.message ?? 'Internal' }, { status: 500 });
  }
}
