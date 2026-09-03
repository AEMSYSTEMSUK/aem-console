export type AlertSource = 'wordfence' | 'imunify360' | 'plesk-backup' | 'plesk-cert' | 'fail2ban' | 'plesk-admin' | 'other';
export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface ClassifiedAlert {
  source: AlertSource;
  severity: AlertSeverity;
  site_domain?: string | null;
}

export function classifyAlert(from: string, subject: string, body: string): ClassifiedAlert {
  const f = (from || '').toLowerCase();
  const s = (subject || '').toLowerCase();
  const b = (body || '').toLowerCase();

  // Wordfence
  if (f.includes('wordfence') || s.includes('wordfence') || b.includes('wordfence')) {
    let severity: AlertSeverity = 'low';
    if (s.includes('critical') || s.includes('infected') || s.includes('hacked')) severity = 'critical';
    else if (s.includes('alert') || s.includes('warning')) severity = 'high';
    else if (s.includes('blocked')) severity = 'medium';
    else if (s.includes('scan complete') || s.includes('weekly')) severity = 'low';
    return { source: 'wordfence', severity, site_domain: extractDomain(subject + ' ' + body) };
  }

  // Imunify360
  if (f.includes('imunify') || s.includes('imunify')) {
    let severity: AlertSeverity = 'medium';
    if (s.includes('malware') || s.includes('infected') || s.includes('blocked attack')) severity = 'high';
    if (s.includes('critical')) severity = 'critical';
    if (s.includes('summary') || s.includes('digest')) severity = 'low';
    return { source: 'imunify360', severity, site_domain: extractDomain(subject + ' ' + body) };
  }

  // Plesk backup
  if (s.includes('backup') && (f.includes('plesk') || f.includes('root@'))) {
    const severity: AlertSeverity = s.includes('fail') || s.includes('error') ? 'critical' : 'low';
    return { source: 'plesk-backup', severity };
  }

  // Plesk cert
  if (s.includes("let's encrypt") || s.includes('certificate') || s.includes('renewal')) {
    const severity: AlertSeverity = s.includes('fail') ? 'high' : 'low';
    return { source: 'plesk-cert', severity };
  }

  // fail2ban
  if (s.includes('fail2ban') || s.includes('banned')) {
    return { source: 'fail2ban', severity: 'medium' };
  }

  // Plesk admin
  if (f.includes('plesk') || (f.includes('root@') && f.includes('infra.aemsystems'))) {
    return { source: 'plesk-admin', severity: 'low' };
  }

  return { source: 'other', severity: 'info' };
}

function extractDomain(text: string): string | null {
  const m = text.match(/\b([a-z0-9-]+\.)+[a-z]{2,}\b/i);
  if (!m) return null;
  const d = m[0].toLowerCase();
  if (d.endsWith('.aemtech.co.uk') || d.endsWith('.aemsystems.co.uk') || d.endsWith('.infra.aemsystems.co.uk')) return null;
  return d;
}
