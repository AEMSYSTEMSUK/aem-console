'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function ScanAllButton() {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  async function run() {
    setRunning(true);
    try {
      await fetch('/api/admin/scan-all-updates', { method: 'POST' });
      alert('Fleet scan started in background. Refresh in ~5 min to see updated counts.');
    } finally { setRunning(false); router.refresh(); }
  }
  return <button onClick={run} disabled={running} style={{ padding: '.3rem .8rem', background: '#1976d2', color: 'white', border: 'none', borderRadius: 3, fontSize: '.85rem' }}>{running ? 'Starting…' : 'Scan all'}</button>;
}

export function ScanOneButton({ siteId }: { siteId: number }) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  async function run() {
    setRunning(true);
    try { await fetch(`/api/sites/${siteId}/scan-updates`, { method: 'POST' }); }
    finally { setRunning(false); router.refresh(); }
  }
  return <button onClick={run} disabled={running} style={{ padding: '.2rem .5rem', fontSize: '.75rem' }}>{running ? '…' : 'Scan'}</button>;
}

export function UpdateButton({ siteId, domain }: { siteId: number; domain: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'plugins'|'themes'|'core'|'all'>('all');
  const [submitting, setSubmitting] = useState(false);
  async function run() {
    setSubmitting(true);
    try {
      const r = await fetch(`/api/sites/${siteId}/update`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind }),
      });
      const d = await r.json();
      if (!r.ok) { alert(d.error || 'Failed'); return; }
      router.push(`/updates/${d.jobId}`);
    } finally { setSubmitting(false); }
  }
  if (!open) return <button onClick={() => setOpen(true)} style={{ padding: '.2rem .5rem', fontSize: '.75rem', background: '#2e7d32', color: 'white', border: 'none', borderRadius: 3 }}>Update</button>;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: 'white', padding: '1.5rem', borderRadius: 6, minWidth: 380 }}>
        <h3 style={{ marginTop: 0 }}>Update {domain}</h3>
        <p style={{ fontSize: '.85rem', color: '#666' }}>Backup → update → healthcheck → success or auto-rollback option.</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '.4rem', margin: '.75rem 0' }}>
          {(['all','plugins','themes','core'] as const).map(k => (
            <label key={k} style={{ display: 'flex', alignItems: 'center', gap: '.5rem' }}>
              <input type="radio" name="kind" value={k} checked={kind === k} onChange={() => setKind(k)} />
              <span>{k}</span>
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '.5rem', justifyContent: 'flex-end' }}>
          <button onClick={() => setOpen(false)} style={{ padding: '.35rem .75rem' }}>Cancel</button>
          <button onClick={run} disabled={submitting} style={{ padding: '.35rem .75rem', background: '#2e7d32', color: 'white', border: 'none', borderRadius: 3 }}>{submitting ? 'Starting…' : 'Run update'}</button>
        </div>
      </div>
    </div>
  );
}

export function RollbackButton({ jobId }: { jobId: number }) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  async function run() {
    if (!confirm('Restore the pre-update backup? This will revert ALL changes since the update.')) return;
    setRunning(true);
    try {
      const r = await fetch(`/api/updates/${jobId}/rollback`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) { alert(d.error || 'Failed'); return; }
      router.refresh();
    } finally { setRunning(false); }
  }
  return <button onClick={run} disabled={running} style={{ padding: '.35rem .75rem', background: '#c62828', color: 'white', border: 'none', borderRadius: 3 }}>{running ? 'Restoring…' : 'Rollback to backup'}</button>;
}
