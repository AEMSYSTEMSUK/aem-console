import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSession } from '@/lib/sessions';
import { listAlerts, countOpenAlerts } from '@/lib/alerts';
import AlertActions from './AlertActions';

export const dynamic = 'force-dynamic';

function severityBadge(severity: string) {
  const map: Record<string, string> = {
    critical: 'bg-red-100 text-red-800',
    high: 'bg-orange-100 text-orange-800',
    medium: 'bg-amber-100 text-amber-800',
    low: 'bg-blue-100 text-blue-800',
    info: 'bg-gray-100 text-gray-600',
  };
  return map[severity] ?? 'bg-gray-100 text-gray-600';
}

export default async function AlertsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get('aem_session')?.value;
  if (!sessionId) redirect('/auth/login');
  const sess = await getSession(sessionId);
  if (!sess) redirect('/auth/login');

  const sp = await searchParams;
  const sourceFilter = sp.source || undefined;
  const severityFilter = sp.severity || undefined;
  const ackFilter = (sp.ack as 'all' | 'open' | 'acked') || 'open';

  const [alerts, counts] = await Promise.all([
    listAlerts({ source: sourceFilter, severity: severityFilter, ack: ackFilter, limit: 300 }),
    countOpenAlerts(),
  ]);

  return (
    <main className="min-h-screen p-6 max-w-7xl mx-auto">
      <header className="flex justify-between items-center mb-6 pb-4 border-b">
        <div>
          <h1 className="text-2xl font-medium">Alerts</h1>
          <p className="text-sm text-gray-500 mt-1">
            Open: {counts.critical > 0 && <span className="text-red-700 font-medium mr-2">{counts.critical} critical</span>}
            {counts.high > 0 && <span className="text-orange-700 mr-2">{counts.high} high</span>}
            {counts.medium > 0 && <span className="text-amber-700 mr-2">{counts.medium} medium</span>}
            {counts.low + counts.info > 0 && <span className="text-blue-700 mr-2">{counts.low + counts.info} low/info</span>}
            {counts.critical + counts.high + counts.medium + counts.low + counts.info === 0 && <span className="text-gray-500">no open alerts</span>}
          </p>
        </div>
        <Link href="/dashboard" className="text-sm text-gray-500 hover:text-gray-800">&larr; Dashboard</Link>
      </header>

      <div className="mb-4 flex gap-3 text-sm">
        <a href="/alerts?ack=open" className={`px-3 py-1 rounded ${ackFilter === 'open' ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-600'}`}>Open</a>
        <a href="/alerts?ack=acked" className={`px-3 py-1 rounded ${ackFilter === 'acked' ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-600'}`}>Acknowledged</a>
        <a href="/alerts?ack=all" className={`px-3 py-1 rounded ${ackFilter === 'all' ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-600'}`}>All</a>
        <span className="ml-auto text-gray-400">{alerts.length} shown</span>
      </div>

      {alerts.length === 0 ? (
        <div className="border rounded p-8 text-center text-gray-500">
          <p className="text-sm">No alerts in this view.</p>
          <p className="text-sm mt-2">
            Configure IMAP credentials on <Link href="/admin/alert-sink" className="text-blue-600">/admin/alert-sink</Link> and create
            <code className="ml-1 mr-1 bg-gray-100 px-1 rounded">security@aemtech.co.uk</code> mailbox on mail.infra to start receiving alerts.
          </p>
        </div>
      ) : (
        <div className="border rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Severity</th>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2">Subject</th>
                <th className="px-3 py-2">Site</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((a) => (
                <tr key={a.id} className={`border-t ${a.acknowledged_at ? 'text-gray-400' : ''}`}>
                  <td className="px-3 py-2 font-mono text-xs">{a.received_at.slice(0, 16)}</td>
                  <td className="px-3 py-2"><span className={`inline-block px-2 py-0.5 rounded text-xs ${severityBadge(a.severity)}`}>{a.severity}</span></td>
                  <td className="px-3 py-2 text-xs font-mono">{a.source}</td>
                  <td className="px-3 py-2 max-w-md truncate" title={a.subject ?? ''}>{a.subject ?? '—'}</td>
                  <td className="px-3 py-2 text-xs">{a.site_domain ?? '—'}</td>
                  <td className="px-3 py-2"><AlertActions alertId={a.id} isAcked={!!a.acknowledged_at} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
