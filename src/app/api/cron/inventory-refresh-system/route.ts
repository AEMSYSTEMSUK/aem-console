import { NextRequest, NextResponse } from 'next/server';
import { syncAllServers } from '@/lib/plesk-inventory';
import { audit } from '@/lib/audit';

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-aem-cron-secret') || '';
  const expected = process.env.AEM_CRON_SECRET || '';
  if (!expected || secret !== expected) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const startedAt = Date.now();
  const results = await syncAllServers();
  const elapsedMs = Date.now() - startedAt;
  await audit({
    actor_user_id: null,
    action: 'inventory.refresh.complete' as never,
    target_type: 'inventory',
    target_id: 'cron-all',
    after_state: { results, elapsedMs },
  });
  return NextResponse.json({ ok: true, elapsedMs, results });
}
