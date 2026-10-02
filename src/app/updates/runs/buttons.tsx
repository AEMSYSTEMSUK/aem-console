'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function ApprovalButtons({ patchSiteId, domain, canApprove }: { patchSiteId: number; domain: string; canApprove: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | 'approve' | 'reject'>(null);
  async function act(action: 'approve' | 'reject') {
    const msg = action === 'approve'
      ? `Approve the staged updates for ${domain}? They will be applied to the LIVE site (after a backup) in the next live run, or straight away for a security fast-track.`
      : `Reject the staged updates for ${domain}? Nothing is applied to live and the staging clone is deleted.`;
    if (!confirm(msg)) return;
    setBusy(action);
    try {
      const r = await fetch(`/api/wp-patch/sites/${patchSiteId}/${action}`, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { alert(d.error || 'Failed'); return; }
      router.refresh();
    } finally { setBusy(null); }
  }
  return (
    <div style={{ display: 'flex', gap: '.4rem' }}>
      {canApprove && (
        <button onClick={() => act('approve')} disabled={busy !== null} style={{ padding: '.3rem .75rem', background: '#2e7d32', color: 'white', border: 'none', borderRadius: 3, fontSize: '.85rem' }}>
          {busy === 'approve' ? 'Approving…' : 'Approve'}
        </button>
      )}
      <button onClick={() => act('reject')} disabled={busy !== null} style={{ padding: '.3rem .75rem', background: '#c62828', color: 'white', border: 'none', borderRadius: 3, fontSize: '.85rem' }}>
        {busy === 'reject' ? 'Rejecting…' : 'Reject'}
      </button>
    </div>
  );
}
