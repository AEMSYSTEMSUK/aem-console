import { ImapFlow } from 'imapflow';
import { db } from '@/lib/db';
import { decrypt } from '@/lib/crypto';
import { classifyAlert } from '@/lib/classifier';

export interface PollResult {
  ok: boolean;
  fetched: number;
  new_alerts: number;
  error?: string;
}

export async function pollAlertSink(): Promise<PollResult> {
  // Load IMAP credentials from integration_tokens
  const r = await db.query<{ encrypted_token: string }>(
    `SELECT encrypted_token FROM integration_tokens WHERE type = 'imap-alerts' ORDER BY id DESC LIMIT 1`
  );
  if (r.rows.length === 0) return { ok: false, fetched: 0, new_alerts: 0, error: 'no IMAP credentials configured' };

  let creds: { host: string; port: number; user: string; password: string; secure?: boolean };
  try {
    creds = JSON.parse(decrypt(r.rows[0].encrypted_token));
  } catch (e) {
    return { ok: false, fetched: 0, new_alerts: 0, error: 'failed to decrypt IMAP credentials' };
  }

  const client = new ImapFlow({
    host: creds.host,
    port: creds.port,
    secure: creds.secure !== false,
    auth: { user: creds.user, pass: creds.password },
    logger: false,
  });

  let fetched = 0;
  let newAlerts = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Fetch last 14 days; rely on imap_uid + to_address dedup
      const sinceDate = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
      for await (const msg of client.fetch({ since: sinceDate }, { envelope: true, source: true, uid: true })) {
        fetched++;
        const env = msg.envelope;
        const subject = env?.subject ?? '';
        const fromAddr = env?.from?.[0]?.address ?? '';
        const toAddr = env?.to?.[0]?.address ?? creds.user;
        const receivedAt = env?.date ?? new Date();
        const body = (msg.source?.toString('utf8') ?? '').slice(0, 10000);
        const headers = {
          messageId: env?.messageId,
          subject,
          from: fromAddr,
          to: toAddr,
          date: receivedAt,
        };
        const classified = classifyAlert(fromAddr, subject, body);

        const result = await db.query<{ id: number }>(`
          INSERT INTO alerts (source, severity, subject, from_address, to_address, site_domain, raw_headers, raw_body, parsed, received_at, imap_uid)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          ON CONFLICT (imap_uid, to_address) DO NOTHING
          RETURNING id
        `, [
          classified.source,
          classified.severity,
          subject.slice(0, 500),
          fromAddr.slice(0, 255),
          toAddr.slice(0, 255),
          classified.site_domain ?? null,
          JSON.stringify(headers),
          body,
          JSON.stringify(classified),
          receivedAt,
          msg.uid,
        ]);
        if (result.rows.length > 0) newAlerts++;
      }
    } finally {
      lock.release();
    }
    await client.logout();
    return { ok: true, fetched, new_alerts: newAlerts };
  } catch (e) {
    try { await client.logout(); } catch { /* ignore */ }
    return { ok: false, fetched, new_alerts: newAlerts, error: e instanceof Error ? e.message : String(e) };
  }
}
