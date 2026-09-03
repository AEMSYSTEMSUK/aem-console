'use client';
import { useState, useMemo } from 'react';
import { SiteCard } from './site-card';

type Row = {
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

const PALETTE = ['#0666ff', '#e66333', '#119988', '#aa33aa', '#ffaa00', '#00cc88', '#cc3399', '#2277aa', '#dd5533', '#8855c2'];
function colorFor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0x7fffffff;
  return PALETTE[h % PALETTE.length];
}

export function CustomerSitesGrid({ rows, groupedParents }: { rows: Row[]; groupedParents: string[] }) {
  const [query, setQuery] = useState('');
  const groupSet = useMemo(() => new Set(groupedParents), [groupedParents]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r =>
      r.domain.toLowerCase().includes(q) ||
      (r.customer_name?.toLowerCase().includes(q) ?? false) ||
      (r.parent_company?.toLowerCase().includes(q) ?? false) ||
      (r.server_label?.toLowerCase().includes(q) ?? false)
    );
  }, [rows, query]);

  return (
    <>
      <div style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <input
          type="search"
          placeholder="Search by domain, customer, company, or server…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          autoFocus
          style={{
            flex: '0 1 420px', padding: '0.5rem 0.75rem',
            fontSize: '0.95rem', border: '1px solid #ccc', borderRadius: 6,
          }}
        />
        {query && (
          <>
            <span style={{ color: '#666', fontSize: '0.85rem' }}>
              {filtered.length} of {rows.length}
            </span>
            <button onClick={() => setQuery('')} style={{ fontSize: '0.8rem', cursor: 'pointer' }}>Clear</button>
          </>
        )}
      </div>
      {filtered.length === 0 ? (
        <p style={{ color: '#888', fontStyle: 'italic' }}>No matches.</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', gap: '1rem' }}>
          {filtered.map(s => {
            const isGrouped = s.parent_company && groupSet.has(s.parent_company);
            const borderColor = isGrouped ? colorFor(s.parent_company!) : undefined;
            return <SiteCard key={s.card_id} site={s} borderColor={borderColor} />;
          })}
        </div>
      )}
    </>
  );
}
