import { promises as dns } from 'dns';
import { sshExec, type SshResult } from '@/lib/ssh';
import { shellQ } from '@/lib/onboarding';
import { parseJsonLoose } from '@/lib/wp-updates';

// #220 phase 2 — thin, quoted wrappers around the remote commands the patch engine runs on a Plesk host.
// EVERY argument that isn't a literal in this file goes through shellQ (the same helper wp-updates.ts uses).

export { shellQ };

// Slugs/versions come from wp-cli output on customer sites, so they're validated before they get anywhere near
// a command line (and are still shellQ'd on top of that).
export const SLUG_RE = /^[A-Za-z0-9._-]{1,200}$/;
export const VERSION_RE = /^[A-Za-z0-9._+-]{1,50}$/;

export function out(r: SshResult): string {
  return `${r.stdout || ''}${r.stderr ? `\n${r.stderr}` : ''}${!r.ok && r.error ? `\n${r.error}` : ''}`.trim();
}

export function tail(s: string, n = 1500): string {
  return s.length > n ? '…' + s.slice(-n) : s;
}

function assertInstId(instId: number): void {
  if (!Number.isInteger(instId) || instId <= 0) throw new Error(`Bad WP Toolkit instance id: ${instId}`);
}

// plesk ext wp-toolkit --wp-cli -instance-id <id> -- <args...>   (every arg quoted)
export function wpCmd(instId: number, args: string[]): string {
  assertInstId(instId);
  return `plesk ext wp-toolkit --wp-cli -instance-id ${instId} -- ${args.map(shellQ).join(' ')} 2>&1`;
}

export async function wp(host: string, instId: number, args: string[], timeoutSec = 120): Promise<SshResult & { cmd: string }> {
  const cmd = wpCmd(instId, args);
  const r = await sshExec(host, cmd, timeoutSec);
  return { ...r, cmd };
}

// Last non-empty line of output (wp-toolkit can print notices before the value).
export function lastLine(s: string): string {
  const lines = (s || '').split('\n').map(l => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

// Installed version of one item on an instance, or null if it can't be read / isn't installed.
export async function installedVersion(host: string, instId: number, kind: 'plugin' | 'theme' | 'core', slug: string): Promise<string | null> {
  if (kind !== 'core' && !SLUG_RE.test(slug)) return null;
  const args = kind === 'core' ? ['core', 'version'] : [kind, 'get', slug, '--field=version'];
  const r = await wp(host, instId, args, 60);
  if (!r.ok) return null;
  const v = (r.stdout || '').split('\n').map(l => l.trim()).reverse().find(l => VERSION_RE.test(l) && /^v?\d/.test(l));
  return v ?? null;
}

export interface InstanceInfo { id: number; siteUrl: string }

// Find the WP Toolkit instance serving <fqdn> on <host>. Like onboarding's lookupWpInstanceId, but accepts http://
// too (a freshly cloned staging subdomain may have no certificate yet) and returns the siteUrl.
export async function findInstance(host: string, fqdn: string): Promise<InstanceInfo | { error: string }> {
  const r = await sshExec(host, `plesk ext wp-toolkit --list -format json 2>&1`, 60);
  if (!r.ok) return { error: `--list failed: ${tail(out(r), 300)}` };
  const list = parseJsonLoose(r.stdout);
  if (!Array.isArray(list)) return { error: `--list unreadable: ${tail(out(r), 300)}` };
  const want = fqdn.toLowerCase();
  const hit = (list as Array<{ id?: number; siteUrl?: string }>).find(i => {
    const u = String(i?.siteUrl ?? '').toLowerCase().replace(/\/+$/, '');
    return u === `https://${want}` || u === `http://${want}`;
  });
  if (!hit || !hit.id) return { error: `No WP Toolkit instance with siteUrl http(s)://${fqdn} on ${host}` };
  return { id: Number(hit.id), siteUrl: String(hit.siteUrl).replace(/\/+$/, '') };
}

// Filesystem path of an instance (from wp-toolkit --info), '' if unknown.
export async function instancePath(host: string, instId: number): Promise<string> {
  assertInstId(instId);
  const r = await sshExec(host, `plesk ext wp-toolkit --info -instance-id ${instId} -format json 2>&1`, 60);
  const j = parseJsonLoose(r.stdout) as { fullPath?: string } | undefined;
  const p = j && typeof j === 'object' && !Array.isArray(j) ? String(j.fullPath ?? '') : '';
  return p.startsWith('/var/www/vhosts/') ? p : '';
}

// Table prefix of an instance: `wp db prefix`, falling back to reading $table_prefix from wp-config.php (the same
// fallback onboarding's wpToolkitInfo uses). Only [A-Za-z0-9_] is accepted.
export async function tablePrefix(host: string, instId: number, path: string): Promise<string | null> {
  const r = await wp(host, instId, ['db', 'prefix', '--skip-plugins', '--skip-themes'], 60);
  const p = lastLine(r.stdout);
  if (r.ok && /^[A-Za-z0-9_]+$/.test(p)) return p;
  if (!path) return null;
  const g = await sshExec(host,
    "grep -E '[$]table_prefix' " + shellQ(path + '/wp-config.php') + " | head -1 | sed -E \"s/.*=[[:space:]]*'([^']*)'.*/\\1/\"", 30);
  const q = (g.stdout || '').trim();
  return /^[A-Za-z0-9_]+$/.test(q) ? q : null;
}

// Write a small file on the host as the owner of <ownerOf> (so PHP running as the subscription user can read it).
export async function writeFileAs(host: string, dest: string, content: string, ownerOf: string): Promise<SshResult> {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const dir = dest.replace(/\/[^/]+$/, '');
  return sshExec(host, [
    'set -e',
    `O=$(stat -c %U:%G ${shellQ(ownerOf)})`,
    `install -d -o "\${O%%:*}" -g "\${O##*:}" -m 755 ${shellQ(dir)}`,
    `echo ${shellQ(b64)} | base64 -d > ${shellQ(dest)}`,
    `chown "$O" ${shellQ(dest)}`,
    `chmod 644 ${shellQ(dest)}`,
  ].join('\n'), 60);
}

// Public IPv4 of a fleet host. Plesk binds HTTPS to the public IP (not 127.0.0.1), so smoke tests pin the request
// to this address with curl --resolve: it reaches the origin directly (no CDN cache) and works for a staging
// subdomain that has no public DNS record.
export async function hostIp(host: string): Promise<string> {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
  const ips = await dns.resolve4(host);
  if (!ips.length) throw new Error(`Could not resolve IPv4 for ${host}`);
  return ips[0];
}

// active_plugins option (JSON array of "dir/file.php") from `wp option get active_plugins --format=json`.
export function parseActivePlugins(s: string): string[] {
  const j = parseJsonLoose(s);
  if (Array.isArray(j)) return j.map(x => String(x));
  if (j && typeof j === 'object') return Object.values(j as Record<string, unknown>).map(x => String(x));
  return [];
}
