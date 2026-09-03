import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAdmin, HttpError } from '@/lib/rbac';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await ctx.params;
    const wizardId = parseInt(id, 10);
    if (!Number.isFinite(wizardId)) throw new HttpError(400, 'Invalid wizard ID');
    const body = await req.json().catch(() => ({}));
    const value = !!body.value;
    await db.query(
      `UPDATE onboarding_wizards SET overwrite_existing = $1 WHERE id = $2`,
      [value, wizardId]
    );
    return NextResponse.json({ ok: true, overwrite_existing: value });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error)?.message ?? 'Internal error' }, { status: 500 });
  }
}
