import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSession } from '@/lib/sessions';
import { listLatestDmarcHealth } from '@/lib/dmarc-probe';
import DmarcProbeButton from './DmarcProbeButton';

export const dynamic = 'force-dynamic';

function badge(condition: boolean | null, label: string) {
  if (condition === null || condition === undefined) return <span className="inline-block bg-gray-100 text-gray-400 px-1.5 py-0.5 rounded text-xs">{label}?</span>;
  return condition
    ? <span className="inline-block bg-green-100 text-green-700 px-1.5 py-0.5 rounded text-xs">{label}</span>
    : <span className="inline-block bg-red-100 text-red-700 px-1.5 py-0.5 rounded text-xs">{label}</span>;
}

function sevBadge(s: string | null) {
  if (s === 'green') return <span className="inline-block bg-green-100 text-green-800 px-2 py-0.5 rounded text-xs">healthy</span>;
  if (s === 'amber') return <span className="inline-block bg-amber-100 text-amber-800 px-2 py-0.5 rounded text-xs">amber</span>;
  if (s === 'red') return <span className="inline-block bg-red-100 text-red-800 px-2 py-0.5 rounded text-xs">red</span>;
  return <span className="inline-block bg-gray-100 text-gray-500 px-2 py-0.5 rounded text-xs">?</span>;
}

export default async function DmarcPage() {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get('aem_session')?.value;
  if (!sessionId) redirect('/auth/login');
  const sess = await getSession(sessionId);
  if (!sess) redirect('/auth/login');

  const rows = await listLatestDmarcHealth();
  const counts = rows.reduce((acc: Record<string, number>, r) => { acc[r.severity ?? 'unknown'] = (acc[r.severity ?? 'unknown'] || 0) + 1; return acc; }, {});

  return (
    <main className="min-h-screen p-6 max-w-7xl mx-auto">
      <header className="flex justify-between items-center mb-6 pb-4 border-b">
        <div>
          <h1 className="text-2xl font-medium">Mail health (SPF / DKIM / DMARC)</h1>
          <p className="text-sm text-gray-500 mt-1">
            {counts.red ? <span className="text-red-700 font-medium mr-2">{counts.red} red</span> : null}
            {counts.amber ? <span className="text-amber-700 mr-2">{counts.amber} amber</span> : null}
            {counts.green ? <span className="text-green-700 mr-2">{counts.green} healthy</span> : null}
            {!counts.red && !counts.amber && !counts.green ? <span className="text-gray-500">no scans yet - click Probe</span> : null}
          </p>
        </div>
        <div className="flex gap-4 items-center">
          <Link href="/dashboard" className="text-sm text-gray-500 hover:text-gray-800">&larr; Dashboard</Link>
          <DmarcProbeButton />
        </div>
      </header>

      {rows.length === 0 ? (
        <div className="border rounded p-8 text-center text-gray-500">
          <p className="text-sm">No scan results yet. Click <strong>Probe</strong> to run live DNS checks across all fleet domains.</p>
        </div>
      ) : (
        <div className="border rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-3 py-2">Domain</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">SPF</th>
                <th className="px-3 py-2">DKIM</th>
                <th className="px-3 py-2">DMARC</th>
                <th className="px-3 py-2">Notes</th>
                <th className="px-3 py-2">Scanned</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.domain} className="border-t">
                  <td className="px-3 py-2 font-mono">{r.domain}</td>
                  <td className="px-3 py-2">{sevBadge(r.severity)}</td>
                  <td className="px-3 py-2 space-x-1">
                    {badge(r.has_spf, 'rec')}
                    {badge(r.spf_includes_aem_relay, 'aem')}
                  </td>
                  <td className="px-3 py-2">{badge(r.has_dkim_default, 'default')}</td>
                  <td className="px-3 py-2 text-xs">
                    {r.has_dmarc ? <span className="text-gray-700">p={r.dmarc_policy ?? '?'}</span> : <span className="text-red-700">none</span>}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-600 max-w-md truncate" title={r.notes ?? ''}>{r.notes ?? '—'}</td>
                  <td className="px-3 py-2 text-xs font-mono text-gray-500">{r.captured_at?.slice(0, 16) ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
