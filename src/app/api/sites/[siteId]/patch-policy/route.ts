import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireUser, HttpError } from '@/lib/rbac';
import { parsePolicyInput, savePolicy } from '@/lib/wp-patch-policy';

// #220 — save (upsert) a site's WordPress patch policy. Admin only.
export async function POST(req: NextRequest, ctx: { params: Promise<{ siteId: string }> }) {
  try {
    const { role } = await requireUser();
    if (role !== 'admin') throw new HttpError(403, 'Admin role required');
    const { siteId } = await ctx.params;
    const sid = parseInt(siteId, 10);
    if (!Number.isFinite(sid)) throw new HttpError(400, 'Invalid site ID');
    const s = await db.query(`SELECT 1 FROM sites WHERE id = $1 AND is_wordpress = true`, [sid]);
    if (s.rows.length === 0) throw new HttpError(404, 'Site not found or not WordPress');
    const body = await req.json().catch(() => ({}));
    const p = parsePolicyInput(body);
    if ('error' in p) throw new HttpError(400, p.error);
    await savePolicy(sid, p.value);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error)?.message ?? 'Internal' }, { status: 500 });
  }
}
