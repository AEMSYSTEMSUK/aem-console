import { spawn } from 'child_process';
import { sshExec } from '@/lib/ssh';
import { shellQ, hostIp } from './remote';

// #220 phase 2 — smoke tests. An HTTP GET of every policy smoke path (pinned to the origin server's IP with
// curl --resolve, basic auth for staging clones) expecting 200, the policy's expect_text on the home page, and no
// WordPress fatal-error page; plus no NEW PHP fatal errors in the vhost's error_log since the step began.

export interface SmokeTarget {
  baseUrl: string;            // e.g. https://example.com or http://aemstg-12.example.com (no trailing slash)
  host: string;               // fleet server FQDN the site lives on (for --resolve and the error log)
  vhost: string;              // Plesk domain/subdomain name whose /var/www/vhosts/system/<vhost>/logs/error_log to read
  auth?: { user: string; pass: string };
}

export interface SmokePolicy { smoke_paths: string[]; expect_text: string | null }

export interface CurlResult { status: number; effectiveUrl: string; body: string; error?: string }

const MAX_BODY = 4 * 1024 * 1024;
const MARK = '\n__AEM_SMOKE__';

// curl on the bastion. Credentials go in via a config on stdin (-K -), never on the command line / process list.
export function curlGet(url: string, opts: { resolveIp?: string; auth?: { user: string; pass: string }; timeoutSec?: number } = {}): Promise<CurlResult> {
  return new Promise((resolve) => {
    const u = new URL(url);
    const args = ['-sS', '-k', '-L', '--max-redirs', '5', '--max-time', String(opts.timeoutSec ?? 45),
      '-A', 'AEM-Console-Smoke/1.0 (+#220)', '-o', '-', '-w', `${MARK}%{http_code} %{url_effective}`];
    if (opts.resolveIp) {
      args.push('--resolve', `${u.hostname}:443:${opts.resolveIp}`, '--resolve', `${u.hostname}:80:${opts.resolveIp}`);
    }
    if (opts.auth) args.push('-K', '-');
    args.push(url);
    const child = spawn('curl', args);
    const chunks: Buffer[] = []; let size = 0; let err = '';
    child.stdout.on('data', (d: Buffer) => { if (size < MAX_BODY) { chunks.push(d); size += d.length; } });
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('error', (e) => resolve({ status: 0, effectiveUrl: url, body: '', error: e.message }));
    child.on('close', () => {
      const all = Buffer.concat(chunks).toString('utf8');
      const i = all.lastIndexOf(MARK);
      if (i < 0) { resolve({ status: 0, effectiveUrl: url, body: all, error: err.trim() || 'no response' }); return; }
      const [code, eff] = all.slice(i + MARK.length).trim().split(' ');
      resolve({ status: parseInt(code, 10) || 0, effectiveUrl: eff || url, body: all.slice(0, i), error: err.trim() || undefined });
    });
    if (opts.auth) {
      // Staging basic-auth credentials are generated alphanumerics; escape anyway for curl's config syntax.
      const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      child.stdin.write(`user = "${esc(opts.auth.user)}:${esc(opts.auth.pass)}"\n`);
    }
    child.stdin.end();
  });
}

function vhostErrorLog(vhost: string): string {
  if (!/^[A-Za-z0-9.-]+$/.test(vhost)) throw new Error(`Bad vhost name: ${vhost}`);
  return `/var/www/vhosts/system/${vhost}/logs/error_log`;
}

// Line count of the vhost's error_log right now (0 if it doesn't exist). Taken when a step begins.
export async function errorLogMark(host: string, vhost: string): Promise<number> {
  const f = vhostErrorLog(vhost);
  const r = await sshExec(host, `wc -l < ${shellQ(f)} 2>/dev/null || echo 0`, 30);
  return parseInt((r.stdout || '').trim().split('\n').pop() || '0', 10) || 0;
}

// PHP fatal/parse errors logged since <mark>. If the log was rotated (fewer lines than the mark) the whole new
// file is checked.
export async function newFatals(host: string, vhost: string, mark: number): Promise<string[]> {
  const f = vhostErrorLog(vhost);
  const m = Math.max(0, Math.floor(mark));
  const r = await sshExec(host,
    `F=${shellQ(f)}; N=$(wc -l < "$F" 2>/dev/null || echo 0); if [ "$N" -lt ${m} ]; then S=1; else S=${m + 1}; fi; ` +
    `tail -n +"$S" "$F" 2>/dev/null | grep -E 'PHP (Fatal|Parse) error' | tail -20 || true`, 30);
  return (r.stdout || '').split('\n').map(l => l.trim()).filter(Boolean);
}

const FATAL_PAGE_RE = /There has been a critical error on this website|<b>Fatal error<\/b>|PHP Fatal error|Error establishing a database connection/i;

export interface SmokeOutcome { ok: boolean; lines: string[] }

export async function smokeTest(t: SmokeTarget, policy: SmokePolicy, sinceMark: number | null): Promise<SmokeOutcome> {
  const lines: string[] = [];
  let ok = true;
  let ip: string | undefined;
  try { ip = await hostIp(t.host); } catch (e) { lines.push(`could not resolve ${t.host}: ${(e as Error).message}`); return { ok: false, lines }; }
  const paths = policy.smoke_paths.length ? policy.smoke_paths : ['/'];
  const want = new URL(t.baseUrl).hostname.toLowerCase();
  const textPath = paths.includes('/') ? '/' : paths[0];

  for (const p of paths) {
    if (!p.startsWith('/')) continue;
    const url = t.baseUrl + p;
    const r = await curlGet(url, { resolveIp: ip, auth: t.auth });
    const problems: string[] = [];
    if (r.status !== 200) problems.push(`HTTP ${r.status || 'error'}${r.error ? ` (${r.error.slice(0, 200)})` : ''}`);
    let effHost = '';
    try { effHost = new URL(r.effectiveUrl).hostname.toLowerCase(); } catch { /* ignore */ }
    if (effHost && effHost !== want) problems.push(`redirected off-site to ${r.effectiveUrl}`);
    if (FATAL_PAGE_RE.test(r.body)) problems.push('page shows a PHP/WordPress fatal error');
    if (r.status === 200 && r.body.length < 200) problems.push(`body too small (${r.body.length} bytes)`);
    if (policy.expect_text && p === textPath && !r.body.includes(policy.expect_text)) {
      problems.push(`expected text not found: ${JSON.stringify(policy.expect_text.slice(0, 80))}`);
    }
    if (problems.length) ok = false;
    lines.push(`GET ${url} -> ${r.status}${problems.length ? ' FAIL: ' + problems.join('; ') : ' ok'}`);
  }

  if (sinceMark !== null) {
    const fatals = await newFatals(t.host, t.vhost, sinceMark);
    if (fatals.length) {
      ok = false;
      lines.push(`NEW PHP fatal errors in ${vhostErrorLog(t.vhost)}:`);
      for (const f of fatals) lines.push(`  ${f.slice(0, 400)}`);
    } else {
      lines.push(`no new PHP fatal errors in ${vhostErrorLog(t.vhost)}`);
    }
  }
  return { ok, lines };
}
