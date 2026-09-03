import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET() {
  const { rows } = await db.query<{ id: number; name: string; fqdn: string }>(
    `SELECT id, name, fqdn FROM servers
     WHERE role = 'plesk-web' AND enabled = true
     ORDER BY id`
  );
  return NextResponse.json({ servers: rows });
}
