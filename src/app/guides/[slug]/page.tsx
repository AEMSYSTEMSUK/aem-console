import { cookies } from 'next/headers';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { marked } from 'marked';
import { getSession } from '@/lib/sessions';
import { getGuide } from '@/lib/guides';

export const dynamic = 'force-dynamic';

export default async function GuidePage({ params }: { params: Promise<{ slug: string }> }) {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get('aem_session')?.value;
  if (!sessionId) redirect('/auth/login');
  const sess = await getSession(sessionId);
  if (!sess) redirect('/auth/login');

  const { slug } = await params;
  const guide = getGuide(slug);
  if (!guide) notFound();

  const html = await marked.parse(guide.body);

  return (
    <main className="min-h-screen p-6 max-w-3xl mx-auto">
      <header className="mb-6 pb-4 border-b">
        <Link href="/guides" className="text-sm text-gray-500 hover:text-gray-800">&larr; All guides</Link>
        {guide.front.tags && (
          <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
            {guide.front.tags.map((t) => (
              <Link key={t} href={`/guides?tag=${encodeURIComponent(t)}`} className="inline-block bg-gray-100 hover:bg-gray-200 text-gray-700 px-1.5 py-0.5 rounded">{t}</Link>
            ))}
          </div>
        )}
        <div className="mt-2 text-xs text-gray-500">
          {guide.front.proof?.['first-verified'] && <>verified {String(guide.front.proof['first-verified'])} &middot; </>}
          {guide.front.proof?.['domains-proved'] && <>{guide.front.proof['domains-proved'].length} domains proved &middot; </>}
          last updated {String(guide.front['last-updated'] ?? guide.mtime.slice(0, 10))}
        </div>
      </header>

      <article className="prose prose-sm max-w-none prose-headings:font-medium prose-h1:text-2xl prose-h2:text-lg prose-h3:text-base prose-code:before:content-none prose-code:after:content-none prose-pre:bg-gray-900 prose-pre:text-gray-100" dangerouslySetInnerHTML={{ __html: html }} />
    </main>
  );
}
