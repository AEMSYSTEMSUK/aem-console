'use client';
import { useState } from 'react';

// Triggers a fleet-wide WP-Toolkit discovery so newly-hosted WordPress sites register themselves
// (login-ready) instead of being added by hand.
export function DiscoverSitesButton() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  async function run() {
    setBusy(true);
    setMsg('Scanning servers for WordPress installs…');
    try {
      const r = await fetch('/api/admin/discover-sites', { method: 'POST' });
      const j = await r.json();
      if (!r.ok) setMsg(j.error || 'Discovery failed');
      else setMsg(`Registered/refreshed ${j.totalUpserted} site(s) across ${j.servers?.length ?? 0} server(s). Reload to see them.`);
    } catch {
      setMsg('Discovery failed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.75rem' }}>
      <button
        onClick={run}
        disabled={busy}
        style={{ padding: '.4rem .9rem', background: '#1976d2', color: 'white', border: 'none', borderRadius: 4, fontSize: '.85rem', cursor: busy ? 'default' : 'pointer' }}
      >
        {busy ? 'Discovering…' : 'Discover sites'}
      </button>
      {msg && <span style={{ fontSize: '.8rem', color: '#555' }}>{msg}</span>}
    </span>
  );
}
