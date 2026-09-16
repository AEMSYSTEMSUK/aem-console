'use client';
import { useState, useEffect } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [next, setNext] = useState('/dashboard');
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const e = p.get('error');
    if (e) setStatus(`Sign-in failed: ${e}`);
    // Honour the return path the middleware stashed (?next=/servers/5). Local paths only (no open redirect).
    const n = p.get('next');
    if (n && n.startsWith('/') && !n.startsWith('//')) setNext(n);
  }, []);
  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setStatus('Requesting authentication challenge...');
    try {
      const optsRes = await fetch('/api/auth/login/options', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!optsRes.ok) {
        const err = await optsRes.json().catch(() => ({}));
        throw new Error(err.error || `login options failed: ${optsRes.status}`);
      }
      const options = await optsRes.json();
      setStatus('Touch your security key / use your platform passkey...');
      const credential = await startAuthentication({ optionsJSON: options });
      setStatus('Verifying...');
      const verifyRes = await fetch('/api/auth/login/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, credential }),
      });
      if (!verifyRes.ok) {
        const err = await verifyRes.json().catch(() => ({}));
        throw new Error(err.error || `verification failed: ${verifyRes.status}`);
      }
      const result = await verifyRes.json();
      setStatus('Signed in. Redirecting...');
      window.location.href = next || result.redirect || '/dashboard';
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
      setBusy(false);
    }
  }
  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md space-y-6">
        <div>
          <h1 className="text-2xl font-medium">Sign in</h1>
          <p className="text-sm text-gray-500 mt-1">AEM Console</p>
        </div>
        <a
          href={`/api/auth/microsoft/start${next && next !== '/dashboard' ? `?next=${encodeURIComponent(next)}` : ''}`}
          className="w-full flex items-center justify-center gap-2 rounded border border-gray-300 px-4 py-2 font-medium text-gray-800 hover:bg-gray-50"
        >
          <span aria-hidden className="inline-grid grid-cols-2 gap-px w-4 h-4">
            <span className="bg-[#f25022]" /><span className="bg-[#7fba00]" />
            <span className="bg-[#00a4ef]" /><span className="bg-[#ffb900]" />
          </span>
          Sign in with Microsoft
        </a>
        <div className="relative">
          <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-gray-200" /></div>
          <div className="relative flex justify-center"><span className="bg-white px-2 text-xs text-gray-400">or</span></div>
        </div>
        <form onSubmit={handleLogin} className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium">Email</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
              className="mt-1 block w-full rounded border border-gray-300 px-3 py-2"
              placeholder="andy@aemsystems.co.uk"
            />
          </label>
          <button
            type="submit"
            disabled={busy || !email}
            className="w-full rounded bg-blue-600 text-white px-4 py-2 font-medium disabled:opacity-50"
          >
            {busy ? 'Working...' : 'Sign in with passkey'}
          </button>
        </form>
        {status && (
          <div className="text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded p-3">
            {status}
          </div>
        )}
        <div className="text-sm text-gray-500">
          Don&apos;t have a passkey yet? <a href="/auth/enroll" className="text-blue-600">Enrol one</a>
        </div>
      </div>
    </main>
  );
}
