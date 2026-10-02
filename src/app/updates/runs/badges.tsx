export function KindBadge({ k }: { k: string }) {
  const colors: Record<string, string> = { staging: '#1976d2', live: '#2e7d32', fasttrack: '#c62828' };
  return <span style={{ background: colors[k] ?? '#888', color: 'white', padding: '.1rem .45rem', borderRadius: 3, fontSize: '.8rem' }}>{k}</span>;
}

export function RunStatusBadge({ s }: { s: string }) {
  const colors: Record<string, string> = { running: '#1976d2', done: '#2e7d32', failed: '#c62828' };
  return <span style={{ background: colors[s] ?? '#888', color: 'white', padding: '.1rem .45rem', borderRadius: 3, fontSize: '.8rem' }}>{s}</span>;
}

export function StateBadge({ s }: { s: string }) {
  const colors: Record<string, string> = {
    pending: '#888', skipped: '#9e9e9e', cloning: '#1976d2', sanitising: '#1976d2', patching: '#1976d2', smoke: '#1976d2',
    staged_ok: '#2e7d32', staged_failed: '#c62828', awaiting_approval: '#ed6c02', approved: '#2e7d32',
    live_backup: '#6a1b9a', live_patching: '#6a1b9a', live_smoke: '#6a1b9a', done: '#1b5e20', rolled_back: '#ed6c02',
    failed: '#c62828',
  };
  return <span style={{ background: colors[s] ?? '#888', color: 'white', padding: '.1rem .45rem', borderRadius: 3, fontSize: '.8rem', whiteSpace: 'nowrap' }}>{s.replace(/_/g, ' ')}</span>;
}
