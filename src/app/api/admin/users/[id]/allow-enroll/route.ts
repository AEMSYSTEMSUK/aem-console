import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, HttpError } from '@/lib/rbac';
import { getUserById, setEnrollAllowed } from '@/lib/users';
import { audit } from '@/lib/audit';

// Admin-only: open (or close) the one-time passkey-enrollment window for a user.
// The /api/auth/enroll routes issue a session with no prior auth, so they are
// gated on users.enroll_allowed. This is how an admin opens that window before
// inviting someone to register their first passkey; it is consumed (set back to
// false) automatically the moment enrollment completes.
// POST body: { allowed?: boolean }  (default true)
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId: actorId } = await requireAdmin();
    const { id } = await params;
    const targetId = Number(id);
    if (!Number.isInteger(targetId) || targetId <= 0) throw new HttpError(400, 'Invalid user id');

    const target = await getUserById(targetId);
    if (!target) throw new HttpError(404, 'User not found');

    const body = await req.json().catch(() => ({}));
    const allowed = body.allowed === undefined ? true : body.allowed === true;

    await setEnrollAllowed(targetId, allowed);

    await audit({
      actor_user_id: actorId,
      action: allowed ? 'user.enroll.window_opened' : 'user.enroll.window_closed',
      target_type: 'user',
      target_id: String(targetId),
      after_state: { enroll_allowed: allowed },
      ip_address: req.headers.get('x-forwarded-for') ?? null,
      user_agent: req.headers.get('user-agent') ?? null,
    });

    return NextResponse.json({ id: targetId, email: target.email, enroll_allowed: allowed });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error)?.message ?? 'Internal error' }, { status: 500 });
  }
}
