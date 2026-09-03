import { NextRequest, NextResponse } from 'next/server';
import { parse, serialize } from 'cookie';
import { exchangeCode, verifyIdToken, roleForEmail, PUBLIC_BASE_URL } from '@/lib/entra';
import { getOrCreateUser } from '@/lib/users';
import { createSession } from '@/lib/sessions';
import { audit } from '@/lib/audit';
import { SESSION_TTL_MS } from '@/lib/webauthn';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const base = PUBLIC_BASE_URL || url.origin;
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const oauthErr = url.searchParams.get('error');
  const c = parse(req.headers.get('cookie') || '');
  const clear = (n: string) => serialize(n, '', { path: '/', maxAge: 0 });
  const clearTmp = ['aem_oidc_state', 'aem_oidc_nonce', 'aem_oidc_verifier'].map(clear);

  const fail = (msg: string) => {
    const res = NextResponse.redirect(new URL('/auth/login?error=' + encodeURIComponent(msg), base));
    clearTmp.forEach(x => res.headers.append('Set-Cookie', x));
    return res;
  };

  if (oauthErr) return fail('microsoft: ' + oauthErr);
  if (!code || !state) return fail('missing code/state');
  if (!c.aem_oidc_state || state !== c.aem_oidc_state) return fail('state mismatch');
  if (!c.aem_oidc_verifier || !c.aem_oidc_nonce) return fail('missing pkce/nonce');

  let claims;
  try {
    const { id_token } = await exchangeCode(code, c.aem_oidc_verifier);
    claims = await verifyIdToken(id_token, c.aem_oidc_nonce);
  } catch (e) {
    return fail('verify failed: ' + String(e));
  }

  const role = roleForEmail(claims.email);
  if (!role) return fail('account not permitted');

  const user = await getOrCreateUser(claims.email, claims.name, role);
  const session = await createSession(user.id);
  await audit({
    actor_user_id: user.id,
    action: 'user.login.complete',
    target_type: 'user',
    target_id: String(user.id),
    ip_address: req.headers.get('x-forwarded-for') ?? null,
    user_agent: req.headers.get('user-agent') ?? null,
  });

  const res = NextResponse.redirect(new URL('/dashboard', base));
  res.headers.append('Set-Cookie', serialize('aem_session', session.id, {
    httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: Math.floor(SESSION_TTL_MS / 1000),
  }));
  clearTmp.forEach(x => res.headers.append('Set-Cookie', x));
  return res;
}
