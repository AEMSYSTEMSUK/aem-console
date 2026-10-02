import { NextRequest, NextResponse } from 'next/server';
import { startFastTrack } from '@/lib/wp-patch/engine';

// #220 phase 2 — security fast-track check. The nightly scan route calls startFastTrack() itself after scanning;
// this route exists to run the check by hand (or from its own timer). Returns runId null when there's nothing to do.
export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-aem-cron-secret') || '';
  const expected = process.env.AEM_CRON_SECRET || '';
  if (!expected || secret !== expected) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const r = await startFastTrack('timer');
  if (!r.ok) return NextResponse.json({ ok: false, reason: r.reason }, { status: 409 });
  return NextResponse.json(r);
}
