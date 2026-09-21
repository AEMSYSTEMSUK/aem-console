import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSession } from '@/lib/sessions';
import { listLatestBackupHealth } from '@/lib/backup-health';
import BackupList from './BackupList';
export const dynamic = 'force-dynamic';
type Row = Awaited<ReturnType<typeof listLatestBackupHealth>>[number];
const ageH = (ts: string | null) => (ts ? (Date.now() - new Date(ts).getTime()) / 3.6e6 : null);
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
      <BackupList rows={rows} />
      <p className="text-xs text-gray-400 mt-4">Click the ▸ arrow to list a server&rsquo;s Plesk backups inline, or the server name for its full history + on-demand &ldquo;Run backup now&rdquo; and restore.</p>
    </main>
  );
}
