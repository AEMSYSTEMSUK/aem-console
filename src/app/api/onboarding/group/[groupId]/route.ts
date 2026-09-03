import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/rbac';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ groupId: string }> }) {
  await requireUser();
  const { groupId } = await ctx.params;
  const gid = parseInt(groupId, 10);
  const r = await db.query(
    `SELECT id, staging_slug, status, is_winner_draft, current_step
       FROM onboarding_wizards WHERE wizard_group_id = $1 ORDER BY id`,
    [gid]
  );
  return NextResponse.json({ siblings: r.rows });
}
