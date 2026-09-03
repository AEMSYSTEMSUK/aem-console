import { createRemoteJWKSet, jwtVerify } from 'jose';

const TENANT = process.env.AEM_ENTRA_TENANT_ID || '';
const CLIENT_ID = process.env.AEM_ENTRA_CLIENT_ID || '';
const CLIENT_SECRET = process.env.AEM_ENTRA_CLIENT_SECRET || '';
export const ENTRA_REDIRECT_URI =
  process.env.AEM_ENTRA_REDIRECT_URI || 'https://bastion.infra.aemsystems.co.uk/api/auth/microsoft/callback';

const AUTHORIZE_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`;
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
const ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;
const SCOPE = 'openid profile email';

const jwks = createRemoteJWKSet(
  new URL(`https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`)
);

export function buildAuthorizeUrl(state: string, nonce: string, codeChallenge: string): string {
  const p = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: ENTRA_REDIRECT_URI,
    response_mode: 'query',
    scope: SCOPE,
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${AUTHORIZE_URL}?${p.toString()}`;
}

export async function exchangeCode(code: string, codeVerifier: string): Promise<{ id_token: string }> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: ENTRA_REDIRECT_URI,
    code_verifier: codeVerifier,
    scope: SCOPE,
  });
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) throw new Error(`token exchange ${r.status}: ${await r.text()}`);
  return r.json();
}

export interface EntraClaims { oid: string; tid: string; email: string; name: string | null; }

export async function verifyIdToken(idToken: string, expectedNonce: string): Promise<EntraClaims> {
  const { payload } = await jwtVerify(idToken, jwks, { issuer: ISSUER, audience: CLIENT_ID });
  if (payload.nonce !== expectedNonce) throw new Error('nonce mismatch');
  if (payload.tid !== TENANT) throw new Error('wrong tenant');
  const email = String((payload as Record<string, unknown>).email
    || (payload as Record<string, unknown>).preferred_username || '').toLowerCase();
  if (!email) throw new Error('no email claim');
  return { oid: String(payload.oid), tid: String(payload.tid), email,
           name: ((payload as Record<string, unknown>).name as string) ?? null };
}

const ALLOWED_DOMAINS = ['aemsystems.co.uk', 'fruitydigital.co.uk'];
export function roleForEmail(email: string): 'admin' | 'web' | null {
  const domain = email.split('@')[1];
  if (!domain || !ALLOWED_DOMAINS.includes(domain)) return null;
  return domain === 'aemsystems.co.uk' ? 'admin' : 'web';
}

export const PUBLIC_BASE_URL = (() => {
  try { return new URL(ENTRA_REDIRECT_URI).origin; } catch { return ''; }
})();
