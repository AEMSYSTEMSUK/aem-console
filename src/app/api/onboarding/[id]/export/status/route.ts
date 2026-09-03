import { NextRequest, NextResponse } from 'next/server';
import { requireUser, HttpError } from '@/lib/rbac';
import { readFileSync, existsSync } from 'fs';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    const { id } = await ctx.params;
    const wid = parseInt(id, 10);
    if (!Number.isFinite(wid)) throw new HttpError(400, 'Invalid wizard ID');
    const statusPath = `/tmp/aem-export-status-${wid}.json`;
    if (!existsSync(statusPath)) {
      return NextResponse.json({ phase: 'idle', pct: 0, message: 'No export in flight' });
    }
    const data = JSON.parse(readFileSync(statusPath, 'utf8'));
    return NextResponse.json(data);
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error)?.message ?? 'Internal error' }, { status: 500 });
  }
}
