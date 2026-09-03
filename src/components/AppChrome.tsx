'use client';

import { usePathname } from 'next/navigation';
import ConsoleNav from './ConsoleNav';

// Wraps every page. Authenticated app pages get the persistent sidebar; the login/enroll and root
// redirect pages render bare (no chrome).
export default function AppChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const bare = pathname === '/' || pathname.startsWith('/auth');
  if (bare) return <>{children}</>;
  return (
    <div className="flex min-h-screen w-full">
      <ConsoleNav />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
