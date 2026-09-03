import { db } from '@/lib/db';
import { decrypt, encrypt } from '@/lib/crypto';

export interface PleskSubscription { id: number; name: string; domain?: string; status?: string; }
export interface PleskDomain { id: number; name: string; hosting_type?: string; status?: string; }
export interface PleskServerInfo { version?: string; os?: string; hostname?: string; }

export interface WPInstance {
  id: number;
  main_domain: string;
  path: string;
  wp_version?: string;
  is_valid?: boolean;
  admin_url?: string;
}

export interface BackupTask {
  id: number | string;
  date?: string;
  status?: string;
  size?: number;
  type?: string;
}

export class PleskClient {
  constructor(private baseUrl: string, private token: string) {}

  private async request<T>(method: string, path: string, body?: object): Promise<T> {
    const url = `${this.baseUrl}/api/v2${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        'X-API-Key': this.token,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Plesk ${method} ${path} ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json() as Promise<T>;
  }

  async serverInfo(): Promise<PleskServerInfo> { return this.request('GET', '/server'); }
  async listSubscriptions(): Promise<PleskSubscription[]> { return this.request('GET', '/subscriptions'); }
  async listDomains(): Promise<PleskDomain[]> { return this.request('GET', '/domains'); }

  async listWPInstances(): Promise<WPInstance[]> {
    try {
      return await this.request<WPInstance[]>('GET', '/extensions/wp-toolkit/instances');
    } catch {
      return []; // WP Toolkit may not be installed on every server
    }
  }

  async wpCliExec(instanceId: number, command: string): Promise<{ stdout: string; stderr: string; code: number }> {
    return this.request('POST', `/extensions/wp-toolkit/instances/${instanceId}/cli`, { command });
  }

  async listBackups(): Promise<BackupTask[]> {
    try {
      return await this.request<BackupTask[]>('GET', '/backups');
    } catch {
      return [];
    }
  }

  async testConnection(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const info = await this.serverInfo();
      return { ok: true, version: info.version };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

export async function getPleskClient(serverId: number): Promise<PleskClient | null> {
  const sRes = await db.query<{ plesk_api_url: string | null }>(
    'SELECT plesk_api_url FROM servers WHERE id = $1 AND enabled = true',
    [serverId]
  );
  const s = sRes.rows[0];
  if (!s?.plesk_api_url) return null;
  const tRes = await db.query<{ encrypted_token: string }>(
    `SELECT encrypted_token FROM integration_tokens WHERE server_id = $1 AND type = 'plesk-api' ORDER BY id DESC LIMIT 1`,
    [serverId]
  );
  const t = tRes.rows[0];
  if (!t) return null;
  return new PleskClient(s.plesk_api_url, decrypt(t.encrypted_token));
}

export async function storePleskToken(serverId: number, token: string): Promise<void> {
  await db.query(
    `INSERT INTO integration_tokens (server_id, type, encrypted_token) VALUES ($1, 'plesk-api', $2)`,
    [serverId, encrypt(token)]
  );
}
