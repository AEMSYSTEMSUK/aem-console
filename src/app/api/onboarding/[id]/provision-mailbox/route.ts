import { NextRequest, NextResponse } from 'next/server';
import { getWizard } from '@/lib/onboarding';
import { requireUser, HttpError } from '@/lib/rbac';
import { promisify } from 'util';
import { execFile } from 'child_process';
import { randomBytes } from 'crypto';

const execFileP = promisify(execFile);
const MAIL_HOST = 'mail.infra.aemsystems.co.uk';
const SSH_KEY = '/etc/aem-console/keys/aem_fleet_id_ed25519';

function ssh(cmd: string, timeoutMs = 60_000) {
  return execFileP('ssh', [
    '-i', SSH_KEY,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=10',
    'root@' + MAIL_HOST, cmd,
  ], { timeout: timeoutMs });
}

function genPassword(len = 20) {
  return randomBytes(Math.ceil(len * 0.75)).toString('base64')
    .replace(/[+\/=]/g, '').slice(0, len) + 'aA1!';
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    const { id } = await ctx.params;
    const wid = parseInt(id, 10);
    if (!Number.isFinite(wid)) throw new HttpError(400, 'Invalid wizard ID');
    const data = await getWizard(wid);
    if (!data) throw new HttpError(404, 'Wizard not found');
    const { wizard } = data;
    const body = await req.json().catch(() => ({}));
    const mailName = (body.mail_name || 'noreply').trim();
    const domain = wizard.real_domain;
    const addr = mailName + '@' + domain;

    // Check whether domain is a Plesk subscription on mail.infra
    const domCheck = await ssh('plesk bin domain --info ' + JSON.stringify(domain) + ' 2>&1 || echo NOT_FOUND', 30);
    const domExists = !/NOT_FOUND/.test(domCheck.stdout);
    if (!domExists) {
      return NextResponse.json({
        error: 'Domain ' + domain + ' is not a Plesk subscription on ' + MAIL_HOST +
          '. Create the subscription first (or change to a domain that is) before provisioning a mailbox.'
      }, { status: 409 });
    }

    // Ensure mail service is on
    await ssh('plesk bin mail --on ' + JSON.stringify(domain), 30).catch(() => {});

    // Generate password + create mailbox
    const password = genPassword(20);
    const create = await ssh(
      'plesk bin mail --create ' + JSON.stringify(addr) +
      ' -passwd ' + JSON.stringify(password) +
      ' -mailbox true 2>&1',
      60
    );
    const stdoutTail = (create.stdout || '').slice(-300);
    if (/already exists|Error:/i.test(stdoutTail)) {
      return NextResponse.json({
        ok: false,
        error: 'Mailbox ' + addr + ' could not be created. plesk output:\n' + stdoutTail,
      });
    }
    return NextResponse.json({
      ok: true,
      address: addr,
      password,
      message: 'Mailbox provisioned. SAVE THE PASSWORD — it will not be shown again. SMTP: ' + MAIL_HOST + ':587 (STARTTLS), user=' + addr,
    });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error)?.message ?? 'Internal error' }, { status: 500 });
  }
}
