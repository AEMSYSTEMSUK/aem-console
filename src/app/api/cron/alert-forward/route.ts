import { NextRequest, NextResponse } from 'next/server';
import { forwardCriticalAlerts } from '@/lib/alerts';

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-aem-cron-secret');
  if (!secret || secret !== process.env.AEM_CRON_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    const result = await forwardCriticalAlerts();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ error: (e as Error)?.message ?? 'Internal error' }, { status: 500 });
  }
}
