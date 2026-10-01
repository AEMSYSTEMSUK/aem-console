import { db } from '@/lib/db';

// #220 — per-site WordPress patch policy (wp_patch_policies). Phase 1 only stores and displays it; the phase 2
// staged-patching engine will consume it. A site with no row gets DEFAULT_POLICY (approve / standard ring).

export type PatchMode = 'auto' | 'approve' | 'report';
export type PatchRing = 'pilot' | 'flagship' | 'standard';
export const PATCH_MODES: PatchMode[] = ['approve', 'auto', 'report'];
export const PATCH_RINGS: PatchRing[] = ['pilot', 'flagship', 'standard'];

export interface PatchPolicy {
  site_id: number;
  enabled: boolean;
  mode: PatchMode;
  ring: PatchRing;
  exclude_slugs: string[];
  hold_core_major: boolean;
  smoke_paths: string[];
  expect_text: string | null;
  is_woocommerce: boolean;
  notes: string | null;
  updated_at: string | null;
  is_default: boolean;   // true = no row saved yet, these are the defaults
}

export interface PendingItem {
  kind: 'plugin' | 'theme' | 'core';
  slug: string;
  name: string | null;
  current_version: string | null;
  new_version: string | null;
}

export function defaultPolicy(siteId: number): PatchPolicy {
  return {
    site_id: siteId, enabled: true, mode: 'approve', ring: 'standard', exclude_slugs: [],
    hold_core_major: true, smoke_paths: ['/'], expect_text: null, is_woocommerce: false, notes: null,
    updated_at: null, is_default: true,
  };
}

const POLICY_COLS = `site_id, enabled, mode, ring, exclude_slugs, hold_core_major, smoke_paths, expect_text,
                     is_woocommerce, notes, updated_at::text`;

export async function getPolicy(siteId: number): Promise<PatchPolicy> {
  const r = await db.query<Omit<PatchPolicy, 'is_default'>>(
    `SELECT ${POLICY_COLS} FROM wp_patch_policies WHERE site_id = $1`, [siteId]);
  return r.rows[0] ? { ...r.rows[0], is_default: false } : defaultPolicy(siteId);
}

export async function getAllPolicies(): Promise<Map<number, PatchPolicy>> {
  const r = await db.query<Omit<PatchPolicy, 'is_default'>>(`SELECT ${POLICY_COLS} FROM wp_patch_policies`);
  return new Map(r.rows.map(p => [p.site_id, { ...p, is_default: false }]));
}

// WordPress "major" = the first two version segments (6.6.x -> 6.7 is a major). Unknown current version is
// treated as major, so the hold errs on the safe side.
export function isCoreMajor(current: string | null, next: string | null): boolean {
  if (!next) return false;
  if (!current) return true;
  const mm = (v: string) => v.split('.').slice(0, 2).map(n => parseInt(n, 10) || 0).join('.');
  return mm(current) !== mm(next);
}

// Why an item would be held back from patching under this policy, or null if it would be patched.
export function heldReason(item: PendingItem, policy: PatchPolicy): string | null {
  if (item.kind !== 'core' && policy.exclude_slugs.includes(item.slug)) return 'excluded';
  if (item.kind === 'core' && policy.hold_core_major && isCoreMajor(item.current_version, item.new_version)) return 'core major';
  return null;
}

export type PolicyInput = Omit<PatchPolicy, 'site_id' | 'updated_at' | 'is_default'>;

function strList(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\n,]/) : [];
  const out: string[] = [];
  for (const x of arr) {
    const s = String(x ?? '').trim();
    if (s && s.length <= 200 && !out.includes(s)) out.push(s);
  }
  return out.slice(0, 200);
}

function optText(v: unknown, max: number): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s.slice(0, max) : null;
}

// Validate/normalise a JSON body from the policy form.
export function parsePolicyInput(body: any): { value: PolicyInput } | { error: string } {
  const mode = String(body?.mode ?? 'approve');
  if (!PATCH_MODES.includes(mode as PatchMode)) return { error: 'Invalid mode' };
  const ring = String(body?.ring ?? 'standard');
  if (!PATCH_RINGS.includes(ring as PatchRing)) return { error: 'Invalid ring' };
  const smoke = strList(body?.smoke_paths);
  if (smoke.some(p => !p.startsWith('/'))) return { error: 'Smoke paths must start with /' };
  return {
    value: {
      enabled: body?.enabled !== false,
      mode: mode as PatchMode,
      ring: ring as PatchRing,
      exclude_slugs: strList(body?.exclude_slugs),
      hold_core_major: body?.hold_core_major !== false,
      smoke_paths: smoke.length ? smoke : ['/'],
      expect_text: optText(body?.expect_text, 500),
      is_woocommerce: body?.is_woocommerce === true,
      notes: optText(body?.notes, 4000),
    },
  };
}

export async function savePolicy(siteId: number, p: PolicyInput): Promise<void> {
  await db.query(
    `INSERT INTO wp_patch_policies
       (site_id, enabled, mode, ring, exclude_slugs, hold_core_major, smoke_paths, expect_text, is_woocommerce, notes, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
     ON CONFLICT (site_id) DO UPDATE SET
       enabled = EXCLUDED.enabled, mode = EXCLUDED.mode, ring = EXCLUDED.ring,
       exclude_slugs = EXCLUDED.exclude_slugs, hold_core_major = EXCLUDED.hold_core_major,
       smoke_paths = EXCLUDED.smoke_paths, expect_text = EXCLUDED.expect_text,
       is_woocommerce = EXCLUDED.is_woocommerce, notes = EXCLUDED.notes, updated_at = NOW()`,
    [siteId, p.enabled, p.mode, p.ring, p.exclude_slugs, p.hold_core_major, p.smoke_paths, p.expect_text,
     p.is_woocommerce, p.notes]);
}
