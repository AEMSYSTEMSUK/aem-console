import { db } from '@/lib/db';
import { sshExec } from '@/lib/ssh';
import { spawn } from 'child_process';
import { promises as dns } from 'dns';
import { findZoneForDomain, upsertARecord, getCloudflareToken } from '@/lib/cloudflare';

export interface WizardInput {
  customer_name: string;
  customer_contact_email: string;
  staging_slug: string;
  real_domain: string;
  overwrite_existing?: boolean;
  wizard_group_id?: number | null;
  parent_company?: string | null;
  target_live_server?: string | null;
  dns_provider?: string | null;
  refresh_mode?: boolean;
  staging_source?: 'fresh' | 'clone_from_live';
  staging_server?: string | null;
  staging_url_override?: string | null;
}

export interface StepDef {
  number: number;
  name: string;
  role_required: 'admin' | 'web';
}

export const STEPS: StepDef[] = [
  { number: 1,  name: 'Validate inputs', role_required: 'web' },
  { number: 2,  name: 'Create <slug>.aemstaging.co.uk + install WP', role_required: 'web' },
  { number: 3,  name: 'Mark site as ready — notify IT (support@aemsystems.co.uk)', role_required: 'web' },
  { number: 4,  name: 'Admin: create customer subscription on staging1', role_required: 'admin' },
  { number: 5,  name: 'WP Toolkit clone staging slug -> real domain (staging1)', role_required: 'admin' },
  { number: 6,  name: 'Transfer staging1 -> live1 (backup/scp/install/restore)', role_required: 'admin' },
  { number: 7,  name: 'Cloudflare DNS A record (real domain -> live1 IP)', role_required: 'admin' },
  { number: 8,  name: 'Plesk DNS template sync (live1)', role_required: 'admin' },
  { number: 9,  name: "Let's Encrypt SSL (live1)", role_required: 'admin' },
  { number: 10, name: 'WP search-replace residual URLs', role_required: 'admin' },
  { number: 11, name: 'Customer mailbox creation', role_required: 'admin' },
  { number: 12, name: 'Verify + schedule 7-day staging drop', role_required: 'admin' },
];

export interface WizardRow {
  id: number;
  customer_name: string;
  customer_contact_email: string;
  staging_slug: string;
  real_domain: string;
  target_live_server: string;
  refresh_mode?: boolean;
  staging_source?: string;
  staging_server?: string;
  staging_url_override?: string | null;
  dns_provider?: string;
  current_step: number;
  status: string;
  created_by_user_id: number;
  created_at: string;
  completed_at: string | null;
  staging_drop_at: string | null;
  staging_dropped_at: string | null;
  notes: string | null;
  overwrite_existing: boolean;
  wizard_group_id: number | null;
  is_winner_draft: boolean;
}

export interface StepRow {
  id: number;
  wizard_id: number;
  step_number: number;
  step_name: string;
  role_required: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  output: string | null;
  error: string | null;
  progress_pct: number | null;
}

interface WpToolkitInstance {
  id: number;
  mainDomainId?: number;
  path?: string;
  siteUrl?: string;
  fullPath?: string;
  name?: string;
}

export const STAGING1 = 'staging1.infra.aemsystems.co.uk';

// Resolve the SSH host for this wizard's staging server.

// Step progress: write phase status to /tmp for run-step button polling.
import { writeFileSync as __writeStepStatus_w, unlinkSync as __writeStepStatus_u } from 'fs';
function writeStepStatus(wid: number, step: number, phase: string, pct: number, message: string) {
  try { __writeStepStatus_w('/tmp/aem-step-status-' + wid + '-' + step + '.json', JSON.stringify({ phase, pct, message, ts: Date.now() })); } catch { /* ignore */ }
}
function clearStepStatus(wid: number, step: number) {
  try { __writeStepStatus_u('/tmp/aem-step-status-' + wid + '-' + step + '.json'); } catch { /* ignore */ }
}

function serverHost(name: string): string {
  const n = (name || '').trim();
  if (!n) return 'staging1.infra.aemsystems.co.uk';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(n)) return n;
  if (n.includes('.')) return n;
  return n + '.infra.aemsystems.co.uk';
}
function stagingHost(w: WizardRow): string {
  return serverHost(w.staging_server || 'staging1');
}
async function ensureStagingDns(w: WizardRow): Promise<string> {
  if ((w.staging_server || 'staging1') === 'staging1') return 'DNS: staging1 wildcard (*.aemstaging.co.uk) - no record needed';
  if ((w.dns_provider || 'cloudflare') !== 'cloudflare') return 'DNS: provider not cloudflare - add staging record manually';
  const fqdn = stagingFqdn(w);
  try {
    const ip = await resolveServerIp(stagingHost(w));
    const token = await getCloudflareToken();
    if (!token) return 'DNS: no Cloudflare token - add A ' + fqdn + ' -> ' + ip + ' manually';
    const zone = await findZoneForDomain(fqdn, token);
    if (!zone) return 'DNS: no Cloudflare zone for ' + fqdn + ' - add A ' + fqdn + ' -> ' + ip + ' manually';
    const r = await upsertARecord(zone.id, fqdn, ip, token, false);
    return 'DNS: ' + r.action + ' A ' + fqdn + ' -> ' + ip + ' (unproxied)';
  } catch (e) {
    return 'DNS: auto-add failed for ' + fqdn + ' (' + (e as Error).message + ') - add manually';
  }
}

// Resolve the staging URL pattern. For staging1 the wildcard <slug>.aemstaging.co.uk applies.
// For other servers, the designer should set staging_url_override (customer-managed DNS).
function stagingFqdn(w: WizardRow): string {
  if ((w.staging_server || 'staging1') === 'staging1') {
    return w.staging_slug + '.aemstaging.co.uk';
  }
  // Non-staging1: use the per-customer override (full URL) -> host. Customer manages DNS.
  if (w.staging_url_override) {
    try { return new URL(w.staging_url_override).host; } catch { /* fall through */ }
  }
  return w.staging_slug + '.aemstaging.co.uk';
}

export const LIVE1 = 'live1.infra.aemsystems.co.uk';
export const MAIL_INFRA = 'mail.infra.aemsystems.co.uk';
export const MAIL_INFRA_IP = '217.174.245.2';
const STAGING1_IP = '88.208.243.243';

// staging1 -> <slug> under aemstaging.co.uk; other servers -> subdomain of the
// customer's own domain (parent must already be a Plesk subscription on that box).
function stagingSubdomain(w: WizardRow): { name: string; parent: string } {
  if ((w.staging_server || 'staging1') === 'staging1') {
    return { name: w.staging_slug, parent: 'aemstaging.co.uk' };
  }
  const host = stagingFqdn(w);
  const parent = w.real_domain;
  const name = host.endsWith('.' + parent)
    ? host.slice(0, host.length - parent.length - 1)
    : host.split('.')[0];
  return { name, parent };
}
const LIVE1_IP = '217.154.61.216';
const FLEET_KEY = '/etc/aem-console/keys/aem_fleet_id_ed25519';
const KNOWN_HOSTS = '/etc/aem-console/keys/known_hosts';

function genPassword(len = 20): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let pw = '';
  for (let i = 0; i < len; i++) pw += chars[Math.floor(Math.random() * chars.length)];
  return pw;
}

function genLogin(slug: string, suffix: string): string {
  const safe = slug.replace(/[^a-z0-9]/g, '').slice(0, 20);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${safe}_${suffix}_${rand}`;
}

export function shellQ(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

async function sendMail(opts: { to: string; from: string; subject: string; body: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('mail', ['-r', opts.from, '-s', opts.subject, opts.to]);
    child.stdin.write(opts.body);
    child.stdin.end();
    let err = '';
    child.stderr.on('data', d => err += d.toString());
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`mail exit ${code}: ${err}`));
    });
    child.on('error', reject);
  });
}

async function resolveServerIp(host: string): Promise<string> {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
  const ips = await dns.resolve4(host);
  if (!ips.length) throw new Error(`Could not resolve IPv4 for ${host}`);
  return ips[0];
}

async function streamFile(srcHost: string, srcPath: string, dstHost: string, dstPath: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const sshFrom = spawn('ssh', [
      '-i', FLEET_KEY, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `UserKnownHostsFile=${KNOWN_HOSTS}`, `root@${srcHost}`, `cat ${srcPath}`,
    ]);
    const sshTo = spawn('ssh', [
      '-i', FLEET_KEY, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `UserKnownHostsFile=${KNOWN_HOSTS}`, `root@${dstHost}`, `cat > ${dstPath}`,
    ]);
    sshFrom.stdout.pipe(sshTo.stdin);
    let errFrom = '', errTo = '';
    sshFrom.stderr.on('data', d => errFrom += d.toString());
    sshTo.stderr.on('data', d => errTo += d.toString());
    let exited = 0;
    let codeFrom = -1, codeTo = -1;
    const check = () => {
      if (++exited === 2) {
        if (codeFrom === 0 && codeTo === 0) resolve({ ok: true });
        else resolve({ ok: false, error: `from(${codeFrom}): ${errFrom.slice(0, 800)}\nto(${codeTo}): ${errTo.slice(0, 800)}` });
      }
    };
    sshFrom.on('exit', (c) => { codeFrom = c ?? -1; check(); });
    sshTo.on('exit', (c) => { codeTo = c ?? -1; check(); });
    setTimeout(() => { try { sshFrom.kill('SIGKILL'); sshTo.kill('SIGKILL'); } catch {} }, 600000);
  });
}

export async function lookupWpInstanceId(host: string, fqdn: string): Promise<{ id: number | null; error?: string }> {
  const r = await sshExec(host, `plesk ext wp-toolkit --list -format json 2>&1`, 30);
  if (!r.ok) return { id: null, error: `--list failed: ${r.stdout || r.stderr || r.error || 'unknown'}` };
  try {
    const instances = JSON.parse(r.stdout) as WpToolkitInstance[];
    const target = instances.find(i =>
      i.siteUrl === `https://${fqdn}` || i.siteUrl?.startsWith(`https://${fqdn}/`)
    );
    if (!target) return { id: null, error: `No instance found with siteUrl=https://${fqdn} in ${instances.length} instances` };
    return { id: target.id };
  } catch (e) {
    return { id: null, error: `JSON parse error: ${(e as Error).message}\nRaw (500c): ${r.stdout.slice(0, 500)}` };
  }
}

async function lookupDomainId(host: string, domain: string): Promise<{ id: number | null; error?: string }> {
  const r = await sshExec(host, `plesk bin domain --info ${shellQ(domain)} 2>&1`, 30);
  if (!r.ok) return { id: null, error: `domain info failed: ${r.stdout || r.stderr || r.error}` };
  const m = r.stdout.match(/Domain ID:\s+(\d+)/);
  if (!m) return { id: null, error: `Could not find 'Domain ID:' in plesk bin domain output. First 400c: ${r.stdout.slice(0, 400)}` };
  return { id: parseInt(m[1], 10) };
}

export async function createWizard(input: WizardInput, createdByUserId: number): Promise<number> {
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(input.staging_slug)) {
    throw new Error('Invalid slug: lowercase letters/digits/hyphens, 3-64 chars, start/end alnum');
  }
  if (!/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/i.test(input.real_domain)) {
    throw new Error('Invalid real domain');
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.customer_contact_email)) {
    throw new Error('Invalid contact email');
  }
  if (!input.customer_name.trim()) throw new Error('Customer name required');

  const r = await db.query<{ id: number }>(`
    INSERT INTO onboarding_wizards
      (customer_name, customer_contact_email, staging_slug, real_domain, target_live_server, current_step, status, created_by_user_id, overwrite_existing, wizard_group_id, parent_company, dns_provider, refresh_mode, staging_source, staging_server, staging_url_override)
    VALUES ($1, $2, $3, $4, $9, 1, 'in_progress', $5, $6, $7, $8, $10, $11, $12, $13, $14) RETURNING id
  `, [input.customer_name.trim(), input.customer_contact_email.toLowerCase(),
      input.staging_slug.toLowerCase(), input.real_domain.toLowerCase(), createdByUserId, !!input.overwrite_existing, input.wizard_group_id ?? null,
      input.parent_company?.trim() || null, (input.target_live_server || 'live1').trim(), (input.dns_provider || 'cloudflare').trim(), !!input.refresh_mode, (input.staging_source === 'clone_from_live' ? 'clone_from_live' : 'fresh'), (input.staging_server || 'staging1').trim(), (input.staging_url_override?.trim() || null)]);
  const wizardId = r.rows[0].id;
  for (const s of STEPS) {
    await db.query(
      `INSERT INTO onboarding_steps (wizard_id, step_number, step_name, role_required) VALUES ($1, $2, $3, $4)`,
      [wizardId, s.number, s.name, s.role_required]);
  }
  return wizardId;
}

export async function getWizard(id: number): Promise<{ wizard: WizardRow; steps: StepRow[] } | null> {
  const w = await db.query<WizardRow>('SELECT * FROM onboarding_wizards WHERE id = $1', [id]);
  if (w.rows.length === 0) return null;
  const s = await db.query<StepRow>('SELECT * FROM onboarding_steps WHERE wizard_id = $1 ORDER BY step_number', [id]);
  return { wizard: w.rows[0], steps: s.rows };
}

interface StepResult { status: 'success' | 'failed' | 'running'; output?: string; error?: string; }

export async function runStep(wizardId: number, stepNumber: number): Promise<StepResult> {
  const data = await getWizard(wizardId);
  if (!data) throw new Error('Wizard not found');
  const { wizard } = data;
  await db.query(
    `UPDATE onboarding_steps SET status='running', started_at=now(), error=NULL, output=NULL, progress_pct=NULL WHERE wizard_id=$1 AND step_number=$2`,
    [wizardId, stepNumber]);
  let result: StepResult;
  writeStepStatus(wizardId, stepNumber, 'start', 1, 'Starting step ' + stepNumber);
  try {
    switch (stepNumber) {
      case 1: result = {
        status: 'success',
        output: `Inputs OK.\n  slug='${wizard.staging_slug}' -> https://${stagingFqdn(wizard)}\n  real domain='${wizard.real_domain}'\n  customer email='${wizard.customer_contact_email}'`,
      }; break;
      case 2: result = wizard.staging_source === 'clone_from_live' ? await runStep2CloneFromLive(wizard) : await runStep2(wizard); break;
      case 3: result = await runStep3(wizard); break;
      case 4: result = await runStep4(wizard); break;
      case 5: result = await runStep5(wizard); break;
      case 6: result = wizard.refresh_mode ? await runStep6Refresh(wizard) : await runStep6(wizard); break;
      case 7: result = await runStep7(wizard); break;
      case 8: result = await runStep8(wizard); break;
      case 9: result = await runStep9(wizard); break;
      case 10: result = wizard.refresh_mode ? { status: 'success' as const, output: 'Skipped — refresh mode (site already live, this step would re-do work already done).' } : await runStep10(wizard); break;
      case 11: result = await runStep11(wizard); break;
      case 12: result = await runStep12(wizard); break;
      default: result = { status: 'failed', error: 'Not implemented. Phase 3 = Steps 8-12.' };
    }
  } catch (e: unknown) {
    result = { status: 'failed', error: (e as Error)?.message ?? String(e) };
  }
  // Clear progress status now the result is decided
  if (result.status !== 'running') clearStepStatus(wizardId, stepNumber);

  if (result.status === 'running') {
    await db.query(
      `UPDATE onboarding_steps SET status='running', output=$1, progress_pct=0 WHERE wizard_id=$2 AND step_number=$3`,
      [result.output ?? null, wizardId, stepNumber]);
  } else {
    await db.query(
      `UPDATE onboarding_steps SET status=$1, output=$2, error=$3, completed_at=now() WHERE wizard_id=$4 AND step_number=$5`,
      [result.status, result.output ?? null, result.error ?? null, wizardId, stepNumber]);
    if (result.status === 'success') {
      await db.query(`UPDATE onboarding_wizards SET current_step=$1 WHERE id=$2 AND current_step < $1`, [stepNumber + 1, wizardId]);
      if (stepNumber === 12) {
        await db.query(`UPDATE onboarding_wizards SET status='completed', completed_at=now(), staging_drop_at=now()+interval '7 days' WHERE id=$1`, [wizardId]);
      }
    }
  }
  return result;
}


// ===== Step 2 — CLONE FROM LIVE MODE =====
// Pull live install down to a fresh staging subdomain.
// Brings code + uploads + most DB content. Skips customer-state tables.
// Shared Let's Encrypt issuance that survives Plesk's forced HTTP->HTTPS redirect.
// Plesk's SEO-safe 301 has no acme-challenge exemption, so it redirects the HTTP-01 challenge and LE
// fails (leaving a stale ACME order Plesk keeps resuming). We add a permanent vhost.conf exemption +
// reconfigure (idempotent), then issue, clearing a stale order once on retry. Mirrors runStep9 (live1)
// so staging gets the same no-manual-step behaviour. [#96]
async function issueLetsEncrypt(host: string, domain: string): Promise<{ ok: boolean; usedCli: string; output: string }> {
  const vhostConf = `/var/www/vhosts/system/${domain}/conf/vhost.conf`;
  const acmeVhostB64 = Buffer.from('RewriteEngine on\nRewriteRule ^/?\\.well-known/acme-challenge/ - [L]\n').toString('base64');
  await sshExec(host,
    `F=${shellQ(vhostConf)}; if ! grep -q 'acme-challenge' "$F" 2>/dev/null; then echo ${shellQ(acmeVhostB64)} | base64 -d >> "$F" && plesk sbin httpdmng --reconfigure-domain ${shellQ(domain)}; fi`,
    120).catch(() => {});

  const newCli = await sshExec(host, `plesk ext letsencrypt --help 2>&1 | head -10`, 15);
  const useNew = newCli.ok && newCli.stdout.includes('Usage');
  const usedCli = useNew ? 'plesk ext letsencrypt --install' : 'plesk bin extension --exec letsencrypt cli.php';
  const issue = () => useNew
    ? sshExec(host,
        `plesk ext letsencrypt --install -domain ${shellQ(domain)} -email security@aemtech.co.uk -www-redirect true 2>&1 | tail -30`, 180)
    : sshExec(host,
        `bash -c 'set -o pipefail; plesk bin extension --exec letsencrypt cli.php --domain ${shellQ(domain)} --email security@aemtech.co.uk 2>&1 | tail -40'`, 180);

  let r = await issue();
  if (/is gone/i.test(r.stdout)) {
    await sshExec(host,
      `grep -rl ${shellQ(domain)} /usr/local/psa/var/modules/letsencrypt/orders/ 2>/dev/null | xargs -r rm -f`, 60);
    r = await issue();
  }
  const hardFail = r.stdout.includes('ERROR:') || r.stdout.includes('TypeError:') || /is gone/i.test(r.stdout) || !r.ok;
  return { ok: !hardFail, usedCli, output: (r.stdout || '') + (r.stderr || r.error || '') };
}

async function ensureStagingSsl(w: WizardRow): Promise<string> {
  if ((w.staging_server || 'staging1') === 'staging1') return 'SSL: staging1 wildcard cert (no action)';
  const fqdn = stagingFqdn(w);
  const r = await issueLetsEncrypt(stagingHost(w), fqdn);
  if (!r.ok) {
    return 'SSL: LE not auto-issued for ' + fqdn + ' — ' + (r.output || '').slice(-300).replace(/\s+/g, ' ').trim() +
      ' (retry the step, or in Plesk: SSL/TLS Certificates -> Install free Lets Encrypt).';
  }
  return 'SSL: LE certificate issued for ' + fqdn + ' (acme-challenge exemption ensured)';
}
async function cloneSameServer(w: WizardRow, liveInstId: number, fqdn: string, livePath: string): Promise<StepResult> {
  const host = stagingHost(w);
  const wid = w.id;
  await sshExec(host, 'grep -q memory_limit ' + shellQ(livePath + '/.user.ini') + ' 2>/dev/null || echo "memory_limit = 512M" >> ' + shellQ(livePath + '/.user.ini'), 20).catch(() => {});
  writeStepStatus(wid, 2, 'cloning', 40, 'Cloning live site (files + database) on the server');
  const clone = await sshExec(host,
    'plesk ext wp-toolkit --clone -source-instance-id ' + liveInstId + ' -target-domain-name ' + shellQ(fqdn) + ' -target-path / -force-overwrite yes 2>&1 | tail -40', 1800);
  const out = (clone.stdout || '') + (clone.stderr || '');
  const copyFailed = /Copying (files|database) failed|could not|does not exist/i.test(out);
  if (copyFailed || (!clone.ok && !/finished with error/i.test(out))) {
    return { status: 'failed', error: 'clone (same-server, WP Toolkit) failed:\n' + (out || clone.error) };
  }
  const stagingInst = await lookupWpInstanceId(host, fqdn);
  writeStepStatus(wid, 2, 'configure', 70, 'Configuring staging (memory, indexing)');
  let stagingPath = '';
  if (stagingInst.id !== null) {
    const info = await sshExec(host, 'plesk ext wp-toolkit --info -instance-id ' + stagingInst.id + ' -format json 2>&1', 30);
    try { stagingPath = JSON.parse(info.stdout).fullPath || ''; } catch { /* ignore */ }
    await sshExec(host, 'plesk ext wp-toolkit --wp-cli -instance-id ' + stagingInst.id + ' -- option update blog_public 0 --skip-plugins --skip-themes 2>&1 | tail -2', 60).catch(() => {});
  }
  if (stagingPath) {
    await sshExec(host, 'grep -q memory_limit ' + shellQ(stagingPath + '/.user.ini') + ' 2>/dev/null || echo "memory_limit = 512M" >> ' + shellQ(stagingPath + '/.user.ini'), 20).catch(() => {});
  }
  const dnsNote = await ensureStagingDns(w);
  writeStepStatus(wid, 2, 'ssl', 90, 'Issuing SSL certificate');
  const sslNote = await ensureStagingSsl(w);
  return {
    status: 'success',
    output: 'SAME-SERVER CLONE (WP Toolkit, no bastion transfer)\n' +
      'Source instance: ' + liveInstId + ' on ' + host + '\n' +
      'Staging URL: https://' + fqdn + '\n' +
      'PHP memory_limit raised to 512M on staging (.user.ini; applies within ~5 min)\n' +
      'Search engine indexing DISABLED (blog_public=0)\n\n' +
      dnsNote + '\n' + sslNote,
  };
}

async function runStep2CloneFromLive(w: WizardRow): Promise<StepResult> {
  const slug = w.staging_slug;
  const fqdn = stagingFqdn(w);
  const sub = stagingSubdomain(w);
  const targetHost = serverHost(w.target_live_server || 'live1');

  // 2c-pre. Same as fresh: check + create subdomain on staging1
  const sdExists = await sshExec(stagingHost(w),
    'plesk bin subdomain --info ' + shellQ(sub.name) + ' -domain ' + shellQ(sub.parent) + ' 2>&1 || true', 30);
  if (sdExists.ok && /Domain ID:\s+\d+/.test(sdExists.stdout)) {
    if (w.overwrite_existing) {
      const rm = await sshExec(stagingHost(w),
        'plesk bin subdomain --remove ' + shellQ(sub.name) + ' -domain ' + shellQ(sub.parent) + ' 2>&1', 60);
      if (!rm.ok) return { status: 'failed', error: 'Overwrite: removing existing subdomain failed:\n' + (rm.stdout || rm.stderr || rm.error) };
    } else {
      return { status: 'failed', error: 'Staging subdomain ' + fqdn + ' already exists.\nTick "Overwrite existing" to remove it first.\n\n' + sdExists.stdout.slice(0, 400) };
    }
  }
  const r1 = await sshExec(stagingHost(w),
    'plesk bin subdomain --create ' + shellQ(sub.name) + ' -domain ' + shellQ(sub.parent) + ' -www-root ' + shellQ(sub.name) + ' -php true 2>&1', 60);
  if (!r1.ok) return { status: 'failed', error: 'Subdomain create failed:\n' + (r1.stdout || r1.stderr || r1.error) };

  // 2c-a. Find live install on target host
  const liveInst = await lookupWpInstanceId(targetHost, w.real_domain);
  if (liveInst.id === null) {
    return { status: 'failed', error: 'clone-2a: no live install found at ' + w.real_domain + ' on ' + targetHost + '.\n' + liveInst.error + '\n\nClone-from-live needs the source site to exist. Use staging_source=fresh for a new build.' };
  }
  const liveInfo = await sshExec(targetHost,
    'plesk ext wp-toolkit --info -instance-id ' + liveInst.id + ' -format json 2>&1', 30);
  let livePath = '';
  let tablePrefix = 'wp_';
  try {
    const j = JSON.parse(liveInfo.stdout);
    livePath = j.fullPath || '';
    tablePrefix = j.tablePrefix || 'wp_';
  } catch { /* fall through */ }
  if (!livePath) return { status: 'failed', error: 'clone-2a: could not parse live install fullPath' };
  // Same-server: use WP Toolkit native clone (files + DB, no bastion transfer).
  if (targetHost === stagingHost(w)) {
    return await cloneSameServer(w, liveInst.id!, fqdn, livePath);
  }

  // 2c-b. Build the skip-tables list for wp-cli db export
  const SKIP_TABLES_BASE = [
    'actionscheduler_actions','actionscheduler_claims','actionscheduler_groups','actionscheduler_logs',
    'wc_orders','wc_orders_meta','wc_order_addresses','wc_order_operational_data',
    'wc_order_product_lookup','wc_order_stats','wc_order_coupon_lookup','wc_order_tax_lookup',
    'woocommerce_order_items','woocommerce_order_itemmeta',
    'e_submissions','e_submissions_actions_log','e_submissions_values','e_notes','e_notes_users_relations',
    'wpforms_logs','wpforms_payments','wpforms_payment_meta','wpforms_tasks_meta',
  ];
  const skipTables = SKIP_TABLES_BASE.map(t => tablePrefix + t).join(',');

  // 2c-c. On live target: tarball code + uploads (NOT wp-config), export filtered DB
  const remoteTmp = '/tmp/aem-clone-' + w.id + '-' + Date.now();
  const liveBuildCmd = [
    'set -e',
    'mkdir -p ' + remoteTmp,
    'cd ' + shellQ(livePath),
    // Tar code + uploads (excludes wp-config + caches + .htaccess + aem-* mu-plugins to start clean)
    'tar --warning=no-file-changed -czf ' + remoteTmp + '/files.tar.gz \\',
    '  --exclude=wp-content/cache \\',
    '  --exclude=wp-content/uploads/cache \\',
    '  --exclude=wp-config.php \\',
    '  --exclude=.htaccess \\',
    '  --exclude=wp-content/mu-plugins/aem-auto-login.php \\',
    '  --exclude=wp-content/mu-plugins/aem-mail-sender.php \\',
    '  wp-admin wp-includes wp-content index.php xmlrpc.php wp-activate.php wp-blog-header.php \\',
    '  wp-comments-post.php wp-cron.php wp-links-opml.php wp-load.php wp-login.php wp-mail.php \\',
    '  wp-settings.php wp-signup.php wp-trackback.php 2>&1 | tail -3 || true',
    // DB export with skip-tables (data dropped but schema retained for those tables)
    'plesk ext wp-toolkit --wp-cli -instance-id ' + liveInst.id + ' -- db export ' + remoteTmp + '/database.sql --exclude_tables=' + skipTables + ' 2>&1 | tail -3',
    'ls -lh ' + remoteTmp + '/',
  ].join('\n');
  const r2c = await sshExec(targetHost, liveBuildCmd, 10 * 60_000);
  if (!r2c.ok) return { status: 'failed', error: 'clone-2c: live tar/dump failed:\n' + (r2c.stdout || r2c.stderr || r2c.error) };
  writeStepStatus(w.id, 2, 'packaged', 45, 'Live site packaged (files + database)');

  // 2c-d. Move both files to staging. Same-server: already on the box - skip the transfer.
  const sameServer = targetHost === stagingHost(w);
  if (!sameServer) {
    writeStepStatus(w.id, 2, 'transfer', 55, 'Transferring site to staging server');
    const r2d_files = await transferFile(
      targetHost, remoteTmp + '/files.tar.gz',
      stagingHost(w), remoteTmp + '/files.tar.gz'
    );
    if (!r2d_files.ok) return { status: 'failed', error: 'clone-2d: scp files failed:\n' + r2d_files.error };
    const r2d_db = await transferFile(
      targetHost, remoteTmp + '/database.sql',
      stagingHost(w), remoteTmp + '/database.sql'
    );
    if (!r2d_db.ok) return { status: 'failed', error: 'clone-2d: scp db failed:\n' + r2d_db.error };
  }
  writeStepStatus(w.id, 2, 'install', 65, sameServer ? 'Same-server clone (no transfer) - installing staging WP' : 'Installing staging WP');

  // 2c-e. On staging1: install fresh WP (gives us wp-config + DB) then overlay
  const password = genPassword(20);
  const title = (w.customer_name + ' (clone-staging)').replace(/[^\w\s\-()]/g, '').slice(0, 50);
  const r2e_install = await sshExec(stagingHost(w),
    'plesk ext wp-toolkit --install -domain-name ' + fqdn + ' -title ' + shellQ(title) +
    ' -admin-username admin -admin-password ' + shellQ(password) +
    ' -admin-email security@aemtech.co.uk -locale en_GB 2>&1 | tail -10', 180);
  if (!r2e_install.ok) return { status: 'failed', error: 'clone-2e: fresh install failed:\n' + (r2e_install.stdout || r2e_install.stderr || r2e_install.error) };
  writeStepStatus(w.id, 2, 'overlay', 78, 'Overlaying live files onto staging');

  // 2c-f. Find the new staging instance
  const stagingInst = await lookupWpInstanceId(stagingHost(w), fqdn);
  if (stagingInst.id === null) return { status: 'failed', error: 'clone-2f: could not find newly-installed staging instance' };
  const stagingInfo = await sshExec(stagingHost(w),
    'plesk ext wp-toolkit --info -instance-id ' + stagingInst.id + ' -format json 2>&1', 30);
  let stagingPath = '';
  try {
    const j = JSON.parse(stagingInfo.stdout);
    stagingPath = j.fullPath || '';
  } catch { /* fall through */ }
  if (!stagingPath) return { status: 'failed', error: 'clone-2f: could not parse staging path' };

  // 2c-g. Extract over the fresh install (preserving wp-config from the fresh install)
  const owner = await sshExec(stagingHost(w), 'stat -c "%U:%G" ' + shellQ(stagingPath), 15);
  const ownerSpec = (owner.stdout || '').trim() || 'root:psaserv';
  const overlayCmd = [
    'set -e',
    'cd ' + shellQ(stagingPath),
    // Remove the fresh-install themes/plugins/code (keeping wp-config.php + .htaccess)
    'mkdir -p wp-content/mu-plugins',
    'find wp-content/mu-plugins -mindepth 1 -maxdepth 1 -exec rm -rf {} \\;',
    'rm -rf wp-admin wp-includes wp-content/themes wp-content/plugins',
    // Extract the live snapshot
    'tar -xzf ' + remoteTmp + '/files.tar.gz',
    'chown -R ' + ownerSpec + ' wp-admin wp-includes wp-content',
    'echo OK',
  ].join('\n');
  const r2g = await sshExec(stagingHost(w), overlayCmd, 5 * 60_000);
  if (!r2g.ok) return { status: 'failed', error: 'clone-2g: overlay failed:\n' + (r2g.stdout || r2g.stderr || r2g.error) };
  writeStepStatus(w.id, 2, 'database', 90, 'Importing database + search-replace');

  // 2c-h. Import live DB into staging (replaces the freshly-installed DB content)
  const r2h_import = await sshExec(stagingHost(w),
    'plesk ext wp-toolkit --wp-cli -instance-id ' + stagingInst.id + ' -- db import ' + remoteTmp + '/database.sql 2>&1 | tail -5', 5 * 60_000);
  if (!r2h_import.ok) return { status: 'failed', error: 'clone-2h: db import failed:\n' + (r2h_import.stdout || r2h_import.stderr || r2h_import.error) };

  // 2c-i. Re-set admin password (the imported DB has live's admin hash)
  await sshExec(stagingHost(w),
    'plesk ext wp-toolkit --wp-cli -instance-id ' + stagingInst.id + ' -- user update admin --user_pass=' + shellQ(password) + ' --skip-plugins --skip-themes 2>&1 | tail -3', 60).catch(() => {});

  // 2c-j. Search-replace URLs (live -> staging)
  const liveUrl = 'https://' + w.real_domain;
  const stagingUrl = 'https://' + fqdn;
  const r2j_sr = await sshExec(stagingHost(w),
    'plesk ext wp-toolkit --wp-cli -instance-id ' + stagingInst.id + ' -- search-replace ' + shellQ(liveUrl) + ' ' + shellQ(stagingUrl) + ' --skip-columns=guid --all-tables-with-prefix 2>&1 | tail -5', 180);

  // 2c-k. set siteurl + home + blog_public
  await sshExec(stagingHost(w),
    'plesk ext wp-toolkit --wp-cli -instance-id ' + stagingInst.id + ' -- option update siteurl ' + shellQ(stagingUrl) + ' 2>&1', 30).catch(() => {});
  await sshExec(stagingHost(w),
    'plesk ext wp-toolkit --wp-cli -instance-id ' + stagingInst.id + ' -- option update home ' + shellQ(stagingUrl) + ' 2>&1', 30).catch(() => {});
  const r2k = await sshExec(stagingHost(w),
    'plesk ext wp-toolkit --wp-cli -instance-id ' + stagingInst.id + ' -- option update blog_public 0 2>&1', 30);

  // 2c-l. Sync wp-toolkit cache
  await sshExec(stagingHost(w),
    'plesk ext wp-toolkit --update-site-url -instance-id ' + stagingInst.id + ' 2>&1', 30).catch(() => {});

  // 2c-m. Cleanup
  await sshExec(targetHost, 'rm -rf ' + remoteTmp, 15).catch(() => {});
  await sshExec(stagingHost(w), 'rm -rf ' + remoteTmp, 15).catch(() => {});

  return {
    status: 'success',
    output: 'CLONE FROM LIVE\n' +
      'Source:  ' + livePath + ' on ' + targetHost + '  (instance ' + liveInst.id + ')\n' +
      'Target:  ' + stagingPath + ' on staging1  (instance ' + stagingInst.id + ')\n' +
      'Staging URL: ' + stagingUrl + '\n' +
      'Admin user: admin / ' + password + '  (record this — same login as fresh installs)\n\n' +
      'Brought over:  themes, plugins, mu-plugins, wp-admin, wp-includes, uploads, DB (most content)\n' +
      'Excluded:      ' + (SKIP_TABLES_BASE.length) + ' customer-state tables (orders, form submissions, action scheduler logs)\n' +
      'Search-replace: ' + liveUrl + ' -> ' + stagingUrl + '\n' +
      'Search engine indexing DISABLED (blog_public=0)\n\n' + (await ensureStagingDns(w)),
  };
}

// ── M8 Part B: publish staging → live, preserving live orders + customers ──────
// Tables NEVER overwritten from staging (live's copy is kept authoritative):
const PUBLISH_PRESERVE_BASE = [
  'wc_orders','wc_orders_meta','wc_order_addresses','wc_order_operational_data',
  'wc_order_product_lookup','wc_order_stats','wc_order_coupon_lookup','wc_order_tax_lookup',
  'wc_customer_lookup',
  'woocommerce_order_items','woocommerce_order_itemmeta',
  'users','usermeta',
  'actionscheduler_actions','actionscheduler_claims','actionscheduler_groups','actionscheduler_logs',
  'wpforms_logs','wpforms_payments','wpforms_payment_meta','wpforms_tasks_meta',
  'e_submissions','e_submissions_actions_log','e_submissions_values','e_notes','e_notes_users_relations',
];
// Hard gate: destructive live import stays OFF until piloted (B1 ships dry-run only).
const PUBLISH_LIVE_ENABLED: boolean = false;

async function wpToolkitInfo(host: string, instId: number): Promise<{ path: string; prefix: string }> {
  const r = await sshExec(host, 'plesk ext wp-toolkit --info -instance-id ' + instId + ' -format json 2>&1', 30);
  let path = '';
  try { const j = JSON.parse(r.stdout); path = j.fullPath || ''; } catch { /* ignore */ }
  // wp-toolkit --info JSON carries no table prefix, and --wp-cli stdout is unreliable
  // over the service SSH context; read $table_prefix straight from wp-config.php as root.
  let prefix = '';
  if (path) {
    const pr = await sshExec(host, "grep -E '[$]table_prefix' " + shellQ(path + '/wp-config.php') + " | head -1 | sed -E \"s/.*=[[:space:]]*'([^']*)'.*/\\1/\"", 15);
    prefix = (pr.stdout || '').trim();
  }
  return { path, prefix };
}

export async function runStepPublish(w: WizardRow, opts: { confirm?: string } = {}): Promise<StepResult> {
  const fqdn = stagingFqdn(w);
  const sHost = stagingHost(w);
  const targetHost = serverHost(w.target_live_server || 'live1');
  const isReal = opts.confirm === ('OVERWRITE-LIVE-' + w.id);

  // 1. Resolve instances + paths + prefixes
  const sInst = await lookupWpInstanceId(sHost, fqdn);
  if (sInst.id === null) return { status: 'failed', error: 'publish: staging instance not found at ' + fqdn + ' on ' + sHost + '.\n' + (sInst.error || '') };
  const lInst = await lookupWpInstanceId(targetHost, w.real_domain);
  if (lInst.id === null) return { status: 'failed', error: 'publish: live instance not found at ' + w.real_domain + ' on ' + targetHost + '.\n' + (lInst.error || '') };
  const sMeta = await wpToolkitInfo(sHost, sInst.id);
  const lMeta = await wpToolkitInfo(targetHost, lInst.id);
  if (!sMeta.path || !lMeta.path) return { status: 'failed', error: 'publish: could not resolve paths (staging=' + sMeta.path + ' live=' + lMeta.path + ')' };
  if (!/^[A-Za-z0-9_]+$/.test(sMeta.prefix) || !/^[A-Za-z0-9_]+$/.test(lMeta.prefix)) return { status: 'failed', error: 'publish: could not read table prefixes (staging=' + JSON.stringify(sMeta.prefix) + ' live=' + JSON.stringify(lMeta.prefix) + ') - aborting to avoid a bad reconciliation.' };

  // 2. SAFETY GATE: with HPOS sync ON, live orders are mirrored into wp_posts; a
  //    content import would clobber them. Require sync OFF (wc_orders* sole authority).
  const sync = await sshExec(targetHost, 'plesk ext wp-toolkit --wp-cli -instance-id ' + lInst.id + ' -- option get woocommerce_custom_orders_table_data_sync_enabled 2>&1 | tail -1', 30);
  const hpos = await sshExec(targetHost, 'plesk ext wp-toolkit --wp-cli -instance-id ' + lInst.id + ' -- option get woocommerce_custom_orders_table_enabled 2>&1 | tail -1', 30);
  const syncOn = /^\s*yes\s*$/i.test(sync.stdout || '');
  const hposOn = /^\s*yes\s*$/i.test(hpos.stdout || '');
  if (hposOn && syncOn) {
    return { status: 'failed', error:
      'publish BLOCKED: live has HPOS sync ENABLED — orders are mirrored into wp_posts, which a content import would overwrite.\n' +
      'Make wc_orders* the sole authority (disable HPOS sync) on ' + w.real_domain + ' first, then re-run.' };
  }

  const remoteTmp = '/tmp/aem-publish-' + w.id + '-' + Date.now();
  const preserveStaging = PUBLISH_PRESERVE_BASE.map(t => sMeta.prefix + t).join(',');

  // 3. Pre-dump LIVE (rollback) + record order count BEFORE
  const bk = await sshExec(targetHost, [
    'set -e', 'mkdir -p ' + remoteTmp, 'chmod 1777 ' + remoteTmp,
    'plesk ext wp-toolkit --wp-cli -instance-id ' + lInst.id + ' -- db export ' + remoteTmp + '/live-rollback.sql 2>&1 | tail -2',
    'gzip -f ' + remoteTmp + '/live-rollback.sql', 'ls -lh ' + remoteTmp + '/',
  ].join('\n'), 10 * 60_000);
  if (!bk.ok) return { status: 'failed', error: 'publish: live rollback dump failed:\n' + (bk.stdout || bk.stderr || bk.error) };
  const oc = await sshExec(targetHost, 'plesk ext wp-toolkit --wp-cli -instance-id ' + lInst.id + ' -- db query ' + shellQ('SELECT COUNT(*) FROM `' + lMeta.prefix + 'wc_orders`') + ' --skip-column-names 2>&1 | tail -1', 30);
  const orderCountBefore = (oc.stdout || '').trim();

  // 4. Export STAGING content (everything EXCEPT the preserve-list) + tar staging code
  const sd = await sshExec(sHost, [
    'set -e', 'mkdir -p ' + remoteTmp, 'chmod 1777 ' + remoteTmp, 'cd ' + shellQ(sMeta.path),
    'plesk ext wp-toolkit --wp-cli -instance-id ' + sInst.id + ' -- db export ' + remoteTmp + '/staging-content.sql --exclude_tables=' + preserveStaging + ' 2>&1 | tail -2',
    'tar --warning=no-file-changed -czf ' + remoteTmp + '/staging-files.tar.gz \\',
    '  --exclude=wp-content/cache --exclude=wp-content/uploads/cache \\',
    '  --exclude=wp-config.php --exclude=.htaccess \\',
    '  --exclude=wp-content/mu-plugins/aem-auto-login.php --exclude=wp-content/mu-plugins/aem-mail-sender.php \\',
    '  wp-admin wp-includes wp-content index.php xmlrpc.php wp-load.php wp-settings.php wp-blog-header.php wp-cron.php 2>&1 | tail -3 || true',
    'ls -lh ' + remoteTmp + '/',
  ].join('\n'), 10 * 60_000);
  if (!sd.ok) return { status: 'failed', error: 'publish: staging export failed:\n' + (sd.stdout || sd.stderr || sd.error) };

  // 5. Transfer staging dump + code to the live server
  const t1 = await transferFile(sHost, remoteTmp + '/staging-content.sql', targetHost, remoteTmp + '/staging-content.sql');
  if (!t1.ok) return { status: 'failed', error: 'publish: scp staging db failed:\n' + (t1.error || '') };
  const t2 = await transferFile(sHost, remoteTmp + '/staging-files.tar.gz', targetHost, remoteTmp + '/staging-files.tar.gz');
  if (!t2.ok) return { status: 'failed', error: 'publish: scp staging files failed:\n' + (t2.error || '') };

  // 6. Reconcile table prefix (staging -> live) in the dump if they differ
  let prefixNote = 'prefixes identical (' + lMeta.prefix + ')';
  if (sMeta.prefix !== lMeta.prefix) {
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\\/&]/g, '\\$&');
    const sed = 'sed -i ' +
      "-e 's/`" + esc(sMeta.prefix) + '/`' + esc(lMeta.prefix) + "/g' " +
      '-e "s/\'' + esc(sMeta.prefix) + 'user_roles\'/\'' + esc(lMeta.prefix) + 'user_roles\'/g" ' +
      remoteTmp + '/staging-content.sql';
    const rw = await sshExec(targetHost, sed, 120);
    if (!rw.ok) return { status: 'failed', error: 'publish: prefix rewrite failed:\n' + (rw.stdout || rw.stderr || rw.error) };
    prefixNote = 'rewrote staging prefix ' + sMeta.prefix + ' -> live ' + lMeta.prefix;
  }

  const summary =
    'Staging: ' + sMeta.path + ' @ ' + sHost + ' (inst ' + sInst.id + ', prefix ' + sMeta.prefix + ')\n' +
    'Live:    ' + lMeta.path + ' @ ' + targetHost + ' (inst ' + lInst.id + ', prefix ' + lMeta.prefix + ')\n' +
    'Live HPOS=' + (hposOn ? 'on' : 'off') + ' sync=' + (syncOn ? 'on' : 'off') + '\n' +
    'Live wc_orders rows (before): ' + orderCountBefore + '\n' +
    'Prefix: ' + prefixNote + '\n' +
    'Preserved from live (NOT imported): ' + PUBLISH_PRESERVE_BASE.length + ' tables — orders, customers, users, action-scheduler, form payments\n' +
    'Rollback dump: ' + remoteTmp + '/live-rollback.sql.gz on ' + targetHost;

  // 7. DRY-RUN (default / always while disabled): all the above is non-destructive to live.
  if (!isReal || !PUBLISH_LIVE_ENABLED) {
    return {
      status: 'success',
      output: 'PUBLISH DRY-RUN — no live changes made.\n\n' + summary + '\n\n' +
        'Staging export + code tarball built and copied to live; prefix reconciled; live fully backed up.\n' +
        (PUBLISH_LIVE_ENABLED
          ? 'To execute for real, re-run with confirm="OVERWRITE-LIVE-' + w.id + '".'
          : 'Live execution is HARD-DISABLED (PUBLISH_LIVE_ENABLED=false) pending a pilot. Staged artifacts left in ' + remoteTmp + ' on ' + targetHost + ' for inspection.'),
    };
  }

  // 8. REAL publish (gated by PUBLISH_LIVE_ENABLED + confirm token)
  const owner = await sshExec(targetHost, 'stat -c "%U:%G" ' + shellQ(lMeta.path), 15);
  const ownerSpec = (owner.stdout || '').trim() || 'root:psaserv';
  const overlay = await sshExec(targetHost, [
    'set -e', 'cd ' + shellQ(lMeta.path),
    'rm -rf wp-admin wp-includes wp-content/themes wp-content/plugins',
    'tar -xzf ' + remoteTmp + '/staging-files.tar.gz',
    'chown -R ' + ownerSpec + ' wp-admin wp-includes wp-content', 'echo OK',
  ].join('\n'), 5 * 60_000);
  if (!overlay.ok) return { status: 'failed', error: 'publish: code overlay failed (restore ' + remoteTmp + '/live-rollback.sql.gz):\n' + (overlay.stdout || overlay.stderr || overlay.error) };
  const imp = await sshExec(targetHost, 'plesk ext wp-toolkit --wp-cli -instance-id ' + lInst.id + ' -- db import ' + remoteTmp + '/staging-content.sql 2>&1 | tail -5', 5 * 60_000);
  if (!imp.ok) return { status: 'failed', error: 'publish: db import failed — ROLL BACK from ' + remoteTmp + '/live-rollback.sql.gz:\n' + (imp.stdout || imp.stderr || imp.error) };
  const stagingUrl = 'https://' + fqdn;
  const liveUrl = 'https://' + w.real_domain;
  await sshExec(targetHost, 'plesk ext wp-toolkit --wp-cli -instance-id ' + lInst.id + ' -- search-replace ' + shellQ(stagingUrl) + ' ' + shellQ(liveUrl) + ' --skip-columns=guid --all-tables-with-prefix 2>&1 | tail -5', 180);
  await sshExec(targetHost, 'plesk ext wp-toolkit --wp-cli -instance-id ' + lInst.id + ' -- option update blog_public 1 2>&1', 30).catch(() => {});
  const ocAfter = await sshExec(targetHost, 'plesk ext wp-toolkit --wp-cli -instance-id ' + lInst.id + ' -- db query ' + shellQ('SELECT COUNT(*) FROM `' + lMeta.prefix + 'wc_orders`') + ' --skip-column-names 2>&1 | tail -1', 30);
  const orderCountAfter = (ocAfter.stdout || '').trim();
  const ok = orderCountBefore === orderCountAfter && orderCountBefore !== '';
  await sshExec(targetHost, 'rm -rf ' + remoteTmp, 15).catch(() => {});
  await sshExec(sHost, 'rm -rf ' + remoteTmp, 15).catch(() => {});
  return {
    status: ok ? 'success' : 'failed',
    output: 'PUBLISH STAGING -> LIVE\n\n' + summary + '\n' +
      'Live wc_orders rows (after): ' + orderCountAfter + (ok ? '  (unchanged)' : '  CHANGED — investigate/rollback') + '\n' +
      'Search-replace: ' + stagingUrl + ' -> ' + liveUrl + '\n' +
      (ok ? 'Orders/customers preserved; content published.' : 'ORDER COUNT MISMATCH — restore ' + remoteTmp + '/live-rollback.sql.gz'),
  };
}

async function runStep2(w: WizardRow): Promise<StepResult> {
  const slug = w.staging_slug;
  const fqdn = stagingFqdn(w);
  const sub = stagingSubdomain(w);
  const password = genPassword(20);
  const title = `${w.customer_name} (staging)`.replace(/[^\w\s\-()]/g, '').slice(0, 50);

  // Pre-check: does staging subdomain already exist?
  const sdExists = await sshExec(stagingHost(w),
    `plesk bin subdomain --info ${shellQ(sub.name)} -domain ${shellQ(sub.parent)} 2>&1 || true`, 30);
  if (sdExists.ok && /Domain ID:\s+\d+/.test(sdExists.stdout)) {
    if (w.overwrite_existing) {
      const rm = await sshExec(stagingHost(w),
        `plesk bin subdomain --remove ${shellQ(sub.name)} -domain ${shellQ(sub.parent)} 2>&1`, 60);
      if (!rm.ok) return { status: 'failed', error: `Overwrite mode: failed to remove existing staging subdomain ${fqdn}:\n${rm.stdout || rm.stderr || rm.error}` };
    } else {
      return { status: 'failed', error: `Staging subdomain ${fqdn} already exists.\nTick 'Overwrite existing' on the wizard form to remove it first.\n\n${sdExists.stdout.slice(0, 400)}` };
    }
  }

  const r1 = await sshExec(stagingHost(w),
    `plesk bin subdomain --create ${shellQ(sub.name)} -domain ${shellQ(sub.parent)} -www-root ${shellQ(sub.name)} -php true 2>&1`, 60);
  if (!r1.ok) return { status: 'failed', error: `Subdomain create failed:\n${r1.stdout || r1.stderr || r1.error}` };
  await new Promise(res => setTimeout(res, 2000));
  const r2 = await sshExec(stagingHost(w),
    `plesk ext wp-toolkit --install -domain-name ${shellQ(fqdn)} -path / -username admin -admin-email security@aemtech.co.uk -site-title ${shellQ(title)} -protocol https -language en_US 2>&1`, 180);
  if (!r2.ok) return { status: 'failed', error: `wp-toolkit --install failed:\n${r2.stdout || r2.stderr || r2.error}` };
  const lookup = await lookupWpInstanceId(stagingHost(w), fqdn);
  let pwNote: string;
  let seoNote: string;
  if (lookup.id === null) {
    pwNote = `WARNING: Could not look up instance-id: ${lookup.error}`;
    seoNote = `WARNING: Could not set blog_public=0 (no instance-id) — staging may be indexable.`;
  } else {
    const r4 = await sshExec(stagingHost(w),
      `plesk ext wp-toolkit --wp-cli -instance-id ${lookup.id} -- user update admin --user_pass=${shellQ(password)} 2>&1`, 60);
    pwNote = r4.ok ? `Admin password set via wp-cli (instance-id ${lookup.id}).` : `WARNING: wp-cli password update failed:\n${r4.stdout || r4.stderr || r4.error}`;
    const r5 = await sshExec(stagingHost(w),
      `plesk ext wp-toolkit --wp-cli -instance-id ${lookup.id} -- option update blog_public 0 2>&1`, 30);
    seoNote = r5.ok ? `Search engine indexing DISABLED (blog_public=0) — staging is private.` : `WARNING: failed to set blog_public=0:\n${r5.stdout || r5.stderr || r5.error}`;
  }
  return {
    status: 'success',
    output: `Created ${fqdn} + installed WP.\n\nSubdomain creation:\n${r1.stdout.slice(0, 500)}\n\nWP install (tail):\n${r2.stdout.slice(-800)}\n\nInstance id: ${lookup.id ?? 'NOT FOUND'}\n${pwNote}\n${seoNote}\n\nAdmin login:\n  URL:      https://${fqdn}/wp-admin\n  Username: admin\n  Password: ${password}\n\n${await ensureStagingDns(w)}`,
  };
}

async function runStep3(w: WizardRow): Promise<StepResult> {
  const subject = `[AEM Console] New customer onboarding: ${w.customer_name}`;
  const body = `A new customer onboarding has been started by the web team.\n\nCustomer:        ${w.customer_name}\nContact email:   ${w.customer_contact_email}\nStaging URL:     https://${stagingFqdn(w)}\nReal domain:     ${w.real_domain}\nTarget server:   ${w.target_live_server}\nWizard ID:       ${w.id}\n\nWeb team has completed Steps 1-3 (staging WP install is live).\nNext: Andy or Lewis to take over Steps 4-12 (admin handover).\n\nConsole wizard:\n  https://bastion.infra.aemsystems.co.uk/onboarding/${w.id}\n\n-- AEM Console\n`;
  await sendMail({ from: 'noreply@aemtech.co.uk', to: 'support@aemsystems.co.uk', subject, body });
  return { status: 'success', output: 'Notification mail sent to support@aemsystems.co.uk' };
}

// =========================================================
// Step 4: Create customer Plesk subscription on staging1
// =========================================================
async function runStep4(w: WizardRow): Promise<StepResult> {
  const clientLogin = genLogin(w.staging_slug, 'c');
  const clientPw = genPassword(24);
  const sysLogin = genLogin(w.staging_slug, 's');
  const sysPw = genPassword(24);
  const cleanName = w.customer_name.replace(/'/g, '').slice(0, 60);

  const exists = await sshExec(STAGING1, `plesk bin domain --info ${shellQ(w.real_domain)} 2>&1 || true`, 30);
  if (exists.ok && /Domain ID:\s+\d+/.test(exists.stdout)) {
    if (w.overwrite_existing) {
      const rm = await sshExec(STAGING1, `plesk bin subscription --remove ${shellQ(w.real_domain)} 2>&1`, 60);
      if (!rm.ok) return { status: 'failed', error: `Overwrite mode: failed to remove existing subscription on staging1:\n${rm.stdout || rm.stderr || rm.error}` };
    } else {
      return { status: 'failed', error: `Subscription for ${w.real_domain} already exists on staging1.\nTick 'Overwrite existing' on the wizard form to remove it first, OR delete manually.\n\n${exists.stdout.slice(0, 500)}` };
    }
  }

  const r1 = await sshExec(STAGING1,
    `plesk bin customer --create ${shellQ(clientLogin)} -name ${shellQ(cleanName)} -email ${shellQ(w.customer_contact_email)} -passwd ${shellQ(clientPw)} -company ${shellQ(cleanName)} 2>&1`, 60);
  if (!r1.ok) return { status: 'failed', error: `Plesk client create failed:\n${r1.stdout || r1.stderr || r1.error}` };

  const r2 = await sshExec(STAGING1,
    `plesk bin subscription --create ${shellQ(w.real_domain)} -owner ${shellQ(clientLogin)} -service-plan Unlimited -login ${shellQ(sysLogin)} -passwd ${shellQ(sysPw)} -ip ${STAGING1_IP} -force 2>&1`, 90);
  if (!r2.ok) return { status: 'failed', error: `Plesk subscription create failed:\n${r2.stdout || r2.stderr || r2.error}\n\nPartial state: client '${clientLogin}' was created but subscription failed.` };

  return {
    status: 'success',
    output: `Customer Plesk subscription created on staging1.\n\nClient login:   ${clientLogin}\nClient password: ${clientPw}\nClient email:   ${w.customer_contact_email}\n\nSubscription:   ${w.real_domain}\nFTP/SSH user:   ${sysLogin}\nFTP/SSH pw:     ${sysPw}\n\nClient create output:\n${r1.stdout.slice(0, 400)}\n\nSubscription create output:\n${r2.stdout.slice(0, 400)}\n\nStore these credentials somewhere safe (they live in Plesk too).`,
  };
}

// =========================================================
// Step 5: WP Toolkit clone staging slug -> real domain on staging1
// =========================================================
async function runStep5(w: WizardRow): Promise<StepResult> {
  const stagingFqdn = `${w.staging_slug}.aemstaging.co.uk`;
  const source = await lookupWpInstanceId(STAGING1, stagingFqdn);
  if (source.id === null) return { status: 'failed', error: `Could not find source instance for ${stagingFqdn}: ${source.error}` };

  const r = await sshExec(STAGING1,
    `plesk ext wp-toolkit --clone -source-instance-id ${source.id} -target-domain-name ${shellQ(w.real_domain)} -target-path / -force-overwrite no -format raw 2>&1`, 240);
  if (!r.ok) return { status: 'failed', error: `wp-toolkit --clone failed:\n${r.stdout || r.stderr || r.error}` };

  const cloned = await lookupWpInstanceId(STAGING1, w.real_domain);
  return {
    status: 'success',
    output: `Cloned WP: ${stagingFqdn} (instance ${source.id}) -> ${w.real_domain} (instance ${cloned.id ?? 'lookup failed'})\n\nClone output (tail):\n${r.stdout.slice(-1500)}`,
  };
}

// =========================================================
// Step 6: Cross-server transfer staging1 -> live1 (Plesk Migrator, async + progress)
// =========================================================
const MIGRATOR_DIR = '/var/lib/plesk-migrator-aem';
const MIGRATOR_BIN = '/opt/plesk/python/3/bin/python3.10 /usr/local/psa/admin/plib/modules/panel-migrator/backend/plesk-migrator.py';


// ===== Step 6 — REFRESH MODE =====
// Code-only deploy: replace themes/plugins/mu-plugins/wp-admin/wp-includes/root-php
// PRESERVE: entire DB, wp-content/uploads, wp-config.php, .htaccess
async function runStep6Refresh(w: WizardRow): Promise<StepResult> {
  const targetHost = serverHost(w.target_live_server || 'live1');

  // 6r-a. Find the staging-build wp instance on staging1
  const stagingFqdn = w.staging_slug + '.aemstaging.co.uk';
  const stagingInst = await lookupWpInstanceId(stagingHost(w), stagingFqdn);
  if (stagingInst.id === null) {
    return { status: 'failed', error: 'refresh-6a: source instance not found on staging1 for ' + stagingFqdn + ': ' + stagingInst.error };
  }
  const stagingInfo = await sshExec(stagingHost(w),
    'plesk ext wp-toolkit --info -instance-id ' + stagingInst.id + ' -format json 2>&1', 30);
  let stagingPath = '';
  try {
    const j = JSON.parse(stagingInfo.stdout);
    stagingPath = j.fullPath || '';
  } catch { /* fall through */ }
  if (!stagingPath) {
    return { status: 'failed', error: 'refresh-6a: could not parse staging fullPath' };
  }

  // 6r-b. Find the live target instance on target server
  const liveInst = await lookupWpInstanceId(targetHost, w.real_domain);
  if (liveInst.id === null) {
    return { status: 'failed', error: 'refresh-6b: no existing live install for ' + w.real_domain + ' on ' + targetHost + '.\nRefresh mode requires the site to already be live. Use normal (non-refresh) mode for first cutover.\n' + liveInst.error };
  }
  const liveInfo = await sshExec(targetHost,
    'plesk ext wp-toolkit --info -instance-id ' + liveInst.id + ' -format json 2>&1', 30);
  let livePath = '';
  try {
    const j = JSON.parse(liveInfo.stdout);
    livePath = j.fullPath || '';
  } catch { /* fall through */ }
  if (!livePath) {
    return { status: 'failed', error: 'refresh-6b: could not parse live fullPath' };
  }

  // 6r-c. Tarball staging's code paths (exclude uploads, wp-config, .htaccess, aem-* mu-plugins)
  const remoteTmp = '/tmp/aem-refresh-' + w.id + '-' + Date.now();
  const tarCmd = [
    'set -e',
    'mkdir -p ' + remoteTmp,
    'cd ' + shellQ(stagingPath),
    // Include the WP code paths
    'tar --warning=no-file-changed -czf ' + remoteTmp + '/bundle.tar.gz \\',
    '  --exclude=wp-content/uploads \\',
    '  --exclude=wp-content/cache \\',
    '  --exclude=wp-config.php \\',
    '  --exclude=.htaccess \\',
    '  --exclude=wp-content/mu-plugins/aem-auto-login.php \\',
    '  --exclude=wp-content/mu-plugins/aem-mail-sender.php \\',
    '  wp-admin wp-includes wp-content/themes wp-content/plugins wp-content/mu-plugins \\',
    '  index.php xmlrpc.php wp-activate.php wp-blog-header.php wp-comments-post.php \\',
    '  wp-cron.php wp-links-opml.php wp-load.php wp-login.php wp-mail.php wp-settings.php \\',
    '  wp-signup.php wp-trackback.php 2>&1 | tail -3 || true',
    'ls -lh ' + remoteTmp + '/bundle.tar.gz',
  ].join('\n');
  const r6c = await sshExec(stagingHost(w), tarCmd, 5 * 60_000);
  if (!r6c.ok) {
    return { status: 'failed', error: 'refresh-6c: tarball failed:\n' + (r6c.stdout || r6c.stderr || r6c.error) };
  }

  // 6r-d. SCP bundle staging1 -> target host
  // (use scp via ssh -o ProxyJump=bastion would be cleaner; for now go via bastion)
  const localBundle = '/tmp/aem-refresh-bundle-' + w.id + '.tar.gz';
  const r6d_pull = await sshExec(stagingHost(w),
    'cat ' + remoteTmp + '/bundle.tar.gz > /dev/null && stat -c "%s" ' + remoteTmp + '/bundle.tar.gz', 30);
  if (!r6d_pull.ok) return { status: 'failed', error: 'refresh-6d: bundle stat failed' };
  // Use the scp helper available via the host's ssh chain
  const r6d_scp = await transferFile(
    stagingHost(w), remoteTmp + '/bundle.tar.gz',
    targetHost, remoteTmp + '/bundle.tar.gz'
  );
  if (!r6d_scp.ok) return { status: 'failed', error: 'refresh-6d: scp failed:\n' + r6d_scp.error };

  // 6r-e. Extract bundle on target over live install
  // Backup current state first (just code paths, not data)
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupTar = '/var/backups/aem-refresh-' + w.id + '-' + ts + '.tar.gz';
  const owner = await sshExec(targetHost, 'stat -c "%U:%G" ' + shellQ(livePath), 15);
  const ownerSpec = (owner.stdout || '').trim() || 'root:psaserv';

  const extractCmd = [
    'set -e',
    'mkdir -p /var/backups',
    'cd ' + shellQ(livePath),
    // Backup code paths only
    'tar -czf ' + backupTar + ' wp-admin wp-includes wp-content/themes wp-content/plugins wp-content/mu-plugins 2>&1 | tail -1 || true',
    // Remove old code paths (preserve uploads + wp-config + .htaccess + aem-* mu-plugins)
    'find wp-content/mu-plugins -mindepth 1 -maxdepth 1 ! -name "aem-*" -exec rm -rf {} \\;',
    'rm -rf wp-admin wp-includes wp-content/themes wp-content/plugins',
    // Extract new code
    'tar -xzf ' + remoteTmp + '/bundle.tar.gz',
    // Restore ownership
    'chown -R ' + ownerSpec + ' wp-admin wp-includes wp-content/themes wp-content/plugins wp-content/mu-plugins',
    'echo OK',
  ].join('\n');
  writeStepStatus(w.id, 6, 'extract', 85, 'Extracting over live install (backup saved)');
  const r6e = await sshExec(targetHost, extractCmd, 5 * 60_000);
  if (!r6e.ok) {
    return { status: 'failed', error: 'refresh-6e: extract failed:\n' + (r6e.stdout || r6e.stderr || r6e.error) + '\n\nBackup of old code at ' + backupTar + ' on ' + targetHost + ' for manual rollback if needed.' };
  }

  // 6r-f. Flush caches + permalinks
  const r6f = await sshExec(targetHost,
    'plesk ext wp-toolkit --wp-cli -instance-id ' + liveInst.id + ' -- cache flush 2>&1; ' +
    'plesk ext wp-toolkit --wp-cli -instance-id ' + liveInst.id + ' -- rewrite flush --hard 2>&1 | tail -3', 60);

  // 6r-g. Cleanup
  await sshExec(stagingHost(w), 'rm -rf ' + remoteTmp, 15).catch(() => {});
  await sshExec(targetHost, 'rm -rf ' + remoteTmp, 15).catch(() => {});

  // 6r-h. Smoke test
  const smoke = await sshExec(LIVE1, 'curl -sIk https://' + w.real_domain + '/ 2>&1 | head -3', 30);

  return {
    status: 'success',
    output: 'REFRESH DEPLOY (code-only)\n' +
      'Source:  ' + stagingPath + ' on staging1\n' +
      'Target:  ' + livePath + ' on ' + targetHost + '\n' +
      'Backup:  ' + backupTar + '  (code only — restore with: cd ' + livePath + ' && rm -rf wp-admin wp-includes wp-content/themes wp-content/plugins && tar -xzf ' + backupTar + ')\n' +
      'Preserved: database (untouched), wp-content/uploads, wp-config.php, .htaccess, aem-* mu-plugins\n' +
      'Replaced:  wp-admin/, wp-includes/, wp-content/themes/, wp-content/plugins/, wp-content/mu-plugins/* (excl aem-*)\n\n' +
      'Cache + permalinks flushed.\n' +
      'Smoke test:\n' + smoke.stdout.slice(-300),
  };
}

// Transfer a file between fleet hosts. Same-host transfers skip the network:
// when src and dst paths match (our tmp paths always do) the file is already in
// place so it's a no-op; otherwise a local cp. Only cross-host hits scp.
async function transferFile(srcHost: string, srcPath: string, dstHost: string, dstPath: string): Promise<{ ok: boolean; error?: string }> {
  if (srcHost === dstHost) {
    if (srcPath === dstPath) return { ok: true };
    const r = await sshExec(srcHost, 'cp -a ' + shellQ(srcPath) + ' ' + shellQ(dstPath), 5 * 60_000);
    return r.ok ? { ok: true } : { ok: false, error: (r.stdout || r.stderr || r.error) };
  }
  return execScp('root@' + srcHost + ':' + srcPath, 'root@' + dstHost + ':' + dstPath);
}

// Helper for scp via the existing ssh chain
async function execScp(src: string, dst: string): Promise<{ ok: boolean; error?: string }> {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileP = promisify(execFile);
  try {
    await execFileP('scp', [
      '-i', '/etc/aem-console/keys/aem_fleet_id_ed25519',
      '-o', 'StrictHostKeyChecking=no',
      '-3', // route through bastion via local relay
      src, dst,
    ], { timeout: 5 * 60_000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

async function runStep6(w: WizardRow): Promise<StepResult> {
  // 6a. Write config.ini on live1
  const configIni = `[GLOBAL]
source-type: plesk
sources: staging1

[plesk]
ip: ${LIVE1_IP}
os: unix

[staging1]
ip: ${STAGING1_IP}
os: unix
ssh-username: root
ssh-auth-type: key
ssh-key: /root/.ssh/aem_fleet_id_ed25519
`;
  const configB64 = Buffer.from(configIni).toString('base64');
  const r6a = await sshExec(LIVE1,
    `mkdir -p ${MIGRATOR_DIR}/conf && echo ${shellQ(configB64)} | base64 -d > ${MIGRATOR_DIR}/conf/config.ini`, 30);
  if (!r6a.ok) return { status: 'failed', error: `6a config.ini failed:\n${r6a.stdout || r6a.stderr || r6a.error}` };

  // 6b. Verify SSH key on live1
  const r6b = await sshExec(LIVE1, `ls -la /root/.ssh/aem_fleet_id_ed25519 2>&1`, 15);
  if (!r6b.ok || !r6b.stdout.includes('aem_fleet_id_ed25519')) {
    return { status: 'failed', error: `6b SSH key missing on live1 at /root/.ssh/aem_fleet_id_ed25519. Install once:\n  scp -i /root/.ssh/aem_fleet_id_ed25519 /root/.ssh/aem_fleet_id_ed25519 root@live1.infra.aemsystems.co.uk:/root/.ssh/\n  ssh -i /root/.ssh/aem_fleet_id_ed25519 root@live1.infra.aemsystems.co.uk 'chmod 600 /root/.ssh/aem_fleet_id_ed25519'` };
  }

  // 6c. Clean previous session
  await sshExec(LIVE1, `rm -rf ${MIGRATOR_DIR}/sessions/ 2>&1`, 15).catch(() => {});

  // 6d. prepare
  const r6d = await sshExec(LIVE1, `${MIGRATOR_BIN} ${MIGRATOR_DIR} prepare 2>&1 | tail -15`, 120);
  if (!r6d.ok) return { status: 'failed', error: `6d prepare failed:\n${r6d.stdout || r6d.stderr || r6d.error}` };

  // 6e. generate-migration-list
  const r6e = await sshExec(LIVE1,
    `${MIGRATOR_BIN} ${MIGRATOR_DIR} generate-migration-list --skip-services-checks --overwrite 2>&1 | tail -10`,
    180);
  if (!r6e.ok) return { status: 'failed', error: `6e generate-migration-list failed:\n${r6e.stdout || r6e.stderr || r6e.error}` };

  // 6f. Filter the list to ONLY our target subscription
  const cat = await sshExec(LIVE1, `cat ${MIGRATOR_DIR}/sessions/migration-session/migration-list 2>&1`, 30);
  if (!cat.ok) return { status: 'failed', error: `6f read list failed:\n${cat.stdout || cat.stderr || cat.error}` };

  const lines = cat.stdout.split('\n');
  let targetIdx = -1, planIdx = -1, customerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === w.real_domain) { targetIdx = i; break; }
  }
  if (targetIdx < 0) {
    // Migrator comments out a domain already on live1 as "# <domain> # already exists in the target panel".
    const alreadyExists = lines.some((l) => l.includes(w.real_domain) && /already exists in the target panel/i.test(l));
    if (!alreadyExists) {
      return { status: 'failed', error: `6f target ${w.real_domain} not in generated list. Did Step 4 create the subscription on staging1?\n\n${cat.stdout.slice(0, 800)}` };
    }
    if (!w.overwrite_existing) {
      return { status: 'failed', error: `6f ${w.real_domain} already exists on live1 (target panel).\nTick 'Overwrite existing' on the wizard form to replace it with the staging1 copy.` };
    }
    const rmEx = await sshExec(LIVE1, `plesk bin subscription --remove ${shellQ(w.real_domain)} 2>&1`, 120);
    if (!rmEx.ok && !/does not exist|not found|Unable to find/i.test(rmEx.stdout + rmEx.stderr + (rmEx.error || ''))) {
      return { status: 'failed', error: `6f could not remove existing ${w.real_domain} on live1:\n${rmEx.stdout || rmEx.stderr || rmEx.error}` };
    }
    await sshExec(LIVE1, `rm -rf ${MIGRATOR_DIR}/sessions/ 2>&1`, 15).catch(() => {});
    const rpEx = await sshExec(LIVE1, `${MIGRATOR_BIN} ${MIGRATOR_DIR} prepare 2>&1 | tail -5`, 120);
    if (!rpEx.ok) return { status: 'failed', error: `6f re-prepare failed:\n${rpEx.stdout || rpEx.stderr || rpEx.error}` };
    const rgEx = await sshExec(LIVE1, `${MIGRATOR_BIN} ${MIGRATOR_DIR} generate-migration-list --skip-services-checks --overwrite 2>&1 | tail -5`, 180);
    if (!rgEx.ok) return { status: 'failed', error: `6f re-generate-list failed:\n${rgEx.stdout || rgEx.stderr || rgEx.error}` };
    const catEx = await sshExec(LIVE1, `cat ${MIGRATOR_DIR}/sessions/migration-session/migration-list 2>&1`, 30);
    lines.length = 0; Array.prototype.push.apply(lines, (catEx.stdout || '').split('\n'));
    for (let i = 0; i < lines.length; i++) { if (lines[i].trim() === w.real_domain) { targetIdx = i; break; } }
    if (targetIdx < 0) {
      return { status: 'failed', error: `6f removed existing ${w.real_domain} but it is still not in the regenerated list.\n\n${(catEx.stdout || '').slice(0, 800)}` };
    }
  }
  for (let i = targetIdx - 1; i >= 0; i--) {
    if (lines[i].trim().startsWith('Plan:')) { planIdx = i; break; }
  }
  const searchFrom = planIdx >= 0 ? planIdx - 1 : targetIdx - 1;
  for (let i = searchFrom; i >= 0; i--) {
    const s = lines[i].trim();
    if (s.startsWith('Customer:')) { customerIdx = i; break; }
    if (s.startsWith('Plan:')) break;
  }
  const keep = new Set([customerIdx, planIdx, targetIdx].filter(i => i >= 0));
  const filteredLines = lines.map((line, i) => {
    const s = line.trim();
    if (!s || s.startsWith('# ')) return line;
    if (keep.has(i)) return line;
    return '# ' + line;
  });
  const filtered = filteredLines.join('\n');
  const filteredB64 = Buffer.from(filtered).toString('base64');
  const r6fWrite = await sshExec(LIVE1,
    `echo ${shellQ(filteredB64)} | base64 -d > ${MIGRATOR_DIR}/sessions/migration-session/migration-list`, 30);
  if (!r6fWrite.ok) return { status: 'failed', error: `6f write filtered failed:\n${r6fWrite.stdout || r6fWrite.stderr || r6fWrite.error}` };

  // 6g. check
  const r6g = await sshExec(LIVE1,
    `${MIGRATOR_BIN} ${MIGRATOR_DIR} check --skip-services-checks 2>&1 | tail -30`,
    300);
  if (!r6g.ok) return { status: 'failed', error: `6g check failed:\n${r6g.stdout || r6g.stderr || r6g.error}` };

  // 6h. START transfer-accounts in background via nohup. Returns immediately.
  const r6h = await sshExec(LIVE1,
    `nohup ${MIGRATOR_BIN} ${MIGRATOR_DIR} transfer-accounts --skip-services-checks --skip-copy-mail-content > ${MIGRATOR_DIR}/sessions/aem-transfer.log 2>&1 &
echo $!`,
    15);
  if (!r6h.ok) return { status: 'failed', error: `6h failed to start transfer-accounts in background:\n${r6h.stdout || r6h.stderr || r6h.error}` };

  // Spawn background polling loop (fire-and-forget)
  startMigrationPolling(w.id, w.real_domain);

  return {
    status: 'running' as const,
    output: `Step 6: Migration started in background on live1.\n\n6a config.ini written\n6b SSH key verified\n6c sessions cleaned\n6d prepare ✓\n6e generate-migration-list ✓\n6f filtered to ${w.real_domain}\n6g check ✓\n6h transfer-accounts started (PID ${r6h.stdout.trim()})\n\nPolling for progress every 5 seconds. Wizard page will auto-refresh.`,
  };
}

// =========================================================
// Background polling for Step 6 migration progress
// =========================================================
function startMigrationPolling(wizardId: number, realDomain: string): void {
  const startTime = Date.now();
  const expectedDurationMs = 240_000; // 4 min — typical Migrator run

  const tick = async () => {
    try {
      // Read progress.yaml on live1
      const r = await sshExec(LIVE1, `cat ${MIGRATOR_DIR}/sessions/migration-session/progress.yaml 2>&1`, 15);

      const elapsedMs = Date.now() - startTime;
      let pct = Math.min(95, Math.round((elapsedMs / expectedDurationMs) * 100));
      let currentAction = 'Migration running...';
      let yamlStatus = 'in-progress';

      if (r.ok) {
        const topStatusMatch = r.stdout.match(/^status: (\S+)/m);
        if (topStatusMatch) yamlStatus = topStatusMatch[1];
        // Get action from the FIRST subscription (we only have one)
        const subActionMatch = r.stdout.match(/subscriptions:[\s\S]*?action: (.+)/);
        if (subActionMatch) {
          const a = subActionMatch[1].trim();
          if (a && a !== 'null') currentAction = a;
        }
      }

      // Map yamlStatus to our step status
      let stepStatus: 'running' | 'success' | 'failed' = 'running';
      if (yamlStatus === 'finished' || yamlStatus === 'finished-successfully' || yamlStatus === 'success') {
        stepStatus = 'success';
        pct = 100;
      } else if (yamlStatus === 'failed' || yamlStatus === 'finished-with-errors') {
        // Could be ONLY the cosmetic mail-recalc error. Check the log
        const logCheck = await sshExec(LIVE1, `tail -50 ${MIGRATOR_DIR}/sessions/aem-transfer.log 2>&1`, 15);
        const mailOnly = logCheck.ok && logCheck.stdout.includes("Mail service is not installed") &&
                                       logCheck.stdout.includes("Failed to copy mail content");
        // Verify the actual WP made it to live1 — if yes, treat as success despite mail error
        const verify = await lookupWpInstanceId(LIVE1, realDomain);
        if (verify.id !== null && mailOnly) {
          stepStatus = 'success';
          pct = 100;
          currentAction = 'Complete (mail-recalc cosmetic error ignored)';
        } else {
          stepStatus = 'failed';
        }
      }

      const elapsedSec = Math.round(elapsedMs / 1000);
      const output = `Plesk Migrator transfer-accounts\n\nElapsed: ${elapsedSec}s\nProgress: ${pct}%\nCurrent: ${currentAction}\nStatus: ${yamlStatus}\n\nLive1 progress file: ${MIGRATOR_DIR}/sessions/migration-session/progress.yaml`;

      if (stepStatus === 'running') {
        await db.query(
          `UPDATE onboarding_steps SET progress_pct = $1, output = $2 WHERE wizard_id = $3 AND step_number = 6`,
          [pct, output, wizardId]
        );
        // Schedule next tick
        setTimeout(tick, 5000);
      } else if (stepStatus === 'success') {
        const verify = await lookupWpInstanceId(LIVE1, realDomain);
        if (verify.id === null) {
          await db.query(
            `UPDATE onboarding_steps SET status='failed', progress_pct=NULL, error=$1, completed_at=now() WHERE wizard_id=$2 AND step_number=6`,
            [`Migration finished but no WP instance found on live1 for ${realDomain}: ${verify.error}`, wizardId]
          );
        } else {
          await db.query(
            `UPDATE onboarding_steps SET status='success', progress_pct=100, output=$1, completed_at=now() WHERE wizard_id=$2 AND step_number=6`,
            [`Migration complete (${elapsedSec}s).\n\nWP instance ${verify.id} alive on live1.\n\nTest from bastion:\n  curl -skI --resolve ${realDomain}:443:${LIVE1_IP} https://${realDomain}/\n\nMigrator log: live1:${MIGRATOR_DIR}/sessions/aem-transfer.log`, wizardId]
          );
          // Advance current_step
          await db.query(
            `UPDATE onboarding_wizards SET current_step=7 WHERE id=$1 AND current_step < 7`,
            [wizardId]
          );
          // Cleanup sessions
          await sshExec(LIVE1, `rm -rf ${MIGRATOR_DIR}/sessions/migration-session/ 2>&1`, 15).catch(() => {});
        }
      } else {
        // failed
        const logTail = await sshExec(LIVE1, `tail -30 ${MIGRATOR_DIR}/sessions/aem-transfer.log 2>&1`, 15);
        await db.query(
          `UPDATE onboarding_steps SET status='failed', progress_pct=NULL, error=$1, completed_at=now() WHERE wizard_id=$2 AND step_number=6`,
          [`Migrator status=${yamlStatus} after ${elapsedSec}s.\n\nLast 30 lines of transfer log:\n${logTail.stdout.slice(-2000)}`, wizardId]
        );
      }
    } catch (e) {
      // Polling itself errored — try once more, then give up
      setTimeout(tick, 5000);
    }
  };

  // Kick off polling after 3 sec (give migrator time to write first progress.yaml)
  setTimeout(tick, 3000);
}

// =========================================================
// Step 7: Cloudflare DNS A record + cache purge
// =========================================================
async function runStep7(w: WizardRow): Promise<StepResult> {
  // Manual DNS branch — customer manages DNS at their registrar
  if ((w.dns_provider ?? 'cloudflare') === 'manual') {
    const liveIp = await resolveServerIp(w.target_live_server || LIVE1);
    const r = await sshExec(LIVE1, `dig +short A ${shellQ(w.real_domain)} @1.1.1.1`, 20);
    const observed = (r.stdout || '').trim().split('\n').filter(Boolean);
    const matched = observed.includes(liveIp);
    const wwwHost = 'w' + 'w' + 'w.' + w.real_domain;
    const lines = [
      'Records to set at your DNS provider:',
      '  ' + w.real_domain + '      A     ' + liveIp,
      '  ' + wwwHost + '  A     ' + liveIp + '   (or CNAME -> ' + w.real_domain + ')',
      'TTL: 300 seconds for first 24 hours, then raise to 3600.',
    ];
    const records = lines.join('\n');
    if (matched) {
      return { status: 'success',
        output: 'Manual DNS — A record verified.\nObserved: ' + w.real_domain + ' -> ' + observed.join(', ') + '\nExpected: ' + liveIp + '\n\n' + records };
    }
    return { status: 'failed',
      error: 'Manual DNS — A record NOT pointing at ' + liveIp + ' yet.\nObserved: ' + (observed.length ? observed.join(', ') : '(no A record)') + '\n\n' + records + '\n\nClick Run again once the customer has updated DNS.' };
  }

  const token = await getCloudflareToken();
  if (!token) {
    return { status: 'failed', error: 'No Cloudflare token configured. Either paste one at /settings/integrations OR choose Manual DNS on the wizard form.' };
  }

  const zone = await findZoneForDomain(w.real_domain, token);
  if (!zone) {
    return { status: 'failed', error: `Cloudflare zone for ${w.real_domain} not found in this account.\nAdd the zone at Cloudflare first OR point the registrar's NS to our Cloudflare NS, then re-run.` };
  }
  if (zone.status !== 'active') {
    return { status: 'failed', error: `Cloudflare zone '${zone.name}' exists but status='${zone.status}' (expected 'active').` };
  }

  const liveIp = await resolveServerIp(LIVE1);
  const r = await upsertARecord(zone.id, w.real_domain, liveIp, token, false);

  // Purge CF cache so old responses (e.g., redirects from prior origin) clear immediately
  let purgeNote = '';
  try {
    const { purgeZone } = await import('@/lib/cloudflare');
    await purgeZone(zone.id, token);
    purgeNote = 'Cloudflare cache: purged (all)';
  } catch (e) {
    purgeNote = `Cloudflare cache purge failed (non-fatal): ${(e as Error).message}`;
  }

  return {
    status: 'success',
    output: `Cloudflare DNS A record updated:
  Zone:       ${zone.name} (${zone.id})
  Record:     ${w.real_domain} -> ${liveIp}
  Action:     ${r.action}
  Record ID:  ${r.record.id}
  Proxied:    ${r.record.proxied}
  TTL:        ${r.record.ttl}

${purgeNote}

DNS propagation typically 30-90 seconds. Tip: test in an incognito window to bypass browser cache.
  curl -s 'https://dns.google/resolve?name=${w.real_domain}&type=A'`,
  };
}

// =========================================================
// Step 8: Disable Plesk DNS service on live1 (Cloudflare is authoritative)
// =========================================================
async function runStep8(w: WizardRow): Promise<StepResult> {
  const r = await sshExec(LIVE1, `plesk bin dns --off ${shellQ(w.real_domain)} 2>&1`, 30);
  if (!r.ok) {
    return { status: 'failed', error: `Plesk DNS disable failed for ${w.real_domain}:\n${r.stdout || r.stderr || r.error}\n\n(If it says "DNS service is already disabled" you can Skip this step.)` };
  }
  return {
    status: 'success',
    output: `Plesk DNS service disabled for ${w.real_domain} on live1.
Cloudflare remains the authoritative DNS provider.

${r.stdout.slice(0, 400)}`,
  };
}

// =========================================================
// Step 9: Let's Encrypt SSL on live1
// =========================================================
async function runStep9(w: WizardRow): Promise<StepResult> {
  // Preflight: Plesk's SEO-safe HTTP->HTTPS redirect has no acme-challenge exemption, so it 301s the
  // HTTP-01 challenge and LE fails (then leaves a stale ACME order Plesk keeps resuming). Add a
  // permanent exemption via the domain's custom vhost.conf + reconfigure, so LE and its 90-day
  // renewals work with no manual step. Idempotent — only added once. [Rawson #16, 19 Jul 2026]
  const vhostConf = `/var/www/vhosts/system/${w.real_domain}/conf/vhost.conf`;
  const acmeVhostB64 = Buffer.from('RewriteEngine on\nRewriteRule ^/?\\.well-known/acme-challenge/ - [L]\n').toString('base64');
  await sshExec(LIVE1,
    `F=${shellQ(vhostConf)}; if ! grep -q 'acme-challenge' "$F" 2>/dev/null; then echo ${shellQ(acmeVhostB64)} | base64 -d >> "$F" && plesk sbin httpdmng --reconfigure-domain ${shellQ(w.real_domain)}; fi`,
    120);

  // Try the newer plesk ext letsencrypt CLI first, fall back to the older bin extension exec
  const newCli = await sshExec(LIVE1,
    `plesk ext letsencrypt --help 2>&1 | head -10`, 15);
  const useNew = newCli.ok && newCli.stdout.includes('Usage');
  const usedCli = useNew ? 'plesk ext letsencrypt --install' : 'plesk bin extension --exec letsencrypt cli.php';
  const issue = () => useNew
    ? sshExec(LIVE1,
        `plesk ext letsencrypt --install -domain ${shellQ(w.real_domain)} -email security@aemtech.co.uk -www-redirect true 2>&1 | tail -30`, 180)
    : sshExec(LIVE1,
        `bash -c 'set -o pipefail; plesk bin extension --exec letsencrypt cli.php --domain ${shellQ(w.real_domain)} --email security@aemtech.co.uk 2>&1 | tail -40'`, 180);

  let r = await issue();

  // Stale-order loop: Plesk resumes a dead ACME order ("Order at .../order/... is gone (HTTP 404)").
  // Clear the cached order file(s) for this domain in the LE orders/ subdir (NEVER registrations/,
  // which is the shared ACME account) and retry once.
  if (/is gone/i.test(r.stdout)) {
    await sshExec(LIVE1,
      `grep -rl ${shellQ(w.real_domain)} /usr/local/psa/var/modules/letsencrypt/orders/ 2>/dev/null | xargs -r rm -f`,
      60);
    r = await issue();
  }

  // ERROR / stale-order still present in stdout = real failure even if exit code is 0
  if (r.stdout.includes('ERROR:') || r.stdout.includes('TypeError:') || /is gone/i.test(r.stdout)) {
    return { status: 'failed', error: `LE SSL issuance failed (${usedCli}, error in output):\n${r.stdout || r.stderr || r.error}` };
  }
  if (!r.ok) {
    return { status: 'failed', error: `LE SSL issuance failed (${usedCli}):\n${r.stdout || r.stderr || r.error}\n\nCommon causes:\n  - DNS not yet propagated to live1 (wait 60s after Step 7)\n  - Domain not accessible from public Internet\n  - LE rate limit hit (try again later)\n  - Cloudflare proxy ON (must be DNS only / grey cloud for HTTP-01 challenge)` };
  }

  return {
    status: 'success',
    output: `LE certificate issued for ${w.real_domain} via ${usedCli} (acme-challenge exemption ensured in vhost.conf):

${r.stdout.slice(-1500)}

Test: curl -sI https://${w.real_domain}/  (no -k needed if cert valid)`,
  };
}

// =========================================================
// Step 10: WP search-replace residual URLs (safety net)
// =========================================================
async function runStep10(w: WizardRow): Promise<StepResult> {
  const inst = await lookupWpInstanceId(LIVE1, w.real_domain);
  if (inst.id === null) {
    return { status: 'failed', error: `Could not find WP instance on live1 for ${w.real_domain}: ${inst.error}` };
  }

  const stagingFqdn = `${w.staging_slug}.aemstaging.co.uk`;

  const r1 = await sshExec(LIVE1,
    `plesk ext wp-toolkit --wp-cli -instance-id ${inst.id} -- search-replace ${shellQ(`https://${stagingFqdn}`)} ${shellQ(`https://${w.real_domain}`)} --all-tables --skip-columns=guid 2>&1 | tail -10`, 120);
  const r2 = await sshExec(LIVE1,
    `plesk ext wp-toolkit --wp-cli -instance-id ${inst.id} -- search-replace ${shellQ(stagingFqdn)} ${shellQ(w.real_domain)} --all-tables --skip-columns=guid 2>&1 | tail -10`, 120);
  await sshExec(LIVE1, `plesk ext wp-toolkit --clear-cache -instance-id ${inst.id} 2>&1`, 30).catch(() => {});

  const r3 = await sshExec(LIVE1,
    `plesk ext wp-toolkit --wp-cli -instance-id ${inst.id} -- option update blog_public 1 2>&1`, 30);

  const opts = await sshExec(LIVE1,
    `plesk ext wp-toolkit --wp-cli -instance-id ${inst.id} -- option get siteurl 2>&1; plesk ext wp-toolkit --wp-cli -instance-id ${inst.id} -- option get home 2>&1`, 30);

  return {
    status: 'success',
    output: `WP search-replace safety net (live1 instance ${inst.id}):

Protocol form:
${r1.stdout.slice(-300)}

Bare host form:
${r2.stdout.slice(-300)}

Search engine indexing ENABLED (blog_public=1): ${r3.ok ? 'ok' : 'WARNING: ' + (r3.stdout || r3.stderr || r3.error)}

Current siteurl + home:
${opts.stdout.slice(0, 400)}`,
  };
}

// =========================================================
// Step 11: Customer mailbox creation (stub - skip by default)
// =========================================================
async function runStep11(w: WizardRow): Promise<StepResult> {
  const targetHost = serverHost(w.target_live_server || 'live1');

  // Find live instance + its docroot
  const inst = await lookupWpInstanceId(targetHost, w.real_domain);
  if (inst.id === null) {
    return { status: 'success', output: 'Skipped - no live WP instance for ' + w.real_domain + ' on ' + targetHost + ' (mail-less target)' };
  }
  const info = await sshExec(targetHost,
    'plesk ext wp-toolkit --info -instance-id ' + inst.id + ' -format json 2>&1', 30);
  let docroot = '';
  try { docroot = (JSON.parse(info.stdout).fullPath) || ''; } catch { /* fall through */ }
  if (!docroot) return { status: 'failed', error: 'Step 11: could not parse docroot from wp-toolkit info' };

  // Read the mu-plugin template from bastion
  const { readFileSync } = await import('fs');
  let template = '';
  try {
    template = readFileSync('/opt/aem-console/aem-mail-sender.php.template', 'utf8');
  } catch (e) {
    return { status: 'failed', error: 'Step 11: cannot read /opt/aem-console/aem-mail-sender.php.template — install canonical template first' };
  }

  // Sender alignment defaults
  const fromEmail = 'noreply@' + w.real_domain;
  const fromName = (w.customer_name || '').replace(/"/g, '\\"');

  // Build commands
  const muDir = docroot + '/wp-content/mu-plugins';
  const muFile = muDir + '/aem-mail-sender.php';
  const confDir = '/etc/aem-mail-sender';
  const confFile = confDir + '/' + w.real_domain + '.conf';

  // Detect owner of the docroot so we can chown the mu-plugin
  const ownerR = await sshExec(targetHost, 'stat -c "%U:%G" ' + shellQ(docroot), 15);
  const ownerSpec = (ownerR.stdout || '').trim() || 'root:psaserv';

  // Write conf file
  const confContent = 'from_email="' + fromEmail + '"\nfrom_name="' + fromName + '"\n';
  const confB64 = Buffer.from(confContent).toString('base64');
  const writeConf = await sshExec(targetHost,
    'mkdir -p ' + confDir + ' && chmod 0755 ' + confDir + ' && chown root:root ' + confDir + ' && ' +
    'echo ' + shellQ(confB64) + ' | base64 -d > ' + confFile + ' && chmod 0644 ' + confFile + ' && chown root:root ' + confFile,
    30);
  if (!writeConf.ok) {
    return { status: 'failed', error: 'Step 11: writing ' + confFile + ' failed:\n' + (writeConf.stdout || writeConf.stderr || writeConf.error) };
  }

  // Install mu-plugin (idempotent — overwrites)
  const templateB64 = Buffer.from(template).toString('base64');
  const writeMu = await sshExec(targetHost,
    'mkdir -p ' + shellQ(muDir) + ' && ' +
    'echo ' + shellQ(templateB64) + ' | base64 -d > ' + shellQ(muFile) + ' && ' +
    'chown ' + ownerSpec + ' ' + shellQ(muFile) + ' && chmod 0640 ' + shellQ(muFile) + ' && ls -la ' + shellQ(muFile),
    30);
  if (!writeMu.ok) {
    return { status: 'failed', error: 'Step 11: writing mu-plugin failed:\n' + (writeMu.stdout || writeMu.stderr || writeMu.error) };
  }

  // Smoke test — homepage should still 200 (mu-plugin is just filter hooks, no UI)
  const smoke = await sshExec(targetHost, 'curl -sIk https://' + w.real_domain + '/ 2>&1 | head -3', 30);

  return {
    status: 'success',
    output: 'aem-mail-sender installed.\n' +
      'Config:    ' + confFile + '\n' +
      '  from_email: ' + fromEmail + '\n' +
      '  from_name:  ' + fromName + '\n' +
      'mu-plugin: ' + muFile + ' (' + ownerSpec + ', 0640)\n\n' +
      'wp_mail() now aligns From + Sender to ' + fromEmail + ' for SPF/DKIM compliance.\n' +
      'IMPORTANT: ensure the customer DNS has:\n' +
      '  SPF including the AEM relay IP (or their own mail provider)\n' +
      '  DKIM TXT record for the domain\n' +
      '  DMARC TXT at _dmarc.' + w.real_domain + '\n' +
      'If using mail.infra hosting, also click "Provision hosted mailbox" on the wizard page.\n\n' +
      'Smoke test:\n' + smoke.stdout.slice(-300),
  };
}

// =========================================================
// Step 12: Verify + schedule 7-day staging drop
// =========================================================
async function runStep12(w: WizardRow): Promise<StepResult> {
  // 12a. Verify WP alive on live1
  const verifyWp = await lookupWpInstanceId(LIVE1, w.real_domain);
  if (verifyWp.id === null) {
    return { status: 'failed', error: `12a Verify WP failed: ${verifyWp.error}` };
  }

  // 12b/c/d. Local checks via child_process (Console runs on bastion, no SSH needed)
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execLocal = promisify(exec);
  const localRun = async (cmd: string): Promise<string> => {
    try {
      const { stdout } = await execLocal(cmd, { timeout: 30000 });
      return stdout;
    } catch (e: unknown) {
      const er = e as { stdout?: string; stderr?: string };
      return (er.stdout ?? '') + (er.stderr ?? '');
    }
  };

  const dnsOut = await localRun(`curl -s 'https://dns.google/resolve?name=${encodeURIComponent(w.real_domain)}&type=A'`);
  let dnsIps = '(lookup failed)';
  try {
    const dnsJson = JSON.parse(dnsOut);
    dnsIps = (dnsJson.Answer ?? []).filter((a: { type: number }) => a.type === 1).map((a: { data: string }) => a.data).join(',') || '(no answers)';
  } catch {}

  // HTTPS status + Cloudflare-proxy detection. A proxied ("orange") site returns a cf-ray header,
  // resolves to Cloudflare edge IPs, and presents CF's edge cert (Google Trust Services) — none of
  // which are failures, they're just what a proxied site looks like.
  const headOut = await localRun(`curl -sI -m 10 https://${w.real_domain}/`);
  const httpsCode = headOut.match(/HTTP\/\d(?:\.\d)? (\d{3})/)?.[1] ?? '(no response)';
  const proxied = /^cf-ray:/im.test(headOut);

  // Cert: for a proxied site the browser cert is Cloudflare's edge cert, so verify the ORIGIN cert
  // instead — connect to live1's IP with SNI (DNS-independent). That's the LE cert Full(Strict) uses.
  const certHost = proxied ? LIVE1_IP : w.real_domain;
  const certOut = await localRun(`openssl s_client -connect ${certHost}:443 -servername ${w.real_domain} </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -dates`);
  const certIssuer = certOut.match(/issuer=.*O=([^,/]+)/)?.[1]?.trim() ?? '(no issuer)';
  const certExpiry = certOut.match(/notAfter=(.+)/)?.[1]?.trim() ?? '(no expiry)';
  const certIsLE = certIssuer.includes("Let's Encrypt") || certIssuer.includes('Lets Encrypt');
  const certNearExpiry = (() => {
    const expMs = new Date(certExpiry).getTime();
    if (isNaN(expMs)) return true;
    const daysLeft = (expMs - Date.now()) / (1000 * 60 * 60 * 24);
    return daysLeft < 30;
  })();

  // DNS/origin correctness:
  //  - direct (grey cloud): DNS must resolve to live1's IP.
  //  - proxied (orange): DNS is Cloudflare's edge (expected); confirm the ORIGIN serves the site.
  let dnsCorrect: boolean;
  let dnsLine: string;
  if (proxied) {
    // DNS legitimately points at Cloudflare's edge — not a failure. The end-to-end HTTPS 200
    // (public request through CF to the origin under Full/Strict) already proves the origin is
    // serving, and the origin's LE cert is verified above.
    dnsCorrect = true;
    dnsLine = `${dnsIps} (Cloudflare-proxied — edge IPs, expected ✓)`;
  } else {
    dnsCorrect = dnsIps.includes(LIVE1_IP);
    dnsLine = `${dnsIps} ${dnsCorrect ? '(matches live1 ' + LIVE1_IP + ') ✓' : '(EXPECTED ' + LIVE1_IP + ') ✗'}`;
  }

  const allGreen = verifyWp.id !== null && dnsCorrect && httpsCode === '200' && certIsLE && !certNearExpiry;

  const proxyLine = proxied
    ? `\n  Cloudflare:        proxied (orange) — browser sees CF edge cert; origin verified directly. Confirm SSL mode = Full (Strict).`
    : '';

  // The runStep wrapper will set staging_drop_at = now() + 7 days when stepNumber===12 + success
  return {
    status: allGreen ? 'success' : 'failed',
    output: `Wizard finalisation report:

  WP on live1:       instance ${verifyWp.id} alive ✓
  DNS resolves to:   ${dnsLine}
  HTTPS status:      ${httpsCode} ${httpsCode === '200' ? '✓' : '✗'}
  Cert issuer:       ${certIssuer} ${certIsLE ? '✓' + (proxied ? ' (origin cert)' : '') : '✗ (NOT Let\'s Encrypt — investigate)'}
  Cert valid until:  ${certExpiry} ${certNearExpiry ? '✗ (renew soon, <30 days)' : '✓'}${proxyLine}

Staging copies (will auto-delete 7 days from now):
  ${w.staging_slug}.aemstaging.co.uk (staging subdomain)
  ${w.real_domain} on staging1 (cloned during Step 5)

To drop staging immediately (admin only):
  Use the Skip button on this step's drop-pending state once it's scheduled
  OR manually: ssh staging1 'plesk bin subdomain --remove ${w.staging_slug} -domain aemstaging.co.uk; plesk bin subscription --remove ${w.real_domain}'

WIZARD COMPLETE 🎉
Customer can now use https://${w.real_domain}`,
    error: allGreen ? undefined : `Final verification did not pass all checks. Review DNS/HTTPS before marking complete. Click Skip (admin) to mark anyway, or fix and re-run.`,
  };
}

// =========================================================
// Staging teardown (#93). Step 12 schedules staging_drop_at = now()+7d but
// nothing consumed it — staging copies lived on forever. dropStaging performs
// the actual removal (idempotent): the <slug> staging subdomain, plus the
// real_domain subscription that Step 5's WP-Toolkit clone created on staging1.
// Called by the admin "Drop staging now" button and by the daily cron sweep.
// =========================================================
export interface DropStagingResult {
  ok: boolean;
  output?: string;
  error?: string;
  alreadyDropped?: boolean;
}

// Did a Plesk `--remove` succeed? Treat as success when the target is already
// absent (any of Plesk's phrasings), OR when Plesk printed its own success line —
// even if surrounded by unrelated `ERR [util_exec] … proc_close()` internal noise,
// which Plesk emits on the vhostmng step but which does not mean the removal failed.
function stagingRemovalOk(r: { ok: boolean; stdout: string; stderr: string; error?: string }): boolean {
  const out = (r.stdout || '') + '\n' + (r.stderr || '') + '\n' + (r.error || '');
  // Already gone — idempotent success.
  if (/does not exist|not found|no such|unable to find|was not found|is not found/i.test(out)) return true;
  // Explicit Plesk success, regardless of surrounding ERR noise.
  if (/SUCCESS:|completed|was removed|successfully removed|removal of .* completed/i.test(out)) return true;
  // Otherwise only trust a clean exit with no genuine failure wording.
  return r.ok && !/\bfailed to\b|\bcannot\b|permission denied|error:/i.test(out);
}

export async function dropStaging(wizardId: number): Promise<DropStagingResult> {
  const data = await getWizard(wizardId);
  if (!data) return { ok: false, error: 'Wizard not found' };
  const { wizard: w } = data;

  if (w.staging_dropped_at) {
    return { ok: true, alreadyDropped: true, output: `Staging for wizard ${wizardId} (${w.real_domain}) already dropped at ${w.staging_dropped_at}.` };
  }

  const host = stagingHost(w);
  const sub = stagingSubdomain(w);
  const lines: string[] = [];
  let hadError = false;

  // 1. Remove the staging subdomain (the WP install created in Step 2).
  //    `|| true` + "does not exist" both treated as success so the sweep is idempotent.
  const rmSub = await sshExec(host, `plesk bin subdomain --remove ${shellQ(sub.name)} -domain ${shellQ(sub.parent)} 2>&1 || true`, 60);
  const subOut = (rmSub.stdout || rmSub.stderr || rmSub.error || '').trim();
  const subOk = stagingRemovalOk(rmSub);
  if (!subOk) hadError = true;
  lines.push(`subdomain ${sub.name}.${sub.parent} on ${host}: ${subOk ? 'removed/absent ✓' : 'ERROR ✗'}\n  ${subOut.slice(0, 300) || '(no output)'}`);

  // 2. Remove the real_domain subscription that Step 5's clone created on staging1
  //    (only staging1 receives that clone).
  if ((w.staging_server || 'staging1') === 'staging1' && w.real_domain) {
    const rmSubn = await sshExec(STAGING1, `plesk bin subscription --remove ${shellQ(w.real_domain)} 2>&1 || true`, 120);
    const snOut = (rmSubn.stdout || rmSubn.stderr || rmSubn.error || '').trim();
    const snOk = stagingRemovalOk(rmSubn);
    if (!snOk) hadError = true;
    lines.push(`subscription ${w.real_domain} on staging1: ${snOk ? 'removed/absent ✓' : 'ERROR ✗'}\n  ${snOut.slice(0, 300) || '(no output)'}`);
  }

  // Only mark dropped when both removals came back clean; a partial failure leaves
  // staging_drop_at set so the next sweep (or a manual retry) picks it up again.
  if (!hadError) {
    await db.query(`UPDATE onboarding_wizards SET staging_dropped_at=now(), staging_drop_at=NULL WHERE id=$1`, [wizardId]);
  }

  return {
    ok: !hadError,
    output: `Staging teardown for wizard ${wizardId} (${w.customer_name} — ${w.real_domain}):\n\n${lines.join('\n\n')}\n\n${hadError ? '⚠ One or more removals errored — staging_drop_at left set for retry.' : '✓ Marked staging_dropped_at; wizard staging is gone.'}`,
    error: hadError ? 'One or more staging removals failed — see output.' : undefined,
  };
}

// Daily sweep: drop any wizard whose scheduled staging_drop_at has passed and
// which hasn't already been dropped. Wired to POST /api/cron/drop-staging-system.
export async function dropDueStaging(): Promise<{ processed: number; results: Array<{ wizardId: number; realDomain: string; ok: boolean; alreadyDropped?: boolean; error?: string }> }> {
  const due = await db.query<{ id: number; real_domain: string }>(
    `SELECT id, real_domain FROM onboarding_wizards
     WHERE staging_drop_at IS NOT NULL AND staging_drop_at <= now() AND staging_dropped_at IS NULL
     ORDER BY staging_drop_at ASC`
  );
  const results: Array<{ wizardId: number; realDomain: string; ok: boolean; alreadyDropped?: boolean; error?: string }> = [];
  for (const row of due.rows) {
    const r = await dropStaging(row.id);
    results.push({ wizardId: row.id, realDomain: row.real_domain, ok: r.ok, alreadyDropped: r.alreadyDropped, error: r.error });
  }
  return { processed: due.rows.length, results };
}

// =========================================================
// setupRelay (called from /api/onboarding/[id]/setup-relay)
// Creates a noreply@<real_domain> mailbox on mail.infra (for SMTP-submit
// auth only — customer's MX stays elsewhere) and merges the relay IP into
// the customer's SPF on Cloudflare. Returns a credentials envelope to the
// API caller; the password is NEVER stored in DB or step output.
// =========================================================
export interface RelaySetupResult {
  ok: boolean;
  credentials?: {
    smtp_host: string;
    port: number;
    encryption: string;
    username: string;
    password: string;
  };
  spf_before?: string | null;
  spf_after?: string;
  step_output?: string;
  error?: string;
}

export async function setupRelay(wizardId: number, localPart: string = 'noreply'): Promise<RelaySetupResult> {
  const data = await getWizard(wizardId);
  if (!data) return { ok: false, error: 'Wizard not found' };
  const { wizard: w } = data;

  // Sanitize local-part — alnum + dot/underscore/hyphen, max 30 chars
  const lp = String(localPart || 'noreply').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 30);
  if (!lp) return { ok: false, error: 'Invalid local-part' };

  const mailbox = `${lp}@${w.real_domain}`;

  // 1. Preflight: subscription exists on mail.infra? Auto-create if missing.
  let sub = await sshExec(MAIL_INFRA, `plesk bin domain --info ${shellQ(w.real_domain)} 2>&1 || true`, 30);
  if (!sub.ok || !/Domain ID:\s+\d+/.test(sub.stdout)) {
    // Auto-create a mail-relay subscription on mail.infra (matches existing relay domains: plan "Unlimited", owner admin)
    const sysLogin = ('m' + w.real_domain.replace(/[^a-z0-9]/gi, '').slice(0, 14) + Math.random().toString(36).slice(2, 5)).toLowerCase();
    const sysPw = genPassword(24);
    const created = await sshExec(MAIL_INFRA, `plesk bin subscription --create ${shellQ(w.real_domain)} -owner admin -service-plan ${shellQ('Unlimited')} -login ${shellQ(sysLogin)} -passwd ${shellQ(sysPw)} -ip ${MAIL_INFRA_IP} -force 2>&1`, 120);
    sub = await sshExec(MAIL_INFRA, `plesk bin domain --info ${shellQ(w.real_domain)} 2>&1 || true`, 30);
    if (!sub.ok || !/Domain ID:\s+\d+/.test(sub.stdout)) {
      return { ok: false, error: `Could not auto-create the mail subscription for ${w.real_domain} on mail.infra:\n${created.stdout || created.stderr || created.error}\n\nIf it reports the domain resolves to another server, relax that policy in the mail.infra Plesk (Tools & Settings > Prohibited Domain Names), or create it manually, then re-run.` };
    }
  }

  // 2. Generate password
  const password = genPassword(24);

  // 3. Create mailbox on mail.infra (use --create or --update if exists)
  const exists = await sshExec(MAIL_INFRA, `plesk bin mail --info ${shellQ(mailbox)} 2>&1 || true`, 30);
  const action = (/Mailbox:\s+true/.test(exists.stdout)) ? 'update' : 'create';
  const cmd = action === 'create'
    ? `plesk bin mail --create ${shellQ(mailbox)} -mailbox true -passwd ${shellQ(password)} 2>&1`
    : `plesk bin mail --update ${shellQ(mailbox)} -passwd ${shellQ(password)} 2>&1`;
  const mc = await sshExec(MAIL_INFRA, cmd, 60);
  if (!mc.ok) {
    return { ok: false, error: `Mailbox ${action} failed:\n${mc.stdout || mc.stderr || mc.error}` };
  }

  // 4. Cloudflare SPF merge
  const { getCloudflareToken, findZoneForDomain, upsertSpfRecord, mergeSpf } = await import('@/lib/cloudflare');
  const { db } = await import('@/lib/db');
  const token = await getCloudflareToken();
  if (!token) return { ok: false, error: 'No Cloudflare token configured. Mailbox was created but SPF NOT updated.' };
  const zone = await findZoneForDomain(w.real_domain, token);
  if (!zone) return { ok: false, error: `No Cloudflare zone for ${w.real_domain}. Mailbox was created but SPF NOT updated.` };

  // Read current SPF
  const cfRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone.id}/dns_records?type=TXT&name=${encodeURIComponent(w.real_domain)}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const cfData: { result: Array<{ content: string }> } = await cfRes.json();
  const existingSpfRec = (cfData.result || []).find(r => r.content.replace(/^"|"$/g, '').toLowerCase().startsWith('v=spf1'));
  const spfBefore: string | null = existingSpfRec ? existingSpfRec.content.replace(/^"|"$/g, '') : null;
  const spfAfter = mergeSpf(spfBefore, MAIL_INFRA_IP);

  const spfUpsert = await upsertSpfRecord(zone.id, w.real_domain, spfAfter, token);

  // 5. Step output — describe what was done, NO PASSWORD
  const stepOutput = `SMTP relay set up for ${w.customer_name}.

Mailbox: ${mailbox}   (action: ${action})
On: mail.infra.aemsystems.co.uk

SPF on ${w.real_domain}:
  Before: ${spfBefore ?? '(none)'}
  After:  ${spfAfter}
  CF action: ${spfUpsert.action}

Credentials surfaced to admin via modal. Password NOT stored.
Customer SMTP setup:
  Host:       mail.infra.aemsystems.co.uk
  Port:       587 (STARTTLS) or 465 (SMTPS)
  Username:   ${mailbox}
  Auth:       PLAIN/LOGIN over TLS
`;

  // Mark step 11 success
  await db.query(
    `UPDATE onboarding_steps SET status='success', output=$1, started_at=NOW(), completed_at=NOW() WHERE wizard_id=$2 AND step_number=11`,
    [stepOutput, wizardId]
  );
  // Advance wizard
  await db.query(`UPDATE onboarding_wizards SET current_step = GREATEST(current_step, 12) WHERE id=$1`, [wizardId]);

  return {
    ok: true,
    credentials: {
      smtp_host: 'mail.infra.aemsystems.co.uk',
      port: 587,
      encryption: 'STARTTLS',
      username: mailbox,
      password,
    },
    spf_before: spfBefore,
    spf_after: spfAfter,
    step_output: stepOutput,
  };
}

// --- Pre-DNS live-server readiness check (added 24 Jun 2026) ---
// Confirms real_domain serves on the target live server itself (Host-header curl to
// 127.0.0.1 on that box, DNS-independent) so we can verify a migration before flipping CF.
export async function checkLiveReady(w: WizardRow): Promise<{
  ok: boolean; http: string; bytes: number; wp: boolean; title: string; targetServer: string; note: string;
}> {
  const targetHost = serverHost(w.target_live_server || 'live1');
  const dom = w.real_domain;
  const cmd =
    `f=$(mktemp); ` +
    `IP=$(getent hosts ${targetHost} 2>/dev/null | awk  �print $1}' | head -1); [ -z "$IP" ] && IP=$(dig +short ${targetHost} | head -1); ` +
    `code=$(curl -Lsk -o "$f" -w '%{http_code}' --resolve ${dom}:80:$IP --resolve ${dom}:443:$IP http://${dom}/ --max-time 25); ` +
    `size=$(wc -c < "$f" 2>/dev/null | tr -d ' '); ` +
    `title=$(grep -o '<title>[^<]*</title>' "$f" 2>/dev/null | head -1 | sed 's/<[^>]*>//g'); ` +
    `wp=$(grep -ci 'wp-content' "$f" 2>/dev/null); ` +
    `rm -f "$f"; ` +
    `echo "HTTP:$code|BYTES:$size|WP:$wp|IP:$IP|TITLE:$title"`;
  const r = await sshExec(targetHost, cmd, 35);
  if (!r.ok) {
    return { ok: false, http: '', bytes: 0, wp: false, title: '', targetServer: targetHost,
      note: 'Could not reach ' + targetHost + ': ' + (r.error || r.stderr || r.stdout || 'unknown') };
  }
  const out = (r.stdout || '').trim();
  const grab = (k: string) => { const m = out.match(new RegExp(k + ':([^|]*)')); return m ? m[1].trim() : ''; };
  const http = grab('HTTP');
  const bytes = parseInt(grab('BYTES') || '0', 10);
  const wp = (parseInt(grab('WP') || '0', 10) > 0);
  const title = grab('TITLE');
  const ok = http === '200' && bytes > 0;
  const note = ok
    ? 'Site serves on ' + (w.target_live_server || 'live1') + ' (HTTP 200, ' + bytes + ' bytes' + (wp ? ', WordPress detected' : '') + (title ? ', "' + title + '"' : '') + '). Safe to run Step 7 (Cloudflare DNS flip).'
    : 'NOT ready on ' + (w.target_live_server || 'live1') + ' (HTTP ' + (http || 'no response') + ', ' + bytes + ' bytes). Finish/verify the Step 6 transfer before flipping DNS.';
  return { ok, http, bytes, wp, title, targetServer: targetHost, note };
}
