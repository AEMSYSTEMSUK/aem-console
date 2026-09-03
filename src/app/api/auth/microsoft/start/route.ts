import { NextRequest, NextResponse } from 'next/server';
import { randomBytes, createHash } from 'crypto';
import { serialize } from 'cookie';
import { buildAuthorizeUrl } from '@/lib/entra';

const b64url = (b: Buffer) => b.toString('base64url');

export async function GET(_req: NextRequest) {
  const state = b64url(randomBytes(24));
  const nonce = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const opts = { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/', maxAge: 600 };
  const res = NextResponse.redirect(buildAuthorizeUrl(state, nonce, challenge));
  res.headers.append('Set-Cookie', serialize('aem_oidc_state', state, opts));
  res.headers.append('Set-Cookie', serialize('aem_oidc_nonce', nonce, opts));
  res.headers.append('Set-Cookie', serialize('aem_oidc_verifier', verifier, opts));
  return res;
}
