import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/rbac';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireUser();
  if (me.role !== 'admin') return NextResponse.json({ error: 'admin only' }, { status: 403 });
  const { id } = await ctx.params;
  const wid = parseInt(id, 10);
  if (!Number.isFinite(wid)) return NextResponse.json({ error: 'bad id' }, { status: 400 });
  const body = await req.json();
  const step = parseInt(String(body.step), 10);
  if (!Number.isFinite(step) || step < 1 || step > 12) return NextResponse.json({ error: 'bad step' }, { status: 400 });

  await db.query(
    `UPDATE onboarding_wizards SET current_step=$1, status='in_progress', completed_at=NULL, staging_drop_at=NULL WHERE id=$2`,
    [step, wid]
  );
  await db.query(
    `UPDATE onboarding_steps SET status='pending', output=NULL, error=NULL, progress_pct=NULL, started_at=NULL, completed_at=NULL WHERE wizard_id=$1 AND step_number >= $2`,
    [wid, step]
  );
  return NextResponse.json({ ok: true });
}
