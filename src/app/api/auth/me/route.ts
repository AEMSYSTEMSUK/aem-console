import { NextRequest, NextResponse } from 'next/server';
import { parse } from 'cookie';
import { getSession } from '@/lib/sessions';
import { getUserById } from '@/lib/users';

export async function GET(req: NextRequest) {
  const cookies = parse(req.headers.get('cookie') || '');
  const sessionId = cookies.aem_session;
  if (!sessionId) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
  const sess = await getSession(sessionId);
  if (!sess) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
  const user = await getUserById(sess.user_id);
  if (!user) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
  return NextResponse.json({
    authenticated: true,
    user: { id: user.id, email: user.email, display_name: user.display_name },
    session: { expires_at: sess.expires_at },
  });
}
