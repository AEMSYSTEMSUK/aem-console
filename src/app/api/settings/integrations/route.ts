import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { encrypt } from '@/lib/crypto';
import { requireAdmin, HttpError } from '@/lib/rbac';
import { verifyToken } from '@/lib/cloudflare';

export async function POST(req: NextRequest) {
  try {
    await requireAdmin();
    const body = await req.json();
    const type = String(body.type ?? '');
    const token = String(body.token ?? '');
    if (!type || !token) throw new HttpError(400, 'type and token required');
    if (!['cloudflare', 'wpscan'].includes(type)) throw new HttpError(400, `Unknown integration type: ${type}`);

    // Verify token if Cloudflare
    if (type === 'cloudflare') {
      const v = await verifyToken(token);
      if (!v.ok) throw new HttpError(400, `Cloudflare token rejected: ${v.error}`);
    }

    const enc = encrypt(token);
    // Insert as new row (versioned — Step 7 reads ORDER BY id DESC LIMIT 1, so always uses latest)
    await db.query(
      `INSERT INTO integration_tokens (type, encrypted_token, server_id) VALUES ($1, $2, NULL)`,
      [type, enc]
    );

    return NextResponse.json({ ok: true, type, message: 'Token stored. AEM Console will use it on next call.' });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error)?.message ?? 'Internal error' }, { status: 500 });
  }
}

export async function GET() {
  try {
    await requireAdmin();
    const r = await db.query<{ type: string; created_at: string; server_id: number | null }>(
      `SELECT DISTINCT ON (type) type, created_at, server_id FROM integration_tokens ORDER BY type, id DESC`
    );
    return NextResponse.json({ tokens: r.rows });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error)?.message ?? 'Internal error' }, { status: 500 });
  }
}
