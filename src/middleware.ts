import { NextRequest, NextResponse } from 'next/server';

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  // Public routes
  if (pathname.startsWith('/auth') || pathname.startsWith('/api/auth') || pathname.startsWith('/api/health') || pathname === '/' || pathname.startsWith('/_next')) {
    return NextResponse.next();
  }
  // Protected: check for session cookie presence (full validation in route)
  const sessionCookie = req.cookies.get('aem_session');
  if (!sessionCookie) {
    const loginUrl = new URL('/auth/login', req.url);
    loginUrl.searchParams.set('next', pathname);
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*', '/inventory/:path*', '/drift/:path*', '/admin/:path*', '/onboarding/:path*', '/updates/:path*', '/settings/:path*', '/vulnerabilities/:path*', '/guides/:path*', '/servers/:path*', '/sites/:path*', '/dmarc/:path*', '/alerts/:path*', '/backups/:path*', '/customer-sites/:path*', '/api/sites/:path*'],
};
