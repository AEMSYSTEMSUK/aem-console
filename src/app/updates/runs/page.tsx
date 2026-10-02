import { db } from '@/lib/db';
import { requireUser } from '@/lib/rbac';
import { REQUIRE_SAVED_POLICY } from '@/lib/wp-patch/engine';
import { KindBadge, RunStatusBadge } from './badges';
export const dynamic = 'force-dynamic';

interface RunRow {
  id: number; kind: string; status: string; triggered_by: string | null;
  started_at: string; finished_at: string | null; summary: { states?: Record<string, number> } | null;
  sites: number; awaiting: number;
}

export default async function PatchRunsPage() {
  await requireUser();
  const rs = await db.query<RunRow>(`
    SELECT r.id, r.kind, r.status, r.triggered_by, r.started_at::text, r.finished_at::text, r.summary,
           (SELECT COUNT(*)::int FROM wp_patch_sites p WHERE p.run_id = r.id OR p.live_run_id = r.id) AS sites,
           (SELECT COUNT(*)::int FROM wp_patch_sites p WHERE p.run_id = r.id AND p.state = 'awaiting_approval') AS awaiting
      FROM wp_patch_runs r
     ORDER BY r.id DESC
     LIMIT 100`);
  const waiting = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM wp_patch_sites WHERE state = 'awaiting_approval'`);

  return (
    <main style={{ maxWidth: 1180, margin: '2rem auto', padding: '0 1rem', fontFamily: 'system-ui' }}>
      <p style={{ margin: 0 }}><a href="/updates" style={{ color: '#1976d2', fontSize: '.85rem', textDecoration: 'none' }}>← Back to WP updates</a></p>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '1rem' }}>
        <h1 style={{ fontSize: '1.5rem', margin: 0 }}>Patch runs</h1>
        <span style={{ color: '#666', fontSize: '.85rem' }}>
          {waiting.rows[0]?.n ? <strong style={{ color: '#ed6c02' }}>{waiting.rows[0].n} site(s) awaiting approval · </strong> : null}
          staging Mon 06:00 · live Tue 06:00 · security fast-track after the nightly scan
        </span>
      </header>
      {REQUIRE_SAVED_POLICY && (
        <p style={{ color: '#888', fontSize: '.8rem', marginTop: 0 }}>
          Only sites with a saved patch policy are included in runs (pilot safety valve).
        </p>
      )}
      {rs.rows.length === 0
        ? <p style={{ color: '#888' }}>No runs yet.</p>
        : <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.9rem' }}>
            <thead>
              <tr style={{ background: '#f0f0f0', textAlign: 'left' }}>
                <th style={{ padding: '.5rem' }}>Run</th>
                <th style={{ padding: '.5rem' }}>Kind</th>
                <th style={{ padding: '.5rem' }}>Status</th>
                <th style={{ padding: '.5rem' }}>Started</th>
                <th style={{ padding: '.5rem' }}>Finished</th>
                <th style={{ padding: '.5rem' }}>Sites</th>
                <th style={{ padding: '.5rem' }}>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {rs.rows.map(r => (
                <tr key={r.id} style={{ borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: '.5rem' }}><a href={`/updates/runs/${r.id}`}>#{r.id}</a></td>
                  <td style={{ padding: '.5rem' }}><KindBadge k={r.kind} /></td>
                  <td style={{ padding: '.5rem' }}><RunStatusBadge s={r.status} /></td>
                  <td style={{ padding: '.5rem', color: '#666', fontSize: '.8rem' }}>{new Date(r.started_at).toLocaleString()}<br /><span style={{ color: '#999' }}>{r.triggered_by ?? ''}</span></td>
                  <td style={{ padding: '.5rem', color: '#666', fontSize: '.8rem' }}>{r.finished_at ? new Date(r.finished_at).toLocaleString() : '-'}</td>
                  <td style={{ padding: '.5rem' }}>{r.sites}{r.awaiting ? <span style={{ color: '#ed6c02' }}> ({r.awaiting} awaiting)</span> : null}</td>
                  <td style={{ padding: '.5rem', fontSize: '.8rem', color: '#555' }}>
                    {Object.entries(r.summary?.states ?? {}).map(([k, v]) => `${k}: ${v}`).join(' · ') || (r.status === 'running' ? 'in progress' : '-')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>}
    </main>
  );
}
