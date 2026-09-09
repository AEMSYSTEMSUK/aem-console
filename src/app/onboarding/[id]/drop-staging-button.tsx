'use client';
import { useState } from 'react';

// Admin "Drop staging now" — removes the staging subdomain + cloned real_domain
// subscription on staging1 immediately. Shows the drop-pending date if scheduled,
// or a done state once staging_dropped_at is set.
export function DropStagingButton({
  wizardId, realDomain, dropAt, droppedAt,
}: { wizardId: number; realDomain: string; dropAt: string | null; droppedAt: string | null }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<null | { ok?: boolean; output?: string; error?: string; alreadyDropped?: boolean }>(null);

  async function fire() {
    if (!confirm(`Remove ALL staging copies for ${realDomain} now?\n\nThis deletes the staging subdomain and the cloned subscription on staging1. The live site is unaffected. This cannot be undone.`)) return;
    setBusy(true); setResult(null);
    try {
      const r = await fetch('/api/onboarding/' + wizardId + '/drop-staging', { method: 'POST' });
      const j = await r.json();
      setResult(j);
      if (j.ok) setTimeout(() => location.reload(), 1500);
    } catch (e) { setResult({ error: (e as Error).message }); } finally { setBusy(false); }
  }

  if (droppedAt) {
    return (
      <div style={{ background: '#f1f8e9', border: '1px solid #c5e1a5', padding: '.6rem .75rem', borderRadius: 4, margin: '1rem 0', fontSize: '.85rem', color: '#33691e' }}>
        ✓ Staging dropped {new Date(droppedAt).toLocaleString('en-GB')} — no staging copies remain for {realDomain}.
      </div>
    );
  }

  return (
    <div style={{ background: '#fbe9e7', border: '1px solid #ff8a65', padding: '.75rem', borderRadius: 4, margin: '1rem 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '.75rem', flexWrap: 'wrap' }}>
        <strong>Staging teardown</strong>
        <span style={{ fontSize: '.85rem' }}>
          {dropAt
            ? `Auto-drops ${new Date(dropAt).toLocaleString('en-GB')}. Remove now:`
            : 'Remove the staging subdomain + cloned staging1 subscription now:'}
        </span>
        <button onClick={fire} disabled={busy} style={{ padding: '.4rem .8rem', cursor: busy ? 'wait' : 'pointer', fontSize: '.9rem' }}>
          {busy ? 'Dropping…' : 'Drop staging now'}
        </button>
      </div>
      {result && (
        <div style={{ marginTop: '.75rem', background: '#fff', padding: '.75rem', borderRadius: 4, border: '1px solid ' + (result.ok ? '#c8e6c9' : '#ffcdd2') }}>
          <div style={{ fontWeight: 600, color: result.ok ? '#2e7d32' : '#c62828' }}>
            {result.ok ? (result.alreadyDropped ? '✓ Already dropped' : '✓ Staging removed') : '✗ Failed'}
          </div>
          {result.output && <pre style={{ marginTop: '.4rem', fontSize: '.78rem', color: '#555', whiteSpace: 'pre-wrap' }}>{result.output}</pre>}
          {result.error && <div style={{ marginTop: '.4rem', color: '#c62828', fontSize: '.85rem' }}><strong>Error:</strong> {result.error}</div>}
        </div>
      )}
    </div>
  );
}
