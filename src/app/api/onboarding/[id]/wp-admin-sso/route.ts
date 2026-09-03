import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireUser, HttpError } from '@/lib/rbac';
import { readFileSync } from 'fs';
import { createHmac } from 'crypto';

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { userId, role } = await requireUser();
    if (role !== 'admin') throw new HttpError(403, 'Admin role required');
    const { id } = await ctx.params;
    const wid = parseInt(id, 10);
    if (!Number.isFinite(wid)) throw new HttpError(400, 'Invalid wizard ID');

    const w = await db.query<{ staging_slug: string; staging_url_override: string | null; wp_admin_user_id: number | null }>(
      `SELECT staging_slug, staging_url_override, wp_admin_user_id FROM onboarding_wizards WHERE id = $1`, [wid]);
    if (w.rows.length === 0) throw new HttpError(404, 'Wizard not found');
    const host = w.rows[0].staging_url_override
    ? new URL(w.rows[0].staging_url_override).host
    : `${w.rows[0].staging_slug}.aemstaging.co.uk`;
    const user_id_resolved = w.rows[0].wp_admin_user_id ?? 1;

    let secret: string;
    try { secret = readFileSync('/etc/aem-console/auto-login.key', 'utf8').trim(); }
    catch { throw new HttpError(500, 'Auto-login secret not configured on this host'); }
    if (!secret) throw new HttpError(500, 'Auto-login secret empty');

    // Hardcoded user_id=1 for now (matches what the installer probes typically).
    // If a site has a different admin user_id, the mu-plugin will reject and fall through to wp-login.php.
    const user_id = user_id_resolved;
    const expiry  = Math.floor(Date.now() / 1000) + 120; // valid 2 min
    const payload = `${user_id}.${expiry}`;
    const hmac    = createHmac('sha256', secret).update(payload).digest('hex');
    const url     = `https://${host}/?aem_login=${user_id}.${expiry}.${hmac}`;

    await db.query(
      `INSERT INTO audit_log (actor_user_id, action, target_type, target_id) VALUES ($1, 'wp_admin_sso', 'wizard', $2)`,
      [userId, String(wid)]).catch(() => {});

    return NextResponse.json({ url });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error)?.message ?? 'Internal' }, { status: 500 });
  }
}
