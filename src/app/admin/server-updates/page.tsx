import { db } from '@/lib/db';
import { requireUser } from '@/lib/rbac';
import { isEligible } from '@/lib/server-updates';
import { ScanAllServersButton, ScanServerButton, UpgradeServerButton, PleskSsoButton } from './buttons';
export const dynamic = 'force-dynamic';

interface Row {
  id: number; name: string; fqdn: string; role: string; enabled: boolean;
  pending_packages_count: number | null;
  pending_kernel_count: number | null;
  reboot_required: boolean | null;
  last_apt_scan_at: string | null;
  last_job_id: number | null;
  last_job_status: string | null;
}

export default async function ServerUpdatesPage() {
  const me = await requireUser();
  const rs = await db.query<Row>(`
    SELECT s.id, s.name, s.fqdn, s.role, s.enabled,
           s.pending_packages_count, s.pending_kernel_count, s.reboot_required,
           s.last_apt_scan_at::text,
           j.id AS last_job_id, j.status AS last_job_status
      FROM servers s
      LEFT JOIN LATERAL (
        SELECT id, status FROM server_update_jobs WHERE server_id = s.id ORDER BY id DESC LIMIT 1
      ) j ON true
      WHERE s.enabled = true
      ORDER BY s.id
  `);
  return (
    <main style={{ maxWidth: 1180, margin: '2rem auto', padding: '0 1rem', fontFamily: 'system-ui' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '1rem' }}>
        <h1 style={{ fontSize: '1.5rem', margin: 0 }}>Server updates</h1>
        <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center' }}>
          <span style={{ color: '#666', fontSize: '.85rem' }}>{rs.rows.length} servers</span>
          {me.role === 'admin' && <ScanAllServersButton />}
        </div>
      </header>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.9rem' }}>
        <thead>
          <tr style={{ background: '#f0f0f0', textAlign: 'left' }}>
            <th style={{ padding: '.5rem' }}>Server</th>
            <th style={{ padding: '.5rem' }}>Role</th>
            <th style={{ padding: '.5rem' }}>Pending</th>
            <th style={{ padding: '.5rem' }}>Kernel</th>
            <th style={{ padding: '.5rem' }}>Reboot</th>
            <th style={{ padding: '.5rem' }}>Last scan</th>
            <th style={{ padding: '.5rem' }}>Last job</th>
            <th style={{ padding: '.5rem' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rs.rows.map((s) => {
            const elig = isEligible(s.name, s.role);
            return (
              <tr key={s.id} style={{ borderBottom: '1px solid #eee', background: elig.eligible ? 'white' : '#fafafa' }}>
                <td style={{ padding: '.5rem' }}>
                  <div style={{ fontWeight: 500 }}>{s.name}</div>
                  <div style={{ fontSize: '.75rem', color: '#888' }}>{s.fqdn}</div>
                  {!elig.eligible && <div style={{ fontSize: '.7rem', color: '#ed6c02', marginTop: '.2rem' }}>{elig.reason}</div>}
                </td>
                <td style={{ padding: '.5rem' }}>{s.role}</td>
                <td style={{ padding: '.5rem' }}><PendingBadge n={s.pending_packages_count} /></td>
                <td style={{ padding: '.5rem' }}>{s.pending_kernel_count && s.pending_kernel_count > 0 ? <span style={{ background: '#c62828', color: 'white', padding: '.1rem .4rem', borderRadius: 3 }}>{s.pending_kernel_count}</span> : (s.pending_kernel_count === 0 ? <span style={{ color: '#2e7d32' }}>ok</span> : '-')}</td>
                <td style={{ padding: '.5rem' }}>{s.reboot_required ? <span style={{ background: '#c62828', color: 'white', padding: '.1rem .4rem', borderRadius: 3 }}>required</span> : (s.reboot_required === false ? <span style={{ color: '#2e7d32' }}>no</span> : '-')}</td>
                <td style={{ padding: '.5rem', color: '#888', fontSize: '.8rem' }}>{s.last_apt_scan_at ? new Date(s.last_apt_scan_at).toLocaleString() : 'never'}</td>
                <td style={{ padding: '.5rem' }}>{s.last_job_id ? <a href={`/admin/server-updates/${s.last_job_id}`}>#{s.last_job_id} {s.last_job_status}</a> : <span style={{ color: '#888' }}>-</span>}</td>
                <td style={{ padding: '.5rem' }}>
                  <div style={{ display: 'flex', gap: '.25rem', flexWrap: 'wrap' }}>
                    <ScanServerButton serverId={s.id} />
                    {me.role === 'admin' && elig.eligible && <UpgradeServerButton serverId={s.id} name={s.name} pendingKernel={s.pending_kernel_count ?? 0} rebootRequired={!!s.reboot_required} />}
                    {me.role === 'admin' && s.role.startsWith('plesk-') && <PleskSsoButton serverId={s.id} />}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </main>
  );
}

function PendingBadge({ n }: { n: number | null }) {
  if (n === null) return <span style={{ color: '#888' }}>-</span>;
  if (n === 0)    return <span style={{ color: '#2e7d32' }}>ok</span>;
  const color = n >= 20 ? '#c62828' : n >= 5 ? '#ed6c02' : '#1976d2';
  return <span style={{ background: color, color: 'white', padding: '.1rem .4rem', borderRadius: 3, fontSize: '.85rem' }}>{n}</span>;
}
