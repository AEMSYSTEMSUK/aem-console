'use client';

import { useState } from 'react';
import { startRegistration } from '@simplewebauthn/browser';

export default function EnrollPage() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<string>('');
  const [busy, setBusy] = useState(false);

  async function handleEnroll(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setStatus('Requesting enrolment challenge...');
    try {
      const optsRes = await fetch('/api/auth/enroll/options', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!optsRes.ok) {
        const err = await optsRes.json().catch(() => ({}));
        throw new Error(err.error || `enrol options failed: ${optsRes.status}`);
      }
      const options = await optsRes.json();
      setStatus('Touch your security key / use your platform passkey...');
      const credential = await startRegistration({ optionsJSON: options });
      setStatus('Verifying...');
      const verifyRes = await fetch('/api/auth/enroll/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, credential }),
      });
      if (!verifyRes.ok) {
        const err = await verifyRes.json().catch(() => ({}));
        throw new Error(err.error || `verification failed: ${verifyRes.status}`);
      }
      const result = await verifyRes.json();
      setStatus('Passkey enrolled. Redirecting...');
      window.location.href = result.redirect || '/dashboard';
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md space-y-6">
        <div>
          <h1 className="text-2xl font-medium">Enrol a passkey</h1>
          <p className="text-sm text-gray-500 mt-1">AEM Console first-time setup.</p>
        </div>
        <form onSubmit={handleEnroll} className="space-y-4">
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
            {busy ? 'Working...' : 'Add passkey'}
          </button>
        </form>
        {status && (
          <div className="text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded p-3">
            {status}
          </div>
        )}
        <div className="text-sm text-gray-500">
          Already have a passkey? <a href="/auth/login" className="text-blue-600">Sign in</a>
        </div>
      </div>
    </main>
  );
}
