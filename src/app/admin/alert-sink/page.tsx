import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSession } from '@/lib/sessions';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export default async function AlertSinkPage() {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get('aem_session')?.value;
  if (!sessionId) redirect('/auth/login');
  const sess = await getSession(sessionId);
  if (!sess) redirect('/auth/login');

  const r = await db.query<{ id: number; created_at: string }>(
    `SELECT id, created_at::text FROM integration_tokens WHERE type = 'imap-alerts' ORDER BY id DESC LIMIT 1`
  );
  const existing = r.rows[0];

  return (
    <main className="min-h-screen p-6 max-w-3xl mx-auto">
      <header className="mb-8 pb-4 border-b">
        <Link href="/dashboard" className="text-sm text-gray-500 hover:text-gray-800">&larr; Dashboard</Link>
        <h1 className="text-2xl font-medium mt-2">Alert sink IMAP credentials</h1>
        <p className="text-sm text-gray-500 mt-1">
          AEM Console polls this mailbox for fleet security alerts (Wordfence, Imunify, Plesk backup, etc.).
        </p>
      </header>

      <section className="mb-8">
        <h2 className="text-lg font-medium mb-3">Current status</h2>
        {existing ? (
          <p className="text-sm text-gray-700">
            <span className="inline-block bg-green-100 text-green-800 px-2 py-0.5 rounded text-xs mr-2">configured</span>
            Last updated: <span className="font-mono text-xs">{existing.created_at.slice(0, 16)}</span>
          </p>
        ) : (
          <p className="text-sm text-amber-700">
            <span className="inline-block bg-amber-100 text-amber-800 px-2 py-0.5 rounded text-xs mr-2">not configured</span>
            Add credentials below to start polling.
          </p>
        )}
      </section>

      <section>
        <h2 className="text-lg font-medium mb-3">{existing ? 'Replace credentials' : 'Add credentials'}</h2>
        <form method="POST" action="/api/admin/alert-sink-token" className="space-y-3">
          <label className="block">
            <span className="text-sm font-medium">IMAP host</span>
            <input name="host" type="text" required placeholder="mail.infra.aemsystems.co.uk" defaultValue="mail.infra.aemsystems.co.uk" className="mt-1 block w-full rounded border border-gray-300 px-3 py-2 font-mono text-sm" />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Port</span>
            <input name="port" type="number" required defaultValue="993" className="mt-1 block w-full rounded border border-gray-300 px-3 py-2 font-mono text-sm" />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Username (full email)</span>
            <input name="user" type="email" required placeholder="security@aemtech.co.uk" defaultValue="security@aemtech.co.uk" className="mt-1 block w-full rounded border border-gray-300 px-3 py-2 font-mono text-sm" />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Password</span>
            <input name="password" type="password" required className="mt-1 block w-full rounded border border-gray-300 px-3 py-2 font-mono text-sm" autoComplete="off" />
          </label>
          <button type="submit" className="rounded bg-blue-600 text-white px-4 py-2 text-sm font-medium">
            Store credentials
          </button>
        </form>
      </section>

      <p className="mt-8 text-sm text-gray-500">
        Credentials are AES-256-GCM encrypted at rest in integration_tokens. Stored as JSON.
      </p>
    </main>
  );
}
