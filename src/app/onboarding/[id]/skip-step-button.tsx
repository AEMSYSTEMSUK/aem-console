'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function SkipStepButton({ wizardId, stepNumber }: { wizardId: number; stepNumber: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function skip() {
    if (!confirm(`Override and skip step ${stepNumber}? This bypasses the web team confirmation.`)) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/onboarding/${wizardId}/skip-step`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step_number: stepNumber }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        alert(`Skip failed: ${data.error ?? r.statusText}`);
      }
    } finally {
      setBusy(false);
      router.refresh();
    }
  }
  return (
    <button onClick={skip} disabled={busy} style={{ marginLeft: '.5rem', padding: '.25rem .75rem', background: '#fff3cd', cursor: busy ? 'wait' : 'pointer' }}>
      {busy ? '...' : 'Skip (admin)'}
    </button>
  );
}
