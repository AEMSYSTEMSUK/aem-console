'use client';
import { useState } from 'react';

export function ProvisionMailboxButton({ wizardId, realDomain }: { wizardId: number; realDomain: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<null | { ok?: boolean; address?: string; password?: string; message?: string; error?: string }>(null);
  const [mailName, setMailName] = useState('noreply');

  async function fire() {
    if (!confirm('Provision ' + mailName + '@' + realDomain + ' on mail.infra? This will create a new mailbox if the domain is a Plesk subscription there.')) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await fetch('/api/onboarding/' + wizardId + '/provision-mailbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mail_name: mailName }),
      });
      const d = await r.json();
      setResult(d);
    } catch (e) {
      setResult({ error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ background: '#e8f5e9', border: '1px solid #2e7d32', padding: '.75rem', borderRadius: 4, margin: '1rem 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '.75rem', flexWrap: 'wrap' }}>
        <strong>Provision hosted mailbox</strong>
        <span style={{ fontSize: '.85rem' }}>on mail.infra:</span>
        <input value={mailName} onChange={e => setMailName(e.target.value.replace(/[^a-z0-9._-]/gi, ''))} disabled={busy}
          style={{ width: 100, padding: '.3rem', fontSize: '.9rem' }} placeholder="noreply" />
        <span style={{ fontSize: '.85rem' }}>@{realDomain}</span>
        <button onClick={fire} disabled={busy} style={{ padding: '.4rem .8rem', cursor: busy ? 'wait' : 'pointer', fontSize: '.9rem' }}>
          {busy ? 'Provisioning…' : 'Create mailbox'}
        </button>
      </div>
      {result?.ok && (
        <div style={{ marginTop: '.75rem', background: '#fff', padding: '.75rem', borderRadius: 4, border: '1px solid #c8e6c9' }}>
          <div style={{ fontWeight: 600 }}>✓ Mailbox created: {result.address}</div>
          <div style={{ marginTop: '.5rem', fontFamily: 'monospace', background: '#f5f5f5', padding: '.5rem', borderRadius: 3 }}>
            Password: <strong>{result.password}</strong>
          </div>
          <div style={{ marginTop: '.5rem', fontSize: '.85rem', color: '#c62828' }}>
            ⚠ Save this password now — it will not be shown again.
          </div>
          <div style={{ marginTop: '.5rem', fontSize: '.85rem', color: '#555' }}>{result.message}</div>
        </div>
      )}
      {result?.error && (
        <div style={{ marginTop: '.5rem', color: '#c62828', fontSize: '.85rem' }}>
          <strong>Error:</strong> {result.error}
        </div>
      )}
      <div style={{ color: '#666', fontSize: '.8rem', marginTop: '.5rem' }}>
        Creates a Plesk mailbox at mail.infra. Only works if the customer's domain is a subscription there. Useful for transactional WP mail (noreply@) — supply credentials to aem-mail-sender or an SMTP plugin.
      </div>
    </div>
  );
}
