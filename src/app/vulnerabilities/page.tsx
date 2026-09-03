import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSession } from '@/lib/sessions';
import { listVulnerabilities } from '@/lib/cve-matcher';
import VulnRefreshButton from './VulnRefreshButton';

export const dynamic = 'force-dynamic';

function sevBadge(s: string | null) {
  if (s === 'CRITICAL') return <span className="inline-block bg-red-200 text-red-900 px-2 py-0.5 rounded text-xs">critical</span>;
  if (s === 'HIGH') return <span className="inline-block bg-orange-100 text-orange-800 px-2 py-0.5 rounded text-xs">high</span>;
  if (s === 'MEDIUM') return <span className="inline-block bg-amber-100 text-amber-800 px-2 py-0.5 rounded text-xs">medium</span>;
  if (s === 'LOW') return <span className="inline-block bg-blue-100 text-blue-800 px-2 py-0.5 rounded text-xs">low</span>;
  return <span className="inline-block bg-gray-100 text-gray-500 px-2 py-0.5 rounded text-xs">{s ?? '?'}</span>;
}

export default async function VulnPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get('aem_session')?.value;
  if (!sessionId) redirect('/auth/login');
  const sess = await getSession(sessionId);
  if (!sess) redirect('/auth/login');

  const sp = await searchParams;
  const ack = (sp.ack as 'open' | 'acked' | 'all') || 'open';
  const rows = await listVulnerabilities({ ack });
  const counts = rows.reduce((acc: Record<string, number>, r) => { acc[r.severity ?? 'UNKNOWN'] = (acc[r.severity ?? 'UNKNOWN'] || 0) + 1; return acc; }, {});

  return (
    <main className="min-h-screen p-6 max-w-7xl mx-auto">
      <header className="flex justify-between items-center mb-6 pb-4 border-b">
        <div>
          <h1 className="text-2xl font-medium">Vulnerabilities</h1>
          <p className="text-sm text-gray-500 mt-1">
            {counts.CRITICAL ? <span className="text-red-700 font-medium mr-2">{counts.CRITICAL} critical</span> : null}
            {counts.HIGH ? <span className="text-orange-700 mr-2">{counts.HIGH} high</span> : null}
            {counts.MEDIUM ? <span className="text-amber-700 mr-2">{counts.MEDIUM} medium</span> : null}
            {counts.LOW ? <span className="text-blue-700 mr-2">{counts.LOW} low</span> : null}
            {!counts.CRITICAL && !counts.HIGH && !counts.MEDIUM && !counts.LOW ? <span className="text-gray-500">no matches yet - click Refresh</span> : null}
          </p>
        </div>
        <div className="flex gap-4 items-center">
          <Link href="/dashboard" className="text-sm text-gray-500 hover:text-gray-800">&larr; Dashboard</Link>
          <VulnRefreshButton />
        </div>
      </header>

      <div className="mb-4 flex gap-3 text-sm">
        <a href="/vulnerabilities?ack=open" className={`px-3 py-1 rounded ${ack === 'open' ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-600'}`}>Open</a>
        <a href="/vulnerabilities?ack=acked" className={`px-3 py-1 rounded ${ack === 'acked' ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-600'}`}>Ack&apos;d</a>
        <a href="/vulnerabilities?ack=all" className={`px-3 py-1 rounded ${ack === 'all' ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-600'}`}>All</a>
        <span className="ml-auto text-gray-400">{rows.length} shown</span>
      </div>

      {rows.length === 0 ? (
        <div className="border rounded p-8 text-center text-gray-500">
          <p className="text-sm">No vulnerabilities in this view.</p>
          <p className="text-sm mt-2">Click <strong>Refresh</strong> to probe plugins + match against NVD.</p>
        </div>
      ) : (
        <div className="border rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-3 py-2">Severity</th>
                <th className="px-3 py-2">CVE</th>
                <th className="px-3 py-2">Score</th>
                <th className="px-3 py-2">Plugin</th>
                <th className="px-3 py-2">Version</th>
                <th className="px-3 py-2">Site</th>
                <th className="px-3 py-2">Description</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.match_id} className="border-t">
                  <td className="px-3 py-2">{sevBadge(r.severity)}</td>
                  <td className="px-3 py-2 font-mono text-xs">
                    <a href={`https://nvd.nist.gov/vuln/detail/${r.cve_id}`} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">{r.cve_id}</a>
                  </td>
                  <td className="px-3 py-2 text-xs">{r.cvss_score ?? '—'}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.target_slug}</td>
                  <td className="px-3 py-2 text-xs">{r.installed_version ?? '—'}</td>
                  <td className="px-3 py-2 text-xs font-mono">{r.domain}</td>
                  <td className="px-3 py-2 text-xs text-gray-600 max-w-md truncate" title={r.description ?? ''}>{r.description?.slice(0, 200) ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
