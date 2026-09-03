import { cookies } from 'next/headers';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { getSession } from '@/lib/sessions';
import { getServer } from '@/lib/servers';

export const dynamic = 'force-dynamic';

export default async function ServerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get('aem_session')?.value;
  if (!sessionId) redirect('/auth/login');
  const sess = await getSession(sessionId);
  if (!sess) redirect('/auth/login');

  const { id } = await params;
  const server = await getServer(Number(id));
  if (!server) notFound();

  return (
    <main className="min-h-screen p-6 max-w-3xl mx-auto">
      <header className="mb-8 pb-4 border-b">
        <Link href="/admin/servers" className="text-sm text-gray-500 hover:text-gray-800">&larr; All servers</Link>
        <h1 className="text-2xl font-medium mt-2">{server.name}</h1>
        <p className="text-sm text-gray-500 mt-1">{server.fqdn}</p>
      </header>

      <section className="mb-8">
        <h2 className="text-lg font-medium mb-3">Details</h2>
        <dl className="grid grid-cols-3 gap-y-2 text-sm">
          <dt className="text-gray-500">Role</dt><dd className="col-span-2 font-mono text-xs">{server.role}</dd>
          <dt className="text-gray-500">Plesk API URL</dt><dd className="col-span-2 font-mono text-xs">{server.plesk_api_url ?? '—'}</dd>
          <dt className="text-gray-500">Enabled</dt><dd className="col-span-2">{server.enabled ? 'yes' : 'no'}</dd>
          <dt className="text-gray-500">Token</dt><dd className="col-span-2">{server.has_token ? 'configured' : 'not yet configured'}</dd>
          <dt className="text-gray-500">Notes</dt><dd className="col-span-2 text-gray-700">{server.notes ?? '—'}</dd>
        </dl>
      </section>

      <section>
        <h2 className="text-lg font-medium mb-3">Plesk API token</h2>
        <p className="text-sm text-gray-500 mb-3">
          {server.has_token
            ? 'Token configured. Use the form below to rotate or replace.'
            : 'To pull inventory from this server, paste a Plesk API token below.'}
        </p>
        <p className="text-sm text-gray-500 mb-3">
          Generate one in Plesk: Tools &amp; Settings &rarr; API keys &rarr; Add new API key (admin user).
        </p>
        <form method="POST" action={`/api/servers/${server.id}/token`} className="space-y-3">
          <input
            type="password"
            name="token"
            required
            placeholder="paste Plesk API key here"
            className="block w-full rounded border border-gray-300 px-3 py-2 font-mono text-sm"
            autoComplete="off"
          />
          <button type="submit" className="rounded bg-blue-600 text-white px-4 py-2 text-sm font-medium">
            Store + test connection
          </button>
        </form>
      </section>
    </main>
  );
}
