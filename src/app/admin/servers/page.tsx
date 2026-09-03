import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSession } from '@/lib/sessions';
import { listServers } from '@/lib/servers';

export const dynamic = 'force-dynamic';

export default async function ServersPage() {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get('aem_session')?.value;
  if (!sessionId) redirect('/auth/login');
  const sess = await getSession(sessionId);
  if (!sess) redirect('/auth/login');

  const servers = await listServers();

  return (
    <main className="min-h-screen p-6 max-w-5xl mx-auto">
      <header className="flex justify-between items-center mb-8 pb-4 border-b">
        <div>
          <h1 className="text-2xl font-medium">Fleet servers</h1>
          <p className="text-sm text-gray-500 mt-1">{servers.length} servers under management</p>
        </div>
        <Link href="/dashboard" className="text-sm text-gray-500 hover:text-gray-800">&larr; Dashboard</Link>
      </header>

      <div className="border rounded overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Role</th>
              <th className="px-3 py-2">FQDN</th>
              <th className="px-3 py-2">Token</th>
              <th className="px-3 py-2">Last health</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {servers.map((s) => (
              <tr key={s.id} className="border-t">
                <td className="px-3 py-2 font-medium">{s.name}</td>
                <td className="px-3 py-2 text-gray-600 font-mono text-xs">{s.role}</td>
                <td className="px-3 py-2 text-gray-600 font-mono text-xs">{s.fqdn}</td>
                <td className="px-3 py-2">
                  {s.has_token ? (
                    <span className="inline-block text-xs bg-green-100 text-green-800 px-2 py-0.5 rounded">configured</span>
                  ) : (
                    <span className="inline-block text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded">no token</span>
                  )}
                </td>
                <td className="px-3 py-2 text-gray-500 font-mono text-xs">
                  {s.last_health_at ? s.last_health_at.slice(0, 16) : '—'}
                </td>
                <td className="px-3 py-2 text-right">
                  <Link href={`/admin/servers/${s.id}`} className="text-blue-600 text-sm">
                    Manage &rarr;
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-6 text-sm text-gray-500">
        Each server needs a Plesk API token before AEM Console can fetch its inventory.
        Tokens are AES-256-GCM encrypted at rest; the key lives in /etc/aem-console/key (mode 640, root + aem-console only).
      </p>
    </main>
  );
}
