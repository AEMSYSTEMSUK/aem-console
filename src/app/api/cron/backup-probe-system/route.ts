import { NextRequest, NextResponse } from 'next/server';
import { probeAllServers } from '@/lib/backup-health';

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-aem-cron-secret') || '';
  const expected = process.env.AEM_CRON_SECRET || '';
  if (!expected || secret !== expected) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const startedAt = Date.now();
  const results = await probeAllServers();
  const elapsedMs = Date.now() - startedAt;
  return NextResponse.json({ ok: true, elapsedMs, results });
}
