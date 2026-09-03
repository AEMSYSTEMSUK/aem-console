'use client';
import { useState } from 'react';
export function CheckLiveButton({ wizardId, realDomain, targetServer }: { wizardId: number; realDomain: string; targetServer: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<null | { ok?: boolean; http?: string; bytes?: number; wp?: boolean; title?: string; note?: string; error?: string }>(null);
  async function fire() {
    setBusy(true); setResult(null);
    try {
      const r = await fetch('/api/onboarding/' + wizardId + '/check-live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      setResult(await r.json());
    } catch (e) { setResult({ error: (e as Error).message }); } finally { setBusy(false); }
  }
  return (
    <div style={{ background: '#fff8e1', border: '1px solid #f9a825', padding: '.75rem', borderRadius: 4, margin: '1rem 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '.75rem', flexWrap: 'wrap' }}>
        <strong>Pre-DNS check</strong>
        <span style={{ fontSize: '.85rem' }}>verify {realDomain} serves on {targetServer} before flipping Cloudflare:</span>
        <button onClick={fire} disabled={busy} style={{ padding: '.4rem .8rem', cursor: busy ? 'wait' : 'pointer', fontSize: '.9rem' }}>
          {busy ? 'Checking…' : 'Check live server'}
        </button>
      </div>
      {result && !result.error && (
        <div style={{ marginTop: '.75rem', background: '#fff', padding: '.75rem', borderRadius: 4, border: '1px solid ' + (result.ok ? '#c8e6c9' : '#ffcdd2') }}>
          <div style={{ fontWeight: 600, color: result.ok ? '#2e7d32' : '#c62828' }}>
            {result.ok ? '✓ Ready' : '✗ Not ready'} — HTTP {result.http || '—'}{result.title ? ' · "' + result.title + '"' : ''}
          </div>
          <div style={{ marginTop: '.4rem', fontSize: '.85rem', color: '#555' }}>{result.note}</div>
        </div>
      )}
      {result?.error && (<div style={{ marginTop: '.5rem', color: '#c62828', fontSize: '.85rem' }}><strong>Error:</strong> {result.error}</div>)}
      <div style={{ color: '#666', fontSize: '.8rem', marginTop: '.5rem' }}>
        Hits {targetServer} directly (Host: {realDomain}, bypassing DNS) to confirm the migrated site responds before Step 7 points the world at it.
      </div>
    </div>
  );
}
