import { NextRequest, NextResponse } from 'next/server';
import { scanFleet, sweepOrphanedUpdateJobs } from '@/lib/wp-updates';

// #220 — nightly itemised WP update scan (aem-console-wp-update-scan.timer). Synchronous: the timer's curl waits
// for the whole fleet scan and logs the counts to the journal.
export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-aem-cron-secret') || '';
  const expected = process.env.AEM_CRON_SECRET || '';
  if (!expected || secret !== expected) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const startedAt = Date.now();
  const orphaned = await sweepOrphanedUpdateJobs();
  const result = await scanFleet();
  const elapsedMs = Date.now() - startedAt;
  return NextResponse.json({ ok: true, elapsedMs, ...result, orphaned: orphaned + result.orphaned });
}
