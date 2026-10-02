import { db } from '@/lib/db';
import { heldReason, isCoreMajor, type PatchPolicy, type PendingItem } from '@/lib/wp-patch-policy';
import { SLUG_RE, VERSION_RE } from './remote';

// #220 phase 2 — what to patch on a site, and whether it needs a human.
//
// Approval rule (owner decision, 2 Oct 2026):
//   mode 'report'                     -> never patched (site not planned at all)
//   mode 'approve' or client_approval -> everything needs staff approval
//   mode 'auto'                       -> minor/patch and security items go live automatically once staging
//                                        passes; a MAJOR (non-security) item needs staff (admin) approval
// Held items (exclude_slugs, hold_core_major) are never applied.

export interface PlannedItem {
  kind: 'plugin' | 'theme' | 'core';
  slug: string;
  name: string | null;
  from_version: string | null;
  to_version: string;
  is_major: boolean;
  security: boolean;
}

export interface SitePlan {
  items: PlannedItem[];
  held: Array<{ slug: string; kind: string; reason: string }>;
}

// Major = first version segment changes for plugins/themes; for core, WordPress's own definition (6.6 -> 6.7).
// Unknown current version counts as major (errs towards asking a human).
export function isMajor(kind: PlannedItem['kind'], from: string | null, to: string): boolean {
  if (kind === 'core') return isCoreMajor(from, to);
  if (!from) return true;
  const first = (v: string) => parseInt(v.replace(/^v/i, '').split('.')[0], 10);
  const a = first(from), b = first(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
  return a !== b;
}

const norm = (s: string) => s.toLowerCase().replace(/_/g, '-');

// Items with a known vulnerability on this site (the Console's cve_matches, filled by the CVE + WPScan matchers).
// A match counts when it's for the same kind + slug and recorded against the version we're updating FROM (or no
// version recorded).
async function vulnerableKeys(siteId: number): Promise<Array<{ kind: string; slug: string; version: string | null }>> {
  const r = await db.query<{ target_type: string; target_slug: string | null; installed_version: string | null }>(
    `SELECT target_type, target_slug, installed_version FROM cve_matches WHERE site_id = $1`, [siteId]);
  return r.rows
    .filter(m => m.target_slug)
    .map(m => ({ kind: String(m.target_type).toLowerCase(), slug: norm(String(m.target_slug)), version: m.installed_version }));
}

export async function planSite(siteId: number, policy: PatchPolicy): Promise<SitePlan> {
  const pend = await db.query<PendingItem>(
    `SELECT kind, slug, name, current_version, new_version FROM wp_pending_updates WHERE site_id = $1`, [siteId]);
  const vulns = await vulnerableKeys(siteId);
  const items: PlannedItem[] = [];
  const held: SitePlan['held'] = [];
  for (const p of pend.rows) {
    const reason = heldReason(p, policy);
    if (reason) { held.push({ slug: p.slug, kind: p.kind, reason }); continue; }
    if (!p.new_version || !VERSION_RE.test(p.new_version) || !SLUG_RE.test(p.slug)
        || (p.current_version !== null && !VERSION_RE.test(p.current_version))) {
      held.push({ slug: p.slug, kind: p.kind, reason: 'unsafe slug/version' });
      continue;
    }
    const security = vulns.some(v =>
      (p.kind === 'core' ? (v.kind === 'core' || v.slug === 'wordpress') : v.kind === p.kind && v.slug === norm(p.slug))
      && (v.version === null || p.current_version === null || v.version === p.current_version));
    items.push({
      kind: p.kind, slug: p.slug, name: p.name, from_version: p.current_version, to_version: p.new_version,
      is_major: isMajor(p.kind, p.current_version, p.new_version), security,
    });
  }
  return { items, held };
}

export function needsApproval(policy: PatchPolicy, items: Array<Pick<PlannedItem, 'is_major' | 'security'>>): boolean {
  if (policy.mode === 'approve' || policy.client_approval) return true;
  if (policy.mode === 'auto') return items.some(i => i.is_major && !i.security);
  return true; // 'report' never gets here; anything unexpected waits for a human
}
