'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function SetDomainForm({ wizardId, current }: { wizardId: number; current: string }) {
  const router = useRouter();
  const isTbd = !current || current === 'TBD';
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState(isTbd ? '' : current);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch(`/api/onboarding/${wizardId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ real_domain: val.trim() }),
      });
      const data = await r.json();
      if (!r.ok) { setError(data.error || 'Failed'); return; }
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        style={{ marginLeft: '.5rem', padding: '.1rem .5rem', fontSize: '.75rem', verticalAlign: 'middle',
                 background: isTbd ? '#f57c00' : '#eee', color: isTbd ? 'white' : '#333',
                 border: '1px solid #ccc', borderRadius: 3, cursor: 'pointer' }}>
        {isTbd ? 'Set domain' : 'Edit'}
      </button>
    );
  }

  return (
    <span style={{ marginLeft: '.5rem', display: 'inline-flex', gap: '.3rem', alignItems: 'center' }}>
      <input value={val} onChange={e => setVal(e.target.value)} placeholder="example.co.uk"
             style={{ padding: '.2rem', fontSize: '.8rem', width: 180 }} />
      <button onClick={save} disabled={submitting || !val.trim()}
        style={{ padding: '.2rem .6rem', fontSize: '.8rem', background: '#2e7d32', color: 'white', border: 'none', borderRadius: 3 }}>
        {submitting ? 'Saving…' : 'Save'}
      </button>
      <button onClick={() => setOpen(false)} style={{ padding: '.2rem .5rem', fontSize: '.8rem' }}>Cancel</button>
      {error && <span style={{ color: '#c62828', fontSize: '.75rem' }}>{error}</span>}
    </span>
  );
}
