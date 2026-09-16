import { NextRequest, NextResponse } from 'next/server';
import { randomBytes, createHash } from 'crypto';
import { serialize } from 'cookie';
import { buildAuthorizeUrl } from '@/lib/entra';

const b64url = (b: Buffer) => b.toString('base64url');

export async function GET(req: NextRequest) {
  const state = b64url(randomBytes(24));
  const nonce = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const opts = { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/', maxAge: 600 };
  // Carry the intended return path through the Microsoft round-trip (local paths only — no open redirect).
  const nextRaw = new URL(req.url).searchParams.get('next') || '';
  const next = nextRaw.startsWith('/') && !nextRaw.startsWith('//') ? nextRaw : '';
  const res = NextResponse.redirect(buildAuthorizeUrl(state, nonce, challenge));
  res.headers.append('Set-Cookie', serialize('aem_oidc_state', state, opts));
  res.headers.append('Set-Cookie', serialize('aem_oidc_nonce', nonce, opts));
  res.headers.append('Set-Cookie', serialize('aem_oidc_verifier', verifier, opts));
  if (next) res.headers.append('Set-Cookie', serialize('aem_oidc_next', next, opts));
  return res;
}
