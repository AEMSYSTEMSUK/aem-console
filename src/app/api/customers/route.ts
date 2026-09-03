import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get('q') || '').trim().toLowerCase();
  const params: unknown[] = [];
  let sql = `SELECT c.id, c.name, c.parent_customer_id, p.name AS parent_name
             FROM customers c LEFT JOIN customers p ON c.parent_customer_id = p.id`;
  if (q) {
    sql += ` WHERE LOWER(c.name) LIKE $1 OR LOWER(COALESCE(p.name,'')) LIKE $1`;
    params.push(`%${q}%`);
  }
  sql += ` ORDER BY COALESCE(p.name, c.name), c.name LIMIT 200`;
  const { rows } = await db.query(sql, params);
  return NextResponse.json({ customers: rows });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const name = (body.name || '').trim();
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 });
  const parentId = body.parent_customer_id ?? null;
  const r = await db.query<{ id: number }>(
    `INSERT INTO customers (name, parent_customer_id) VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET updated_at = now() RETURNING id`,
    [name, parentId]
  );
  return NextResponse.json({ id: r.rows[0].id, name });
}
