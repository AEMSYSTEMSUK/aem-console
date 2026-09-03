import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSession } from '@/lib/sessions';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export default async function WpScanAdminPage() {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get('aem_session')?.value;
  if (!sessionId) redirect('/auth/login');
  const sess = await getSession(sessionId);
  if (!sess) redirect('/auth/login');

  const r = await db.query<{ id: number; created_at: string }>(`SELECT id, created_at::text FROM integration_tokens WHERE type = 'wpscan' ORDER BY id DESC LIMIT 1`);
  const existing = r.rows[0];

  const counts = await db.query<{ total: string; vuln_count: string; not_found: string }>(`
    SELECT
      count(*)::text AS total,
      count(*) FILTER (WHERE jsonb_array_length(vulnerabilities) > 0)::text AS vuln_count,
      count(*) FILTER (WHERE not_found = true)::text AS not_found
    FROM wpscan_plugin_data
  `);
  const c = counts.rows[0];

  return (
    <main className="min-h-screen p-6 max-w-3xl mx-auto">
      <header className="mb-8 pb-4 border-b">
        <Link href="/dashboard" className="text-sm text-gray-500 hover:text-gray-800">&larr; Dashboard</Link>
        <h1 className="text-2xl font-medium mt-2">WPScan API integration</h1>
        <p className="text-sm text-gray-500 mt-1">Accurate WordPress plugin vulnerability data from wpscan.com.</p>
      </header>

      <section className="mb-8">
        <h2 className="text-lg font-medium mb-3">Cache status</h2>
        <div className="text-sm space-y-1">
          <p>Plugins cached: <span className="font-mono">{c.total}</span></p>
          <p>With known vulnerabilities: <span className="font-mono text-red-700">{c.vuln_count}</span></p>
          <p>Not found in WPScan DB: <span className="font-mono text-gray-500">{c.not_found}</span></p>
        </div>
      </section>

      <section className="mb-8">
        <h2 className="text-lg font-medium mb-3">API key</h2>
        {existing ? (
          <p className="text-sm text-gray-700 mb-3">
            <span className="inline-block bg-green-100 text-green-800 px-2 py-0.5 rounded text-xs mr-2">configured</span>
            Set: <span className="font-mono text-xs">{existing.created_at.slice(0, 16)}</span>
          </p>
        ) : (
          <p className="text-sm text-amber-700 mb-3">
            <span className="inline-block bg-amber-100 text-amber-800 px-2 py-0.5 rounded text-xs mr-2">not configured</span>
            Sign up free at <a href="https://wpscan.com/profile" target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">wpscan.com/profile</a>, get your API token, paste below.
          </p>
        )}
        <form method="POST" action="/api/admin/wpscan-token" className="space-y-3">
          <input name="token" type="password" required placeholder="WPScan API token" className="block w-full rounded border border-gray-300 px-3 py-2 font-mono text-sm" autoComplete="off" />
          <button type="submit" className="rounded bg-blue-600 text-white px-4 py-2 text-sm font-medium">Store API key</button>
        </form>
      </section>

      <section>
        <h2 className="text-lg font-medium mb-3">Usage</h2>
        <p className="text-sm text-gray-600 mb-3">Free tier: 75 requests/day. Fleet has ~200 unique plugins — bootstrap takes ~3 days, then daily ~25 stale entries refresh automatically.</p>
        <form method="POST" action="/api/cron/wpscan-refresh" className="inline">
          <button type="submit" className="rounded bg-blue-600 text-white px-4 py-2 text-sm font-medium">Probe stale plugins now</button>
        </form>
      </section>
    </main>
  );
}
