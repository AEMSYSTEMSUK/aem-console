'use client';

import { useState } from 'react';

export default function AlertActions({ alertId, isAcked }: { alertId: number; isAcked: boolean }) {
  const [acked, setAcked] = useState(isAcked);
  const [busy, setBusy] = useState(false);

  if (acked) return <span className="text-xs text-gray-400">ack&apos;d</span>;

  async function handleAck() {
    setBusy(true);
    const r = await fetch(`/api/alerts/${alertId}/acknowledge`, { method: 'POST', credentials: 'include' });
    if (r.ok) setAcked(true);
    setBusy(false);
  }

  return (
    <button onClick={handleAck} disabled={busy} className="text-xs text-blue-600 hover:underline disabled:text-gray-400">
      {busy ? '...' : 'ack'}
    </button>
  );
}
