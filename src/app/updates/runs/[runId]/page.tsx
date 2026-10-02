import { db } from '@/lib/db';
import { requireUser } from '@/lib/rbac';
import { notFound } from 'next/navigation';
import { AutoRefresh } from '../../../onboarding/[id]/auto-refresh';
import { KindBadge, RunStatusBadge, StateBadge } from '../badges';
import { ApprovalButtons } from '../buttons';
export const dynamic = 'force-dynamic';

interface SiteRow {
  id: number; run_id: number; live_run_id: number | null; site_id: number; domain: string; state: string;
  staging_url: string | null; staging_user: string | null; staging_password: string | null; staging_deleted_at: string | null;
  staged_at: string | null; needs_staging1: boolean; is_woocommerce: boolean; backup_ref: string | null;
  needs_approval: boolean; approved_at: string | null; approver: string | null; security: boolean;
  error: string | null; log: string; updated_at: string;
}
interface ItemRow {
  patch_site_id: number; kind: string; slug: string; name: string | null; from_version: string | null; to_version: string;
  is_major: boolean; security: boolean; applied_staging: boolean; applied_live: boolean;
}

const BUSY = ['pending', 'cloning', 'sanitising', 'patching', 'smoke', 'staged_ok', 'live_backup', 'live_patching', 'live_smoke'];

export default async function PatchRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const rid = parseInt(runId, 10);
  if (!Number.isFinite(rid)) notFound();
  const me = await requireUser();
  const isAdmin = me.role === 'admin';

  const rr = await db.query<{ id: number; kind: string; status: string; triggered_by: string | null; started_at: string; finished_at: string | null }>(
    `SELECT id, kind, status, triggered_by, started_at::text, finished_at::text FROM wp_patch_runs WHERE id = $1`, [rid]);
  if (rr.rows.length === 0) notFound();
  const run = rr.rows[0];

  const sites = await db.query<SiteRow>(`
    SELECT p.id, p.run_id, p.live_run_id, p.site_id, s.domain, p.state, p.staging_url, p.staging_user, p.staging_password,
           p.staging_deleted_at::text, p.staged_at::text, p.needs_staging1, p.is_woocommerce, p.backup_ref,
           p.needs_approval, p.approved_at::text, COALESCE(u.display_name, u.email) AS approver, p.security,
           p.error, p.log, p.updated_at::text
      FROM wp_patch_sites p
      JOIN sites s ON s.id = p.site_id
      LEFT JOIN users u ON u.id = p.approved_by
     WHERE p.run_id = $1 OR p.live_run_id = $1
     ORDER BY CASE p.state WHEN 'awaiting_approval' THEN 0 ELSE 1 END, p.security DESC, s.domain`, [rid]);
  const items = await db.query<ItemRow>(`
    SELECT i.patch_site_id, i.kind, i.slug, i.name, i.from_version, i.to_version, i.is_major, i.security,
           i.applied_staging, i.applied_live
      FROM wp_patch_items i
     WHERE i.patch_site_id = ANY($1::int[])
     ORDER BY CASE i.kind WHEN 'core' THEN 0 WHEN 'plugin' THEN 1 ELSE 2 END, i.slug`, [sites.rows.map(s => s.id)]);
  const itemsBy = new Map<number, ItemRow[]>();
  for (const it of items.rows) {
    const l = itemsBy.get(it.patch_site_id) ?? [];
    l.push(it);
    itemsBy.set(it.patch_site_id, l);
  }
  const inProgress = run.status === 'running' || sites.rows.some(s => BUSY.includes(s.state));

  const pill = (text: string, bg: string) => (
    <span style={{ background: bg, color: 'white', padding: '.05rem .35rem', borderRadius: 3, fontSize: '.72rem', marginLeft: '.3rem', whiteSpace: 'nowrap' }}>{text}</span>
  );

  return (
    <main style={{ maxWidth: 1180, margin: '2rem auto', padding: '0 1rem', fontFamily: 'system-ui' }}>
      <AutoRefresh enabled={inProgress} intervalMs={8000} />
      <p style={{ margin: 0 }}><a href="/updates/runs" style={{ color: '#1976d2', fontSize: '.85rem', textDecoration: 'none' }}>← Back to patch runs</a></p>
      <h1 style={{ marginBottom: '.25rem' }}>Patch run #{run.id}</h1>
      <div style={{ display: 'flex', gap: '.6rem', alignItems: 'center', color: '#666', fontSize: '.85rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <KindBadge k={run.kind} /> <RunStatusBadge s={run.status} />
        <span>started {new Date(run.started_at).toLocaleString()}</span>
        {run.finished_at && <span>· finished {new Date(run.finished_at).toLocaleString()}</span>}
        {run.triggered_by && <span>· by {run.triggered_by}</span>}
      </div>

      {sites.rows.length === 0 && <p style={{ color: '#888' }}>{run.status === 'running' ? 'Selecting sites…' : 'No sites in this run.'}</p>}

      {sites.rows.map(s => {
        const its = itemsBy.get(s.id) ?? [];
        const otherRun = s.run_id !== rid ? s.run_id : (s.live_run_id && s.live_run_id !== rid ? s.live_run_id : null);
        return (
          <section key={s.id} style={{ border: '1px solid #e0e0e0', borderRadius: 4, padding: '.75rem 1rem', marginBottom: '.75rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
              <div>
                <strong>{s.domain}</strong>
                <span style={{ marginLeft: '.5rem' }}><StateBadge s={s.state} /></span>
                {s.security && pill('security', '#c62828')}
                {s.is_woocommerce && pill('woocommerce', '#6a1b9a')}
                {s.needs_approval && pill('needs approval', '#ed6c02')}
                {s.needs_staging1 && pill('needs staging1', '#757575')}
                <span style={{ color: '#999', fontSize: '.75rem', marginLeft: '.5rem' }}>
                  patch #{s.id}{otherRun ? <> · also in <a href={`/updates/runs/${otherRun}`}>run #{otherRun}</a></> : null}
                </span>
              </div>
              {isAdmin && (s.state === 'awaiting_approval' || s.state === 'approved') && (
                <ApprovalButtons patchSiteId={s.id} domain={s.domain} canApprove={s.state === 'awaiting_approval'} />
              )}
            </div>
            {s.approved_at && (
              <div style={{ fontSize: '.8rem', color: '#555', marginTop: '.25rem' }}>
                Approved by {s.approver ?? 'unknown user'} at {new Date(s.approved_at).toLocaleString()}
              </div>
            )}
            {!s.approved_at && !s.needs_approval && s.staged_at && (
              <div style={{ fontSize: '.8rem', color: '#555', marginTop: '.25rem' }}>Auto-approved by policy (minor/patch/security only)</div>
            )}
            {s.error && <pre style={{ background: '#fee', padding: '.5rem', color: '#a00', fontSize: '.78rem', whiteSpace: 'pre-wrap', margin: '.5rem 0' }}>{s.error}</pre>}

            {its.length > 0 && (
              <table style={{ borderCollapse: 'collapse', fontSize: '.8rem', margin: '.5rem 0' }}>
                <tbody>
                  {its.map(it => (
                    <tr key={`${it.kind}:${it.slug}`}>
                      <td style={{ padding: '.1rem .5rem .1rem 0', color: '#888' }}>{it.kind}</td>
                      <td style={{ padding: '.1rem .5rem' }}>{it.name ?? it.slug} <span style={{ color: '#999', fontFamily: 'monospace' }}>{it.slug}</span></td>
                      <td style={{ padding: '.1rem .5rem', whiteSpace: 'nowrap', color: '#555' }}>{it.from_version ?? '?'} → {it.to_version}</td>
                      <td style={{ padding: '.1rem .5rem', whiteSpace: 'nowrap' }}>
                        {it.is_major && pill('major', '#ed6c02')}
                        {it.security && pill('security', '#c62828')}
                        {it.applied_staging && pill('staging ✓', '#1976d2')}
                        {it.applied_live && pill('live ✓', '#2e7d32')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {s.staging_url && (
              <div style={{ fontSize: '.8rem', color: '#555', margin: '.25rem 0' }}>
                Staging:{' '}
                {s.staging_deleted_at
                  ? <span style={{ color: '#999' }}>{s.staging_url} (deleted {new Date(s.staging_deleted_at).toLocaleString()})</span>
                  : <a href={s.staging_url + '/'} target="_blank" rel="noreferrer">{s.staging_url}</a>}
                {!s.staging_deleted_at && isAdmin && s.staging_user && s.staging_password && (
                  <span style={{ marginLeft: '.5rem' }}>login <code>{s.staging_user}</code> / <code>{s.staging_password}</code></span>
                )}
                {!s.staging_deleted_at && (
                  <div style={{ color: '#999', fontSize: '.75rem' }}>No public DNS record: add a hosts-file entry for the staging host pointing at the site&apos;s server to browse it.</div>
                )}
              </div>
            )}
            {s.backup_ref && <div style={{ fontSize: '.8rem', color: '#555' }}>Live backup (WP Toolkit): <code>{s.backup_ref}</code></div>}

            <details style={{ marginTop: '.4rem' }}>
              <summary style={{ cursor: 'pointer', color: '#666', fontSize: '.8rem' }}>log · updated {new Date(s.updated_at).toLocaleString()}</summary>
              <pre style={{ background: '#f8f8f8', padding: '.6rem', fontSize: '.72rem', whiteSpace: 'pre-wrap', maxHeight: 420, overflow: 'auto' }}>{s.log || '(empty)'}</pre>
            </details>
          </section>
        );
      })}
    </main>
  );
}
