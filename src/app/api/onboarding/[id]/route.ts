import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

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
