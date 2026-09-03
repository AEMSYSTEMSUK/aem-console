'use client';
import { useState } from 'react';
import { CustomerPicker } from './customer-picker';

type Props = {
  site: {
    card_id: string;
    source_id: number;
    source: 'live' | 'staging';
    domain: string;
    server_label: string | null;
    parent_company: string | null;
    customer_name: string | null;
    has_sso_plugin: boolean;
    preview_url: string;
    is_eol: boolean;
  };
  borderColor?: string;
};

export function SiteCard({ site, borderColor }: Props) {
  const [parent, setParent] = useState(site.parent_company ?? '');
  const [name, setName] = useState(site.customer_name ?? '');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const thumbUrl = `https://s.wordpress.com/mshots/v1/${encodeURIComponent('https://' + site.preview_url)}?w=520&h=300`;

  async function ssoClick() {
    if (!site.has_sso_plugin) return;
    const endpoint = site.source === 'staging'
      ? `/api/onboarding/${site.source_id}/wp-admin-sso`
      : `/api/sites/${site.source_id}/wp-admin-sso`;
    const r = await fetch(endpoint, { method: 'POST' });
    const d = await r.json();
    if (d.url) window.open(d.url, '_blank', 'noopener');
    else alert('SSO failed: ' + (d.error ?? 'unknown'));
  }

  async function save() {
    setSaving(true);
    const endpoint = site.source === 'staging'
      ? `/api/onboarding/${site.source_id}`
      : `/api/sites/${site.source_id}`;
    await fetch(endpoint, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent_company: parent || null, customer_name: name || null }),
    });
    setSaving(false); setEditing(false);
    window.location.reload();
  }

  return (
    <div style={{
      border: `3px solid ${borderColor ?? '#e5e5e5'}`,
      borderRadius: 8, overflow: 'hidden', background: '#fff',
      position: 'relative',
    }}>
      {site.source === 'staging' && (
        <div style={{
          position: 'absolute', top: 6, right: 6, zIndex: 1,
          background: '#fa0', color: '#fff', fontSize: '0.6rem', fontWeight: 700,
          padding: '2px 6px', borderRadius: 3, letterSpacing: 0.5,
        }}>STAGING</div>
      )}
      {site.is_eol && (
        <div style={{
          position: 'absolute', top: 6, right: 6, zIndex: 1,
          background: '#e33', color: '#fff', fontSize: '0.6rem', fontWeight: 700,
          padding: '2px 6px', borderRadius: 3, letterSpacing: 0.5,
        }}>EOL · REPLACE</div>
      )}
      <button
        onClick={ssoClick}
        disabled={!site.has_sso_plugin}
        title={site.has_sso_plugin ? 'Log in to wp-admin' : 'SSO mu-plugin not installed yet'}
        style={{
          display: 'block', width: '100%', padding: 0, border: 0,
          cursor: site.has_sso_plugin ? 'pointer' : 'not-allowed',
          opacity: site.has_sso_plugin ? 1 : 0.5, background: '#f5f5f5',
        }}
      >
        <img src={thumbUrl} alt={site.domain}
             style={{ width: '100%', aspectRatio: '16/9', objectFit: 'cover', display: 'block' }} />
      </button>
      <div style={{ padding: '0.6rem' }}>
        {borderColor && site.parent_company && (
          <div style={{ fontSize: '0.65rem', color: borderColor, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 }}>
            {site.parent_company}
          </div>
        )}
        <div style={{ fontWeight: 600, fontSize: '0.85rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {site.domain}
        </div>
        <div style={{ color: '#888', fontSize: '0.7rem', marginBottom: '0.35rem' }}>
          {site.server_label}{!site.has_sso_plugin && ' · no SSO'}
        </div>
        {editing ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <CustomerPicker value={parent} onChange={setParent} placeholder="Parent company (optional)" />
            <CustomerPicker value={name} onChange={setName} placeholder="Customer name" />
            <div style={{ display: 'flex', gap: 4 }}>
              <button onClick={save} disabled={saving} style={{ flex: 1, fontSize: '0.7rem' }}>{saving ? 'Saving' : 'Save'}</button>
              <button onClick={() => setEditing(false)} style={{ fontSize: '0.7rem' }}>Cancel</button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
            <button onClick={() => setEditing(true)}
                    style={{ background: 'none', border: 0, color: '#06f', fontSize: '0.75rem', padding: 0, cursor: 'pointer', textAlign: 'left' }}>
              Edit: {site.customer_name ?? 'Set customer'}
            </button>
            {site.customer_name && (
              // Two-way link into AEM One: lands on the matching client via ?search= (name is the shared key). [#95]
              <a
                href={`https://one.aemtech.co.uk/admin/clients?search=${encodeURIComponent(site.customer_name)}`}
                target="_blank" rel="noopener noreferrer"
                title={`Open ${site.customer_name} in AEM One`}
                style={{ color: '#888', fontSize: '0.7rem', textDecoration: 'none', whiteSpace: 'nowrap' }}
              >
                Open in ONE ↗
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
