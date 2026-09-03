import { NextRequest, NextResponse } from 'next/server';
import { setupRelay } from '@/lib/onboarding';
import { requireUser, HttpError } from '@/lib/rbac';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { role } = await requireUser();
    if (role !== 'admin') throw new HttpError(403, 'Admin role required');
    const { id } = await ctx.params;
    const wizardId = parseInt(id, 10);
    if (!Number.isFinite(wizardId)) throw new HttpError(400, 'Invalid wizard ID');
    const body = await req.json().catch(() => ({}));
    const localPart = String(body.local_part ?? 'noreply');
    const result = await setupRelay(wizardId, localPart);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error)?.message ?? 'Internal error' }, { status: 500 });
  }
}
