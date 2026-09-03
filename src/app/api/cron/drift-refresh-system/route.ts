import { NextRequest, NextResponse } from 'next/server';
import { runAllChecksAllServers, runAllChecksForServer } from '@/lib/drift';

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-aem-cron-secret') || '';
  const expected = process.env.AEM_CRON_SECRET || '';
  if (!expected || secret !== expected) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const url = new URL(req.url);
  const serverIdParam = url.searchParams.get('server_id');
  const startedAt = Date.now();
  let results;
  if (serverIdParam) {
    results = [{ server_id: Number(serverIdParam), results: await runAllChecksForServer(Number(serverIdParam)) }];
  } else {
    results = await runAllChecksAllServers();
  }
  const elapsedMs = Date.now() - startedAt;
  const summary = results.flatMap(s => s.results).reduce((acc: Record<string, number>, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
  return NextResponse.json({ ok: true, elapsedMs, summary, total: results.flatMap(s => s.results).length });
}
