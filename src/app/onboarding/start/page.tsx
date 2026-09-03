'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { CustomerPicker } from '../../customer-sites/customer-picker';

export default function StartOnboarding() {
  const router = useRouter();
  const [parent_company, setParent] = useState('');
  const [target_live_server, setTargetServer] = useState('live1');
  const [dns_provider, setDnsProvider] = useState<'cloudflare'|'manual'>('cloudflare');
  const [refresh_mode, setRefreshMode] = useState(false);
  const [staging_source, setStagingSource] = useState<'fresh'|'clone_from_live'>('fresh');
  const [staging_server, setStagingServer] = useState('staging1');
  const [staging_url_override, setStagingUrlOverride] = useState('');
  const [servers, setServers] = useState<{id:number;name:string;fqdn:string}[]>([]);
  const [customer_name, setName] = useState('');
  const [customer_contact_email, setEmail] = useState('');
  const [staging_slug, setSlug] = useState('');
  const [real_domain, setDomain] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [parentId, setParentId] = useState<number | null>(null);
  const [parentLocked, setParentLocked] = useState(false);
  useEffect(() => {
    fetch('/api/servers/plesk-web').then(r => r.json()).then(d => setServers(d.servers ?? [])).catch(() => {});
  }, []);
  useEffect(() => {
    const pid = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('parent') : null;
    if (!pid) return;
    const pn = parseInt(pid, 10);
    if (!Number.isFinite(pn)) return;
    setParentId(pn);
    setParentLocked(true);
    fetch(`/api/onboarding/${pn}`).then(r => r.json()).then(d => {
      if (d?.wizard) {
        setName(d.wizard.customer_name || '');
        setParent(d.wizard.parent_company || '');
        setEmail(d.wizard.customer_contact_email || '');
        setDomain(d.wizard.real_domain || '');
      }
    }).catch(() => {});
  }, []);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const r = await fetch('/api/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_name, customer_contact_email, staging_slug, real_domain, parent_company, target_live_server, dns_provider, refresh_mode, staging_source, staging_server, staging_url_override }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
      router.push(`/onboarding/${data.wizard_id}`);
    } catch (e) {
      setError((e as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <main style={{ maxWidth: 640, margin: '2rem auto', padding: '0 1rem', fontFamily: 'system-ui' }}>
      <h1 style={{ marginBottom: '0.25rem' }}>New customer onboarding</h1>
      {parentLocked && parentId && (
        <div style={{ padding: '.75rem', background: '#f8f4ff', border: '1px solid #e0d4ff', borderRadius: 4, marginBottom: '1rem' }}>
          📑 Adding a new draft to wizard group #{parentId}. Customer details are locked from the parent. You only need to choose a new staging slug.
        </div>
      )}

      <p style={{ color: '#666', marginTop: 0 }}>
        Creates <code>&lt;slug&gt;.aemstaging.co.uk</code> with a fresh WP install, then notifies IT
        (support@aemsystems.co.uk) to complete the rest of the lifecycle.
      </p>

      <form onSubmit={submit} style={{ display: 'grid', gap: '1rem', marginTop: '1.5rem' }}>
        <label>
          <div>Parent company <span style={{ color: '#999' }}>(optional — for groups like DCR Machines)</span></div>
          <CustomerPicker value={parent_company} onChange={setParent} disabled={parentLocked}
            placeholder="DCR Machines"
            inputStyle={{ fontSize: '1rem', padding: '.5rem' }} />
        </label>
        <label>
          <div>Customer name</div>
          <CustomerPicker value={customer_name} onChange={setName} disabled={parentLocked}
            placeholder="Acme Corp"
            inputStyle={{ fontSize: '1rem', padding: '.5rem' }} />
        </label>
        <label>
          <div>Customer contact email</div>
          <input required type="email" value={customer_contact_email} onChange={e => setEmail(e.target.value)} readOnly={parentLocked}
            style={{ width: '100%', padding: '.5rem', fontSize: '1rem' }} placeholder="hello@acme.com" />
        </label>
        <label>
          <div>Staging slug (lowercase, letters/digits/hyphens)</div>
          <input required pattern="^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$" value={staging_slug}
            onChange={e => setSlug(e.target.value.toLowerCase())}
            style={{ width: '100%', padding: '.5rem', fontSize: '1rem' }} placeholder="acme-corp" />
          <div style={{ color: '#888', fontSize: '0.85rem', marginTop: '.25rem' }}>
            Becomes: <code>{staging_slug || 'acme-corp'}.aemstaging.co.uk</code>
          </div>
        </label>
        <label>
          <div>Real (production) domain</div>
          <input required value={real_domain} onChange={e => setDomain(e.target.value.toLowerCase())} readOnly={parentLocked}
            style={{ width: '100%', padding: '.5rem', fontSize: '1rem' }} placeholder="acme.com" />
        </label>
        <label>
          <div>Target live server <span style={{ color: '#999' }}>(where the site will go live at cutover)</span></div>
          <select value={target_live_server} onChange={e => setTargetServer(e.target.value)} disabled={parentLocked}
            style={{ width: '100%', padding: '.5rem', fontSize: '1rem' }}>
            {servers.map(sv => <option key={sv.id} value={sv.name}>{sv.name} ({sv.fqdn})</option>)}
          </select>
        </label>
                <label>
          <div>DNS at cutover</div>
          <div style={{ display: 'flex', gap: '1rem', marginTop: 4 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="radio" name="dnsp" checked={dns_provider==='cloudflare'} onChange={() => setDnsProvider('cloudflare')} disabled={parentLocked} />
              Cloudflare (auto)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="radio" name="dnsp" checked={dns_provider==='manual'} onChange={() => setDnsProvider('manual')} disabled={parentLocked} />
              Manual (registrar / non-CF)
            </label>
          </div>
          <div style={{ color: '#888', fontSize: '0.85rem', marginTop: 4 }}>
            {dns_provider === 'cloudflare'
              ? 'Step 7 upserts the A record + purges cache via the Console CF token.'
              : 'Step 7 prints records to set + verifies via dig. Customer updates DNS at their registrar before Step 9 (SSL).'}
          </div>
        </label>
                <label style={{ padding: '.75rem', background: refresh_mode ? '#fff3e0' : 'transparent', border: refresh_mode ? '1px solid #ff9800' : '1px solid transparent', borderRadius: 4 }}>
          <div>
            <input type="checkbox" checked={refresh_mode} onChange={e => setRefreshMode(e.target.checked)} disabled={parentLocked}
              style={{ marginRight: 6 }} />
            <strong>Refresh deploy</strong> — live site already exists, push code only, preserve all data + uploads
          </div>
          {refresh_mode && (
            <div style={{ marginTop: '.5rem', fontSize: '.85rem', color: '#666', lineHeight: 1.5 }}>
              Step 6 will replace wp-admin, wp-includes, themes, plugins, and mu-plugins from staging build.<br />
              Preserved untouched: <code>database</code>, <code>wp-content/uploads</code>, <code>wp-config.php</code>, <code>.htaccess</code>, <code>aem-*</code> mu-plugins.<br />
              Steps 7-10 (DNS, SSL, search-replace) will auto-skip — site is already live.<br />
              <em>Use this when redeploying a new design build to an existing customer site.</em>
            </div>
          )}
        </label>
                <label>
          <div>Staging server <span style={{ color: '#999' }}>(where the staging build will live)</span></div>
          <select value={staging_server} onChange={e => setStagingServer(e.target.value)} disabled={parentLocked}
            style={{ width: '100%', padding: '.5rem', fontSize: '1rem' }}>
            {servers.map(sv => <option key={sv.id} value={sv.name}>{sv.name} ({sv.fqdn})</option>)}
          </select>
          {staging_server !== 'staging1' && (
            <div style={{ marginTop: 8 }}>
              <div style={{ color: '#b26a00', fontSize: '.82rem', marginBottom: 4 }}>
                Non-staging1 target: customer manages DNS. Enter the full staging URL (a subdomain of the customer domain, e.g. https://staging.example.com).
              </div>
              <input type="url" placeholder="https://staging.example.com" value={staging_url_override}
                onChange={e => setStagingUrlOverride(e.target.value)} disabled={parentLocked}
                style={{ width: '100%', padding: '.5rem', fontSize: '1rem' }} />
            </div>
          )}
        </label>
        <label style={{ padding: '.75rem', background: staging_source === 'clone_from_live' ? '#e3f2fd' : 'transparent', border: staging_source === 'clone_from_live' ? '1px solid #1976d2' : '1px solid transparent', borderRadius: 4 }}>
          <div><strong>Staging source</strong></div>
          <div style={{ marginTop: 6 }}>
            <label style={{ display: 'block', cursor: 'pointer', padding: '.2rem 0' }}>
              <input type="radio" name="staging_source" checked={staging_source === 'fresh'} onChange={() => setStagingSource('fresh')} disabled={parentLocked} style={{ marginRight: 6 }} />
              Fresh install — new WP from scratch
            </label>
            <label style={{ display: 'block', cursor: 'pointer', padding: '.2rem 0' }}>
              <input type="radio" name="staging_source" checked={staging_source === 'clone_from_live'} onChange={() => setStagingSource('clone_from_live')} disabled={parentLocked} style={{ marginRight: 6 }} />
              Clone from live — designer works on a copy of the existing site
            </label>
          </div>
          {staging_source === 'clone_from_live' && (
            <div style={{ marginTop: '.5rem', fontSize: '.85rem', color: '#666', lineHeight: 1.5 }}>
              Step 2 will pull from live (<code>{real_domain || 'real domain'}</code> on <code>{target_live_server}</code>), bringing themes, plugins, mu-plugins, uploads, and DB content.<br />
              Excluded (stays only on live): WooCommerce orders, form submissions, action scheduler logs.<br />
              <em>Use this when redesigning a customer site whose existing live install you want to mirror.</em>
            </div>
          )}
        </label>
        {error && (
          <div style={{ background: '#fdd', padding: '.5rem .75rem', borderRadius: 4 }}>
            <strong>Error:</strong> {error}
          </div>
        )}
        <button type="submit" disabled={submitting}
          style={{ padding: '.75rem 1.5rem', fontSize: '1rem', fontWeight: 600, cursor: submitting ? 'wait' : 'pointer' }}>
          {submitting ? 'Creating (this takes ~30 sec)...' : 'Create staging site + notify IT'}
        </button>
      </form>
    </main>
  );
}
