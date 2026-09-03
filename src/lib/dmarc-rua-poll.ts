import { ImapFlow } from 'imapflow';
import { gunzipSync } from 'zlib';
import AdmZip from 'adm-zip';
import { decrypt } from '@/lib/crypto';
import { db } from '@/lib/db';
import { parseAggregateReport, storeAggregateReport } from '@/lib/dmarc-rua';

const PROCESSED_FOLDER = 'Processed';
const RETENTION_DAYS = 365;

export interface DmarcPollResult { ok: boolean; messages: number; reports: number; new_reports: number; records: number; moved: number; pruned: number; error?: string; }
interface BodyNode { part?: string; disposition?: string; dispositionParameters?: Record<string, string>; parameters?: Record<string, string>; childNodes?: BodyNode[]; }

function attachmentsOf(node: BodyNode | undefined, acc: { part: string; filename: string }[]): void {
  if (!node) return;
  const fn = node.dispositionParameters?.filename || node.parameters?.name;
  const disp = (node.disposition || '').toLowerCase();
  if (fn && (disp === 'attachment' || /\.(gz|zip|xml)$/i.test(fn))) acc.push({ part: node.part || '1', filename: fn });
  (node.childNodes || []).forEach((c) => attachmentsOf(c, acc));
}
function xmlsFromAttachment(filename: string, buf: Buffer): string[] {
  const fn = filename.toLowerCase();
  try {
    if (fn.endsWith('.gz')) return [gunzipSync(buf).toString('utf8')];
    if (fn.endsWith('.zip')) return new AdmZip(buf).getEntries().filter((e) => !e.isDirectory && e.entryName.toLowerCase().endsWith('.xml')).map((e) => e.getData().toString('utf8'));
    if (fn.endsWith('.xml')) return [buf.toString('utf8')];
  } catch { /* ignore */ }
  return [];
}
export async function pollDmarcRua(): Promise<DmarcPollResult> {
  const r = await db.query<{ encrypted_token: string }>(`SELECT encrypted_token FROM integration_tokens WHERE type = 'imap-dmarc' ORDER BY id DESC LIMIT 1`);
  if (r.rows.length === 0) return { ok: false, messages: 0, reports: 0, new_reports: 0, records: 0, moved: 0, pruned: 0, error: 'no imap-dmarc credentials configured' };
  let creds: { host: string; port: number; user: string; password: string; secure?: boolean };
  try { creds = JSON.parse(decrypt(r.rows[0].encrypted_token)); } catch { return { ok: false, messages: 0, reports: 0, new_reports: 0, records: 0, moved: 0, pruned: 0, error: 'failed to decrypt imap-dmarc credentials' }; }
  const client = new ImapFlow({ host: creds.host, port: creds.port, secure: creds.secure !== false, auth: { user: creds.user, pass: creds.password }, logger: false, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 60000 });
  let messages = 0, reports = 0, newReports = 0, records = 0, moved = 0, pruned = 0;
  try {
    await client.connect();
    try { await client.mailboxCreate(PROCESSED_FOLDER); } catch { /* exists */ }
    const lock = await client.getMailboxLock('INBOX');
    try {
      const mbox = client.mailbox;
      const exists = mbox && typeof mbox !== 'boolean' ? mbox.exists : 0;
      if (exists > 0) {
        const allUids: number[] = [];
        const gathered: { uid: number; atts: { part: string; filename: string }[] }[] = [];
        for await (const msg of client.fetch('1:*', { uid: true, bodyStructure: true })) {
          messages++; allUids.push(msg.uid);
          const atts: { part: string; filename: string }[] = [];
          attachmentsOf(msg.bodyStructure as unknown as BodyNode, atts);
          if (atts.length) gathered.push({ uid: msg.uid, atts });
        }
        for (const g of gathered) {
          for (const a of g.atts) {
            const dl = await client.download(String(g.uid), a.part, { uid: true });
            if (!dl || !dl.content) continue;
            const chunks: Buffer[] = [];
            for await (const c of dl.content) chunks.push(c as Buffer);
            for (const xml of xmlsFromAttachment(a.filename, Buffer.concat(chunks))) {
              try { const rep = parseAggregateReport(xml); if (!rep.report_id) continue; reports++; const res = await storeAggregateReport(rep); if (res.inserted) { newReports++; records += res.recordCount; } } catch { /* skip */ }
            }
          }
        }
        if (allUids.length) { await client.messageMove(allUids, PROCESSED_FOLDER, { uid: true }); moved = allUids.length; }
      }
    } finally { lock.release(); }
    try {
      const lock2 = await client.getMailboxLock(PROCESSED_FOLDER);
      try {
        const pmbox = client.mailbox;
        const pexists = pmbox && typeof pmbox !== 'boolean' ? pmbox.exists : 0;
        if (pexists > 0) {
          const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
          const oldUids = await client.search({ before: cutoff }, { uid: true });
          if (oldUids && oldUids.length) { await client.messageDelete(oldUids, { uid: true }); pruned = oldUids.length; }
        }
      } finally { lock2.release(); }
    } catch { /* prune best-effort */ }
    await client.logout();
    return { ok: true, messages, reports, new_reports: newReports, records, moved, pruned };
  } catch (e) { try { await client.logout(); } catch { /* ignore */ } return { ok: false, messages, reports, new_reports: newReports, records, moved, pruned, error: (e as Error)?.message ?? String(e) }; }
}
