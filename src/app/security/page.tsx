import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSession } from '@/lib/sessions';
import { listDomainSecurity } from '@/lib/domain-security';
export const dynamic = 'force-dynamic';
const pct = (n: number, d: number) => (d > 0 ? Math.round((100 * n) / d) : null);
const pcls = (p: number | null) => (p === null ? 'text-gray-400' : p >= 95 ? 'text-green-700' : p >= 80 ? 'text-amber-700' : 'text-red-700');
const barCls = (p: number | null) => (p === null ? 'bg-gray-200' : p >= 95 ? 'bg-green-500' : p >= 80 ? 'bg-amber-500' : 'bg-red-500');
const gcls = (g: string) => (g.startsWith('A') ? 'bg-green-100 text-green-800' : g.startsWith('B') ? 'bg-amber-100 text-amber-800' : 'bg-red-100 text-red-800');
export default async function SecurityPage() {
  const cookieStore = await cookies();
  const sid = cookieStore.get('aem_session')?.value;
  if (!sid) redirect('/auth/login');
  const sess = await getSession(sid);
  if (!sess) redirect('/auth/login');
  const rows = await listDomainSecurity();
  const avg = rows.length ? Math.round(rows.reduce((a, r) => a + r.score, 0) / rows.length) : null;
  return (
    <main className="min-h-screen p-6 max-w-7xl mx-auto">
      <header className="flex justify-between items-center mb-6 pb-4 border-b">
        <div>
          <h1 className="text-2xl font-medium">Domain security</h1>
          <p className="text-sm text-gray-500 mt-1">{rows.length === 0 ? 'No domains scanned yet — run a probe on the Posture page.' : <>Average score <span className="font-medium">{avg}</span> across {rows.length} domain{rows.length === 1 ? '' : 's'} · sorted weakest first</>}</p>
        </div>
        <div className="flex gap-4 items-center">
          <Link href="/dmarc" className="text-sm text-gray-500 hover:text-gray-800">Posture</Link>
          <Link href="/dmarc/reports" className="text-sm text-gray-500 hover:text-gray-800">Reports</Link>
          <Link href="/dashboard" className="text-sm text-gray-500 hover:text-gray-800">&larr; Dashboard</Link>
        </div>
      </header>
      {rows.length === 0 ? (
        <div className="border rounded p-8 text-center text-gray-500"><p className="text-sm">No domain scans yet. Run the probe on the <Link href="/dmarc" className="text-blue-600">Posture</Link> page first.</p></div>
      ) : (
        <div className="border rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left border-b">
              <tr>
                <th className="px-3 py-2">Domain</th><th className="px-3 py-2 w-32">Security score</th>
                <th className="px-3 py-2 w-20">Policy</th><th className="px-3 py-2 w-20">Volume</th>
                <th className="px-3 py-2 w-52">DMARC compliance</th><th className="px-3 py-2 w-16">SPF</th>
                <th className="px-3 py-2 w-16">DKIM</th><th className="px-3 py-2 w-28">Scanned</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => { const comp = pct(r.dmarc_pass, r.messages); const spf = pct(r.spf_pass, r.messages); const dkim = pct(r.dkim_pass, r.messages); return (
                <tr key={r.domain} className="border-t align-middle">
                  <td className="px-3 py-2 font-mono">{r.domain}</td>
                  <td className="px-3 py-2"><span className={`inline-block px-2 py-0.5 rounded text-xs font-medium mr-2 ${gcls(r.grade)}`}>{r.grade}</span><span className="text-xs text-gray-600">{r.score}</span></td>
                  <td className="px-3 py-2 text-xs">{r.has_dmarc ? `p=${r.dmarc_policy ?? '?'}` : <span className="text-red-700">none</span>}</td>
                  <td className="px-3 py-2 text-xs text-gray-600">{r.messages ? r.messages.toLocaleString() : '—'}</td>
                  <td className="px-3 py-2">{r.messages ? <div className="flex items-center gap-2"><div className="flex-1 h-2 rounded bg-gray-100 overflow-hidden"><div className={`h-2 ${barCls(comp)}`} style={{ width: `${comp ?? 0}%` }}></div></div><span className={`text-xs font-medium w-10 text-right ${pcls(comp)}`}>{comp ?? '—'}%</span></div> : <span className="text-xs text-gray-400">awaiting reports</span>}</td>
                  <td className={`px-3 py-2 text-xs ${pcls(spf)}`}>{r.messages ? `${spf ?? '—'}%` : '—'}</td>
                  <td className={`px-3 py-2 text-xs ${pcls(dkim)}`}>{r.messages ? `${dkim ?? '—'}%` : '—'}</td>
                  <td className="px-3 py-2 text-xs font-mono text-gray-500">{r.captured_at ? r.captured_at.slice(0, 16) : '—'}</td>
                </tr>
              );})}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
