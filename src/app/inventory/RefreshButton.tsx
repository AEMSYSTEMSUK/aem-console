'use client';

import { useState } from 'react';

export default function RefreshButton() {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>('');

  async function handleRefresh() {
    setBusy(true);
    setStatus('Refreshing...');
    try {
      const r = await fetch('/api/cron/inventory-refresh', { method: 'POST', credentials: 'include' });
      const data = await r.json();
      if (!r.ok) {
        setStatus(`Error: ${data.error || r.status}`);
      } else {
        const okCount = data.results.filter((x: { ok: boolean }) => x.ok).length;
        const failCount = data.results.filter((x: { ok: boolean }) => !x.ok).length;
        const totalDomains = data.results.reduce((acc: number, x: { domains_seen: number }) => acc + x.domains_seen, 0);
        setStatus(`${okCount} ok, ${failCount} failed, ${totalDomains} domains synced (${data.elapsedMs}ms)`);
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
        onClick={handleRefresh}
        disabled={busy}
        className="rounded bg-blue-600 text-white px-4 py-2 text-sm font-medium disabled:opacity-50"
      >
        {busy ? 'Refreshing...' : 'Refresh inventory'}
      </button>
    </div>
  );
}
