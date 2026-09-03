import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSession } from '@/lib/sessions';
import { probeAllServers, probeServerBackup, recordBackupHealth } from '@/lib/backup-health';

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
    const snap = await probeServerBackup(Number(serverIdParam));
    await recordBackupHealth(snap);
    results = [snap];
  } else {
    results = await probeAllServers();
  }
  return NextResponse.json({ ok: true, elapsedMs: Date.now() - startedAt, results });
}
