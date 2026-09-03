import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, HttpError } from '@/lib/rbac';
import { addServerException, removeServerException } from '@/lib/drift';

export async function POST(req: NextRequest) {
  try {
    const { userId } = await requireAdmin();
    const body = await req.json().catch(() => ({}));
    const serverId = Number(body.server_id);
    const standardId = Number(body.standard_id);
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    const expiresAt = typeof body.expires_at === 'string' && body.expires_at ? body.expires_at : null;
    if (!Number.isInteger(serverId) || !Number.isInteger(standardId)) throw new HttpError(400, 'server_id and standard_id required');
    if (!reason) throw new HttpError(400, 'reason required');
    await addServerException(serverId, standardId, reason, userId, expiresAt);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error)?.message ?? 'Internal error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await requireAdmin();
    const body = await req.json().catch(() => ({}));
    const id = Number(body.id);
    if (!Number.isInteger(id)) throw new HttpError(400, 'id required');
    await removeServerException(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error)?.message ?? 'Internal error' }, { status: 500 });
  }
}
