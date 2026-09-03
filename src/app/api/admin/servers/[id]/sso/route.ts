import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { sshExec } from '@/lib/ssh';
import { requireUser, HttpError } from '@/lib/rbac';

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { userId, role } = await requireUser();
    if (role !== 'admin') throw new HttpError(403, 'Admin role required');
    const { id } = await ctx.params;
    const sid = parseInt(id, 10);
    if (!Number.isFinite(sid)) throw new HttpError(400, 'Invalid server ID');

    const s = await db.query<{ name: string; fqdn: string; role: string }>(
      `SELECT name, fqdn, role FROM servers WHERE id = $1 AND enabled = true`, [sid]);
    if (s.rows.length === 0) throw new HttpError(404, 'Server not found');
    const { name, fqdn, role: serverRole } = s.rows[0];
    if (!serverRole.startsWith('plesk-')) {
      throw new HttpError(400, `${name} is role=${serverRole}, no Plesk panel to SSO into`);
    }

    const r = await sshExec(fqdn, 'plesk login admin 2>&1', 15);
    if (!r.ok) throw new HttpError(500, `plesk login failed: ${r.stdout || r.stderr || r.error}`);
    // Plesk login returns URL with whatever Plesk panel hostname is configured
    // (e.g. customer-branded aemstaging.co.uk). The secret is hostname-agnostic
    // on Plesk's side — rewrite host to the FQDN Console knows for this server.
    const m = r.stdout.match(/https:\/\/[^\/]+(\/login\?secret=[A-Za-z0-9_\-]+)/);
    if (!m) throw new HttpError(500, `Could not parse SSO URL from: ${r.stdout.slice(0, 200)}`);
    const url = `https://${fqdn}:8443${m[1]}`;

    // Audit (do NOT log the URL — contains the secret)
    await db.query(
      `INSERT INTO audit_log (actor_user_id, action, target_type, target_id)
       VALUES ($1, 'plesk_sso', 'server', $2)`,
      [userId, String(sid)]).catch(() => {});

    return NextResponse.json({ url });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error)?.message ?? 'Internal' }, { status: 500 });
  }
}
