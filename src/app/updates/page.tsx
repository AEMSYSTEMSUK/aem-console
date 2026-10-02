import { db } from '@/lib/db';
import { requireUser } from '@/lib/rbac';
import { Fragment } from 'react';
import { getAllPolicies, defaultPolicy, heldReason, type PatchPolicy, type PendingItem } from '@/lib/wp-patch-policy';
import { ScanAllButton, UpdateButton, ScanOneButton } from './buttons';
export const dynamic = 'force-dynamic';

interface Row {
  id: number; domain: string; wp_version: string | null;
  pending_plugin_updates: number | null;
  pending_theme_updates: number | null;
  pending_core_update: boolean | null;
  last_update_scan_at: string | null;
  last_job_id: number | null;
  last_job_status: string | null;
}

export default async function UpdatesPage() {
  const me = await requireUser();
  const rs = await db.query<Row>(`
    SELECT s.id, s.domain, s.wp_version,
           s.pending_plugin_updates, s.pending_theme_updates, s.pending_core_update,
           s.last_update_scan_at::text,
           j.id AS last_job_id, j.status AS last_job_status
      FROM sites s
      LEFT JOIN LATERAL (
        SELECT id, status FROM wp_update_jobs WHERE site_id = s.id ORDER BY id DESC LIMIT 1
      ) j ON true
      WHERE s.is_wordpress = true
      ORDER BY
        COALESCE(s.pending_plugin_updates, 0) + COALESCE(s.pending_theme_updates, 0) DESC,
        s.domain
  `);
  const pending = await db.query<PendingItem & { site_id: number }>(`
    SELECT site_id, kind, slug, name, current_version, new_version
      FROM wp_pending_updates
     ORDER BY site_id, CASE kind WHEN 'core' THEN 0 WHEN 'plugin' THEN 1 ELSE 2 END, lower(COALESCE(name, slug))
  `);
  const itemsBySite = new Map<number, PendingItem[]>();
  for (const it of pending.rows) {
    const list = itemsBySite.get(it.site_id) ?? [];
    list.push(it);
    itemsBySite.set(it.site_id, list);
  }
  const policies = await getAllPolicies();
  const awaiting = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM wp_patch_sites WHERE state = 'awaiting_approval'`);

  return (
    <main style={{ maxWidth: 1180, margin: '2rem auto', padding: '0 1rem', fontFamily: 'system-ui' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '1rem' }}>
        <h1 style={{ fontSize: '1.5rem', margin: 0 }}>WordPress updates</h1>
        <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center' }}>
          <span style={{ color: '#666', fontSize: '.85rem' }}>{rs.rows.length} WP sites</span>
          <a href="/updates/runs" style={{ fontSize: '.85rem', color: '#1976d2' }}>
            Patch runs{awaiting.rows[0]?.n ? ` (${awaiting.rows[0].n} awaiting approval)` : ''}
          </a>
          {me.role === 'admin' && <ScanAllButton />}
        </div>
      </header>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.9rem' }}>
        <thead>
          <tr style={{ background: '#f0f0f0', textAlign: 'left' }}>
            <th style={{ padding: '.5rem' }}>Domain</th>
            <th style={{ padding: '.5rem' }}>WP</th>
            <th style={{ padding: '.5rem' }}>Plugins</th>
            <th style={{ padding: '.5rem' }}>Themes</th>
            <th style={{ padding: '.5rem' }}>Core</th>
            <th style={{ padding: '.5rem' }}>Last scan</th>
            <th style={{ padding: '.5rem' }}>Last job</th>
            <th style={{ padding: '.5rem' }}>Policy</th>
            <th style={{ padding: '.5rem' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rs.rows.map((s) => {
            const items = itemsBySite.get(s.id) ?? [];
            const policy = policies.get(s.id) ?? defaultPolicy(s.id);
            const heldCount = items.filter(it => heldReason(it, policy)).length;
            return (
            <Fragment key={s.id}>
            <tr style={{ borderBottom: items.length ? 'none' : '1px solid #eee' }}>
              <td style={{ padding: '.5rem' }}><a href={`https://${s.domain}/`} target="_blank" rel="noreferrer">{s.domain}</a></td>
              <td style={{ padding: '.5rem', color: '#666' }}>{s.wp_version ?? '-'}</td>
              <td style={{ padding: '.5rem' }}><PendingBadge n={s.pending_plugin_updates} /></td>
              <td style={{ padding: '.5rem' }}><PendingBadge n={s.pending_theme_updates} /></td>
              <td style={{ padding: '.5rem' }}>{s.pending_core_update === true
                ? <span style={{ background: '#c62828', color: 'white', padding: '.1rem .4rem', borderRadius: 3 }}>update</span>
                : s.pending_core_update === false ? <span style={{ color: '#888' }}>ok</span> : '-'}</td>
              <td style={{ padding: '.5rem', color: '#888', fontSize: '.8rem' }}>{s.last_update_scan_at ? new Date(s.last_update_scan_at).toLocaleString() : 'never'}</td>
              <td style={{ padding: '.5rem' }}>{s.last_job_id ? <a href={`/updates/${s.last_job_id}`}>#{s.last_job_id} {s.last_job_status}</a> : <span style={{ color: '#888' }}>-</span>}</td>
              <td style={{ padding: '.5rem' }}>
                <PolicyBadges policy={policy} />
                {me.role === 'admin' && <a href={`/updates/policy/${s.id}`} style={{ fontSize: '.75rem', marginLeft: '.3rem' }}>edit</a>}
              </td>
              <td style={{ padding: '.5rem' }}>
                <div style={{ display: 'flex', gap: '.25rem' }}>
                  <ScanOneButton siteId={s.id} />
                  {me.role === 'admin' && <UpdateButton siteId={s.id} domain={s.domain} />}
                </div>
              </td>
            </tr>
            {items.length > 0 && (
              <tr style={{ borderBottom: '1px solid #eee' }}>
                <td colSpan={9} style={{ padding: '0 .5rem .5rem 1.5rem' }}>
                  <details>
                    <summary style={{ cursor: 'pointer', color: '#555', fontSize: '.8rem' }}>
                      {items.length} pending item{items.length === 1 ? '' : 's'}{heldCount ? ` (${heldCount} held)` : ''}
                    </summary>
                    <table style={{ borderCollapse: 'collapse', fontSize: '.8rem', marginTop: '.25rem' }}>
                      <tbody>
                        {items.map(it => {
                          const held = heldReason(it, policy);
                          return (
                            <tr key={`${it.kind}:${it.slug}`}>
                              <td style={{ padding: '.1rem .5rem .1rem 0', color: '#888' }}>{it.kind}</td>
                              <td style={{ padding: '.1rem .5rem' }}>{it.name ?? it.slug}</td>
                              <td style={{ padding: '.1rem .5rem', whiteSpace: 'nowrap', color: '#555' }}>{it.current_version ?? '?'} → {it.new_version ?? '?'}</td>
                              <td style={{ padding: '.1rem .5rem' }}>{held && <span style={{ background: '#ed6c02', color: 'white', padding: '.05rem .35rem', borderRadius: 3 }}>held: {held}</span>}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </details>
                </td>
              </tr>
            )}
            </Fragment>
            );
          })}
        </tbody>
      </table>
    </main>
  );
}

function PolicyBadges({ policy }: { policy: PatchPolicy }) {
  const badge = (text: string, bg: string, title?: string) => (
    <span title={title} style={{ background: bg, color: 'white', padding: '.05rem .35rem', borderRadius: 3, fontSize: '.75rem', marginRight: '.2rem', whiteSpace: 'nowrap' }}>{text}</span>
  );
  const modeColor = policy.mode === 'auto' ? '#2e7d32' : policy.mode === 'approve' ? '#1976d2' : '#757575';
  const ringColor = policy.ring === 'pilot' ? '#6a1b9a' : policy.ring === 'flagship' ? '#ad1457' : '#757575';
  return (
    <span style={{ opacity: policy.is_default ? 0.6 : 1 }} title={policy.is_default ? 'Default policy (not saved)' : undefined}>
      {!policy.enabled && badge('disabled', '#c62828')}
      {badge(policy.mode, modeColor)}
      {badge(policy.ring, ringColor)}
      {policy.exclude_slugs.length > 0 && badge(`${policy.exclude_slugs.length} excl`, '#ed6c02', policy.exclude_slugs.join(', '))}
    </span>
  );
}

function PendingBadge({ n }: { n: number | null }) {
  if (n === null) return <span style={{ color: '#888' }}>-</span>;
  if (n === 0)    return <span style={{ color: '#2e7d32' }}>ok</span>;
  const color = n >= 5 ? '#c62828' : n >= 2 ? '#ed6c02' : '#1976d2';
  return <span style={{ background: color, color: 'white', padding: '.1rem .4rem', borderRadius: 3, fontSize: '.85rem' }}>{n}</span>;
}
