'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export interface PolicyFormValue {
  enabled: boolean;
  mode: 'auto' | 'approve' | 'report';
  ring: 'pilot' | 'flagship' | 'standard';
  exclude_slugs: string[];
  hold_core_major: boolean;
  smoke_paths: string[];
  expect_text: string | null;
  is_woocommerce: boolean;
  notes: string | null;
}

const label: React.CSSProperties = { display: 'block', fontWeight: 600, fontSize: '.85rem', marginBottom: '.2rem' };
const hint: React.CSSProperties = { color: '#888', fontSize: '.75rem', marginTop: '.15rem' };
const field: React.CSSProperties = { marginBottom: '1rem' };
const input: React.CSSProperties = { padding: '.35rem .5rem', fontSize: '.9rem', border: '1px solid #ccc', borderRadius: 3, width: '100%', boxSizing: 'border-box' };

export function PolicyForm({ siteId, initial }: { siteId: number; initial: PolicyFormValue }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [mode, setMode] = useState(initial.mode);
  const [ring, setRing] = useState(initial.ring);
  const [exclude, setExclude] = useState(initial.exclude_slugs.join('\n'));
  const [holdCoreMajor, setHoldCoreMajor] = useState(initial.hold_core_major);
  const [smoke, setSmoke] = useState(initial.smoke_paths.join('\n'));
  const [expectText, setExpectText] = useState(initial.expect_text ?? '');
  const [isWoo, setIsWoo] = useState(initial.is_woocommerce);
  const [notes, setNotes] = useState(initial.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setMsg(null);
    try {
      const r = await fetch(`/api/sites/${siteId}/patch-policy`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled, mode, ring, hold_core_major: holdCoreMajor, is_woocommerce: isWoo,
          exclude_slugs: exclude.split(/[\n,]/).map(s => s.trim()).filter(Boolean),
          smoke_paths: smoke.split(/[\n,]/).map(s => s.trim()).filter(Boolean),
          expect_text: expectText, notes,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg(d.error || 'Failed'); return; }
      setMsg('Saved');
      router.refresh();
    } finally { setSaving(false); }
  }

  return (
    <form onSubmit={save} style={{ maxWidth: 560 }}>
      <div style={field}>
        <label style={{ display: 'flex', gap: '.5rem', alignItems: 'center' }}>
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
          <span style={{ fontWeight: 600, fontSize: '.85rem' }}>Patching enabled</span>
        </label>
      </div>
      <div style={field}>
        <label style={label}>Mode</label>
        <select value={mode} onChange={e => setMode(e.target.value as PolicyFormValue['mode'])} style={input}>
          <option value="approve">approve: stage and test, wait for sign-off before live</option>
          <option value="auto">auto: promote to live automatically if the staging tests pass</option>
          <option value="report">report: scan and report only, never patch</option>
        </select>
      </div>
      <div style={field}>
        <label style={label}>Ring</label>
        <select value={ring} onChange={e => setRing(e.target.value as PolicyFormValue['ring'])} style={input}>
          <option value="pilot">pilot: low-stakes, patched first</option>
          <option value="flagship">flagship</option>
          <option value="standard">standard: the long tail</option>
        </select>
      </div>
      <div style={field}>
        <label style={label}>Excluded plugin/theme slugs</label>
        <textarea value={exclude} onChange={e => setExclude(e.target.value)} rows={4} style={{ ...input, fontFamily: 'monospace' }} />
        <div style={hint}>One slug per line (e.g. woocommerce). These are held and never patched automatically.</div>
      </div>
      <div style={field}>
        <label style={{ display: 'flex', gap: '.5rem', alignItems: 'center' }}>
          <input type="checkbox" checked={holdCoreMajor} onChange={e => setHoldCoreMajor(e.target.checked)} />
          <span style={{ fontWeight: 600, fontSize: '.85rem' }}>Hold WordPress core major versions (e.g. 6.6 to 6.7)</span>
        </label>
      </div>
      <div style={field}>
        <label style={label}>Smoke-test paths</label>
        <textarea value={smoke} onChange={e => setSmoke(e.target.value)} rows={3} style={{ ...input, fontFamily: 'monospace' }} />
        <div style={hint}>One path per line, each starting with / (e.g. /, /shop/, /contact/). Defaults to /.</div>
      </div>
      <div style={field}>
        <label style={label}>Expected text on the home page (optional)</label>
        <input value={expectText} onChange={e => setExpectText(e.target.value)} style={input} />
      </div>
      <div style={field}>
        <label style={{ display: 'flex', gap: '.5rem', alignItems: 'center' }}>
          <input type="checkbox" checked={isWoo} onChange={e => setIsWoo(e.target.checked)} />
          <span style={{ fontWeight: 600, fontSize: '.85rem' }}>WooCommerce store (live orders: sync code only, never the database)</span>
        </label>
      </div>
      <div style={field}>
        <label style={label}>Notes</label>
        <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} style={input} />
      </div>
      <div style={{ display: 'flex', gap: '.75rem', alignItems: 'center' }}>
        <button type="submit" disabled={saving} style={{ padding: '.4rem 1rem', background: '#1976d2', color: 'white', border: 'none', borderRadius: 3 }}>{saving ? 'Saving…' : 'Save policy'}</button>
        {msg && <span style={{ fontSize: '.85rem', color: msg === 'Saved' ? '#2e7d32' : '#c62828' }}>{msg}</span>}
      </div>
    </form>
  );
}
