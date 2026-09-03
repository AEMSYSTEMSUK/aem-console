'use client';
import { useState } from 'react';

export function ExceptButton({ serverId, standardId }: { serverId: number; standardId: number }) {
  const [busy, setBusy] = useState(false);
  async function handle() {
    const reason = window.prompt('Reason for documenting this as an accepted exception:');
    if (!reason) return;
    setBusy(true);
    try {
      const r = await fetch('/api/drift/except', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ server_id: serverId, standard_id: standardId, reason }) });
      const data = await r.json();
      if (!r.ok) { alert(`Error: ${data.error || r.status}`); setBusy(false); return; }
      window.location.reload();
    } catch (e) { alert(`Error: ${e instanceof Error ? e.message : String(e)}`); setBusy(false); }
  }
  return <button onClick={handle} disabled={busy} className="text-xs text-blue-600 hover:underline disabled:opacity-50">{busy ? '…' : 'Except…'}</button>;
}

export function RemoveExceptionButton({ id }: { id: number }) {
  const [busy, setBusy] = useState(false);
  async function handle() {
    if (!window.confirm('Remove this exception? The drift will reappear on the next scan if still present.')) return;
    setBusy(true);
    try {
      const r = await fetch('/api/drift/except', { method: 'DELETE', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      const data = await r.json();
      if (!r.ok) { alert(`Error: ${data.error || r.status}`); setBusy(false); return; }
      window.location.reload();
    } catch (e) { alert(`Error: ${e instanceof Error ? e.message : String(e)}`); setBusy(false); }
  }
  return <button onClick={handle} disabled={busy} className="text-xs text-red-600 hover:underline disabled:opacity-50">{busy ? '…' : 'Remove'}</button>;
}
