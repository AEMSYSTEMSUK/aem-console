import { promisify } from 'util';
import { exec as execCb, execFile as execFileCb } from 'child_process';

const execAsync = promisify(execCb);
const execFileAsync = promisify(execFileCb);

const KEY_PATH = process.env.AEM_FLEET_SSH_KEY || '/etc/aem-console/keys/aem_fleet_id_ed25519';
const KNOWN_HOSTS = process.env.AEM_FLEET_KNOWN_HOSTS || '/etc/aem-console/keys/known_hosts';

export interface SshResult { stdout: string; stderr: string; ok: boolean; error?: string; }

export async function sshExec(host: string, command: string, timeoutSec = 30): Promise<SshResult> {
  const sshCmd = [
    'ssh',
    '-i', KEY_PATH,
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${Math.min(10, timeoutSec)}`,
    `-o`, `UserKnownHostsFile=${KNOWN_HOSTS}`,
    '-o', 'StrictHostKeyChecking=accept-new',
    `root@${host}`,
    command,
  ].map((s) => `'${s.replace(/'/g, "'\\''")}'`).join(' ');

  try {
    const { stdout, stderr } = await execAsync(sshCmd, { timeout: timeoutSec * 1000, maxBuffer: 4 * 1024 * 1024 });
    return { stdout: stdout.toString(), stderr: stderr.toString(), ok: true };
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; code?: number; message?: string };
    return {
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
      ok: false,
      error: err.message ?? String(e),
    };
  }
}

// scp a file FROM a remote fleet host TO a local path on the bastion (shared fleet key + known_hosts).
export async function scpFromHost(host: string, remotePath: string, localPath: string, timeoutSec = 300): Promise<SshResult> {
  try {
    await execFileAsync('scp', [
      '-i', KEY_PATH,
      '-o', 'BatchMode=yes',
      '-o', `UserKnownHostsFile=${KNOWN_HOSTS}`,
      '-o', 'StrictHostKeyChecking=accept-new',
      `root@${host}:${remotePath}`,
      localPath,
    ], { timeout: timeoutSec * 1000, maxBuffer: 4 * 1024 * 1024 });
    return { stdout: '', stderr: '', ok: true };
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; message?: string };
    return { stdout: err.stdout?.toString() ?? '', stderr: err.stderr?.toString() ?? '', ok: false, error: err.message ?? String(e) };
  }
}
