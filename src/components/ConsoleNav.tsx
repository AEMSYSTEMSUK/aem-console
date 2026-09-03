'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

type Item = { href: string; label: string };
type Group = { title: string; items: Item[] };

// Persistent Console navigation — every authenticated page shows this, so there's always a menu and a
// way back (click any item, or the logo to return to the dashboard). Mirrors the AEM One layout.
const GROUPS: Group[] = [
  { title: 'Overview', items: [{ href: '/dashboard', label: 'Dashboard' }] },
  {
    title: 'Sites',
    items: [
      { href: '/customer-sites', label: 'Customer Sites' },
      { href: '/onboarding', label: 'Onboarding' },
      { href: '/onboarding/start', label: 'Start Onboarding' },
    ],
  },
  {
    title: 'Monitoring',
    items: [
      { href: '/inventory', label: 'Inventory' },
      { href: '/updates', label: 'WP Updates' },
      { href: '/admin/server-updates', label: 'Server Updates' },
      { href: '/admin/servers', label: 'Servers' },
      { href: '/drift', label: 'Config Drift' },
      { href: '/backups', label: 'Backups' },
    ],
  },
  {
    title: 'Security',
    items: [
      { href: '/vulnerabilities', label: 'Vulnerabilities' },
      { href: '/security', label: 'Security' },
      { href: '/dmarc', label: 'DMARC' },
      { href: '/dmarc/reports', label: 'DMARC Reports' },
      { href: '/admin/wpscan', label: 'WPScan' },
      { href: '/alerts', label: 'Alerts' },
    ],
  },
  {
    title: 'System',
    items: [
      { href: '/guides', label: 'Guides' },
      { href: '/admin/alert-sink', label: 'Alert Sink' },
      { href: '/settings/integrations', label: 'Integrations' },
    ],
  },
];

export default function ConsoleNav() {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === '/dashboard' ? pathname === href : pathname === href || pathname.startsWith(href + '/');

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/auth/login';
  }

  return (
    <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-gray-200 bg-white">
      <Link href="/dashboard" className="block border-b border-gray-100 px-4 py-4">
        <div className="text-lg font-semibold text-gray-900">AEM Console</div>
        <div className="text-[11px] text-gray-400">Hosting &amp; fleet</div>
      </Link>

      <nav className="flex-1 space-y-4 overflow-y-auto px-2 py-3">
        {GROUPS.map((g) => (
          <div key={g.title}>
            <div className="mb-1 px-2 text-[10px] font-bold uppercase tracking-widest text-gray-400">{g.title}</div>
            <div className="space-y-0.5">
              {g.items.map((it) => (
                <Link
                  key={it.href}
                  href={it.href}
                  className={
                    'block rounded-md px-2 py-1.5 text-sm transition-colors ' +
                    (isActive(it.href)
                      ? 'bg-blue-50 font-medium text-blue-700'
                      : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900')
                  }
                >
                  {it.label}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t border-gray-100 p-3">
        <button
          onClick={logout}
          className="w-full rounded-md px-2 py-1.5 text-left text-sm text-gray-500 hover:bg-gray-50 hover:text-gray-800"
        >
          Sign out
        </button>
      </div>
    </aside>
  );
}
