import { NextRequest, NextResponse } from 'next/server';
import { scanFleet } from '@/lib/wp-updates';
import { requireUser, HttpError } from '@/lib/rbac';
export async function POST(_req: NextRequest) {
  try {
    const { role } = await requireUser();
    if (role !== 'admin') throw new HttpError(403, 'Admin role required');
    // background — return immediately with started flag
    void scanFleet().catch(e => console.error('scanFleet error:', e));
    return NextResponse.json({ started: true });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error)?.message ?? 'Internal' }, { status: 500 });
  }
}
