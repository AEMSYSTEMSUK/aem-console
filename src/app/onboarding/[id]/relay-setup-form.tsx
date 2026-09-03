'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Credentials {
  smtp_host: string;
  port: number;
  encryption: string;
  username: string;
  password: string;
}

export function RelaySetupForm({ wizardId, realDomain }: { wizardId: number; realDomain: string }) {
  const router = useRouter();
  const [localPart, setLocalPart] = useState('noreply');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creds, setCreds] = useState<Credentials | null>(null);
  const [spfAfter, setSpfAfter] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch(`/api/onboarding/${wizardId}/setup-relay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ local_part: localPart }),
      });
      const data = await r.json();
      if (!r.ok) { setError(data.error || 'Failed'); return; }
      setCreds(data.credentials);
      setSpfAfter(data.spf_after);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  function copyAll() {
    if (!creds) return;
    const block = `Host:       ${creds.smtp_host}\nPort:       ${creds.port}\nEncryption: ${creds.encryption}\nUsername:   ${creds.username}\nPassword:   ${creds.password}`;
    navigator.clipboard.writeText(block);
  }

  function done() {
    setCreds(null);
    router.refresh();
  }

  if (creds) {
    return (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
        <div style={{ background: 'white', padding: '1.5rem', borderRadius: 6, maxWidth: 560, width: '90%' }}>
          <h3 style={{ marginTop: 0 }}>SMTP relay credentials</h3>
          <p style={{ background: '#fff3cd', padding: '.5rem .75rem', border: '1px solid #ffc107', borderRadius: 4, fontSize: '0.85rem' }}>
            ⚠ Shown ONCE. Copy now and store in a password manager. Closing this dialog clears the password from memory.
          </p>
          <pre style={{ background: '#f8f8f8', padding: '.75rem', fontSize: '0.85rem' }}>
{`Host:       ${creds.smtp_host}
Port:       ${creds.port}
Encryption: ${creds.encryption}
Username:   ${creds.username}
Password:   ${creds.password}`}
          </pre>
          {spfAfter && (
            <p style={{ fontSize: '0.8rem', color: '#555' }}>SPF on {realDomain} now:<br /><code>{spfAfter}</code></p>
          )}
          <div style={{ display: 'flex', gap: '.5rem', justifyContent: 'flex-end' }}>
            <button onClick={copyAll} style={{ padding: '.4rem .8rem' }}>Copy all</button>
            <button onClick={done} style={{ padding: '.4rem .8rem', background: '#1976d2', color: 'white', border: 'none', borderRadius: 4 }}>Done</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginTop: '.5rem', padding: '.5rem', background: '#f5f5f5', borderRadius: 4 }}>
      <div style={{ fontSize: '0.8rem', marginBottom: '.3rem' }}>SMTP relay setup ({realDomain})</div>
      <div style={{ display: 'flex', gap: '.4rem', alignItems: 'center' }}>
        <input value={localPart} onChange={e => setLocalPart(e.target.value)} placeholder="noreply" style={{ padding: '.25rem', width: 100, fontSize: '0.85rem' }} />
        <span style={{ fontSize: '0.85rem' }}>@{realDomain}</span>
        <button onClick={submit} disabled={submitting} style={{ padding: '.3rem .7rem', fontSize: '0.85rem', background: '#2e7d32', color: 'white', border: 'none', borderRadius: 3 }}>
          {submitting ? 'Setting up…' : 'Set up relay'}
        </button>
      </div>
      {error && <div style={{ color: '#c62828', fontSize: '0.8rem', marginTop: '.3rem' }}>{error}</div>}
    </div>
  );
}
