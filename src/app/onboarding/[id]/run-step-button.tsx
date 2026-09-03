'use client';
import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

export function RunStepButton({ wizardId, stepNumber }: { wizardId: number; stepNumber: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{phase:string;pct:number;message:string}>({phase:'idle',pct:0,message:''});
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!busy) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`/api/onboarding/${wizardId}/step-status?step=${stepNumber}`);
        const d = await r.json();
        if (d.phase) setStatus(d);
      } catch { /* ignore */ }
    }, 1000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [busy, wizardId, stepNumber]);
  async function run() {
    setBusy(true);
    try {
      const r = await fetch(`/api/onboarding/${wizardId}/run-step`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step_number: stepNumber }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        alert(`Failed: ${data.error ?? r.statusText}`);
      }
    } finally {
      setBusy(false);
      router.refresh();
    }
  }
  return (
    <>
    <button onClick={run} disabled={busy}
      style={{ padding: '.25rem .75rem', cursor: busy ? 'wait' : 'pointer' }}>
      {busy ? 'Running...' : 'Run'}
    </button>
      {busy && (status.phase !== 'idle') && (
        <div style={{ marginTop: 6, minWidth: 200 }}>
          <div style={{ background: '#eee', height: 6, borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ background: '#1976d2', height: '100%', width: status.pct + '%', transition: 'width .4s ease' }} />
          </div>
          <div style={{ fontSize: '.72rem', color: '#555', marginTop: 2 }}>
            <strong>{status.phase}</strong> ({status.pct}%) {status.message ? '— ' + status.message : ''}
          </div>
        </div>
      )}
    </>
  );
}
