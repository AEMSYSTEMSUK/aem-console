import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSession } from '@/lib/sessions';
import { listLatestBackupHealth } from '@/lib/backup-health';
export const dynamic = 'force-dynamic';
type Row = Awaited<ReturnType<typeof listLatestBackupHealth>>[number];
const ageH = (ts: string | null) => (ts ? (Date.now() - new Date(ts).getTime()) / 3.6e6 : null);
const fmtAge = (h: number | null) => (h === null ? 'never' : h < 1 ? Math.round(h * 60) + 'm' : h < 48 ? Math.round(h) + 'h' : Math.round(h / 24) + 'd');
function cls(r: Row): 'green' | 'amber' | 'red' {
  const age = ageH(r.last_backup_at);
  const st = (r.last_backup_status || '').toLowerCase();
  const failed = !st || ['error','failed','failure'].some((x) => st.includes(x));
  const warned = st.includes('warning');
  if (age === null || failed || r.dumps_mounted === false) return 'red';
  if (age > 96) return 'red';
  if (warned || age > 26) return 'amber';
  return 'green';
}
export default async function BackupsPage() {
  const cookieStore = await cookies();
  const sid = cookieStore.get('aem_session')?.value;
  if (!sid) redirect('/auth/login');
  const sess = await getSession(sid);
  if (!sess) redirect('/auth/login');
  const rows = await listLatestBackupHealth();
  const g = rows.filter((r) => cls(r) === 'green').length;
  const a = rows.filter((r) => cls(r) === 'amber').length;
  const b = rows.filter((r) => cls(r) === 'red').length;
  const dot = (c: string) => (c === 'green' ? 'bg-green-500' : c === 'amber' ? 'bg-amber-500' : 'bg-red-500');
  return (
    <main className="min-h-screen p-6 max-w-6xl mx-auto">
      <header className="flex justify-between items-center mb-8 pb-4 border-b">
        <div>
          <h1 className="text-2xl font-medium">Backups &amp; Restore</h1>
          <p className="text-sm text-gray-500 mt-1">
            <span className="text-green-700 font-medium">{g} healthy</span>
            {a > 0 && <> · <span className="text-amber-700">{a} stale</span></>}
            {b > 0 && <> · <span className="text-red-700 font-medium">{b} failing</span></>}
            <span className="text-gray-400"> · {rows.length} server{rows.length === 1 ? '' : 's'}</span>
          </p>
        </div>
        <Link href="/dashboard" className="text-sm text-gray-500 hover:text-gray-800">&larr; Dashboard</Link>
      </header>
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
            {rows.map((r) => { const c = cls(r); const age = ageH(r.last_backup_at); return (
              <tr key={r.server_id} className="border-t align-top">
                <td className="px-3 py-2"><span className={`inline-block w-2.5 h-2.5 rounded-full ${dot(c)}`}></span></td>
                <td className="px-3 py-2"><div className="font-medium">{r.server_name}</div><div className="text-xs text-gray-500 font-mono">{r.fqdn}</div></td>
                <td className="px-3 py-2 text-xs text-gray-600 font-mono">{r.role}</td>
                <td className="px-3 py-2 text-xs"><span className={c === 'red' ? 'text-red-700' : c === 'amber' ? 'text-amber-700' : 'text-gray-700'}>{fmtAge(age)}{age !== null ? ' ago' : ''}</span></td>
                <td className="px-3 py-2 text-xs">{r.last_backup_status ?? '—'}</td>
                <td className="px-3 py-2 text-xs text-gray-600">{r.last_backup_size_mb != null ? (r.last_backup_size_mb >= 1024 ? (r.last_backup_size_mb / 1024).toFixed(1) + ' GB' : r.last_backup_size_mb + ' MB') : '—'}</td>
                <td className="px-3 py-2 text-xs text-gray-600">{r.disk_usage_pct != null ? r.disk_usage_pct + '%' : '—'}{r.disk_total_gb != null ? ` / ${r.disk_total_gb}GB` : ''}</td>
                <td className="px-3 py-2 text-xs">{r.dumps_mounted === true ? <span className="text-green-700">mounted</span> : r.dumps_mounted === false ? <span className="text-red-700">not mounted</span> : <span className="text-gray-400">—</span>}</td>
                <td className="px-3 py-2 text-xs text-gray-500 font-mono">{r.captured_at ? r.captured_at.slice(0, 16) : '—'}</td>
              </tr>
            );})}
          </tbody>
        </table>
      </section>
      <p className="text-xs text-gray-400 mt-4">Phase 1 — health view. Restore actions (browse / restore offsite backups) coming in Phase 2.</p>
    </main>
  );
}
