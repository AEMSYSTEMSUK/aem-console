'use client';
import { useState, useEffect, useRef } from 'react';
type Status = { phase: string; pct: number; message: string };
type PluginResult = { ok?: boolean; installed_ok?: boolean; plugin?: string; admin_url?: string; customer_steps?: string; error?: string };
const PLUGIN_OPTIONS: { slug: string; name: string; label: string; when: string }[] = [
  { slug: 'all-in-one-wp-migration', name: 'All-in-One WP Migration', label: 'All-in-One WP Migration — single file (default)',
    when: 'Default. Small/medium sites where the destination can install the same plugin and import one .wpress file. Note: the FREE importer caps at 512MB on the destination — for bigger sites use Migrate Guru.' },
  { slug: 'migrate-guru', name: 'Migrate Guru', label: 'Migrate Guru — large sites / server-side',
    when: 'Large sites (free up to ~200GB) or pushing straight onto the new host server-side — no file to download, no size limit. Needs the destination host login details.' },
  { slug: 'wp-migrate-db', name: 'WP Migrate Lite', label: 'WP Migrate Lite — downloadable ZIP',
    when: 'When you just want a clean downloadable ZIP of the whole site (files + DB) with include/exclude control, to hand over manually.' },
  { slug: 'duplicator', name: 'Duplicator', label: 'Duplicator — installer + archive',
    when: 'When the destination is a blank/empty server and you want a self-running installer (installer.php) + archive rather than a plugin-to-plugin import.' },
];
export function ExportButton({ wizardId }: { wizardId: number }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>({ phase: 'idle', pct: 0, message: '' });
  const [result, setResult] = useState<null | { ok?: boolean; download_url?: string; filename?: string; size_bytes?: number; error?: string }>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [pluginSlug, setPluginSlug] = useState('all-in-one-wp-migration');
  const [pluginBusy, setPluginBusy] = useState(false);
  const [pluginResult, setPluginResult] = useState<PluginResult | null>(null);
  useEffect(() => {
    if (!busy) return;
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`/api/onboarding/${wizardId}/export/status`);
        const d = await r.json();
        if (d.phase) setStatus(d);
      } catch { /* ignore poll errors */ }
    }, 1000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [busy, wizardId]);
  async function fire() {
    setBusy(true);
    setResult(null);
    setStatus({ phase: 'starting', pct: 0, message: 'Starting export…' });
    try {
      const r = await fetch(`/api/onboarding/${wizardId}/export`, { method: 'POST' });
      const d = await r.json();
      setResult(d);
    } catch (e) {
      setResult({ error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  async function firePlugin() {
    setPluginBusy(true);
    setPluginResult(null);
    try {
      const r = await fetch(`/api/onboarding/${wizardId}/export-plugin?plugin=${encodeURIComponent(pluginSlug)}`, { method: 'POST' });
      const d = await r.json();
      setPluginResult(d);
    } catch (e) {
      setPluginResult({ error: (e as Error).message });
    } finally {
      setPluginBusy(false);
    }
  }
  return (
    <div style={{ background: '#fff8e1', border: '1px solid #ffb300', padding: '.75rem', borderRadius: 4, margin: '1rem 0' }}>
      <strong style={{ fontSize: '.95rem' }}>Export this site (for customers leaving AEM hosting)</strong>

      <div style={{ marginTop: '.6rem' }}>
        <strong style={{ fontSize: '.9rem' }}>1. Technical / developer path — portable bundle</strong>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', marginTop: '.4rem' }}>
          <button onClick={fire} disabled={busy}
            style={{ padding: '.4rem .8rem', cursor: busy ? 'wait' : 'pointer', fontSize: '.9rem' }}>
            {busy ? 'Generating…' : 'Generate export'}
          </button>
          {result?.download_url && (
            <a href={result.download_url} download
              style={{ padding: '.4rem .8rem', background: '#2e7d32', color: 'white', textDecoration: 'none', borderRadius: 4, fontSize: '.9rem' }}>
              ↓ Download {result.filename} ({result.size_bytes ? (result.size_bytes / 1024 / 1024).toFixed(1) : '?'} MB)
            </a>
          )}
        </div>
        {busy && (
          <div style={{ marginTop: '.6rem' }}>
            <div style={{ background: '#eee', height: 10, borderRadius: 5, overflow: 'hidden', position: 'relative' }}>
              <div style={{ background: '#ffb300', height: '100%', width: `${status.pct}%`, transition: 'width .5s ease' }} />
            </div>
            <div style={{ marginTop: '.3rem', fontSize: '.82rem', color: '#555' }}>
              <strong>{status.phase}</strong> ({status.pct}%) — {status.message}
            </div>
          </div>
        )}
        {result?.error && (
          <div style={{ marginTop: '.5rem', color: '#c62828', fontSize: '.85rem' }}>
            <strong>Error:</strong> {result.error}
          </div>
        )}
        <div style={{ color: '#555', fontSize: '.78rem', marginTop: '.45rem', lineHeight: 1.45 }}>
          Produces a downloadable bundle: WP files (files.tar.gz) + database dump (database.sql) + a README with step-by-step restore for Plesk, cPanel, managed WP (WP Engine / Kinsta), and generic SSH. The receiving developer extracts the files over the WP root, imports the DB, updates wp-config.php, then runs a wp search-replace for the new URL (never a plain SQL UPDATE — that corrupts WordPress serialized data) and flushes permalinks. Best when the destination has a developer or sysadmin to run the restore.
        </div>
      </div>

      <div style={{ marginTop: '.75rem', paddingTop: '.75rem', borderTop: '1px dashed #ffb300' }}>
        <strong style={{ fontSize: '.9rem' }}>2. Non-technical path — install an export plugin on the site</strong>
        <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', flexWrap: 'wrap', marginTop: '.4rem' }}>
          <select value={pluginSlug} onChange={(e) => setPluginSlug(e.target.value)} disabled={pluginBusy}
            style={{ padding: '.35rem', fontSize: '.85rem', maxWidth: '100%' }}>
            {PLUGIN_OPTIONS.map((p) => <option key={p.slug} value={p.slug}>{p.label}</option>)}
          </select>
          <button onClick={firePlugin} disabled={pluginBusy}
            style={{ padding: '.4rem .8rem', cursor: pluginBusy ? 'wait' : 'pointer', fontSize: '.9rem' }}>
            {pluginBusy ? 'Installing…' : 'Install on site'}
          </button>
        </div>
        <div style={{ marginTop: '.5rem', fontSize: '.78rem', lineHeight: 1.45 }}>
          {PLUGIN_OPTIONS.map((p) => {
            const sel = p.slug === pluginSlug;
            return (
              <div key={p.slug} style={{ marginTop: '.25rem', padding: '.25rem .4rem', borderRadius: 3,
                background: sel ? '#fff3cd' : 'transparent', color: sel ? '#1a1a1d' : '#666' }}>
                <strong>{p.name}</strong> — {p.when}
              </div>
            );
          })}
        </div>
        {pluginResult?.ok && (
          <div style={{ marginTop: '.5rem', fontSize: '.82rem', color: '#2e7d32' }}>
            ✓ {pluginResult.plugin} {pluginResult.installed_ok ? 'installed + activated' : 'install attempted'} on the site.{' '}
            {pluginResult.admin_url && <a href={pluginResult.admin_url} target="_blank" rel="noreferrer">Open wp-admin ↗</a>}
            {pluginResult.customer_steps && <div style={{ color: '#555', marginTop: '.3rem' }}>{pluginResult.customer_steps}</div>}
          </div>
        )}
        {pluginResult?.error && (
          <div style={{ marginTop: '.5rem', color: '#c62828', fontSize: '.82rem' }}>
            <strong>Error:</strong> {pluginResult.error}
          </div>
        )}
        <div style={{ color: '#666', fontSize: '.78rem', marginTop: '.5rem' }}>
          Installs a free export/migration plugin on the customer&apos;s site so they can self-export to a host AEM doesn&apos;t manage.
        </div>
      </div>
    </div>
  );
}
