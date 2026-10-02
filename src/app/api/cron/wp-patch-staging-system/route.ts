import { NextRequest, NextResponse } from 'next/server';
import { startStagingRun, sweepOrphanedPatchSites } from '@/lib/wp-patch/engine';

// #220 phase 2 — Monday 06:00 Europe/London staging run (aem-console-wp-patch-staging.timer). Starts the run in
// the background and returns its id at once; progress is on /updates/runs/<id>.
export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-aem-cron-secret') || '';
  const expected = process.env.AEM_CRON_SECRET || '';
  if (!expected || secret !== expected) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const orphaned = await sweepOrphanedPatchSites();
  const r = await startStagingRun('timer');
  if (!r.ok) return NextResponse.json({ ok: false, reason: r.reason, orphaned }, { status: 409 });
  return NextResponse.json({ ok: true, runId: r.runId, orphaned });
}
