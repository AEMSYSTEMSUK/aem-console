import { NextRequest, NextResponse } from 'next/server';
import { scanServer } from '@/lib/server-updates';
import { requireUser, HttpError } from '@/lib/rbac';
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { role } = await requireUser();
    if (role !== 'admin') throw new HttpError(403, 'Admin role required');
    const { id } = await ctx.params;
    const sid = parseInt(id, 10);
    if (!Number.isFinite(sid)) throw new HttpError(400, 'Invalid server ID');
    const r = await scanServer(sid);
    if (!r) return NextResponse.json({ error: 'Scan failed' }, { status: 400 });
    return NextResponse.json(r);
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error)?.message ?? 'Internal' }, { status: 500 });
  }
}
