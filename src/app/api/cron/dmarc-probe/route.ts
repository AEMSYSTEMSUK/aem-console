import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSession } from '@/lib/sessions';
import { probeAllDomains } from '@/lib/dmarc-probe';

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get('aem_session')?.value;
  if (!sessionId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const sess = await getSession(sessionId);
  if (!sess) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const started = Date.now();
  const results = await probeAllDomains();
  const summary = results.reduce((acc: Record<string, number>, r) => { acc[r.severity] = (acc[r.severity] || 0) + 1; return acc; }, {});
  return NextResponse.json({ ok: true, elapsedMs: Date.now() - started, total: results.length, summary });
}
