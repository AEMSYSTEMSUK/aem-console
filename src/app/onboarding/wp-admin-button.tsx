'use client';
import { useState } from 'react';

export function WpAdminButton({ wizardId }: { wizardId: number }) {
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      const r = await fetch(`/api/onboarding/${wizardId}/wp-admin-sso`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) { alert(d.error || 'SSO failed'); return; }
      window.open(d.url, '_blank', 'noopener');
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <button onClick={go} disabled={busy}
      style={{ padding: '.3rem .6rem', background: '#21759b', color: 'white', border: 'none', borderRadius: 3, fontSize: '.75rem', whiteSpace: 'nowrap', cursor: 'pointer' }}>
      {busy ? '...' : 'wp-admin ↗'}
    </button>
  );
}
