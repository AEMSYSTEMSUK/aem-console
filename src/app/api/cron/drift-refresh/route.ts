import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSession } from '@/lib/sessions';
import { runAllChecksAllServers, runAllChecksForServer } from '@/lib/drift';

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get('aem_session')?.value;
  if (!sessionId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const sess = await getSession(sessionId);
  if (!sess) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

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
  return NextResponse.json({ ok: true, elapsedMs, results });
}
