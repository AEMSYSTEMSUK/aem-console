import { NextRequest, NextResponse } from 'next/server';
import { dropStaging } from '@/lib/onboarding';
import { requireAdmin, HttpError } from '@/lib/rbac';

// Admin-only "Drop staging now" — removes this wizard's staging subdomain and the
// cloned real_domain subscription on staging1 immediately, rather than waiting for
// the scheduled 7-day auto-drop. Idempotent (safe to click if already gone).
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await ctx.params;
    const wizardId = parseInt(id, 10);
    if (!Number.isFinite(wizardId)) throw new HttpError(400, 'Invalid wizard ID');
    const result = await dropStaging(wizardId);
    return NextResponse.json(result, { status: result.ok ? 200 : 500 });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error)?.message ?? 'Internal error' }, { status: 500 });
  }
}
