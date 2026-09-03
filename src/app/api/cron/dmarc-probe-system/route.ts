import { NextRequest, NextResponse } from 'next/server';
import { probeAllDomains } from '@/lib/dmarc-probe';

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-aem-cron-secret') || '';
  const expected = process.env.AEM_CRON_SECRET || '';
  if (!expected || secret !== expected) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const started = Date.now();
  const results = await probeAllDomains();
  const summary = results.reduce((acc: Record<string, number>, r) => { acc[r.severity] = (acc[r.severity] || 0) + 1; return acc; }, {});
  return NextResponse.json({ ok: true, elapsedMs: Date.now() - started, total: results.length, summary });
}
