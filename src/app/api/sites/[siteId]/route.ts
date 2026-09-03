import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ siteId: string }> }) {
  const { siteId: id } = await ctx.params;
  const body = await req.json();
  const sid = parseInt(id, 10);
  if (!Number.isFinite(sid)) return NextResponse.json({ error: 'bad id' }, { status: 400 });
  const sets: string[] = []; const vals: unknown[] = [];
  if ('parent_company' in body) { sets.push(`parent_company = $${sets.length + 1}`); vals.push(body.parent_company); }
  if ('customer_name' in body) { sets.push(`customer_name = $${sets.length + 1}`); vals.push(body.customer_name); }
  if (!sets.length) return NextResponse.json({ ok: true });
  vals.push(sid);
  await db.query(`UPDATE sites SET ${sets.join(',')}, updated_at = now() WHERE id = $${vals.length}`, vals);

  // Sync customer_id from customer_name (find or create matching customer)
  if ('customer_name' in body && body.customer_name) {
    const cust = await db.query<{ id: number }>(
      `INSERT INTO customers (name) VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET updated_at = now() RETURNING id`,
      [body.customer_name]
    );
    // If parent_company also given, link them
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
    await db.query(`UPDATE sites SET customer_id = $1 WHERE id = $2`, [cust.rows[0].id, sid]);
  }

  return NextResponse.json({ ok: true });
}
