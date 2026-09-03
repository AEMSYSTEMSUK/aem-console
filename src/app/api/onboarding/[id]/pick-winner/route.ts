import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireUser, HttpError } from '@/lib/rbac';

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const me = await requireUser();
    const { id } = await ctx.params;
    const wid = parseInt(id, 10);
    if (!Number.isFinite(wid)) throw new HttpError(400, 'Invalid wizard ID');

    const w = await db.query<{ wizard_group_id: number | null }>(
      `SELECT wizard_group_id FROM onboarding_wizards WHERE id = $1`, [wid]);
    if (w.rows.length === 0) throw new HttpError(404, 'Wizard not found');
    const groupId = w.rows[0].wizard_group_id;
    if (!groupId) throw new HttpError(400, 'Wizard is not part of a draft group');

    await db.query(
      `UPDATE onboarding_wizards SET is_winner_draft = true WHERE id = $1`, [wid]);
    await db.query(
      `UPDATE onboarding_wizards SET status = 'archived'
       WHERE wizard_group_id = $1 AND id <> $2 AND status = 'in_progress'`,
      [groupId, wid]);

    return NextResponse.json({ ok: true, winner_id: wid });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error)?.message ?? 'Internal' }, { status: 500 });
  }
}
