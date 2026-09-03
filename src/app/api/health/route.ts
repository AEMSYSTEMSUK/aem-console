import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET() {
  try {
    const res = await db.query<{ now: string; version: string; current_user: string; current_database: string }>(
      `SELECT now()::text AS now, version() AS version, current_user, current_database()`
    );
    const row = res.rows[0];
    return NextResponse.json({
      status: 'ok',
      app: 'aem-console',
      db: { connected: true, server_time: row.now, version: row.version, user: row.current_user, database: row.current_database },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json({
      status: 'degraded',
      app: 'aem-console',
      db: { connected: false, error: err instanceof Error ? err.message : String(err) },
      timestamp: new Date().toISOString(),
    }, { status: 500 });
  }
}
