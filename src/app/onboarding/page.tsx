import { db } from '@/lib/db';
import { requireUser } from '@/lib/rbac';
import { STEPS } from '@/lib/onboarding';
import { WpAdminButton } from './wp-admin-button';
export const dynamic = 'force-dynamic';

interface Row {
  id: number;
  customer_name: string;
  customer_contact_email: string;
  staging_slug: string;
  staging_url_override: string | null;
  parent_company: string | null;
  real_domain: string;
  target_live_server: string;
  current_step: number;
  status: string;
  wizard_group_id: number | null;
  is_winner_draft: boolean;
  created_at: string;
}

type Entry = { kind: 'single'; row: Row } | { kind: 'group'; rows: Row[]; customer_name: string };

export default async function OnboardingIndex() {
  await requireUser();
  const rs = await db.query<Row>(`
    SELECT id, customer_name, customer_contact_email, staging_slug, real_domain, staging_url_override, parent_company,
           target_live_server, current_step, status, wizard_group_id, is_winner_draft,
           created_at::text
      FROM onboarding_wizards
      ORDER BY LOWER(customer_name), LOWER(staging_slug), id
  `);

  // Build mixed entry list: each draft group becomes ONE entry, each standalone becomes ONE entry
  const grouped = new Map<number, Row[]>();
  for (const r of rs.rows) {
    if (r.wizard_group_id) {
      const arr = grouped.get(r.wizard_group_id) ?? [];
      arr.push(r);
      grouped.set(r.wizard_group_id, arr);
    }
  }
  const consumedGroups = new Set<number>();
  const entries: Entry[] = [];
  for (const r of rs.rows) {
    if (r.wizard_group_id) {
      if (consumedGroups.has(r.wizard_group_id)) continue;
      consumedGroups.add(r.wizard_group_id);
      const groupRows = grouped.get(r.wizard_group_id)!;
      entries.push({ kind: 'group', rows: groupRows, customer_name: groupRows[0].customer_name });
    } else {
      entries.push({ kind: 'single', row: r });
    }
  }
  // Final sort: customer name asc, with groups slotting where their first row sits
  entries.sort((a, b) => {
    const an = (a.kind === 'single' ? a.row.customer_name : a.customer_name).toLowerCase();
    const bn = (b.kind === 'single' ? b.row.customer_name : b.customer_name).toLowerCase();
    return an.localeCompare(bn);
  });

  return (
    <main style={{ maxWidth: 1280, margin: '2rem auto', padding: '0 1rem', fontFamily: 'system-ui' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '1rem' }}>
        <h1 style={{ fontSize: '1.5rem', margin: 0 }}>Onboarding wizards</h1>
        <a href="/onboarding/start" style={{ padding: '.4rem .8rem', background: '#2e7d32', color: 'white', textDecoration: 'none', borderRadius: 4, fontSize: '.9rem' }}>+ New wizard</a>
      </header>
      <p style={{ color: '#666', marginTop: 0, fontSize: '.85rem' }}>
        {rs.rows.length} wizards total · {entries.filter(e => e.kind === 'group').length} draft group(s)
      </p>

      <div style={{ display: 'block' }}>
        {entries.map((e, i) =>
          e.kind === 'single'
            ? <SingleCard key={e.row.id} row={e.row} />
            : <GroupCard key={e.rows[0].wizard_group_id} customerName={e.customer_name} rows={e.rows} />
        )}
      </div>
    </main>
  );
}

function SingleCard({ row: r }: { row: Row }) {
  return (
    <div style={{ border: '1px solid #e0e0e0', borderRadius: 6, background: 'white', width: '100%', marginBottom: '.5rem', padding: '.5rem 1rem' }}>
      <CardHeader customer_name={r.customer_name} suffix={null} statuses={[r.status]} winner={false} />
      <SingleWizardTable rows={[r]} />
    </div>
  );
}

function GroupCard({ customerName, rows }: { customerName: string; rows: Row[] }) {
  const inProgress = rows.filter(w => w.status === 'in_progress').length;
  const completed  = rows.filter(w => w.status === 'completed').length;
  const archived   = rows.filter(w => w.status === 'archived').length;
  const winner     = !!rows.find(w => w.is_winner_draft);
  return (
    <details style={{ border: '1px solid #e0e0e0', borderRadius: 6, background: 'white', width: '100%', marginBottom: '.5rem' }}>
      <summary style={{ padding: '.75rem 1rem', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', listStyle: 'none' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: '.75rem' }}>
          <span style={{ fontSize: '.85rem', color: '#888' }}>▸</span>
          <strong style={{ fontSize: '1rem' }}>{customerName}</strong>
          <span style={{ color: '#5c2d91', fontSize: '.75rem' }}>📑 Draft group — {rows.length} drafts</span>
        </span>
        <span style={{ display: 'flex', gap: '.4rem' }}>
          {inProgress > 0 && <Badge color="#1976d2">{inProgress} in_progress</Badge>}
          {completed > 0  && <Badge color="#2e7d32">{completed} completed</Badge>}
          {archived > 0   && <Badge color="#888">{archived} archived</Badge>}
          {winner         && <Badge color="#5c2d91">✓ winner picked</Badge>}
        </span>
      </summary>
      <div style={{ borderTop: '1px solid #eee' }}>
        <SingleWizardTable rows={rows} />
      </div>
    </details>
  );
}

function CardHeader({ customer_name, suffix, statuses, winner }: any) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '.75rem', marginBottom: '.4rem' }}>
      <strong style={{ fontSize: '1rem' }}>{customer_name}</strong>
      {suffix && <span style={{ color: '#666', fontSize: '.75rem' }}>{suffix}</span>}
      {statuses.includes('in_progress') && <Badge color="#1976d2">in_progress</Badge>}
      {statuses.includes('completed')   && <Badge color="#2e7d32">completed</Badge>}
      {statuses.includes('archived')    && <Badge color="#888">archived</Badge>}
      {winner && <Badge color="#5c2d91">✓ winner</Badge>}
    </div>
  );
}

function Badge({ color, children }: { color: string; children: any }) {
  return <span style={{ background: color, color: 'white', padding: '.1rem .5rem', borderRadius: 3, fontSize: '.7rem' }}>{children}</span>;
}

function SingleWizardTable({ rows }: { rows: Row[] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.85rem', tableLayout: 'auto' }}>
      <thead>
        <tr style={{ background: '#fafafa', textAlign: 'left' }}>
          <th style={{ padding: '.4rem .75rem', width: 40 }}>#</th>
          <th style={{ padding: '.4rem .75rem' }}>Slug</th>
          <th style={{ padding: '.4rem .75rem' }}>Real domain</th>
          <th style={{ padding: '.4rem .75rem' }}>Live</th>
          <th style={{ padding: '.4rem .75rem' }}>Step</th>
          <th style={{ padding: '.4rem .75rem' }}>Status</th>
          <th style={{ padding: '.4rem .75rem' }}>Created</th>
          <th style={{ padding: '.4rem .75rem' }}></th>
        </tr>
      </thead>
      <tbody>
        {rows.map(w => <WizardRow key={w.id} row={w} />)}
      </tbody>
    </table>
  );
}

function WizardRow({ row: r }: { row: Row }) {
  const def = STEPS.find(s => s.number === r.current_step);
  return (
    <tr style={{ borderBottom: '1px solid #f0f0f0', verticalAlign: 'top' }}>
      <td style={{ padding: '.5rem .75rem', color: '#888' }}>{r.id}</td>
      <td style={{ padding: '.5rem .75rem', minWidth: 250, maxWidth: 320 }}>
        <div style={{ display: 'flex', gap: '.5rem', alignItems: 'flex-start' }}>
          <a href={(r.staging_url_override ?? `https://${r.staging_url_override ? new URL(r.staging_url_override).host : r.staging_slug + '.aemstaging.co.uk'}/`)} target="_blank" rel="noreferrer" style={{ flexShrink: 0 }}>
            <img
              src={`https://s.wordpress.com/mshots/v1/${encodeURIComponent(r.staging_url_override ?? ('https://' + r.staging_slug + '.aemstaging.co.uk/'))}?w=1280&h=720`}
              alt={`${r.staging_slug} preview`}
              width={140} height={79} loading="lazy"
              style={{ borderRadius: 3, border: '1px solid #ddd', background: '#f8f8f8', display: 'block', objectFit: 'cover', objectPosition: 'top' }}
            />
          </a>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '.15rem', minWidth: 0, overflow: 'hidden' }}>
            <a href={(r.staging_url_override ?? `https://${r.staging_url_override ? new URL(r.staging_url_override).host : r.staging_slug + '.aemstaging.co.uk'}/`)} target="_blank" rel="noreferrer" style={{ fontSize: '.8rem' }}>{r.staging_url_override ? new URL(r.staging_url_override).host : r.staging_slug + '.aemstaging.co.uk'}</a>
            {r.is_winner_draft && <span style={{ fontSize: '.7rem', color: '#2e7d32' }}>✓ winner draft</span>}
          </div>
        </div>
      </td>
      <td style={{ padding: '.5rem .75rem' }}>{r.real_domain === 'TBD' ? <span style={{ color: '#bbb' }}>TBD</span> : r.real_domain}</td>
      <td style={{ padding: '.5rem .75rem', color: '#666' }}>{r.target_live_server}</td>
      <td style={{ padding: '.5rem .75rem' }}>
        <span style={{ fontWeight: 500 }}>{r.current_step}</span> <span style={{ color: '#888', fontSize: '.7rem' }}>{def?.name ?? ''}</span>
      </td>
      <td style={{ padding: '.5rem .75rem' }}><Badge color={({in_progress:'#1976d2', completed:'#2e7d32', archived:'#888', failed:'#c62828'} as any)[r.status] ?? '#888'}>{r.status}</Badge></td>
      <td style={{ padding: '.5rem .75rem', color: '#888', fontSize: '.75rem' }}>{r.created_at ? new Date(r.created_at).toLocaleDateString() : ''}</td>
      <td style={{ padding: '.5rem .75rem' }}>
        <div style={{ display: 'flex', gap: '.4rem', flexWrap: 'wrap', alignItems: 'center', minWidth: 160 }}>
          {(() => {
            let label = 'Open →';
            let bg = '#1976d2';
            if (r.status === 'in_progress') {
              if (r.current_step <= 3)      { label = 'Continue wizard →'; bg = '#1976d2'; }
              else if (r.current_step < 13) { label = 'Time to go live? →'; bg = '#ed6c02'; }
            }
            return (
              <a href={`/onboarding/${r.id}`}
                 style={{ padding: '.3rem .6rem', background: bg, color: 'white', textDecoration: 'none', borderRadius: 3, fontSize: '.75rem', whiteSpace: 'nowrap' }}>
                {label}
              </a>
            );
          })()}
          <WpAdminButton wizardId={r.id} />
        </div>
      </td>
    </tr>
  );
}
