'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function ScanAllServersButton() {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  async function run() {
    setRunning(true);
    try {
      await fetch('/api/admin/scan-all-servers', { method: 'POST' });
      alert('Fleet scan started in background. Refresh in ~1 min.');
    } finally { setRunning(false); router.refresh(); }
  }
  return <button onClick={run} disabled={running} style={{ padding: '.3rem .8rem', background: '#1976d2', color: 'white', border: 'none', borderRadius: 3, fontSize: '.85rem' }}>{running ? 'Starting…' : 'Scan all'}</button>;
}

export function ScanServerButton({ serverId }: { serverId: number }) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  async function run() {
    setRunning(true);
    try { await fetch(`/api/admin/servers/${serverId}/scan`, { method: 'POST' }); }
    finally { setRunning(false); router.refresh(); }
  }
  return <button onClick={run} disabled={running} style={{ padding: '.2rem .5rem', fontSize: '.75rem' }}>{running ? '…' : 'Scan'}</button>;
}

export function UpgradeServerButton({ serverId, name, pendingKernel, rebootRequired }: { serverId: number; name: string; pendingKernel: number; rebootRequired: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'upgrade'|'upgrade-and-reboot'|'reboot'>(rebootRequired || pendingKernel > 0 ? 'upgrade-and-reboot' : 'upgrade');
  const [submitting, setSubmitting] = useState(false);
  async function run() {
    setSubmitting(true);
    try {
      const r = await fetch(`/api/admin/servers/${serverId}/upgrade`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind }),
      });
      const d = await r.json();
      if (!r.ok) { alert(d.error || 'Failed'); return; }
      router.push(`/admin/server-updates/${d.jobId}`);
    } finally { setSubmitting(false); }
  }
  if (!open) return <button onClick={() => setOpen(true)} style={{ padding: '.2rem .5rem', fontSize: '.75rem', background: '#2e7d32', color: 'white', border: 'none', borderRadius: 3 }}>Upgrade</button>;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: 'white', padding: '1.5rem', borderRadius: 6, minWidth: 420 }}>
        <h3 style={{ marginTop: 0 }}>Upgrade {name}</h3>
        <p style={{ fontSize: '.85rem', color: '#666' }}>apt-get upgrade with safe Dpkg options. Reboot only if kernel changed.</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '.4rem', margin: '.75rem 0' }}>
          {(['upgrade','upgrade-and-reboot','reboot'] as const).map(k => (
            <label key={k} style={{ display: 'flex', alignItems: 'center', gap: '.5rem' }}>
              <input type="radio" name="kind" value={k} checked={kind === k} onChange={() => setKind(k)} />
              <span>{k}{k === 'upgrade-and-reboot' && (pendingKernel > 0 || rebootRequired) ? ' (recommended)' : ''}</span>
            </label>
          ))}
        </div>
        <p style={{ fontSize: '.75rem', color: '#ed6c02' }}>Reboot causes ~30s downtime. Web servers will return 502 briefly.</p>
        <div style={{ display: 'flex', gap: '.5rem', justifyContent: 'flex-end' }}>
          <button onClick={() => setOpen(false)} style={{ padding: '.35rem .75rem' }}>Cancel</button>
          <button onClick={run} disabled={submitting} style={{ padding: '.35rem .75rem', background: '#2e7d32', color: 'white', border: 'none', borderRadius: 3 }}>{submitting ? 'Starting…' : 'Run'}</button>
        </div>
      </div>
    </div>
  );
}

export function PleskSsoButton({ serverId }: { serverId: number }) {
  async function go() {
    try {
      const r = await fetch(`/api/admin/servers/${serverId}/sso`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) { alert(d.error || 'SSO failed'); return; }
      // Open in new tab — URL contains one-time secret valid ~60s
      window.open(d.url, '_blank', 'noopener');
    } catch (e) {
      alert((e as Error).message);
    }
  }
  return <button onClick={go} style={{ padding: '.2rem .5rem', fontSize: '.75rem', background: '#5c2d91', color: 'white', border: 'none', borderRadius: 3 }}>Plesk panel ↗</button>;
}
