'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';

type Backup = { at: string | null; status: string; sizeMb: number | null; ref: string | null };
type Job = {
  id: number; status: string; kind: string; triggered_by: string | null;
  started_at: string; finished_at: string | null; output: string | null;
};
type Health = {
  last_backup_at: string | null; last_backup_status: string | null; last_backup_size_mb: number | null;
  disk_usage_pct: number | null; disk_total_gb: number | null; dumps_mounted: boolean | null; captured_at: string | null;
};
type Server = { id: number; name: string; fqdn: string; role: string; backup_max_age_hours: number };
type Detail = { server: Server; health: Health | null; backups: Backup[]; jobs: Job[] };

const fmt = (ts: string | null) => (ts ? new Date(ts).toLocaleString() : '—');
const fmtSize = (mb: number | null) => (mb === null ? '—' : mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb + ' MB');
const badge = (s: string) => {
  const v = (s || '').toLowerCase();
  if (v.includes('success') || v === 'ok') return 'bg-green-100 text-green-700';
  if (v.includes('running')) return 'bg-blue-100 text-blue-700';
  if (v.includes('warn')) return 'bg-amber-100 text-amber-700';
  if (v.includes('fail') || v.includes('error')) return 'bg-red-100 text-red-700';
  return 'bg-gray-100 text-gray-600';
};

export default function BackupServerDetail() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const [d, setD] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`/api/backups/servers/${id}`, { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Failed to load');
      setD(j);
    } catch (e) { setErr((e as Error).message); } finally { setLoading(false); }
  }, [id]);

  useEffect(() => { load(); }, [load]);
  // Poll while a job is running so the operator sees it complete without a manual refresh.
  useEffect(() => {
    if (!d?.jobs?.some((j) => j.status === 'running')) return;
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [d, load]);

  const runBackup = async () => {
    setConfirmOpen(false);
    setRunning(true);
    setErr(null);
    try {
      const r = await fetch(`/api/backups/servers/${id}/run`, { method: 'POST' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Failed to start backup');
      await load();
    } catch (e) { setErr((e as Error).message); } finally { setRunning(false); }
  };

  // ---- Phase 2: restore a subscription from a chosen dump ----
  const [restoreDump, setRestoreDump] = useState<Backup | null>(null);
  const [restoreDomain, setRestoreDomain] = useState('');
  const [restoreConfirm, setRestoreConfirm] = useState('');
  const [restoring, setRestoring] = useState(false);
  const openRestore = (b: Backup) => { setRestoreDump(b); setRestoreDomain(''); setRestoreConfirm(''); setErr(null); };
  const doRestore = async () => {
    if (!restoreDump?.ref) return;
    setRestoring(true);
    setErr(null);
    try {
      const r = await fetch(`/api/backups/servers/${id}/restore`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: restoreDomain.trim(), ref: restoreDump.ref, confirm: restoreConfirm.trim() }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Restore failed to start');
      setRestoreDump(null);
      await load();
    } catch (e) { setErr((e as Error).message); } finally { setRestoring(false); }
  };

  const s = d?.server;
  const jobRunning = d?.jobs?.some((j) => j.status === 'running');

  return (
    <main className="min-h-screen p-6 max-w-5xl mx-auto">
      <header className="flex justify-between items-center mb-6 pb-4 border-b">
        <div>
          <h1 className="text-2xl font-medium">{s?.name || 'Server'} — Backups</h1>
          <p className="text-sm text-gray-500 mt-1 font-mono">{s?.fqdn}{s ? ` · ${s.role}` : ''}</p>
        </div>
        <Link href="/backups" className="text-sm text-gray-500 hover:text-gray-800">&larr; All servers</Link>
      </header>

      {err && <div className="mb-4 rounded border border-red-200 bg-red-50 text-red-700 text-sm px-3 py-2">{err}</div>}

      {loading && !d ? (
        <p className="text-gray-500">Loading…</p>
      ) : d ? (
        <>
          {/* Health summary + action */}
          <section className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            <div className="border rounded p-3"><div className="text-xs text-gray-500">Last backup</div><div className="font-medium">{fmt(d.health?.last_backup_at || null)}</div></div>
            <div className="border rounded p-3"><div className="text-xs text-gray-500">Status</div><span className={`inline-block px-2 py-0.5 rounded text-xs ${badge(d.health?.last_backup_status || '')}`}>{d.health?.last_backup_status || 'unknown'}</span></div>
            <div className="border rounded p-3"><div className="text-xs text-gray-500">Repo mounted</div><div className="font-medium">{d.health?.dumps_mounted === false ? <span className="text-red-700">NOT MOUNTED</span> : d.health?.dumps_mounted ? 'Yes' : '—'}</div></div>
            <div className="border rounded p-3"><div className="text-xs text-gray-500">Disk used</div><div className="font-medium">{d.health?.disk_usage_pct != null ? `${d.health.disk_usage_pct}%${d.health.disk_total_gb ? ` of ${d.health.disk_total_gb} GB` : ''}` : '—'}</div></div>
          </section>

          <div className="flex items-center gap-3 mb-6">
            <button
              onClick={() => setConfirmOpen(true)}
              disabled={running || jobRunning}
              className="px-4 py-2 rounded bg-gray-900 text-white text-sm disabled:opacity-50">
              {jobRunning ? 'Backup running…' : running ? 'Starting…' : 'Run backup now'}
            </button>
            <button onClick={load} className="px-3 py-2 rounded border text-sm">Refresh</button>
            {jobRunning && <span className="text-xs text-blue-600">A backup is in progress — this page auto-refreshes.</span>}
          </div>

          {/* On-demand job history */}
          <section className="mb-8">
            <h2 className="text-sm font-medium text-gray-700 mb-2">On-demand runs</h2>
            {d.jobs.length === 0 ? (
              <p className="text-sm text-gray-400">No on-demand backups triggered from Console yet.</p>
            ) : (
              <div className="border rounded overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-left border-b"><tr>
                    <th className="px-3 py-2 w-24">Status</th><th className="px-3 py-2">Started</th>
                    <th className="px-3 py-2">Finished</th><th className="px-3 py-2">By</th>
                  </tr></thead>
                  <tbody>
                    {d.jobs.map((j) => (
                      <tr key={j.id} className="border-t align-top">
                        <td className="px-3 py-2"><span className={`inline-block px-2 py-0.5 rounded text-xs ${badge(j.status)}`}>{j.status}</span></td>
                        <td className="px-3 py-2">{fmt(j.started_at)}</td>
                        <td className="px-3 py-2">{fmt(j.finished_at)}{j.status === 'failed' && j.output ? <details className="mt-1"><summary className="text-xs text-red-600 cursor-pointer">log</summary><pre className="text-xs bg-gray-50 border rounded p-2 mt-1 whitespace-pre-wrap max-h-48 overflow-auto">{j.output}</pre></details> : null}</td>
                        <td className="px-3 py-2 text-gray-500 text-xs">{j.triggered_by || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Dump repository history (live over SSH) */}
          <section>
            <h2 className="text-sm font-medium text-gray-700 mb-2">Backup history <span className="text-gray-400 font-normal">(Plesk repository, newest first)</span></h2>
            {d.backups.length === 0 ? (
              <p className="text-sm text-gray-400">No backups found in the repository (or the server couldn&apos;t be reached).</p>
            ) : (
              <div className="border rounded overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-left border-b"><tr>
                    <th className="px-3 py-2">Taken</th><th className="px-3 py-2 w-32">Status</th><th className="px-3 py-2 w-28">Size</th><th className="px-3 py-2 w-28" />
                  </tr></thead>
                  <tbody>
                    {d.backups.map((b, i) => (
                      <tr key={i} className="border-t">
                        <td className="px-3 py-2">{fmt(b.at)}</td>
                        <td className="px-3 py-2"><span className={`inline-block px-2 py-0.5 rounded text-xs ${badge(b.status)}`}>{b.status}</span></td>
                        <td className="px-3 py-2">{fmtSize(b.sizeMb)}</td>
                        <td className="px-3 py-2">{b.ref && <button onClick={() => openRestore(b)} disabled={jobRunning} className="text-rose-600 hover:underline disabled:text-gray-300">Restore…</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : null}

      {/* Confirm dialog for the (non-destructive but attributed) run */}
      {confirmOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50" onClick={() => setConfirmOpen(false)}>
          <div className="bg-white rounded-lg max-w-md w-full p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-medium mb-2">Run a backup now?</h3>
            <p className="text-sm text-gray-600 mb-4">
              This starts a full Plesk server backup on <span className="font-mono">{s?.fqdn}</span>, writing into its backup repository.
              It runs in the background and can take a while on a busy server. It creates a new backup — it does not overwrite or delete anything.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmOpen(false)} className="px-3 py-2 rounded border text-sm">Cancel</button>
              <button onClick={runBackup} className="px-4 py-2 rounded bg-gray-900 text-white text-sm">Run backup</button>
            </div>
          </div>
        </div>
      )}

      {/* Restore dialog — destructive, typed-domain confirm */}
      {restoreDump && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50" onClick={() => !restoring && setRestoreDump(null)}>
          <div className="bg-white rounded-lg max-w-lg w-full p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-medium mb-1 text-rose-700">Restore a subscription</h3>
            <p className="text-sm text-gray-600 mb-3">
              Restore a single subscription <strong>in place</strong> from the <span className="font-mono">{fmt(restoreDump.at)}</span> backup on <span className="font-mono">{s?.fqdn}</span>.
              This <strong>overwrites the live site</strong> (files, databases, mail). A fresh safety backup of that subscription is taken first and the restore aborts if it fails.
            </p>
            <label className="block text-xs text-gray-500 mb-1">Domain to restore</label>
            <input value={restoreDomain} onChange={(e) => setRestoreDomain(e.target.value)} placeholder="example.co.uk"
              className="w-full border rounded px-3 py-2 text-sm mb-3 font-mono" />
            <label className="block text-xs text-gray-500 mb-1">Type the domain again to confirm</label>
            <input value={restoreConfirm} onChange={(e) => setRestoreConfirm(e.target.value)} placeholder="example.co.uk"
              className="w-full border rounded px-3 py-2 text-sm mb-4 font-mono" />
            {err && <div className="mb-3 text-sm text-red-700">{err}</div>}
            <div className="flex justify-end gap-2">
              <button onClick={() => setRestoreDump(null)} disabled={restoring} className="px-3 py-2 rounded border text-sm">Cancel</button>
              <button onClick={doRestore}
                disabled={restoring || !restoreDomain.trim() || restoreDomain.trim().toLowerCase() !== restoreConfirm.trim().toLowerCase()}
                className="px-4 py-2 rounded bg-rose-600 text-white text-sm disabled:opacity-40">
                {restoring ? 'Starting…' : 'Restore (overwrites live)'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
