import { db } from '@/lib/db';
import { sshExec } from '@/lib/ssh';

export interface Eligibility { eligible: boolean; reason?: string; }
export function isEligible(name: string, role: string): Eligibility {
  if (name === 'bastion' || role === 'console') return { eligible: false, reason: 'self — manual updates only' };
  if (name === 'db1')                          return { eligible: false, reason: 'Console DB dependency — manual updates only' };
  if (role === 'unifi-controller')             return { eligible: false, reason: 'UniFi — handled separately (#108)' };
  return { eligible: true };
}

export interface ScanResult {
  pending_packages: number;
  pending_kernel:   number;
  reboot_required:  boolean;
  os:               string;
  uptime:           string;
}

export async function scanServer(serverId: number): Promise<ScanResult | null> {
  const s = await db.query<{ fqdn: string; name: string; role: string }>(
    `SELECT fqdn, name, role FROM servers WHERE id = $1 AND enabled = true`, [serverId]);
  if (s.rows.length === 0) return null;
  const { fqdn } = s.rows[0];

  const cmd = `apt-get update -qq 2>&1 >/dev/null || true; ` +
    `echo PENDING_START; apt list --upgradable 2>/dev/null | grep -v '^Listing' | wc -l; ` +
    `echo KERNEL_START; apt list --upgradable 2>/dev/null | grep -E '^linux-image|^linux-headers' | wc -l; ` +
    `echo REBOOT_START; [ -f /var/run/reboot-required ] && echo YES || echo no; ` +
    `echo OS_START; lsb_release -d 2>/dev/null | sed 's/Description:\\s*//'; ` +
    `echo UPTIME_START; uptime -p`;
  const r = await sshExec(fqdn, cmd, 90);
  if (!r.ok) return null;
  const get = (k: string) => {
    const m = new RegExp(`${k}_START\\s*\\n([^\\n]*)`).exec(r.stdout);
    return m ? m[1].trim() : '';
  };
  const result: ScanResult = {
    pending_packages: parseInt(get('PENDING'), 10) || 0,
    pending_kernel:   parseInt(get('KERNEL'),  10) || 0,
    reboot_required:  /^YES$/.test(get('REBOOT')),
    os:               get('OS'),
    uptime:           get('UPTIME'),
  };
  await db.query(
    `UPDATE servers
       SET pending_packages_count = $1,
           pending_kernel_count   = $2,
           reboot_required        = $3,
           last_apt_scan_at       = NOW()
     WHERE id = $4`,
    [result.pending_packages, result.pending_kernel, result.reboot_required, serverId]);
  return result;
}

export async function scanFleet(): Promise<{ scanned: number; failed: number }> {
  const ss = await db.query<{ id: number; name: string; role: string }>(
    `SELECT id, name, role FROM servers WHERE enabled = true ORDER BY id`);
  let scanned = 0, failed = 0;
  for (const s of ss.rows) {
    try { const r = await scanServer(s.id); if (r) scanned++; else failed++; } catch { failed++; }
  }
  return { scanned, failed };
}

export async function triggerUpgrade(
  serverId: number,
  kind: 'upgrade' | 'upgrade-and-reboot' | 'reboot',
  userId: number,
): Promise<{ jobId: number } | { error: string }> {
  const s = await db.query<{ name: string; role: string }>(
    `SELECT name, role FROM servers WHERE id = $1 AND enabled = true`, [serverId]);
  if (s.rows.length === 0) return { error: 'Server not found or disabled' };
  const elig = isEligible(s.rows[0].name, s.rows[0].role);
  if (!elig.eligible) return { error: elig.reason || 'Not eligible for orchestration' };

  const j = await db.query<{ id: number }>(
    `INSERT INTO server_update_jobs (server_id, kind, status, progress_pct, triggered_by_user_id)
     VALUES ($1, $2, 'pending', 0, $3) RETURNING id`,
    [serverId, kind, userId]);
  const jobId = j.rows[0].id;

  void runUpgradeJob(jobId).catch(async (e) => {
    await db.query(
      `UPDATE server_update_jobs SET status='failed', error=$1, completed_at=NOW() WHERE id=$2`,
      [String(e?.message ?? e), jobId]);
  });
  return { jobId };
}

async function setJob(jobId: number, fields: Record<string, any>) {
  const sets: string[] = []; const vals: any[] = []; let i = 1;
  for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = $${i}`); vals.push(v); i++; }
  vals.push(jobId);
  await db.query(`UPDATE server_update_jobs SET ${sets.join(', ')} WHERE id = $${i}`, vals);
}

async function snapshotServer(fqdn: string) {
  // Service check covers both Plesk mail/web stack and generic boxes (ssh/cron/docker/db/firewall),
  // so non-Plesk fleet members report meaningful status instead of a wall of "not-found". [#94]
  const r = await sshExec(fqdn,
    `uname -r; echo ---; dpkg -l | awk '{print $2,$3}' | head -50; echo ---; ` +
    `for svc in ssh cron postfix dovecot psa nginx apache2 plesk-php83-fpm docker mysql mariadb postgresql fail2ban ufw; do ` +
    `st=$(systemctl is-active "$svc" 2>/dev/null); [ "$st" = "active" ] && echo "$svc=$st"; done | head -20`, 30);
  return { snapshot: r.stdout.slice(0, 4000) };
}

export async function runUpgradeJob(jobId: number): Promise<void> {
  const j = await db.query<any>(
    `SELECT j.*, s.fqdn, s.name FROM server_update_jobs j JOIN servers s ON s.id = j.server_id WHERE j.id = $1`, [jobId]);
  if (j.rows.length === 0) throw new Error('Job not found');
  const job = j.rows[0];
  const fqdn = job.fqdn;

  await setJob(jobId, { status: 'running', progress_pct: 10 });

  const pre = await snapshotServer(fqdn);
  await setJob(jobId, { pre_state: pre as any, progress_pct: 20 });

  // apt update
  let outputs = '';
  if (job.kind === 'upgrade' || job.kind === 'upgrade-and-reboot') {
    const u = await sshExec(fqdn, `apt-get update 2>&1 | tail -20`, 120);
    outputs += `\n$ apt-get update\n${u.stdout}\n`;
    await setJob(jobId, { progress_pct: 35 });

    const upg = await sshExec(fqdn,
      `DEBIAN_FRONTEND=noninteractive apt-get -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" upgrade 2>&1 | tail -80`,
      1800);
    outputs += `\n$ apt-get upgrade\n${upg.stdout}\n`;
    if (!upg.ok) {
      await setJob(jobId, { status: 'failed', output: outputs, error: upg.stdout || upg.stderr || upg.error, completed_at: new Date() as any });
      return;
    }
    // Detect held-back packages (apt-get upgrade is conservative; major version
    // bumps like PHP 8.3 -> 8.4 get held. Surface them so admin knows.)
    const heldBack = await sshExec(fqdn,
      `apt list --upgradable 2>/dev/null | grep -v '^Listing' | head -30 ; ` +
      `echo '--- held-back simulation ---' ; ` +
      `apt-get -s upgrade 2>&1 | grep -A50 'kept back' | head -20`, 30);
    if (heldBack.stdout && heldBack.stdout.trim().length > 0) {
      outputs += `\n--- packages still pending after apt-get upgrade ---\n${heldBack.stdout}\n` +
                 `Note: 'apt-get upgrade' will not install packages that require removing others ` +
                 `(major version changes, new dependencies). Review these manually — for PHP ` +
                 `version upgrades use Plesk's per-subscription PHP manager, not host apt.\n`;
    }
    await setJob(jobId, { output: outputs, progress_pct: 65 });
  }

  // Reboot
  if (job.kind === 'reboot' || job.kind === 'upgrade-and-reboot') {
    // Check if reboot actually needed (or forced)
    const rr = await sshExec(fqdn, `[ -f /var/run/reboot-required ] && echo YES || echo no`, 15);
    const needsReboot = /YES/.test(rr.stdout);
    const forced = job.kind === 'reboot';
    if (needsReboot || forced) {
      outputs += `\n$ scheduled reboot in 1 minute (needsReboot=${needsReboot} forced=${forced})\n`;
      await sshExec(fqdn, `(sleep 60 && systemctl reboot) &`, 10).catch(() => {});
      await setJob(jobId, { output: outputs, progress_pct: 75 });

      // Wait for server to drop and return
      await waitForReturn(fqdn, jobId, outputs);
    } else {
      outputs += `\nNo reboot required and not forced — skipped.\n`;
      await setJob(jobId, { output: outputs, progress_pct: 85 });
    }
  }

  // Post-upgrade snapshot + rescan
  const post = await snapshotServer(fqdn);
  await setJob(jobId, { post_state: post as any, progress_pct: 90 });
  try { await scanServer(job.server_id); } catch {}
  await setJob(jobId, { status: 'success', progress_pct: 100, completed_at: new Date() as any });
}

async function waitForReturn(fqdn: string, jobId: number, prevOutput: string) {
  // Wait up to 7 min: 70s grace, then poll every 10s
  await new Promise((r) => setTimeout(r, 70000));
  let attempts = 0;
  while (attempts < 35) {
    const r = await sshExec(fqdn, `uptime -p`, 10);
    if (r.ok && r.stdout.trim().length > 0) {
      await setJob(jobId, { output: prevOutput + `\nServer back up: ${r.stdout.trim()}\n`, progress_pct: 88 });
      return;
    }
    attempts++;
    await new Promise((r) => setTimeout(r, 10000));
  }
  throw new Error('Server did not return within 7 minutes of reboot');
}
