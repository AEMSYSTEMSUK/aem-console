import { NextRequest, NextResponse } from 'next/server';
import { getCloudflareToken, findZoneForDomain, upsertARecord, upsertTxtRecord } from '@/lib/cloudflare';
import { requireAdmin, HttpError } from '@/lib/rbac';

// Admin-only reusable DNS helper — reuses the Console's existing Cloudflare
// integration (encrypted token in DB -> findZoneForDomain -> upsert).
// POST body: { name: "<fqdn>", content: "<ip-or-txt>", type?: "A"|"TXT", proxied?: boolean }
export async function POST(req: NextRequest) {
  try {
    await requireAdmin();
    const body = await req.json().catch(() => ({}));
    const name = typeof body.name === 'string' ? body.name.trim().toLowerCase() : '';
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    const type = (body.type === 'TXT' ? 'TXT' : 'A') as 'A' | 'TXT';
    const proxied = body.proxied === true;
    if (!/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/.test(name)) throw new HttpError(400, 'Invalid record name (fqdn)');
    if (!content) throw new HttpError(400, 'Missing content');
    const token = await getCloudflareToken();
    if (!token) throw new HttpError(500, 'No Cloudflare token configured');
    const zone = await findZoneForDomain(name, token);
    if (!zone) throw new HttpError(404, 'No Cloudflare zone found for ' + name);
    const result = type === 'TXT'
      ? await upsertTxtRecord(zone.id, name, content, token)
      : await upsertARecord(zone.id, name, content, token, proxied);
    return NextResponse.json({ zone_id: zone.id, type, ...result });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error)?.message ?? 'Internal error' }, { status: 500 });
  }
}
