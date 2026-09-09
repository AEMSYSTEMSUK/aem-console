import { NextRequest, NextResponse } from 'next/server';
import { dropDueStaging } from '@/lib/onboarding';

// Daily sweep: drops staging for any completed wizard whose scheduled
// staging_drop_at has passed. Guarded by the shared cron secret, same as the
// other /api/cron/*-system routes. Install as a daily cron/systemd timer on the
// bastion:
//   curl -fsS -X POST -H "x-aem-cron-secret: $AEM_CRON_SECRET" \
//     http://127.0.0.1:<port>/api/cron/drop-staging-system
export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-aem-cron-secret') || '';
  const expected = process.env.AEM_CRON_SECRET || '';
  if (!expected || secret !== expected) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const startedAt = Date.now();
  const result = await dropDueStaging();
  const elapsedMs = Date.now() - startedAt;
  return NextResponse.json({ ok: true, elapsedMs, ...result });
}
