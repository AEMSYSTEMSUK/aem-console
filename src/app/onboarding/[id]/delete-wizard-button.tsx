'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

// Admin "Delete this wizard" — removes the wizard record (steps cascade) so
// abandoned drafts / pick-winner losers drop off the /onboarding list. Does not
// touch any live site. Strongly confirmed since it's destructive to the record.
export function DeleteWizardButton({ wizardId, customerName, stagingDropped }: { wizardId: number; customerName: string; stagingDropped: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function fire() {
    const warn = stagingDropped
      ? `Delete the onboarding record for "${customerName}"?\n\nStaging is already dropped. This removes the wizard and its steps from the Console. The live site is unaffected. This cannot be undone.`
      : `Delete the onboarding record for "${customerName}"?\n\n⚠ Staging has NOT been dropped for this wizard — consider "Drop staging now" first, or staging copies may be left orphaned on the server.\n\nThe live site is unaffected. This cannot be undone.`;
    if (!confirm(warn)) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch('/api/onboarding/' + wizardId, { method: 'DELETE' });
      const j = await r.json();
      if (!r.ok) { setError(j.error || 'Delete failed'); setBusy(false); return; }
      router.push('/onboarding');
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }

  return (
    <div style={{ margin: '1rem 0' }}>
      <button onClick={fire} disabled={busy} style={{ padding: '.4rem .8rem', cursor: busy ? 'wait' : 'pointer', fontSize: '.85rem', color: '#c62828', border: '1px solid #ef9a9a', background: '#fff', borderRadius: 4 }}>
        {busy ? 'Deleting…' : 'Delete this wizard record'}
      </button>
      {error && <span style={{ marginLeft: '.6rem', color: '#c62828', fontSize: '.85rem' }}>{error}</span>}
    </div>
  );
}
