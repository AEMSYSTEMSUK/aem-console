import { wp, out, tail, lastLine, tablePrefix, writeFileAs, parseActivePlugins } from './remote';

// #220 phase 2 — sanitise a STAGING clone before any update runs on it. Only ever called with the clone's own
// instance id (engine asserts it differs from the live instance).
//
// Every clone:   mail-blocking mu-plugin, WP_ENVIRONMENT_TYPE=staging, DISABLE_WP_CRON, blog_public=0 (noindex).
//                (Password protection is applied to the vhost BEFORE the clone exists — see staging.ts.)
// WooCommerce:   + payment gateways disabled, Action Scheduler + webhook delivery paused (mu-plugin), wc_webhooks
//                rows set to 'paused'.
// The early steps use --skip-plugins --skip-themes so no site code runs until mail and cron are already blocked.

const MAIL_MU = `<?php
/**
 * AEM staging clone (#220): block ALL outgoing email. Installed by the AEM Console on a staging clone only.
 * Never copy this file to a live site.
 */
add_filter('pre_wp_mail', '__return_true', PHP_INT_MAX);
add_action('phpmailer_init', function ($m) { $m->clearAllRecipients(); }, PHP_INT_MAX);
`;

const WOO_MU = `<?php
/**
 * AEM staging clone (#220): WooCommerce clone sanitising. Pauses Action Scheduler and webhook delivery.
 * Installed by the AEM Console on a staging clone only. Never copy this file to a live site.
 */
add_filter('action_scheduler_allow_async_request_runner', '__return_false', PHP_INT_MAX);
add_filter('action_scheduler_queue_runner_concurrent_batches', '__return_zero', PHP_INT_MAX);
add_filter('woocommerce_webhook_should_deliver', '__return_false', PHP_INT_MAX);
`;

export const MAIL_MU_FILE = 'aem-staging-no-mail.php';
export const WOO_MU_FILE = 'aem-staging-woo-pause.php';

type Log = (line: string) => Promise<void>;

const SKIP = ['--skip-plugins', '--skip-themes'];

// Run one wp-cli step on the clone, log the command + output. Returns ok.
async function step(host: string, inst: number, args: string[], log: Log, timeoutSec = 120): Promise<{ ok: boolean; output: string }> {
  const r = await wp(host, inst, args, timeoutSec);
  const o = out(r);
  await log(`$ ${r.cmd}\n${tail(o, 800) || '(no output)'}${r.ok ? '' : '\n  -> FAILED'}`);
  return { ok: r.ok, output: o };
}

// Is WooCommerce active on this instance? Reads the active_plugins option without loading any plugin code.
export async function detectWoo(host: string, inst: number): Promise<boolean> {
  const r = await wp(host, inst, ['option', 'get', 'active_plugins', '--format=json', ...SKIP], 60);
  return parseActivePlugins(r.stdout).some(p => p === 'woocommerce/woocommerce.php' || p.startsWith('woocommerce/'));
}

export async function sanitiseClone(host: string, inst: number, path: string, isWoo: boolean, log: Log): Promise<{ ok: boolean; error?: string }> {
  const content = `${path}/wp-content`;

  // 1. Mail block first, before anything can load site code.
  const mu = await writeFileAs(host, `${content}/mu-plugins/${MAIL_MU_FILE}`, MAIL_MU, content);
  await log(`write ${content}/mu-plugins/${MAIL_MU_FILE}: ${mu.ok ? 'ok' : 'FAILED ' + tail(out(mu), 400)}`);
  if (!mu.ok) return { ok: false, error: 'could not install the mail-blocking mu-plugin' };

  // 2. wp-config constants (wp config set does not load WordPress).
  const env = await step(host, inst, ['config', 'set', 'WP_ENVIRONMENT_TYPE', 'staging', '--type=constant'], log);
  if (!env.ok) return { ok: false, error: 'could not set WP_ENVIRONMENT_TYPE' };
  const cron = await step(host, inst, ['config', 'set', 'DISABLE_WP_CRON', 'true', '--raw', '--type=constant'], log);
  if (!cron.ok) return { ok: false, error: 'could not set DISABLE_WP_CRON' };

  // 3. noindex.
  const pub = await step(host, inst, ['option', 'update', 'blog_public', '0', ...SKIP], log);
  if (!pub.ok) return { ok: false, error: 'could not set blog_public=0' };

  if (!isWoo) return { ok: true };

  // 4. WooCommerce.
  const wmu = await writeFileAs(host, `${content}/mu-plugins/${WOO_MU_FILE}`, WOO_MU, content);
  await log(`write ${content}/mu-plugins/${WOO_MU_FILE}: ${wmu.ok ? 'ok' : 'FAILED ' + tail(out(wmu), 400)}`);
  if (!wmu.ok) return { ok: false, error: 'could not install the WooCommerce pause mu-plugin' };

  const prefix = await tablePrefix(host, inst, path);
  if (!prefix) return { ok: false, error: 'could not read the clone table prefix (needed to pause webhooks)' };
  // Table may not exist on very old Woo — tolerated (the mu-plugin also stops delivery).
  await step(host, inst, ['db', 'query', `UPDATE \`${prefix}wc_webhooks\` SET status = 'paused' WHERE status <> 'paused'`], log);

  // Payment gateways: ask WooCommerce for its registered gateway ids (needs plugins loaded — safe now that mail
  // and cron are blocked). Fallback: every woocommerce_*_settings option.
  let optionNames: string[] = [];
  const ids = await step(host, inst, ['eval',
    "if (function_exists('WC')) { echo wp_json_encode(array_keys(WC()->payment_gateways()->payment_gateways())); }",
    '--skip-themes'], log);
  const idList = ids.ok ? parseStringArray(ids.output) : null;
  if (idList && idList.length) {
    optionNames = idList.filter(id => /^[A-Za-z0-9_-]{1,100}$/.test(id)).map(id => `woocommerce_${id}_settings`);
  } else {
    const ls = await step(host, inst, ['option', 'list', '--search=woocommerce_*_settings', '--field=option_name', ...SKIP], log);
    optionNames = ls.output.split('\n').map(l => l.trim()).filter(l => /^woocommerce_[A-Za-z0-9_-]+_settings$/.test(l));
  }
  if (!optionNames.length) await log('no WooCommerce gateway settings found to disable');
  for (const name of optionNames) {
    // Errors here usually mean the option doesn't exist / has no 'enabled' key — logged, not fatal.
    await step(host, inst, ['option', 'patch', 'update', name, 'enabled', 'no', ...SKIP], log);
  }
  // Confirm no gateway is still enabled before any update (which loads plugin code) runs.
  for (const name of optionNames) {
    const r = await wp(host, inst, ['option', 'pluck', name, 'enabled', ...SKIP], 60);
    if (r.ok && /^yes$/i.test(lastLine(r.stdout))) {
      await log(`gateway option ${name} is STILL enabled`);
      return { ok: false, error: `could not disable payment gateway (${name})` };
    }
  }
  await log(`payment gateways disabled: ${optionNames.join(', ') || '(none)'}`);
  return { ok: true };
}

function parseStringArray(s: string): string[] | null {
  for (const line of (s || '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('[')) continue;
    try {
      const j = JSON.parse(t);
      if (Array.isArray(j)) return j.map(x => String(x));
    } catch { /* next */ }
  }
  return null;
}
