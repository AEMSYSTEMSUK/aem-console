import { NextRequest, NextResponse } from 'next/server';
import { createWizard, runStep, getWizard } from '@/lib/onboarding';
import { requireUser, HttpError } from '@/lib/rbac';

export async function POST(req: NextRequest) {
  try {
    const { userId } = await requireUser();
    const body = await req.json();
    const parent_company = body.parent_company ? String(body.parent_company).trim() : null;
    const customer_name = String(body.customer_name ?? '').trim();
    const wizardId = await createWizard({
      customer_name,
      customer_contact_email: String(body.customer_contact_email ?? ''),
      staging_slug: String(body.staging_slug ?? ''),
      real_domain: String(body.real_domain ?? ''),
      overwrite_existing: !!body.overwrite_existing,
      wizard_group_id: body.wizard_group_id ? parseInt(String(body.wizard_group_id), 10) : null,
      parent_company,
      target_live_server: body.target_live_server ? String(body.target_live_server) : 'live1',
      dns_provider: body.dns_provider ? String(body.dns_provider) : 'cloudflare',
      refresh_mode: !!body.refresh_mode,
      staging_source: body.staging_source === 'clone_from_live' ? 'clone_from_live' : 'fresh',
      staging_server: body.staging_server ? String(body.staging_server) : 'staging1',
      staging_url_override: body.staging_url_override ? String(body.staging_url_override) : null,
    }, userId);

    // Sync customer_id (find or create matching customer hierarchy)
    if (customer_name) {
      const { db } = await import('@/lib/db');
      const cust = await db.query<{ id: number }>(
        `INSERT INTO customers (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET updated_at = now() RETURNING id`,
        [customer_name]
      );
      if (parent_company) {
        const parent = await db.query<{ id: number }>(
          `INSERT INTO customers (name) VALUES ($1)
           ON CONFLICT (name) DO UPDATE SET updated_at = now() RETURNING id`,
          [parent_company]
        );
        await db.query(
          `UPDATE customers SET parent_customer_id = $1 WHERE id = $2 AND id != $1`,
          [parent.rows[0].id, cust.rows[0].id]
        );
      }
      await db.query(`UPDATE onboarding_wizards SET customer_id = $1 WHERE id = $2`, [cust.rows[0].id, wizardId]);
    }

    // Run Steps 1, 2, 3 sequentially. Pause if any fails.
    for (const n of [1, 2]) {  // Step 3 is web-team-triggered ('Mark site as ready')
      const r = await runStep(wizardId, n);
      if (r.status !== 'success') break;
    }

    const data = await getWizard(wizardId);
    return NextResponse.json({ wizard_id: wizardId, ...data });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error)?.message ?? 'Internal error' }, { status: 500 });
  }
}
