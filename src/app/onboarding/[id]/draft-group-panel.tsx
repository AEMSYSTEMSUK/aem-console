'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

interface Sibling { id: number; staging_slug: string; status: string; is_winner_draft: boolean; }

export function DraftGroupPanel({ wizardId, groupId, stagingSlug }: { wizardId: number; groupId: number; stagingSlug: string }) {
  const router = useRouter();
  const [siblings, setSiblings] = useState<Sibling[]>([]);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    fetch(`/api/onboarding/group/${groupId}`)
      .then(r => r.json())
      .then(d => setSiblings(d.siblings || []))
      .catch(() => {});
  }, [groupId]);

  async function pick() {
    if (!confirm(`Mark "${stagingSlug}" as the winning draft? Other drafts in this group will be archived.`)) return;
    setPicking(true);
    try {
      const r = await fetch(`/api/onboarding/${wizardId}/pick-winner`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) { alert(d.error || 'Failed'); return; }
      router.refresh();
    } finally { setPicking(false); }
  }

  return (
    <div style={{ background: '#fff3cd', border: '1px solid #ffc107', padding: '.75rem', borderRadius: 4, margin: '1rem 0' }}>
      <strong>Draft group (group #{groupId})</strong>
      <div style={{ marginTop: '.5rem', fontSize: '.85rem' }}>
        Multi-draft scenario: customer has {siblings.length || '?'} parallel drafts in flight.
        Once customer picks the winner, click below to advance only that draft to live transfer.
      </div>
      {siblings.length > 0 && (
        <ul style={{ margin: '.5rem 0', fontSize: '.85rem' }}>
          {siblings.map(s => (
            <li key={s.id}>
              <a href={`/onboarding/${s.id}`}>{s.staging_slug}</a>
              {s.is_winner_draft && <span style={{ marginLeft: '.5rem', color: '#2e7d32' }}>← winner</span>}
              {s.status === 'archived' && <span style={{ marginLeft: '.5rem', color: '#888' }}>(archived)</span>}
              {s.id === wizardId && <span style={{ marginLeft: '.5rem', color: '#1976d2' }}>(this one)</span>}
            </li>
          ))}
        </ul>
      )}
      <button onClick={pick} disabled={picking} style={{ padding: '.4rem .8rem', background: '#2e7d32', color: 'white', border: 'none', borderRadius: 3, marginTop: '.5rem' }}>
        {picking ? 'Picking...' : `Mark "${stagingSlug}" as winning draft`}
      </button>
    </div>
  );
}
