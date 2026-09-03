import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSession } from '@/lib/sessions';
import { pollAlertSink } from '@/lib/imap-poller';

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get('aem_session')?.value;
  if (!sessionId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const sess = await getSession(sessionId);
  if (!sess) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const startedAt = Date.now();
  const result = await pollAlertSink();
  return NextResponse.json({ elapsedMs: Date.now() - startedAt, ...result });
}
