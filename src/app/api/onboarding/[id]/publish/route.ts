import { NextRequest, NextResponse } from 'next/server';
import { runStepPublish, getWizard } from '@/lib/onboarding';
import { requireAdmin, HttpError } from '@/lib/rbac';

// Guarded trigger for the M8 keep-orders publish-back.
// Admin-only. Dry-run by default; the destructive path is additionally gated
// inside runStepPublish by PUBLISH_LIVE_ENABLED (currently false) + the confirm token.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await ctx.params;
    const wizardId = parseInt(id, 10);
    if (!Number.isFinite(wizardId)) throw new HttpError(400, 'Invalid wizard ID');
    const data = await getWizard(wizardId);
    if (!data) throw new HttpError(404, 'Wizard not found');
    const body = await req.json().catch(() => ({}));
    const confirm = typeof body.confirm === 'string' ? body.confirm : undefined;
    const result = await runStepPublish(data.wizard, { confirm });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error)?.message ?? 'Internal error' }, { status: 500 });
  }
}
