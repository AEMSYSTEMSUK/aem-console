import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSession } from '@/lib/sessions';
import { syncAllServers, syncServerInventory } from '@/lib/plesk-inventory';
import { audit } from '@/lib/audit';

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
    results = [await syncServerInventory(Number(serverIdParam))];
  } else {
    results = await syncAllServers();
  }

  const elapsedMs = Date.now() - startedAt;

  await audit({
    actor_user_id: sess.user_id,
    action: 'inventory.refresh.complete' as never, // type cast - new action not in AuditAction union yet
    target_type: 'inventory',
    target_id: serverIdParam ?? 'all',
    after_state: { results, elapsedMs },
    ip_address: req.headers.get('x-forwarded-for') ?? null,
    user_agent: req.headers.get('user-agent') ?? null,
  });

  return NextResponse.json({ ok: true, elapsedMs, results });
}
