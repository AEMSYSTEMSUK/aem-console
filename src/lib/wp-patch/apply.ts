import { wp, out, tail, installedVersion, SLUG_RE, VERSION_RE } from './remote';
import { updateItem, type PatchItem } from './store';

// #220 phase 2 — apply updates at EXACT versions (never --all). Used for the staging clone and, with the versions
// that passed on staging, for the live site.
//   plugin: wp plugin update <slug> --version=<to>
//   theme:  wp theme update <slug> --version=<to>
//   core:   wp core update --version=<to>   then   wp core update-db
//   woocommerce (after it updates): wp wc update   (WooCommerce DB migrations; failure logged, not fatal)

type Log = (line: string) => Promise<void>;

export function updateArgs(it: Pick<PatchItem, 'kind' | 'slug' | 'to_version'>): string[] {
  if (!VERSION_RE.test(it.to_version)) throw new Error(`unsafe version ${it.to_version}`);
  if (it.kind === 'core') return ['core', 'update', `--version=${it.to_version}`];
  if (!SLUG_RE.test(it.slug)) throw new Error(`unsafe slug ${it.slug}`);
  return [it.kind, 'update', it.slug, `--version=${it.to_version}`];
}

export async function applyItems(host: string, inst: number, items: PatchItem[], target: 'staging' | 'live', log: Log)
  : Promise<{ ok: boolean; error?: string }> {
  // Core first (plugins may require the newer core), then plugins, then themes — getItems() already orders so.
  for (const it of items) {
    const r = await wp(host, inst, updateArgs(it), 900);
    await log(`$ ${r.cmd}\n${tail(out(r), 1200) || '(no output)'}`);
    const now = await installedVersion(host, inst, it.kind, it.slug);
    if (now !== it.to_version) {
      return { ok: false, error: `${it.kind} ${it.slug}: expected ${it.to_version} after update, found ${now ?? 'unknown'}` };
    }
    if (it.kind === 'core') {
      const db = await wp(host, inst, ['core', 'update-db'], 600);
      await log(`$ ${db.cmd}\n${tail(out(db), 600)}`);
    }
    if (it.kind === 'plugin' && it.slug === 'woocommerce') {
      const wc = await wp(host, inst, ['wc', 'update'], 900);
      await log(`$ ${wc.cmd}\n${tail(out(wc), 600)}${wc.ok ? '' : '\n  (wc update failed — WooCommerce will retry its DB update itself)'}`);
    }
    await updateItem(it.id, target === 'staging' ? { applied_staging: true } : { applied_live: true });
    await log(`${it.kind} ${it.slug} now at ${it.to_version}`);
  }
  return { ok: true };
}
