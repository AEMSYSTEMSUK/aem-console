import { NextRequest, NextResponse } from 'next/server';
import { checkLiveReady, getWizard } from '@/lib/onboarding';
import { requireAdmin, HttpError } from '@/lib/rbac';

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await ctx.params;
    const wizardId = parseInt(id, 10);
    if (!Number.isFinite(wizardId)) throw new HttpError(400, 'Invalid wizard ID');
    const data = await getWizard(wizardId);
    if (!data) throw new HttpError(404, 'Wizard not found');
    const result = await checkLiveReady(data.wizard);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error)?.message ?? 'Internal error' }, { status: 500 });
  }
}
