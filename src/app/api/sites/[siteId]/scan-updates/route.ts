import { NextRequest, NextResponse } from 'next/server';
import { scanSite } from '@/lib/wp-updates';
import { requireUser, HttpError } from '@/lib/rbac';
export async function POST(_req: NextRequest, ctx: { params: Promise<{ siteId: string }> }) {
  try {
    await requireUser();
    const { siteId } = await ctx.params;
    const sid = parseInt(siteId, 10);
    if (!Number.isFinite(sid)) throw new HttpError(400, 'Invalid site ID');
    const r = await scanSite(sid);
    if (!r) return NextResponse.json({ error: 'Could not scan site' }, { status: 400 });
    return NextResponse.json(r);
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error)?.message ?? 'Internal' }, { status: 500 });
  }
}
