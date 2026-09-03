'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function RewindButton({ wizardId, stepNumber }: { wizardId: number; stepNumber: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function go() {
    if (!confirm(`Rewind this onboarding back to step ${stepNumber}? Steps ${stepNumber} onward will be reset to pending and re-runnable.`)) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/onboarding/${wizardId}/rewind`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: stepNumber }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); alert('Rewind failed: ' + (d.error || r.status)); return; }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button onClick={go} disabled={busy} title={`Rewind to step ${stepNumber}`}
      style={{ marginLeft: '.3rem', padding: '.1rem .4rem', fontSize: '.75rem', background: '#eee', color: '#555',
               border: '1px solid #ccc', borderRadius: 3, cursor: 'pointer', whiteSpace: 'nowrap' }}>
      {busy ? '…' : '↶ Rewind here'}
    </button>
  );
}
