'use client';
import { useState } from 'react';
import Link from 'next/link';

// Row summary passed from the server component (a latest-health snapshot per Plesk server).
export interface BackupRow {
  server_id: number; server_name: string; fqdn: string; role: string;
  last_backup_at: string | null; last_backup_status: string | null; last_backup_size_mb: number | null;
  disk_usage_pct: number | null; disk_total_gb: number | null; dumps_mounted: boolean | null; captured_at: string | null;
}
// A discovered Plesk dump in the server's repository (from GET /api/backups/servers/:id → backups[]).
interface ServerBackup { at: string | null; status: string; sizeMb: number | null; ref: string | null }

const ageH = (ts: string | null) => (ts ? (Date.now() - new Date(ts).getTime()) / 3.6e6 : null);
const fmtAge = (h: number | null) => (h === null ? 'never' : h < 1 ? Math.round(h * 60) + 'm' : h < 48 ? Math.round(h) + 'h' : Math.round(h / 24) + 'd');
const fmtMb = (mb: number | null) => (mb != null ? (mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb + ' MB') : '—');
function cls(r: BackupRow): 'green' | 'amber' | 'red' {
  const age = ageH(r.last_backup_at);
  const st = (r.last_backup_status || '').toLowerCase();
  const failed = !st || ['error', 'failed', 'failure'].some((x) => st.includes(x));
  const warned = st.includes('warning');
  if (age === null || failed || r.dumps_mounted === false) return 'red';
  if (age > 96) return 'red';
  if (warned || age > 26) return 'amber';
  return 'green';
}
const dot = (c: string) => (c === 'green' ? 'bg-green-500' : c === 'amber' ? 'bg-amber-500' : 'bg-red-500');
const fmtTs = (ts: string | null) => (ts ? new Date(ts).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

export default function BackupList({ rows }: { rows: BackupRow[] }) {
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [loading, setLoading] = useState<Record<number, boolean>>({});
  const [backups, setBackups] = useState<Record<number, ServerBackup[]>>({});
  const [err, setErr] = useState<Record<number, string>>({});

  const toggle = async (id: number) => {
    const next = !open[id];
    setOpen((o) => ({ ...o, [id]: next }));
    if (next && !backups[id] && !loading[id]) {
      setLoading((l) => ({ ...l, [id]: true }));
      try {
        const r = await fetch(`/api/backups/servers/${id}`, { cache: 'no-store' });
        const j = await r.json();
        if (!r.ok) throw new Error(j?.error || 'Failed to load backups');
        setBackups((b) => ({ ...b, [id]: Array.isArray(j.backups) ? j.backups : [] }));
      } catch (e) {
        setErr((x) => ({ ...x, [id]: (e as Error)?.message || 'Failed to load backups' }));
      } finally {
        setLoading((l) => ({ ...l, [id]: false }));
      }
    }
  };

  return (
    <section className="border rounded overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-left border-b">
          <tr>
            <th className="px-3 py-2 w-8"></th><th className="px-3 py-2">Server</th>
            <th className="px-3 py-2 w-28">Role</th><th className="px-3 py-2 w-28">Last backup</th>
            <th className="px-3 py-2 w-24">Status</th><th className="px-3 py-2 w-24">Size</th>
            <th className="px-3 py-2 w-32">Disk</th><th className="px-3 py-2 w-28">Offsite</th>
            <th className="px-3 py-2 w-36">Captured</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const c = cls(r); const age = ageH(r.last_backup_at); const isOpen = !!open[r.server_id];
            return (
              <FragmentRow key={r.server_id}>
                <tr className="border-t align-top">
                  <td className="px-3 py-2">
                    <button onClick={() => toggle(r.server_id)} title="Show Plesk backups" className="flex items-center gap-1.5 text-gray-500 hover:text-gray-800">
                      <span className={`inline-block transition-transform ${isOpen ? 'rotate-90' : ''}`}>▸</span>
                      <span className={`inline-block w-2.5 h-2.5 rounded-full ${dot(c)}`}></span>
                    </button>
                  </td>
                  <td className="px-3 py-2"><Link href={`/backups/${r.server_id}`} className="font-medium text-blue-700 hover:underline">{r.server_name}</Link><div className="text-xs text-gray-500 font-mono">{r.fqdn}</div></td>
                  <td className="px-3 py-2 text-xs text-gray-600 font-mono">{r.role}</td>
                  <td className="px-3 py-2 text-xs"><span className={c === 'red' ? 'text-red-700' : c === 'amber' ? 'text-amber-700' : 'text-gray-700'}>{fmtAge(age)}{age !== null ? ' ago' : ''}</span></td>
                  <td className="px-3 py-2 text-xs">{r.last_backup_status ?? '—'}</td>
                  <td className="px-3 py-2 text-xs text-gray-600">{fmtMb(r.last_backup_size_mb)}</td>
                  <td className="px-3 py-2 text-xs text-gray-600">{r.disk_usage_pct != null ? r.disk_usage_pct + '%' : '—'}{r.disk_total_gb != null ? ` / ${r.disk_total_gb}GB` : ''}</td>
                  <td className="px-3 py-2 text-xs">{r.dumps_mounted === true ? <span className="text-green-700">mounted</span> : r.dumps_mounted === false ? <span className="text-red-700">not mounted</span> : <span className="text-gray-400">—</span>}</td>
                  <td className="px-3 py-2 text-xs text-gray-500 font-mono">{r.captured_at ? r.captured_at.slice(0, 16) : '—'}</td>
                </tr>
                {isOpen && (
                  <tr className="bg-gray-50/60">
                    <td></td>
                    <td colSpan={8} className="px-3 py-2">
                      {loading[r.server_id] ? (
                        <p className="text-xs text-gray-500">Loading Plesk backups…</p>
                      ) : err[r.server_id] ? (
                        <p className="text-xs text-red-600">{err[r.server_id]}</p>
                      ) : (backups[r.server_id]?.length ?? 0) === 0 ? (
                        <p className="text-xs text-gray-500">No Plesk backups found in this server&rsquo;s repository.</p>
                      ) : (
                        <div className="max-w-3xl">
                          <p className="text-[11px] uppercase tracking-wide text-gray-400 mb-1">Plesk backups (newest first)</p>
                          <table className="w-full text-xs">
                            <thead className="text-left text-gray-400"><tr><th className="py-1 pr-4">When</th><th className="py-1 pr-4">Status</th><th className="py-1 pr-4">Size</th><th className="py-1">Ref</th></tr></thead>
                            <tbody>
                              {backups[r.server_id].map((b, i) => (
                                <tr key={b.ref || i} className="border-t border-gray-200">
                                  <td className="py-1 pr-4 text-gray-700">{fmtTs(b.at)}</td>
                                  <td className="py-1 pr-4 text-gray-600">{b.status}</td>
                                  <td className="py-1 pr-4 text-gray-600">{fmtMb(b.sizeMb)}</td>
                                  <td className="py-1 font-mono text-gray-400">{b.ref || '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          <Link href={`/backups/${r.server_id}`} className="mt-1 inline-block text-[11px] text-blue-700 hover:underline">Open server →</Link>
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </FragmentRow>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

// Tiny helper so each server yields two <tr>s (summary + expandable detail) without an invalid wrapper.
function FragmentRow({ children }: { children: React.ReactNode }) { return <>{children}</>; }
