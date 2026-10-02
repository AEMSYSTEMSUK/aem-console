import { NextRequest, NextResponse } from 'next/server';
import { rejectPatchSite } from '@/lib/wp-patch/engine';
import { requireUser, HttpError } from '@/lib/rbac';

// #220 — reject a staged site (awaiting approval, or auto-approved but not yet live). Nothing is applied to live;
// the staging clone is deleted.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ patchSiteId: string }> }) {
  try {
    const { userId, role } = await requireUser();
    if (role !== 'admin') throw new HttpError(403, 'Admin role required');
    const { patchSiteId } = await ctx.params;
    const id = parseInt(patchSiteId, 10);
    if (!Number.isFinite(id)) throw new HttpError(400, 'Invalid patch site ID');
    const r = await rejectPatchSite(id, userId);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 409 });
    return NextResponse.json(r);
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error)?.message ?? 'Internal' }, { status: 500 });
  }
}
