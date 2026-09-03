import { db } from '@/lib/db';
import { requireUser } from '@/lib/rbac';
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

  return (
    <main style={{ maxWidth: 1180, margin: '2rem auto', padding: '0 1rem', fontFamily: 'system-ui' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '1rem' }}>
        <h1 style={{ fontSize: '1.5rem', margin: 0 }}>WordPress updates</h1>
        <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center' }}>
          <span style={{ color: '#666', fontSize: '.85rem' }}>{rs.rows.length} WP sites</span>
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
            <th style={{ padding: '.5rem' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rs.rows.map((s) => (
            <tr key={s.id} style={{ borderBottom: '1px solid #eee' }}>
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
                <div style={{ display: 'flex', gap: '.25rem' }}>
                  <ScanOneButton siteId={s.id} />
                  {me.role === 'admin' && <UpdateButton siteId={s.id} domain={s.domain} />}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

function PendingBadge({ n }: { n: number | null }) {
  if (n === null) return <span style={{ color: '#888' }}>-</span>;
  if (n === 0)    return <span style={{ color: '#2e7d32' }}>ok</span>;
  const color = n >= 5 ? '#c62828' : n >= 2 ? '#ed6c02' : '#1976d2';
  return <span style={{ background: color, color: 'white', padding: '.1rem .4rem', borderRadius: 3, fontSize: '.85rem' }}>{n}</span>;
}
