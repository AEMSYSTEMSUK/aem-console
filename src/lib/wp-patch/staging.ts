import { createHash, randomInt } from 'crypto';
import { sshExec } from '@/lib/ssh';
import { shellQ, wp, out, tail, lastLine, findInstance, hostIp, type InstanceInfo } from './remote';
import { curlGet } from './smoke';

// #220 phase 2 — staging clones on the SAME server as the live site.
//
// Layout: a Plesk subdomain  aemstg-<patchSiteId>.<site domain>  (docroot <subscription>/aemstg-<patchSiteId>),
// basic-auth protected in its Apache vhost config BEFORE anything is copied into it, then filled with
// WP Toolkit's clone of the live instance. The subdomain has no public DNS record; the engine reaches it with
// curl --resolve to the server's IP.
//
// Moving clones to staging1 (for big sites / full disks) is a later phase: here we only record needs_staging1.

export const MAX_SITE_BYTES = 10 * 1024 ** 3;   // > 10 GB -> needs_staging1
export const FREE_FACTOR = 2;                    // free space must be >= 2x site size

const STAGING_LABEL_RE = /^aemstg-\d+$/;

export function stagingLabel(patchSiteId: number): string {
  return `aemstg-${patchSiteId}`;
}

export function genPassword(len = 20): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let pw = '';
  for (let i = 0; i < len; i++) pw += chars[randomInt(chars.length)];
  return pw;
}

type Log = (line: string) => Promise<void>;

// ---------------------------------------------------------------------------------------------------------------
// Capacity: free space on the vhosts partition vs the live site's files + database.
// ---------------------------------------------------------------------------------------------------------------
export interface Capacity { ok: boolean; reason?: string; siteBytes: number; freeBytes: number }

export async function checkCapacity(host: string, liveInst: number, livePath: string, log: Log): Promise<Capacity> {
  const df = await sshExec(host, `df -PB1 /var/www/vhosts | awk 'NR==2 {print $4}'`, 30);
  const freeBytes = parseInt(lastLine(df.stdout), 10);
  const du = await sshExec(host, `du -sb ${shellQ(livePath)} 2>/dev/null | cut -f1`, 900);
  const fileBytes = parseInt(lastLine(du.stdout), 10);
  const dbr = await wp(host, liveInst, ['db', 'size', '--size_format=b', '--skip-plugins', '--skip-themes'], 120);
  const dbBytes = parseInt(lastLine(dbr.stdout), 10);
  if (!Number.isFinite(freeBytes) || !Number.isFinite(fileBytes)) {
    return { ok: false, reason: `could not measure disk (df: ${tail(out(df), 200)}; du: ${tail(out(du), 200)})`, siteBytes: 0, freeBytes: 0 };
  }
  const siteBytes = fileBytes + (Number.isFinite(dbBytes) ? dbBytes : 0);
  const gb = (n: number) => (n / 1024 ** 3).toFixed(2) + ' GB';
  await log(`capacity: site ${gb(siteBytes)} (files ${gb(fileBytes)}, db ${Number.isFinite(dbBytes) ? gb(dbBytes) : 'unknown'}), free on /var/www/vhosts ${gb(freeBytes)}`);
  if (siteBytes > MAX_SITE_BYTES) return { ok: false, reason: `site is ${gb(siteBytes)} (> 10 GB): needs staging1`, siteBytes, freeBytes };
  if (freeBytes < FREE_FACTOR * siteBytes) {
    return { ok: false, reason: `only ${gb(freeBytes)} free, need ${gb(FREE_FACTOR * siteBytes)} (2x site): needs staging1`, siteBytes, freeBytes };
  }
  return { ok: true, siteBytes, freeBytes };
}

// ---------------------------------------------------------------------------------------------------------------
// Subdomain + vhost-level basic auth.
// ---------------------------------------------------------------------------------------------------------------

// Apache-style {SHA} htpasswd entry (supported by Apache 2.4 mod_authn_file). The password is a throwaway for a
// short-lived staging clone and is stored on the wp_patch_sites row anyway.
function htpasswdLine(user: string, pass: string): string {
  return `${user}:{SHA}${createHash('sha1').update(pass).digest('base64')}\n`;
}

function authBlock(htpasswdPath: string): string {
  return [
    '# AEM staging clone (#220): basic auth for the whole vhost. Added by the AEM Console.',
    '<Location />',
    '  AuthType Basic',
    '  AuthName "AEM staging"',
    `  AuthUserFile ${htpasswdPath}`,
    '  Require valid-user',
    '</Location>',
    '',
  ].join('\n');
}

export async function createProtectedSubdomain(host: string, parentDomain: string, label: string, user: string, pass: string, log: Log)
  : Promise<{ ok: boolean; fqdn: string; error?: string }> {
  if (!STAGING_LABEL_RE.test(label)) return { ok: false, fqdn: '', error: `refusing unexpected staging label ${label}` };
  if (!/^[A-Za-z0-9.-]+$/.test(parentDomain)) return { ok: false, fqdn: '', error: `bad parent domain ${parentDomain}` };
  const fqdn = `${label}.${parentDomain}`;

  // Same command onboarding uses for staging subdomains.
  const mk = await sshExec(host,
    `plesk bin subdomain --create ${shellQ(label)} -domain ${shellQ(parentDomain)} -www-root ${shellQ(label)} -php true 2>&1`, 120);
  await log(`$ plesk bin subdomain --create ${label} -domain ${parentDomain} -www-root ${label} -php true\n${tail(out(mk), 600)}`);
  if (!mk.ok) return { ok: false, fqdn, error: `subdomain create failed: ${tail(out(mk), 300)}` };

  // Basic auth in vhost.conf + vhost_ssl.conf (outside the docroot, so the clone's --force-overwrite can't remove
  // it, and in place BEFORE any site code exists -> no loopback/wp-cron/WP Toolkit request can execute the clone
  // unauthenticated).
  // TODO(verify on a host): Plesk includes /var/www/vhosts/system/<fqdn>/conf/vhost{,_ssl}.conf for subdomains
  // (onboarding's issueLetsEncrypt relies on the same path) and Apache (group psaserv) can read the htpasswd.
  const conf = `/var/www/vhosts/system/${fqdn}/conf`;
  const htp = `${conf}/aem-staging.htpasswd`;
  const block = Buffer.from(authBlock(htp)).toString('base64');
  const pw = Buffer.from(htpasswdLine(user, pass)).toString('base64');
  const prot = await sshExec(host, [
    'set -e',
    `D=${shellQ(conf)}`,
    'test -d "$D"',
    `echo ${shellQ(pw)} | base64 -d > ${shellQ(htp)}`,
    `chgrp psaserv ${shellQ(htp)} 2>/dev/null || true`,
    `chmod 640 ${shellQ(htp)}`,
    `for F in vhost.conf vhost_ssl.conf; do grep -q 'AEM staging clone' "$D/$F" 2>/dev/null || echo ${shellQ(block)} | base64 -d >> "$D/$F"; done`,
    `plesk sbin httpdmng --reconfigure-domain ${shellQ(fqdn)}`,
  ].join('\n'), 180);
  await log(`basic-auth vhost config on ${fqdn}: ${prot.ok ? 'ok' : 'FAILED ' + tail(out(prot), 500)}`);
  if (!prot.ok) return { ok: false, fqdn, error: 'could not write the basic-auth vhost config' };

  // Prove it: an unauthenticated HTTP request must get 401 before we copy anything in. (HTTPS is only logged
  // here — a new subdomain may have no SSL hosting yet, in which case https://<fqdn> lands on another vhost. The
  // engine re-probes the clone's real siteUrl after cloning, and that one must be 401.)
  const ip = await hostIp(host);
  for (const scheme of ['http', 'https']) {
    const r = await curlGet(`${scheme}://${fqdn}/`, { resolveIp: ip, timeoutSec: 20 });
    await log(`unauthenticated probe ${scheme}://${fqdn}/ -> ${r.status || r.error}`);
    if (scheme === 'http' && r.status !== 401) {
      return { ok: false, fqdn, error: `staging vhost is not password-protected (http probe returned ${r.status || r.error}); not cloning` };
    }
  }
  return { ok: true, fqdn };
}

// After cloning: the clone's own URL must refuse an unauthenticated request.
export async function assertProtected(host: string, siteUrl: string, log: Log): Promise<boolean> {
  const ip = await hostIp(host);
  const r = await curlGet(`${siteUrl}/`, { resolveIp: ip, timeoutSec: 30 });
  await log(`unauthenticated probe ${siteUrl}/ -> ${r.status || r.error}`);
  return r.status === 401;
}

// ---------------------------------------------------------------------------------------------------------------
// Clone (WP Toolkit). Isolated so the flags can be checked / changed in one place.
// ---------------------------------------------------------------------------------------------------------------
// Flags copied from onboarding.ts cloneSameServer(), which runs this in production for same-server staging:
//   plesk ext wp-toolkit --clone -source-instance-id <live> -target-domain-name <fqdn> -target-path / -force-overwrite yes
// TODO(verify on a host): that WP Toolkit's clone does not put the SOURCE into maintenance mode and that the clone
// keeps the source's table prefix handling we rely on (`wp db prefix`).
export async function cloneToSubdomain(host: string, liveInst: number, fqdn: string, log: Log): Promise<InstanceInfo | { error: string }> {
  if (!Number.isInteger(liveInst) || liveInst <= 0) return { error: 'bad live instance id' };
  const cmd = `plesk ext wp-toolkit --clone -source-instance-id ${liveInst} -target-domain-name ${shellQ(fqdn)} -target-path / -force-overwrite yes 2>&1 | tail -40`;
  await log(`$ ${cmd}`);
  const r = await sshExec(host, cmd, 1800);
  const o = out(r);
  await log(tail(o, 1500) || '(no output)');
  // Same failure detection as onboarding's cloneSameServer.
  if (/Copying (files|database) failed|could not|does not exist/i.test(o) || (!r.ok && !/finished with error/i.test(o))) {
    return { error: `WP Toolkit clone failed: ${tail(o, 400)}` };
  }
  const inst = await findInstance(host, fqdn);
  if ('error' in inst) return inst;
  if (inst.id === liveInst) return { error: 'clone resolved to the LIVE instance id — refusing to continue' };
  return inst;
}

// ---------------------------------------------------------------------------------------------------------------
// Delete a clone: WP Toolkit instance (files + its database), then the subdomain.
// ---------------------------------------------------------------------------------------------------------------
// TODO(verify on a host): `plesk ext wp-toolkit --remove -instance-id <id>` is the WP Toolkit CLI's uninstall
// (removes files + DB). If it doesn't exist on this WP Toolkit version, removing the subdomain still removes the
// files; check the clone's database is dropped with it (Plesk drops databases assigned to a removed domain).
export async function deleteClone(host: string, fqdn: string, stagingInst: number | null, liveInstGuard: number | null, log: Log)
  : Promise<{ ok: boolean; error?: string }> {
  const label = fqdn.split('.')[0];
  const parent = fqdn.slice(label.length + 1);
  if (!STAGING_LABEL_RE.test(label) || !parent) return { ok: false, error: `refusing to delete non-staging domain ${fqdn}` };

  if (stagingInst && stagingInst !== liveInstGuard) {
    // Re-check the instance id still belongs to the staging subdomain before removing it.
    const inst = await findInstance(host, fqdn);
    if (!('error' in inst) && inst.id === stagingInst) {
      const rm = await sshExec(host, `plesk ext wp-toolkit --remove -instance-id ${stagingInst} 2>&1`, 600);
      await log(`$ plesk ext wp-toolkit --remove -instance-id ${stagingInst}\n${tail(out(rm), 500)}`);
    } else {
      await log(`staging instance ${stagingInst} not found at ${fqdn} (already removed?)`);
    }
  }
  const sd = await sshExec(host, `plesk bin subdomain --remove ${shellQ(label)} -domain ${shellQ(parent)} 2>&1 || true`, 300);
  const o = out(sd);
  await log(`$ plesk bin subdomain --remove ${label} -domain ${parent}\n${tail(o, 500)}`);
  // Same tolerance as onboarding's stagingRemovalOk: "does not exist" counts as removed.
  const ok = /does not exist|not found|no such|unable to find|was not found|is not found/i.test(o)
    || /SUCCESS:|completed|was removed|successfully removed|removal of .* completed/i.test(o)
    || (sd.ok && !/\bfailed to\b|\bcannot\b|permission denied|error:/i.test(o));
  return ok ? { ok: true } : { ok: false, error: tail(o, 300) };
}
