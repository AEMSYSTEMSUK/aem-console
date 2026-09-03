import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSession } from '@/lib/sessions';
import { acknowledgeAlert } from '@/lib/alerts';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get('aem_session')?.value;
  if (!sessionId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const sess = await getSession(sessionId);
  if (!sess) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await ctx.params;
  await acknowledgeAlert(Number(id), sess.user_id);
  return NextResponse.json({ ok: true });
}
