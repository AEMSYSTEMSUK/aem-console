import { NextRequest, NextResponse } from 'next/server';
import { destroySession } from '@/lib/sessions';
import { audit } from '@/lib/audit';
import { parse, serialize } from 'cookie';
import { getSession } from '@/lib/sessions';

export async function POST(req: NextRequest) {
  const cookies = parse(req.headers.get('cookie') || '');
  const sessionId = cookies.aem_session;
  if (sessionId) {
    const sess = await getSession(sessionId);
    if (sess) {
      await audit({
        actor_user_id: sess.user_id,
        action: 'user.logout',
        ip_address: req.headers.get('x-forwarded-for') ?? null,
        user_agent: req.headers.get('user-agent') ?? null,
      });
    }
    await destroySession(sessionId);
  }

  const cookie = serialize('aem_session', '', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });

  return NextResponse.json({ ok: true }, { headers: { 'Set-Cookie': cookie } });
}
