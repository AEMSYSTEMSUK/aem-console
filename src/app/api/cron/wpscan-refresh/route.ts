import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSession } from '@/lib/sessions';
import { uniqueInstalledSlugs, refreshSlugs } from '@/lib/wpscan';
import { matchWpScanInstalled } from '@/lib/wpscan-matcher';

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get('aem_session')?.value;
  let isUser = false;
  if (sessionId) {
    const sess = await getSession(sessionId);
    if (sess) isUser = true;
  }
  if (!isUser) {
    const secret = req.headers.get('x-aem-cron-secret') || '';
    const expected = process.env.AEM_CRON_SECRET || '';
    if (!expected || secret !== expected) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const slugs = await uniqueInstalledSlugs();
  const refresh = await refreshSlugs(slugs, 75);
  const m = await matchWpScanInstalled();
  if (isUser) {
    const proto = req.headers.get('x-forwarded-proto') || 'https';
    const host = req.headers.get('host') || 'bastion.infra.aemsystems.co.uk';
    return NextResponse.redirect(`${proto}://${host}/admin/wpscan?refreshed=1`, 303);
  }
  return NextResponse.json({ ok: true, refreshed: refresh.length, matches: m });
}
