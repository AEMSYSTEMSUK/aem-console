import { NextRequest, NextResponse } from 'next/server';
import { startLiveRun, sweepOrphanedPatchSites } from '@/lib/wp-patch/engine';

// #220 phase 2 — Tuesday 06:00 Europe/London live run (aem-console-wp-patch-live.timer). Promotes every site whose
// staging passed and is approved (auto or staff). Starts in the background and returns the run id at once.
export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-aem-cron-secret') || '';
  const expected = process.env.AEM_CRON_SECRET || '';
  if (!expected || secret !== expected) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const orphaned = await sweepOrphanedPatchSites();
  const r = await startLiveRun('timer');
  if (!r.ok) return NextResponse.json({ ok: false, reason: r.reason, orphaned }, { status: 409 });
  return NextResponse.json({ ok: true, runId: r.runId, orphaned });
}
