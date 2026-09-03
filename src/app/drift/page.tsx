import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSession } from '@/lib/sessions';
import { listOpenDrifts, listActiveExceptions } from '@/lib/drift';
import DriftRefreshButton from './DriftRefreshButton';
import { ExceptButton, RemoveExceptionButton } from './DriftExceptionButtons';
export const dynamic = 'force-dynamic';

export default async function DriftPage() {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get('aem_session')?.value;
  if (!sessionId) redirect('/auth/login');
  const sess = await getSession(sessionId);
  if (!sess) redirect('/auth/login');
  const [drifts, exceptions] = await Promise.all([listOpenDrifts(), listActiveExceptions()]);
  const criticalCount = drifts.filter((d) => d.severity === 'critical').length;
  const warnCount = drifts.filter((d) => d.severity === 'warn').length;
  const groups = new Map<string, typeof drifts>();
  for (const d of drifts) {
    const key = d.server_name ?? '— unassigned —';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(d);
  }
  const sevRank = (s: string) => (s === 'critical' ? 1 : s === 'warn' ? 2 : 3);
  const orderedServers = [...groups.entries()].sort((a, b) => {
    const wa = Math.min(...a[1].map((d) => sevRank(d.severity)));
    const wb = Math.min(...b[1].map((d) => sevRank(d.severity)));
    return wa - wb || a[0].localeCompare(b[0]);
  });
  return (
    <main className="min-h-screen p-6 max-w-6xl mx-auto">
      <header className="flex justify-between items-center mb-8 pb-4 border-b">
        <div>
          <h1 className="text-2xl font-medium">Drift detection</h1>
          <p className="text-sm text-gray-500 mt-1">
            {drifts.length === 0 ? (
              'No open drifts'
            ) : (
              <>
                {criticalCount > 0 && <span className="text-red-700 font-medium">{criticalCount} critical</span>}
                {criticalCount > 0 && warnCount > 0 && ' · '}
                {warnCount > 0 && <span className="text-amber-700">{warnCount} warn</span>}
                {' · '}
                <span className="text-gray-500">{drifts.length} across {groups.size} server{groups.size === 1 ? '' : 's'}</span>
              </>
            )}
            {exceptions.length > 0 && <span className="text-gray-400"> · {exceptions.length} documented exception{exceptions.length === 1 ? '' : 's'}</span>}
          </p>
        </div>
        <div className="flex gap-4 items-center">
          <Link href="/dashboard" className="text-sm text-gray-500 hover:text-gray-800">&larr; Dashboard</Link>
          <DriftRefreshButton />
        </div>
      </header>

      {exceptions.length > 0 && (
        <section className="border rounded overflow-hidden mb-6">
          <div className="bg-gray-50 px-3 py-2 border-b text-sm font-medium">Documented exceptions ({exceptions.length})</div>
          <table className="w-full text-sm">
            <thead className="bg-white text-left border-b">
              <tr>
                <th className="px-3 py-2 w-40">Server</th>
                <th className="px-3 py-2 w-48">Standard</th>
                <th className="px-3 py-2">Reason</th>
                <th className="px-3 py-2 w-28">Expires</th>
                <th className="px-3 py-2 w-20"></th>
              </tr>
            </thead>
            <tbody>
              {exceptions.map((ex) => (
                <tr key={ex.id} className="border-t align-top">
                  <td className="px-3 py-2">{ex.server_name ?? '—'}</td>
                  <td className="px-3 py-2 font-mono text-xs">{ex.standard_name ?? '—'}</td>
                  <td className="px-3 py-2 text-gray-600 whitespace-pre-wrap break-words">{ex.reason}</td>
                  <td className="px-3 py-2 text-xs text-gray-500 font-mono">{ex.expires_at ? ex.expires_at.slice(0, 10) : 'never'}</td>
                  <td className="px-3 py-2"><RemoveExceptionButton id={ex.id} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {drifts.length === 0 ? (
        <div className="border rounded p-8 text-center text-gray-500">
          <p className="text-sm">No open drift records{exceptions.length > 0 ? ' (excepted drifts are suppressed above)' : ''}. Click &quot;Run checks&quot; above to scan the fleet.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {orderedServers.map(([server, rows]) => (
            <section key={server} className="border rounded overflow-hidden">
              <div className="bg-gray-50 px-3 py-2 flex items-center justify-between border-b">
                <span className="font-medium">{server}</span>
                <span className="text-xs text-gray-500">{rows.length} open</span>
              </div>
              <table className="w-full text-sm">
                <thead className="bg-white text-left border-b">
                  <tr>
                    <th className="px-3 py-2 w-24">Severity</th>
                    <th className="px-3 py-2 w-48">Standard</th>
                    <th className="px-3 py-2">Detail</th>
                    <th className="px-3 py-2 w-28">Site</th>
                    <th className="px-3 py-2 w-20">Status</th>
                    <th className="px-3 py-2 w-32">Detected</th>
                    <th className="px-3 py-2 w-20"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((d) => (
                    <tr key={d.id} className="border-t align-top">
                      <td className="px-3 py-2 text-xs">
                        {d.severity === 'critical' ? (
                          <span className="inline-block bg-red-100 text-red-800 px-2 py-0.5 rounded">critical</span>
                        ) : d.severity === 'warn' ? (
                          <span className="inline-block bg-amber-100 text-amber-800 px-2 py-0.5 rounded">warn</span>
                        ) : (
                          <span className="inline-block bg-gray-100 text-gray-600 px-2 py-0.5 rounded">{d.severity}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{d.standard_name}</td>
                      <td className="px-3 py-2 text-xs text-gray-600 whitespace-pre-wrap break-words">{d.notes ?? '—'}</td>
                      <td className="px-3 py-2 text-gray-600 font-mono text-xs">{d.site_domain ?? '—'}</td>
                      <td className="px-3 py-2 text-xs">{d.status === 'drift' ? <span className="text-amber-700">drift</span> : <span className="text-red-700">{d.status}</span>}</td>
                      <td className="px-3 py-2 text-gray-500 font-mono text-xs">{d.detected_at.slice(0, 16)}</td>
                      <td className="px-3 py-2"><ExceptButton serverId={d.server_id} standardId={d.standard_id} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
