import { NextRequest, NextResponse } from 'next/server';
import { scanFleet, sweepOrphanedUpdateJobs } from '@/lib/wp-updates';
import { startFastTrack, sweepOrphanedPatchSites } from '@/lib/wp-patch/engine';

// #220 — nightly itemised WP update scan (aem-console-wp-update-scan.timer). Synchronous: the timer's curl waits
// for the whole fleet scan and logs the counts to the journal. After the scan it runs the #220 security fast-track
// check, which starts its own background run if any site has a pending security update (it never blocks the scan).
export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-aem-cron-secret') || '';
  const expected = process.env.AEM_CRON_SECRET || '';
  if (!expected || secret !== expected) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const startedAt = Date.now();
  const orphaned = await sweepOrphanedUpdateJobs();
  const result = await scanFleet();
  const elapsedMs = Date.now() - startedAt;
  let fasttrack: unknown;
  try {
    const patchOrphans = await sweepOrphanedPatchSites();
    const ft = await startFastTrack('scan');
    fasttrack = { ...ft, patchOrphans };
  } catch (e) {
    fasttrack = { ok: false, error: (e as Error)?.message ?? String(e) };
  }
  return NextResponse.json({ ok: true, elapsedMs, ...result, orphaned: orphaned + result.orphaned, fasttrack });
}
