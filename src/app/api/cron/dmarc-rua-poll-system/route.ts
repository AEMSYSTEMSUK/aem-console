import { NextRequest, NextResponse } from 'next/server';
import { pollDmarcRua } from '@/lib/dmarc-rua-poll';
export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-aem-cron-secret') || '';
  const expected = process.env.AEM_CRON_SECRET || '';
  if (!expected || secret !== expected) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const startedAt = Date.now();
  const result = await pollDmarcRua();
  return NextResponse.json({ elapsedMs: Date.now() - startedAt, ...result });
}
