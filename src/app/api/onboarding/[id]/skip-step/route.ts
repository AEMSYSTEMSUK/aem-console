import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getWizard } from '@/lib/onboarding';
import { requireAdmin, HttpError } from '@/lib/rbac';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireAdmin();
    const { id } = await ctx.params;
    const wizardId = parseInt(id, 10);
    if (!Number.isFinite(wizardId)) throw new HttpError(400, 'Invalid wizard ID');
    const body = await req.json().catch(() => ({}));
    const stepNumber = parseInt(String(body.step_number ?? ''), 10);
    if (!Number.isFinite(stepNumber)) throw new HttpError(400, 'Missing step_number');

    const data = await getWizard(wizardId);
    if (!data) throw new HttpError(404, 'Wizard not found');

    await db.query(
      `UPDATE onboarding_steps SET status='skipped', completed_at=now(), output=$3 WHERE wizard_id=$1 AND step_number=$2`,
      [wizardId, stepNumber, `Skipped by admin user ${userId}`]
    );
    await db.query(
      `UPDATE onboarding_wizards SET current_step=$1 WHERE id=$2 AND current_step < $1`,
      [stepNumber + 1, wizardId]
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error)?.message ?? 'Internal error' }, { status: 500 });
  }
}
