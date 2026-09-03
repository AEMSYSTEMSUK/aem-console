import { readFileSync } from 'fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const path = process.env.AEM_CONSOLE_KEY_PATH || '/etc/aem-console/key';
  const raw = readFileSync(path, 'utf8').trim();
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(`encryption key must be 32 bytes (base64 of 32 bytes); got ${key.length}`);
  }
  cachedKey = key;
  return key;
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // format: base64(iv) | base64(tag) | base64(ciphertext)
  return `${iv.toString('base64')}|${tag.toString('base64')}|${enc.toString('base64')}`;
}

export function decrypt(blob: string): string {
  const [ivB64, tagB64, encB64] = blob.split('|');
  if (!ivB64 || !tagB64 || !encB64) throw new Error('malformed encrypted blob');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const enc = Buffer.from(encB64, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString('utf8');
}
