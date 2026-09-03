// /opt/aem-console/src/app/api/onboarding/[id]/export/download/route.ts
//
// Authenticated download of a previously-generated export bundle.
import { NextRequest, NextResponse } from 'next/server';
import { requireUser, HttpError } from '@/lib/rbac';
import { readFileSync, existsSync } from 'fs';
import { join, basename } from 'path';

const EXPORT_DIR = '/var/aem-exports';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    const { id } = await ctx.params;
    const wizardId = parseInt(id, 10);
    if (!Number.isFinite(wizardId)) throw new HttpError(400, 'Invalid wizard ID');

    const file = req.nextUrl.searchParams.get('file') || '';
    // Sanitize: no path separators, must start with the expected prefix
    if (!file || file.includes('/') || file.includes('..') || !file.startsWith(`wizard-${wizardId}-`)) {
      throw new HttpError(400, 'Bad filename');
    }
    const fullPath = join(EXPORT_DIR, basename(file));
    if (!existsSync(fullPath)) throw new HttpError(404, 'Export not found');
    const data = readFileSync(fullPath);
    return new NextResponse(data, {
      status: 200,
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${file}"`,
        'Content-Length': String(data.length),
      },
    });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error)?.message ?? 'Internal error' }, { status: 500 });
  }
}
