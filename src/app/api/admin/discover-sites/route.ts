import { NextRequest, NextResponse } from 'next/server';
import { discoverAllSites } from '@/lib/wp-discover';
import { requireUser, HttpError } from '@/lib/rbac';

// POST /api/admin/discover-sites — SSH each Plesk server, list its WP-Toolkit installs, and register them
// as sites so they appear in Customer Sites and support wp-admin SSO — no more manual adds. Admin only.
export async function POST(_req: NextRequest) {
  try {
    const { role } = await requireUser();
    if (role !== 'admin') throw new HttpError(403, 'Admin role required');
    const summary = await discoverAllSites();
    return NextResponse.json(summary);
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error)?.message ?? 'Internal' }, { status: 500 });
  }
}
