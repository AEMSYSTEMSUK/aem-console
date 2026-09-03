'use client';

import { useState } from 'react';

export default function DriftRefreshButton() {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  async function handle() {
    setBusy(true);
    setStatus('Running checks...');
    try {
      const r = await fetch('/api/cron/drift-refresh', { method: 'POST', credentials: 'include' });
      const data = await r.json();
      if (!r.ok) {
        setStatus(`Error: ${data.error || r.status}`);
      } else {
        const totalChecks = data.results.reduce((acc: number, s: { results: unknown[] }) => acc + s.results.length, 0);
        setStatus(`${totalChecks} checks ran (${data.elapsedMs}ms)`);
        setTimeout(() => window.location.reload(), 1500);
      }
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      {status && <span className="text-xs text-gray-500">{status}</span>}
      <button
        onClick={handle}
        disabled={busy}
        className="rounded bg-blue-600 text-white px-4 py-2 text-sm font-medium disabled:opacity-50"
      >
        {busy ? 'Running...' : 'Run checks'}
      </button>
    </div>
  );
}
