'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function OverwriteToggle({ wizardId, initial }: { wizardId: number; initial: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);

  async function toggle(next: boolean) {
    if (next && !confirm('Enable overwrite mode for this wizard?\n\nWhen running Step 4 or Step 6, if a subscription with the same domain already exists, it will be DELETED before creating the new one. All data at the existing subscription will be lost.\n\nThis is an admin-only override. Continue?')) {
      return;
    }
    setBusy(true);
    try {
      const r = await fetch(`/api/onboarding/${wizardId}/set-overwrite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: next }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        alert(`Failed: ${data.error ?? r.statusText}`);
        return;
      }
      setValue(next);
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  return (
    <div style={{ marginTop: '1rem', padding: '.75rem', background: value ? '#fff3cd' : '#f5f5f5', borderRadius: 4, border: value ? '1px solid #f0c040' : '1px solid #ddd' }}>
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: '.5rem', cursor: busy ? 'wait' : 'pointer' }}>
        <input type="checkbox" checked={value} disabled={busy} onChange={e => toggle(e.target.checked)} style={{ marginTop: '.25rem' }} />
        <span style={{ fontSize: '0.9rem' }}>
          <strong>Admin override: overwrite existing subscriptions</strong>
          <div style={{ color: '#666', marginTop: '.25rem' }}>
            When ticked, Step 4 (staging1) and Step 6 (live1) will DELETE any existing subscription with the same real domain
            before creating the new one. All data lost. Admin only — web team cannot enable this.
          </div>
        </span>
      </label>
    </div>
  );
}
