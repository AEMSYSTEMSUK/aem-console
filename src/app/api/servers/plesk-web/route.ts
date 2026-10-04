import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/rbac';
import { db } from '@/lib/db';

export async function GET() {
  try { await requireUser(); } catch (e) { return NextResponse.json({ error: (e as Error)?.message || 'Unauthorized' }, { status: (e as { status?: number })?.status || 401 }); }
  const { rows } = await db.query<{ id: number; name: string; fqdn: string }>(
    `SELECT id, name, fqdn FROM servers
     WHERE role = 'plesk-web' AND enabled = true
     ORDER BY id`
  );
  return NextResponse.json({ servers: rows });
}
