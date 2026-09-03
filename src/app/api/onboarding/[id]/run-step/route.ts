import { NextRequest, NextResponse } from 'next/server';
import { runStep, getWizard, STEPS } from '@/lib/onboarding';
import { requireUser, HttpError } from '@/lib/rbac';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { role } = await requireUser();
    const { id } = await ctx.params;
    const wizardId = parseInt(id, 10);
    if (!Number.isFinite(wizardId)) throw new HttpError(400, 'Invalid wizard ID');

    const body = await req.json().catch(() => ({}));
    const stepNumber = parseInt(String(body.step_number ?? ''), 10);
    if (!Number.isFinite(stepNumber)) throw new HttpError(400, 'Missing step_number');

    const data = await getWizard(wizardId);
    if (!data) throw new HttpError(404, 'Wizard not found');

    const stepDef = STEPS.find(s => s.number === stepNumber);
    if (!stepDef) throw new HttpError(400, 'Unknown step');
    if (stepDef.role_required === 'admin' && role !== 'admin') {
      throw new HttpError(403, 'Admin role required for this step');
    }

    const result = await runStep(wizardId, stepNumber);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error)?.message ?? 'Internal error' }, { status: 500 });
  }
}
