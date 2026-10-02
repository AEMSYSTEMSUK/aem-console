import { db } from '@/lib/db';

// #220 phase 2 — DB helpers for the staged-patching engine (wp_patch_runs / wp_patch_sites / wp_patch_items).
// Plain TypeScript, no Next.js imports, so the engine can be lifted into ONE later.

export type RunKind = 'staging' | 'live' | 'fasttrack';
export type RunStatus = 'running' | 'done' | 'failed';

export type PatchState =
  | 'pending' | 'skipped' | 'cloning' | 'sanitising' | 'patching' | 'smoke' | 'staged_ok' | 'staged_failed'
  | 'awaiting_approval' | 'approved' | 'live_backup' | 'live_patching' | 'live_smoke' | 'done' | 'rolled_back'
  | 'failed';

// A row in one of these states means a step is executing right now (or the Console died mid-step).
export const TRANSITIONAL_STATES: PatchState[] = [
  'pending', 'cloning', 'sanitising', 'patching', 'smoke', 'staged_ok', 'live_backup', 'live_patching', 'live_smoke',
];
// Staged and waiting for the live run (or for a human).
export const OPEN_STATES: PatchState[] = ['awaiting_approval', 'approved'];
export const LIVE_STATES: PatchState[] = ['live_backup', 'live_patching', 'live_smoke'];

export interface PatchRun {
  id: number;
  kind: RunKind;
  started_at: string;
  finished_at: string | null;
  status: RunStatus;
  triggered_by: string | null;
  summary: Record<string, unknown> | null;
}

export interface PatchSite {
  id: number;
  run_id: number;
  live_run_id: number | null;
  site_id: number;
  state: PatchState;
  staging_host: string | null;
  staging_domain: string | null;
  staging_url: string | null;
  staging_instance_id: number | null;
  staging_user: string | null;
  staging_password: string | null;
  staging_deleted_at: string | null;
  staged_at: string | null;
  needs_staging1: boolean;
  is_woocommerce: boolean;
  backup_ref: string | null;
  needs_approval: boolean;
  approved_by: number | null;
  approved_at: string | null;
  security: boolean;
  error: string | null;
  log: string;
  created_at: string;
  updated_at: string;
}

export interface PatchItem {
  id: number;
  patch_site_id: number;
  kind: 'plugin' | 'theme' | 'core';
  slug: string;
  name: string | null;
  from_version: string | null;
  to_version: string;
  is_major: boolean;
  security: boolean;
  applied_staging: boolean;
  applied_live: boolean;
}

const SITE_COLS = `id, run_id, live_run_id, site_id, state, staging_host, staging_domain, staging_url, staging_instance_id,
  staging_user, staging_password, staging_deleted_at::text, staged_at::text, needs_staging1, is_woocommerce, backup_ref,
  needs_approval, approved_by, approved_at::text, security, error, log, created_at::text, updated_at::text`;

export async function createRun(kind: RunKind, triggeredBy: string): Promise<number> {
  const r = await db.query<{ id: number }>(
    `INSERT INTO wp_patch_runs (kind, status, triggered_by) VALUES ($1, 'running', $2) RETURNING id`, [kind, triggeredBy]);
  return r.rows[0].id;
}

// A run of this kind already in progress (a second timer fire, or a manual curl while the timer runs).
export async function runningRunOfKind(kind: RunKind): Promise<number | null> {
  const r = await db.query<{ id: number }>(
    `SELECT id FROM wp_patch_runs WHERE kind = $1 AND status = 'running' ORDER BY id DESC LIMIT 1`, [kind]);
  return r.rows[0]?.id ?? null;
}

export async function finishRun(runId: number, status: RunStatus, extra: Record<string, unknown> = {}): Promise<void> {
  const counts = await db.query<{ state: string; n: number }>(
    `SELECT state, COUNT(*)::int AS n FROM wp_patch_sites WHERE run_id = $1 OR live_run_id = $1 GROUP BY state`, [runId]);
  const byState: Record<string, number> = {};
  for (const c of counts.rows) byState[c.state] = c.n;
  await db.query(
    `UPDATE wp_patch_runs SET status = $2, finished_at = NOW(), summary = $3 WHERE id = $1`,
    [runId, status, JSON.stringify({ ...extra, states: byState })]);
}

export async function createPatchSite(runId: number, siteId: number, fields: {
  needs_approval: boolean; security: boolean; is_woocommerce: boolean;
}): Promise<number> {
  const r = await db.query<{ id: number }>(
    `INSERT INTO wp_patch_sites (run_id, site_id, state, needs_approval, security, is_woocommerce)
     VALUES ($1, $2, 'pending', $3, $4, $5) RETURNING id`,
    [runId, siteId, fields.needs_approval, fields.security, fields.is_woocommerce]);
  return r.rows[0].id;
}

// A skipped row is still recorded so the run page shows WHY a site wasn't patched this cycle.
export async function recordSkippedSite(runId: number, siteId: number, reason: string, needsStaging1 = false): Promise<number> {
  const r = await db.query<{ id: number }>(
    `INSERT INTO wp_patch_sites (run_id, site_id, state, needs_staging1, error, log)
     VALUES ($1, $2, 'skipped', $3, $4, $5) RETURNING id`,
    [runId, siteId, needsStaging1, reason, `${stamp()} skipped: ${reason}\n`]);
  return r.rows[0].id;
}

export async function getPatchSite(id: number): Promise<PatchSite | null> {
  const r = await db.query<PatchSite>(`SELECT ${SITE_COLS} FROM wp_patch_sites WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

export async function getItems(patchSiteId: number): Promise<PatchItem[]> {
  const r = await db.query<PatchItem>(
    `SELECT id, patch_site_id, kind, slug, name, from_version, to_version, is_major, security, applied_staging, applied_live
       FROM wp_patch_items WHERE patch_site_id = $1
      ORDER BY CASE kind WHEN 'core' THEN 0 WHEN 'plugin' THEN 1 ELSE 2 END, slug`, [patchSiteId]);
  return r.rows;
}

export async function insertItem(patchSiteId: number, it: {
  kind: PatchItem['kind']; slug: string; name: string | null; from_version: string | null; to_version: string;
  is_major: boolean; security: boolean;
}): Promise<void> {
  await db.query(
    `INSERT INTO wp_patch_items (patch_site_id, kind, slug, name, from_version, to_version, is_major, security)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [patchSiteId, it.kind, it.slug, it.name, it.from_version, it.to_version, it.is_major, it.security]);
}

export async function updateItem(itemId: number, fields: Partial<Pick<PatchItem, 'from_version' | 'is_major' | 'applied_staging' | 'applied_live'>>): Promise<void> {
  const sets: string[] = []; const vals: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) { vals.push(v); sets.push(`${k} = $${vals.length}`); }
  if (!sets.length) return;
  vals.push(itemId);
  await db.query(`UPDATE wp_patch_items SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
}

export async function deleteItem(itemId: number): Promise<void> {
  await db.query(`DELETE FROM wp_patch_items WHERE id = $1`, [itemId]);
}

function stamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// Append-only log: every step writes here BEFORE and AFTER it acts, so a crash mid-run is visible on the run page.
export async function appendLog(patchSiteId: number, line: string): Promise<void> {
  const text = line.length > 8000 ? line.slice(0, 8000) + '\n…(truncated)' : line;
  await db.query(
    `UPDATE wp_patch_sites SET log = log || $2, updated_at = NOW() WHERE id = $1`,
    [patchSiteId, `${stamp()} ${text.replace(/\s+$/, '')}\n`]);
}

type SiteFields = Partial<Omit<PatchSite, 'id' | 'run_id' | 'site_id' | 'log' | 'created_at' | 'updated_at'>>;

export async function updatePatchSite(patchSiteId: number, fields: SiteFields): Promise<void> {
  const sets: string[] = []; const vals: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) { vals.push(v); sets.push(`${k} = $${vals.length}`); }
  vals.push(patchSiteId);
  await db.query(`UPDATE wp_patch_sites SET ${sets.join(', ')}${sets.length ? ', ' : ''}updated_at = NOW() WHERE id = $${vals.length}`, vals);
}

export async function setState(patchSiteId: number, state: PatchState, fields: SiteFields = {}, logLine?: string): Promise<void> {
  await updatePatchSite(patchSiteId, { ...fields, state });
  await appendLog(patchSiteId, `[${state}] ${logLine ?? ''}`);
}
