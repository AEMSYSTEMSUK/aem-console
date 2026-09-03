import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSession } from '@/lib/sessions';
import { listSites, countSites } from '@/lib/sites';
import RefreshButton from './RefreshButton';

export const dynamic = 'force-dynamic';

export default async function InventoryPage() {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get('aem_session')?.value;
  if (!sessionId) redirect('/auth/login');
  const sess = await getSession(sessionId);
  if (!sess) redirect('/auth/login');

  const sites = await listSites();
  const counts = await countSites();

  return (
    <main className="min-h-screen p-6 max-w-6xl mx-auto">
      <header className="flex justify-between items-center mb-8 pb-4 border-b">
        <div>
          <h1 className="text-2xl font-medium">Site inventory</h1>
          <p className="text-sm text-gray-500 mt-1">
            {counts.total} sites &middot; {counts.wordpress} WordPress &middot; {counts.with_mu_plugin} with aem-mail-sender
          </p>
        </div>
        <div className="flex gap-4 items-center">
          <Link href="/dashboard" className="text-sm text-gray-500 hover:text-gray-800">&larr; Dashboard</Link>
          <RefreshButton />
        </div>
      </header>

      {sites.length === 0 ? (
        <div className="border rounded p-8 text-center text-gray-500">
          <p className="text-sm">No sites yet.</p>
          <p className="text-sm mt-2">
            Add Plesk API tokens on <Link href="/admin/servers" className="text-blue-600">/admin/servers</Link>,
            then click &quot;Refresh inventory&quot; above.
          </p>
        </div>
      ) : (
        <div className="border rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-3 py-2">Domain</th>
                <th className="px-3 py-2">Host server</th>
                <th className="px-3 py-2">Stage</th>
                <th className="px-3 py-2">WordPress</th>
                <th className="px-3 py-2">mu-plugin</th>
                <th className="px-3 py-2">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {sites.map((s) => (
                <tr key={s.id} className="border-t">
                  <td className="px-3 py-2 font-mono">{s.domain}</td>
                  <td className="px-3 py-2 text-gray-600">{s.host_server_name ?? '—'}</td>
                  <td className="px-3 py-2 text-gray-600 text-xs">{s.lifecycle_stage}</td>
                  <td className="px-3 py-2 text-xs">
                    {s.is_wordpress
                      ? <span className="text-green-700">{s.wp_version ?? 'yes'}</span>
                      : <span className="text-gray-400">—</span>}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {s.has_mu_plugin === true ? <span className="text-green-700">yes</span>
                     : s.has_mu_plugin === false ? <span className="text-amber-700">no</span>
                     : <span className="text-gray-400">unknown</span>}
                  </td>
                  <td className="px-3 py-2 text-gray-500 font-mono text-xs">
                    {s.last_seen_at ? s.last_seen_at.slice(0, 16) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
