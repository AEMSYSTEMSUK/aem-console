import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSession } from '@/lib/sessions';
import { listGuides, allTags } from '@/lib/guides';

export const dynamic = 'force-dynamic';

export default async function GuidesPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get('aem_session')?.value;
  if (!sessionId) redirect('/auth/login');
  const sess = await getSession(sessionId);
  if (!sess) redirect('/auth/login');

  const sp = await searchParams;
  const tagFilter = sp.tag;
  const q = (sp.q || '').toLowerCase();
  let guides = listGuides();
  if (tagFilter) guides = guides.filter((g) => g.front.tags?.includes(tagFilter));
  if (q) guides = guides.filter((g) =>
    g.front.title.toLowerCase().includes(q) ||
    g.front.tags?.some((t) => t.includes(q)) ||
    g.body.toLowerCase().includes(q)
  );

  const tags = allTags();

  return (
    <main className="min-h-screen p-6 max-w-5xl mx-auto">
      <header className="flex justify-between items-center mb-6 pb-4 border-b">
        <div>
          <h1 className="text-2xl font-medium">Setup Guides</h1>
          <p className="text-sm text-gray-500 mt-1">{guides.length} operationally proven runbooks</p>
        </div>
        <Link href="/dashboard" className="text-sm text-gray-500 hover:text-gray-800">&larr; Dashboard</Link>
      </header>

      <form method="GET" className="mb-6">
        <input name="q" defaultValue={q} placeholder="search title, tags, body..." className="w-full max-w-md rounded border border-gray-300 px-3 py-2 text-sm" />
      </form>

      {tags.length > 0 && (
        <div className="mb-6 flex flex-wrap gap-2 text-sm">
          <Link href="/guides" className={`px-3 py-1 rounded ${!tagFilter ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-600'}`}>all</Link>
          {tags.map((t) => (
            <Link key={t} href={`/guides?tag=${encodeURIComponent(t)}`} className={`px-3 py-1 rounded ${tagFilter === t ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-600'}`}>{t}</Link>
          ))}
        </div>
      )}

      {guides.length === 0 ? (
        <div className="border rounded p-8 text-center text-gray-500">
          <p className="text-sm">No guides match your filter.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {guides.map((g) => (
            <Link key={g.slug} href={`/guides/${g.slug}`} className="block border rounded p-4 hover:bg-gray-50">
              <h2 className="text-base font-medium">{g.front.title}</h2>
              {g.front.tags && (
                <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
                  {g.front.tags.map((t) => (
                    <span key={t} className="inline-block bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">{t}</span>
                  ))}
                </div>
              )}
              <div className="mt-2 text-xs text-gray-500">
                {g.front.proof?.['first-verified'] && <>verified {String(g.front.proof['first-verified'])} &middot; </>}
                {g.front.proof?.['domains-proved'] && <>{g.front.proof['domains-proved'].length} domains proved &middot; </>}
                last updated {String(g.front['last-updated'] ?? g.mtime.slice(0, 10))}
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
