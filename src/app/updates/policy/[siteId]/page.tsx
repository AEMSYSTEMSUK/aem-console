import { db } from '@/lib/db';
import { requireUser } from '@/lib/rbac';
import { notFound } from 'next/navigation';
import { getPolicy, heldReason, type PendingItem } from '@/lib/wp-patch-policy';
import { PolicyForm } from './form';
export const dynamic = 'force-dynamic';

export default async function PatchPolicyPage({ params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  const sid = parseInt(siteId, 10);
  if (!Number.isFinite(sid)) notFound();
  const me = await requireUser();
  const back = <p style={{ margin: 0 }}><a href="/updates" style={{ color: '#1976d2', fontSize: '.85rem', textDecoration: 'none' }}>← Back to WP updates</a></p>;
  if (me.role !== 'admin') {
    return (
      <main style={{ maxWidth: 980, margin: '2rem auto', padding: '0 1rem', fontFamily: 'system-ui' }}>
        {back}
        <h1>Patch policy</h1>
        <p style={{ color: '#c62828' }}>Admin role required.</p>
      </main>
    );
  }

  const s = await db.query<{ id: number; domain: string }>(
    `SELECT id, domain FROM sites WHERE id = $1 AND is_wordpress = true`, [sid]);
  if (s.rows.length === 0) notFound();
  const site = s.rows[0];
  const policy = await getPolicy(sid);
  const items = await db.query<PendingItem>(
    `SELECT kind, slug, name, current_version, new_version FROM wp_pending_updates
      WHERE site_id = $1 ORDER BY kind, name`, [sid]);

  return (
    <main style={{ maxWidth: 980, margin: '2rem auto', padding: '0 1rem', fontFamily: 'system-ui' }}>
      {back}
      <h1 style={{ marginBottom: '.25rem' }}>Patch policy</h1>
      <p style={{ color: '#666', marginTop: 0 }}>
        {site.domain} · {policy.is_default ? 'defaults (not saved yet)' : `last saved ${policy.updated_at ? new Date(policy.updated_at).toLocaleString() : ''}`}
      </p>
      <p style={{ color: '#888', fontSize: '.8rem' }}>
        Used by the staged-patching engine (#220): Monday 06:00 staging run, Tuesday 06:00 live run, same-day fast-track for
        security fixes. Held items (excluded slugs, held core majors) are never applied. See <a href="/updates/runs">patch runs</a>.
      </p>
      <div style={{ display: 'flex', gap: '2rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <PolicyForm siteId={sid} initial={{
          enabled: policy.enabled, mode: policy.mode, ring: policy.ring, exclude_slugs: policy.exclude_slugs,
          hold_core_major: policy.hold_core_major, smoke_paths: policy.smoke_paths, expect_text: policy.expect_text,
          is_woocommerce: policy.is_woocommerce, client_approval: policy.client_approval, notes: policy.notes,
        }} />
        <section style={{ flex: 1, minWidth: 280 }}>
          <h2 style={{ fontSize: '1rem', marginTop: 0 }}>Pending updates ({items.rows.length})</h2>
          {items.rows.length === 0
            ? <p style={{ color: '#888', fontSize: '.85rem' }}>None recorded. Run a scan from the updates page.</p>
            : <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.8rem' }}>
                <tbody>
                  {items.rows.map(it => {
                    const held = heldReason(it, policy);
                    return (
                      <tr key={`${it.kind}:${it.slug}`} style={{ borderBottom: '1px solid #eee' }}>
                        <td style={{ padding: '.25rem', color: '#888' }}>{it.kind}</td>
                        <td style={{ padding: '.25rem' }}>{it.name ?? it.slug} <span style={{ color: '#888', fontFamily: 'monospace' }}>{it.slug}</span></td>
                        <td style={{ padding: '.25rem', whiteSpace: 'nowrap' }}>{it.current_version ?? '?'} → {it.new_version ?? '?'}</td>
                        <td style={{ padding: '.25rem' }}>{held && <span style={{ background: '#ed6c02', color: 'white', padding: '.05rem .35rem', borderRadius: 3 }}>held: {held}</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>}
        </section>
      </div>
    </main>
  );
}
