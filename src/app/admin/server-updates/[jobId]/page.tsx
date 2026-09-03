import { db } from '@/lib/db';
import { requireUser } from '@/lib/rbac';
import { notFound } from 'next/navigation';
import { AutoRefresh } from '../../../onboarding/[id]/auto-refresh';
export const dynamic = 'force-dynamic';

export default async function JobPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const jid = parseInt(jobId, 10);
  if (!Number.isFinite(jid)) notFound();
  await requireUser();
  const j = await db.query<any>(
    `SELECT j.*, s.name AS server_name, s.fqdn FROM server_update_jobs j JOIN servers s ON s.id = j.server_id WHERE j.id = $1`, [jid]);
  if (j.rows.length === 0) notFound();
  const job = j.rows[0];

  return (
    <main style={{ maxWidth: 980, margin: '2rem auto', padding: '0 1rem', fontFamily: 'system-ui' }}>
      <AutoRefresh enabled={job.status === 'running' || job.status === 'pending'} />
      <p style={{ margin: 0 }}><a href="/admin/server-updates" style={{ color: '#1976d2', fontSize: '.85rem', textDecoration: 'none' }}>← Back to server updates</a></p>
      <h1 style={{ marginBottom: '.25rem' }}>Server update job #{job.id}</h1>
      <p style={{ color: '#666', marginTop: 0 }}>{job.server_name} ({job.fqdn}) — {job.kind}</p>
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', margin: '.5rem 0 1rem' }}>
        <StatusBadge s={job.status} />
        {(job.status === 'running' || job.status === 'pending') && job.progress_pct !== null && (
          <div style={{ flex: 1, maxWidth: 400 }}>
            <div style={{ background: '#e0e0e0', borderRadius: 4, overflow: 'hidden', height: 14 }}>
              <div style={{ background: '#1976d2', width: `${job.progress_pct}%`, height: '100%', transition: 'width .5s ease' }} />
            </div>
            <div style={{ fontSize: '.75rem', color: '#666', marginTop: '.15rem' }}>{job.progress_pct}%</div>
          </div>
        )}
      </div>
      <div style={{ color: '#888', fontSize: '.8rem', marginBottom: '1rem' }}>
        Started: {new Date(job.started_at).toLocaleString()}{job.completed_at ? ` · Completed: ${new Date(job.completed_at).toLocaleString()}` : ''}
      </div>
      {job.error && <pre style={{ background: '#fee', padding: '.75rem', color: '#a00', fontSize: '.8rem', whiteSpace: 'pre-wrap' }}>{job.error}</pre>}
      {job.output && <pre style={{ background: '#f8f8f8', padding: '.75rem', fontSize: '.75rem', whiteSpace: 'pre-wrap', maxHeight: 480, overflow: 'auto' }}>{job.output}</pre>}
      <details><summary style={{ cursor: 'pointer', color: '#666' }}>pre-state</summary>
        <pre style={{ background: '#f8f8f8', padding: '.5rem', fontSize: '.7rem', maxHeight: 240, overflow: 'auto' }}>{JSON.stringify(job.pre_state, null, 2)}</pre>
      </details>
      <details><summary style={{ cursor: 'pointer', color: '#666' }}>post-state</summary>
        <pre style={{ background: '#f8f8f8', padding: '.5rem', fontSize: '.7rem', maxHeight: 240, overflow: 'auto' }}>{JSON.stringify(job.post_state, null, 2)}</pre>
      </details>
    </main>
  );
}

function StatusBadge({ s }: { s: string }) {
  const c: Record<string, string> = { pending: '#888', running: '#1976d2', success: '#2e7d32', failed: '#c62828' };
  return <span style={{ background: c[s] ?? '#888', color: 'white', padding: '.2rem .6rem', borderRadius: 3, fontSize: '.85rem' }}>{s}</span>;
}
