import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAdmin, HttpError } from '@/lib/rbac';

// Admin-only: delete a wizard record (its onboarding_steps cascade). Used to clear
// abandoned drafts and pick-winner losers from the /onboarding list once their
// staging has been dropped. Does NOT touch any live site — only the wizard row.
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await ctx.params;
    const wid = parseInt(id, 10);
    if (!Number.isFinite(wid)) throw new HttpError(400, 'bad id');
    const r = await db.query<{ customer_name: string; staging_dropped_at: string | null }>(
      `DELETE FROM onboarding_wizards WHERE id = $1 RETURNING customer_name, staging_dropped_at`,
      [wid]
    );
    if (!r.rows.length) throw new HttpError(404, 'Wizard not found');
    return NextResponse.json({ ok: true, deleted: wid, customer_name: r.rows[0].customer_name });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error)?.message ?? 'Internal error' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const wid = parseInt(id, 10);
  if (!Number.isFinite(wid)) return NextResponse.json({ error: 'bad id' }, { status: 400 });
  const body = await req.json();
  const sets: string[] = []; const vals: unknown[] = [];
  if ('parent_company' in body) { sets.push(`parent_company = $${sets.length + 1}`); vals.push(body.parent_company); }
  if ('customer_name' in body) { sets.push(`customer_name = $${sets.length + 1}`); vals.push(body.customer_name); }
  if ('real_domain' in body) {
    const d = String(body.real_domain ?? '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/i.test(d)) return NextResponse.json({ error: 'invalid domain' }, { status: 400 });
    sets.push(`real_domain = $${sets.length + 1}`); vals.push(d);
  }
  if (!sets.length) return NextResponse.json({ ok: true });
  vals.push(wid);
  await db.query(`UPDATE onboarding_wizards SET ${sets.join(',')} WHERE id = $${vals.length}`, vals);

  // Sync customer_id from customer_name (find or create matching customer)
  if ('customer_name' in body && body.customer_name) {
    const cust = await db.query<{ id: number }>(
      `INSERT INTO customers (name) VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET updated_at = now() RETURNING id`,
      [body.customer_name]
    );
    if (body.parent_company) {
      const parent = await db.query<{ id: number }>(
        `INSERT INTO customers (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET updated_at = now() RETURNING id`,
        [body.parent_company]
      );
      await db.query(
        `UPDATE customers SET parent_customer_id = $1 WHERE id = $2 AND id != $1`,
        [parent.rows[0].id, cust.rows[0].id]
      );
    }
    await db.query(`UPDATE onboarding_wizards SET customer_id = $1 WHERE id = $2`, [cust.rows[0].id, wid]);
  }

  return NextResponse.json({ ok: true });
}
