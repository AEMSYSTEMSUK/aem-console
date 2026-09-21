import { NextRequest, NextResponse } from 'next/server';
import { requireUser, HttpError } from '@/lib/rbac';
import { readFileSync, existsSync } from 'fs';
import { sweepStaleTmpStatus } from '@/lib/onboarding';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    sweepStaleTmpStatus(); // opportunistic cleanup of orphaned /tmp status files (throttled)
    const { id } = await ctx.params;
    const wid = parseInt(id, 10);
    if (!Number.isFinite(wid)) throw new HttpError(400, 'Invalid wizard ID');
    const step = parseInt(req.nextUrl.searchParams.get('step') || '0', 10);
    if (!Number.isFinite(step)) throw new HttpError(400, 'Invalid step');
    const path = `/tmp/aem-step-status-${wid}-${step}.json`;
    if (!existsSync(path)) {
      return NextResponse.json({ phase: 'idle', pct: 0, message: '' });
    }
    return NextResponse.json(JSON.parse(readFileSync(path, 'utf8')));
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error)?.message ?? 'Internal error' }, { status: 500 });
  }
}
