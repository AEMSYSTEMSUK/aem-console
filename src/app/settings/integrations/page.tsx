'use client';
import { useEffect, useState } from 'react';

interface TokenRow { type: string; created_at: string; server_id: number | null; }

export default function IntegrationsPage() {
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [type, setType] = useState<'cloudflare' | 'wpscan'>('cloudflare');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    try {
      const r = await fetch('/api/settings/integrations');
      const data = await r.json();
      if (r.ok) setTokens(data.tokens ?? []);
    } catch {}
  }
  useEffect(() => { load(); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null); setErr(null); setBusy(true);
    try {
      const r = await fetch('/api/settings/integrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, token }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
      setMsg(data.message ?? 'Stored.');
      setToken('');
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 720, margin: '2rem auto', padding: '0 1rem', fontFamily: 'system-ui' }}>
      <h1>Integration tokens</h1>
      <p style={{ color: '#666' }}>
        Tokens are encrypted at rest with AES-256-GCM. Never echoed back; only the type + creation date is visible.
      </p>

      <h2 style={{ marginTop: '2rem' }}>Configured</h2>
      {tokens.length === 0 ? (
        <p style={{ color: '#888' }}>No tokens configured yet.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '0.5rem' }}>
          <thead><tr style={{ background: '#f0f0f0', textAlign: 'left' }}>
            <th style={{ padding: '.5rem' }}>Type</th>
            <th style={{ padding: '.5rem' }}>Server</th>
            <th style={{ padding: '.5rem' }}>Stored at</th>
          </tr></thead>
          <tbody>
            {tokens.map(t => (
              <tr key={`${t.type}-${t.server_id ?? 'global'}`} style={{ borderBottom: '1px solid #ddd' }}>
                <td style={{ padding: '.5rem' }}>{t.type}</td>
                <td style={{ padding: '.5rem' }}>{t.server_id ?? '(global)'}</td>
                <td style={{ padding: '.5rem' }}>{new Date(t.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 style={{ marginTop: '2rem' }}>Add / replace token</h2>
      <form onSubmit={submit} style={{ display: 'grid', gap: '1rem', marginTop: '1rem' }}>
        <label>
          <div>Type</div>
          <select value={type} onChange={e => setType(e.target.value as 'cloudflare' | 'wpscan')}
            style={{ padding: '.5rem', fontSize: '1rem' }}>
            <option value="cloudflare">Cloudflare API token</option>
            <option value="wpscan">WPScan API key</option>
          </select>
        </label>
        <label>
          <div>Token value</div>
          <input type="password" required value={token} onChange={e => setToken(e.target.value)}
            autoComplete="off"
            style={{ width: '100%', padding: '.5rem', fontSize: '1rem', fontFamily: 'monospace' }}
            placeholder={type === 'cloudflare' ? 'cfut_... or hex string' : 'WPScan key'} />
          <div style={{ color: '#888', fontSize: '0.85rem', marginTop: '.25rem' }}>
            For Cloudflare: token will be verified against /user/tokens/verify before storage.
          </div>
        </label>
        {err && <div style={{ background: '#fdd', padding: '.5rem .75rem', borderRadius: 4 }}><strong>Error:</strong> {err}</div>}
        {msg && <div style={{ background: '#dfd', padding: '.5rem .75rem', borderRadius: 4 }}>{msg}</div>}
        <button type="submit" disabled={busy}
          style={{ padding: '.75rem 1.5rem', fontSize: '1rem', fontWeight: 600, cursor: busy ? 'wait' : 'pointer' }}>
          {busy ? 'Verifying + storing...' : 'Store token'}
        </button>
      </form>
    </main>
  );
}
