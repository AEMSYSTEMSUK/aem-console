import { NextRequest, NextResponse } from 'next/server';
import { triggerUpdate } from '@/lib/wp-updates';
import { requireUser, HttpError } from '@/lib/rbac';
import { getPolicy } from '@/lib/wp-patch-policy';

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
    // #220: a site on staged patching (saved, enabled, not report-only policy) is only ever patched through
    // staging + approval - this direct 'update everything on live' path would bypass that (2 Oct 2026 pilot).
    const policy = await getPolicy(sid);
    if (!policy.is_default && policy.enabled && policy.mode !== 'report') {
      throw new HttpError(409, 'This site is on staged patching - updates go through Patch runs (staging + approval), not the direct Update button');
    }
    const r = await triggerUpdate(sid, kind as any, userId);
    if ('error' in r) return NextResponse.json({ error: r.error }, { status: 400 });
    return NextResponse.json(r);
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error)?.message ?? 'Internal' }, { status: 500 });
  }
}
