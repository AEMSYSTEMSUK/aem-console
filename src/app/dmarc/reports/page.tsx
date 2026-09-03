import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSession } from '@/lib/sessions';
import { listDmarcReportSummary } from '@/lib/dmarc-reports';
export const dynamic = 'force-dynamic';
const pct = (n: number, d: number) => (d > 0 ? Math.round((100 * n) / d) : null);
const pcls = (p: number | null) => (p === null ? 'text-gray-400' : p >= 95 ? 'text-green-700' : p >= 80 ? 'text-amber-700' : 'text-red-700');
const barCls = (p: number | null) => (p === null ? 'bg-gray-300' : p >= 95 ? 'bg-green-500' : p >= 80 ? 'bg-amber-500' : 'bg-red-500');
export default async function DmarcReportsPage() {
  const cookieStore = await cookies();
  const sid = cookieStore.get('aem_session')?.value;
  if (!sid) redirect('/auth/login');
  const sess = await getSession(sid);
  if (!sess) redirect('/auth/login');
  const rows = await listDmarcReportSummary();
  const totMsg = rows.reduce((a, r) => a + r.messages, 0);
  const totPass = rows.reduce((a, r) => a + r.dmarc_pass, 0);
  const overall = pct(totPass, totMsg);
  return (
    <main className="min-h-screen p-6 max-w-7xl mx-auto">
      <header className="flex justify-between items-center mb-6 pb-4 border-b">
        <div>
          <h1 className="text-2xl font-medium">DMARC reports</h1>
          <p className="text-sm text-gray-500 mt-1">
            {rows.length === 0 ? 'No aggregate reports yet — reporters send daily, so the first land ~24h after the rua cutover.' : <>Overall compliance <span className={`font-medium ${pcls(overall)}`}>{overall ?? '—'}%</span> across {totMsg.toLocaleString()} messages · {rows.length} domain{rows.length === 1 ? '' : 's'}</>}
          </p>
        </div>
        <div className="flex gap-4 items-center">
          <Link href="/dmarc" className="text-sm text-gray-500 hover:text-gray-800">Posture</Link>
          <Link href="/dashboard" className="text-sm text-gray-500 hover:text-gray-800">&larr; Dashboard</Link>
        </div>
      </header>
      {rows.length === 0 ? (
        <div className="border rounded p-8 text-center text-gray-500">
          <p className="text-sm">No DMARC aggregate reports ingested yet. Google/Microsoft etc. send these once daily; the first land within ~24h of the rua cutover and the hourly poller stores them here.</p>
        </div>
      ) : (
        <div className="border rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left border-b">
              <tr>
                <th className="px-3 py-2">Domain</th><th className="px-3 py-2 w-20">Policy</th>
                <th className="px-3 py-2 w-24">Volume</th><th className="px-3 py-2 w-56">DMARC compliance</th>
                <th className="px-3 py-2 w-20">SPF</th><th className="px-3 py-2 w-20">DKIM</th>
                <th className="px-3 py-2 w-16">Reports</th><th className="px-3 py-2 w-28">Latest</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => { const comp = pct(r.dmarc_pass, r.messages); const spf = pct(r.spf_pass, r.messages); const dkim = pct(r.dkim_pass, r.messages); return (
                <tr key={r.domain} className="border-t align-middle">
                  <td className="px-3 py-2 font-mono">{r.domain}</td>
                  <td className="px-3 py-2 text-xs">{r.policy ? `p=${r.policy}` : '—'}</td>
                  <td className="px-3 py-2 text-xs text-gray-600">{r.messages.toLocaleString()}</td>
                  <td className="px-3 py-2"><div className="flex items-center gap-2"><div className="flex-1 h-2 rounded bg-gray-100 overflow-hidden"><div className={`h-2 ${barCls(comp)}`} style={{ width: `${comp ?? 0}%` }}></div></div><span className={`text-xs font-medium w-10 text-right ${pcls(comp)}`}>{comp ?? '—'}%</span></div></td>
                  <td className={`px-3 py-2 text-xs ${pcls(spf)}`}>{spf ?? '—'}%</td>
                  <td className={`px-3 py-2 text-xs ${pcls(dkim)}`}>{dkim ?? '—'}%</td>
                  <td className="px-3 py-2 text-xs text-gray-500">{r.reports}</td>
                  <td className="px-3 py-2 text-xs font-mono text-gray-500">{r.latest ? r.latest.slice(0, 10) : '—'}</td>
                </tr>
              );})}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
