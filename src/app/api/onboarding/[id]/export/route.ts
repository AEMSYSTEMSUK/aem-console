// /opt/aem-console/src/app/api/onboarding/[id]/export/route.ts
//
// Portable export: produces a tarball with WP files + DB dump + README
// suitable for handing to a customer who wants to host elsewhere.
import { NextRequest, NextResponse } from 'next/server';
import { getWizard } from '@/lib/onboarding';
import { requireUser, HttpError } from '@/lib/rbac';
import { sshExec, scpFromHost } from '@/lib/ssh';
import { mkdirSync, existsSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';

const EXPORT_DIR = '/var/aem-exports';

function writeStatus(wid: number, phase: string, pct: number, message: string) {
  try {
    writeFileSync(`/tmp/aem-export-status-${wid}.json`, JSON.stringify({ phase, pct, message, ts: Date.now() }));
  } catch { /* non-fatal */ }
}
function clearStatus(wid: number) {
  try { unlinkSync(`/tmp/aem-export-status-${wid}.json`); } catch { /* ignore */ }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    const { id } = await ctx.params;
    const wizardId = parseInt(id, 10);
    if (!Number.isFinite(wizardId)) throw new HttpError(400, 'Invalid wizard ID');
    writeStatus(wizardId, 'init', 5, 'Loading wizard metadata');
    const data = await getWizard(wizardId);
    if (!data) throw new HttpError(404, 'Wizard not found');
    const { wizard } = data;

    // Decide source: post-cutover = target_live_server; pre-cutover = staging1
    const isLive = wizard.current_step > 6 && wizard.status === 'completed';
    const sourceServer = (isLive ? wizard.target_live_server : 'staging1') + '.infra.aemsystems.co.uk';
    const domain = isLive ? wizard.real_domain : `${wizard.staging_slug}.aemstaging.co.uk`;

    writeStatus(wizardId, 'discover', 15, `Discovering WP instance on ${sourceServer}`);
    // Find wp-toolkit instance ID on the source
    const listRes = await sshExec(sourceServer, 'plesk ext wp-toolkit --list -format json 2>/dev/null', 30);
    if (!listRes.ok) throw new HttpError(502, `wp-toolkit --list failed on ${sourceServer}: ${listRes.stderr || listRes.error}`);
    const instances = JSON.parse(listRes.stdout) as Array<{ id: number; siteUrl?: string; fullPath?: string }>;
    const inst = instances.find(i => (i.siteUrl || '').includes(domain) || (i.fullPath || '').includes(domain));
    if (!inst) throw new HttpError(404, `No wp-toolkit instance found for ${domain} on ${sourceServer}`);

    writeStatus(wizardId, 'backup', 25, 'Running wp-toolkit backup (this is the slow step)');
    if (!existsSync(EXPORT_DIR)) mkdirSync(EXPORT_DIR, { mode: 0o700 });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const bundleName = `wizard-${wizardId}-${wizard.staging_slug}-${ts}.tar.gz`;
    const bundlePath = join(EXPORT_DIR, bundleName);

    // On the source server: backup, dump DB, write README, tar, then we scp to bastion
    const remoteTmp = `/tmp/aem-export-${wizardId}-${ts}`;
    const readme = [
      `AEM Portable Export — Restore Guide`,
      `===================================`,
      ``,
      `Customer:  ${wizard.customer_name}`,
      `Wizard:    #${wizard.id}`,
      `Domain:    ${domain}`,
      `Source:    ${sourceServer}`,
      `Exported:  ${new Date().toISOString()}`,
      ``,
      `BUNDLE CONTENTS`,
      `--------------`,
      `  files.tar.gz     - WordPress files (wp-content, wp-includes, wp-admin, wp-config.php, .htaccess, index.php, etc.)`,
      `                     EXCLUDES: wp-content/cache and wp-content/uploads/cache (regeneratable).`,
      `  database.sql     - mysqldump of the WP database (CREATE TABLE + INSERT for every table).`,
      `  README.txt       - this file`,
      ``,
      `RESTORE OVERVIEW (any host)`,
      `--------------------------`,
      `1. Create or empty the target WordPress installation.`,
      `2. Extract files.tar.gz over the WP root, overwriting existing files.`,
      `3. Create a fresh MySQL/MariaDB database + user, import database.sql.`,
      `4. Edit wp-config.php with the new DB credentials.`,
      `5. Search-replace OLD_URL with NEW_URL using wp-cli (NEVER a plain SQL UPDATE).`,
      `6. Resave permalinks (Settings -> Permalinks -> Save Changes).`,
      `7. Smoke test: homepage 200, /wp-login.php loads, key feature works.`,
      ``,
      `RESTORE — TARGET IS A PLESK HOST (most common)`,
      `---------------------------------------------`,
      `If the target has Plesk + wp-toolkit:`,
      `  a. In Plesk, create a new subscription for the target domain.`,
      `  b. wp-toolkit -> Install WordPress (any credentials, you will overwrite).`,
      `  c. SSH to the target server, navigate to the httpdocs directory.`,
      `  d. Upload files.tar.gz to /tmp on the target, then:`,
      `       cd /var/www/vhosts/NEW_DOMAIN/httpdocs`,
      `       tar -xzf /tmp/files.tar.gz`,
      `       chown -R NEW_DOMAIN_user:psaserv .   # match Plesk subscription user`,
      `  e. Import the DB:`,
      `       plesk ext wp-toolkit --wp-cli -instance-id <N> -- db import /tmp/database.sql`,
      `       (find <N> via:  plesk ext wp-toolkit --list)`,
      `  f. Edit wp-config.php with the new DB credentials (Plesk usually generates these on subscription create).`,
      `  g. Search-replace + flush:`,
      `       plesk ext wp-toolkit --wp-cli -instance-id <N> -- option update siteurl 'https://NEW_DOMAIN'`,
      `       plesk ext wp-toolkit --wp-cli -instance-id <N> -- option update home    'https://NEW_DOMAIN'`,
      `       plesk ext wp-toolkit --wp-cli -instance-id <N> -- search-replace 'OLD_URL' 'NEW_URL' --skip-columns=guid --all-tables-with-prefix`,
      `       plesk ext wp-toolkit --wp-cli -instance-id <N> -- cache flush`,
      `       plesk ext wp-toolkit --update-site-url -instance-id <N>`,
      `  h. Issue Let's Encrypt SSL for NEW_DOMAIN via Plesk (Domains -> NEW_DOMAIN -> SSL/TLS Certificates -> Let's Encrypt).`,
      ``,
      `RESTORE — TARGET IS A cPANEL HOST (Bluehost, SiteGround legacy, HostGator, etc.)`,
      `------------------------------------------------------------------------------`,
      `  a. cPanel -> File Manager -> public_html. Delete or rename existing content.`,
      `  b. Upload files.tar.gz via File Manager. Right-click -> Extract. Files land in public_html.`,
      `  c. cPanel -> MySQL Databases:`,
      `       - Create database (e.g. cpaneluser_wp).`,
      `       - Create user with strong password.`,
      `       - Add user to database with ALL PRIVILEGES.`,
      `  d. cPanel -> phpMyAdmin -> select your new DB -> Import -> upload database.sql.`,
      `  e. cPanel -> File Manager -> public_html/wp-config.php -> Edit. Set:`,
      `       define('DB_NAME',     'cpaneluser_wp');`,
      `       define('DB_USER',     'cpaneluser_wp');`,
      `       define('DB_PASSWORD', 'the-strong-password');`,
      `       define('DB_HOST',     'localhost');`,
      `  f. If SSH is enabled (Bluehost paid plans, SiteGround GoGeek, etc.), use wp-cli:`,
      `       cd public_html`,
      `       wp option update siteurl https://NEW_DOMAIN`,
      `       wp option update home    https://NEW_DOMAIN`,
      `       wp search-replace https://OLD_DOMAIN https://NEW_DOMAIN --skip-columns=guid`,
      `       wp cache flush`,
      `       wp rewrite flush --hard`,
      `  g. No SSH? Install the 'Better Search Replace' WP plugin and use its UI to replace OLD with NEW URL across all tables.`,
      `  h. cPanel -> SSL/TLS Status -> Run AutoSSL (or enable Let's Encrypt via the host's panel).`,
      ``,
      `RESTORE — TARGET IS MANAGED WP (WP Engine, Kinsta, Pressable, Flywheel)`,
      `--------------------------------------------------------------------`,
      `Most managed-WP hosts have a 'Migrate via Backup' tool in their dashboard:`,
      `  a. Sign in to the dashboard, locate the staging/install you are migrating into.`,
      `  b. Their tool may accept a UpdraftPlus-format backup. files.tar.gz + database.sql do not match that exactly,`,
      `     so the easier path is SSH/SFTP:`,
      `       SFTP your files.tar.gz to the install. Extract (over SSH if available, or extract locally and SFTP individual files).`,
      `       Use phpMyAdmin (most managed hosts provide it) to drop existing tables, then Import database.sql.`,
      `  c. wp-cli search-replace step as above. Managed hosts often have wp-cli pre-installed.`,
      `  d. Most managed hosts auto-handle SSL via Let's Encrypt + auto-renew.`,
      ``,
      `RESTORE — GENERIC SSH/CLI (any Linux host)`,
      `-----------------------------------------`,
      `  Assumes:  Apache or Nginx + PHP-FPM + MySQL/MariaDB + WordPress CLI installed.`,
      `            (Install wp-cli with:  curl -O https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar)`,
      ``,
      `  # 1. Extract files into the webroot (replace anything there)`,
      `  cd /var/www/vhosts/NEW_DOMAIN/httpdocs    # adjust path to your host`,
      `  tar -xzf /tmp/files.tar.gz`,
      `  chown -R webuser:webgroup .               # adjust to your host's www user`,
      ``,
      `  # 2. Create DB + user, import dump`,
      `  mysql -uroot -p -e "CREATE DATABASE newwp DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"`,
      `  mysql -uroot -p -e "CREATE USER 'newwp'@'localhost' IDENTIFIED BY 'STRONG_PASSWORD';"`,
      `  mysql -uroot -p -e "GRANT ALL ON newwp.* TO 'newwp'@'localhost'; FLUSH PRIVILEGES;"`,
      `  mysql -unewwp -p newwp < /tmp/database.sql`,
      ``,
      `  # 3. Update wp-config.php with new DB creds (edit DB_NAME, DB_USER, DB_PASSWORD, DB_HOST)`,
      `  vim wp-config.php`,
      ``,
      `  # 4. wp-cli URL update + search-replace + cache flush`,
      `  wp option update siteurl https://NEW_DOMAIN`,
      `  wp option update home    https://NEW_DOMAIN`,
      `  wp search-replace https://OLD_DOMAIN https://NEW_DOMAIN --skip-columns=guid --all-tables-with-prefix --report-changed-only`,
      `  wp cache flush`,
      `  wp rewrite flush --hard`,
      ``,
      `  # 5. Verify`,
      `  curl -sIL https://NEW_DOMAIN/ | head -3   # expect 200`,
      `  wp core verify-checksums`,
      ``,
      `IMPORTANT — URL SEARCH-REPLACE WARNING`,
      `-------------------------------------`,
      `WordPress stores serialized PHP arrays in the database (widget settings, plugin options, theme mods, etc.).`,
      `A plain SQL UPDATE on the URL columns will CORRUPT serialized data because the byte-length prefixes`,
      `embedded in the serialization get out of sync. NEVER use:`,
      `   UPDATE wp_options SET option_value = REPLACE(option_value, 'old.com', 'new.com');   # BROKEN`,
      ``,
      `ALWAYS use one of:`,
      `   wp search-replace 'old.com' 'new.com' --skip-columns=guid --all-tables-with-prefix`,
      `   Better Search Replace plugin (WP admin -> Tools -> Better Search Replace)`,
      `   interconnect-it Search Replace DB script (PHP-based, runs from browser)`,
      ``,
      `--skip-columns=guid is important: GUIDs should remain unchanged (WP uses them as permanent post identifiers).`,
      ``,
      `POST-RESTORE CHECKLIST`,
      `---------------------`,
      `  [ ] Homepage loads (no 500, no white screen of death)`,
      `  [ ] /wp-login.php loads`,
      `  [ ] Login with the customer's admin credentials works`,
      `  [ ] All page navigation (menu) works without 404s -- if 404s, resave permalinks`,
      `  [ ] All images load (no mixed-content browser warnings)`,
      `  [ ] Key customer feature works (WooCommerce checkout, contact form submission, booking, etc.)`,
      `  [ ] SSL cert is valid + covers both apex and www`,
      `  [ ] Email-sending features work (test the contact form submits and reaches an inbox)`,
      `  [ ] Cache/CDN purged (Cloudflare, Sucuri, host-level cache)`,
      ``,
      `COMMON ISSUES`,
      `------------`,
      `  Symptom: 404 on every page except homepage`,
      `    Fix:   .htaccess missing or permalinks not flushed. Resave permalinks in WP admin OR run 'wp rewrite flush --hard'.`,
      ``,
      `  Symptom: Mixed-content warnings, broken images`,
      `    Fix:   search-replace missed a URL variant. Try the bare-host variant too:`,
      `             wp search-replace 'old.com' 'new.com' --skip-columns=guid`,
      ``,
      `  Symptom: 500 Internal Server Error on every page`,
      `    Fix:   1) Enable WP_DEBUG in wp-config.php and check wp-content/debug.log`,
      `           2) Check PHP version (some plugins won't run on PHP 8.x)`,
      `           3) Check file ownership matches the webserver user`,
      `           4) Check wp-config.php DB credentials are correct`,
      ``,
      `  Symptom: Cannot login (redirects back to wp-login.php endlessly)`,
      `    Fix:   Clear all cookies for the new domain, hard refresh, retry`,
      `           Verify siteurl + home match the URL you're accessing`,
      ``,
      `  Symptom: Admin dashboard shows 'There has been a critical error'`,
      `    Fix:   Plugin/theme conflict. Rename wp-content/plugins to plugins.bak temporarily, retry login,`,
      `           then re-enable plugins one at a time.`,
      ``,
      `SUPPORT`,
      `-------`,
      `Generated by AEM Console. For questions about this export bundle:`,
      `  Email:  support@aemsystems.co.uk`,
      `  Web:    https://aemsystems.co.uk`,
      ``,
    ].join('\n');

    const remoteScript = [
      `set -e`,
      `mkdir -p ${remoteTmp}`,
      `cd ${remoteTmp}`,
      // wp-toolkit native backup
      `plesk ext wp-toolkit --backup -instance-id ${inst.id} 2>&1 | tail -5 || true`,
      // grab newest backup file
      `WP_BACKUP=$(plesk ext wp-toolkit --list -format json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); bs=[(b.get('id'), b.get('createdAt',''), b.get('size')) for i in d if i.get('id')==${inst.id} for b in (i.get('backups') or [])]; bs.sort(key=lambda x: x[1], reverse=True); print(bs[0][0] if bs else '')")`,
      // raw files tarball (excludes large caches)
      `tar --warning=no-file-changed -czf files.tar.gz -C "${inst.fullPath}" --exclude=wp-content/cache --exclude=wp-content/uploads/cache . || true`,
      // db dump via wp-cli
      `plesk ext wp-toolkit --wp-cli -instance-id ${inst.id} -- db export ${remoteTmp}/database.sql 2>&1 | tail -3`,
      // readme
      `cat > README.txt <<'EOF'\n${readme}\nEOF`,
      // bundle
      `tar -czf bundle.tar.gz files.tar.gz database.sql README.txt`,
      `ls -lh ${remoteTmp}/bundle.tar.gz`,
    ].join('\n');

    writeStatus(wizardId, 'build', 50, 'Building files.tar.gz + database.sql + bundle on source server');
    const buildRes = await sshExec(sourceServer, remoteScript, 5 * 60);
    if (!buildRes.ok) throw new HttpError(500, `Export build failed on ${sourceServer}: ${buildRes.stderr || buildRes.stdout || buildRes.error}`);
    writeStatus(wizardId, 'transfer', 85, `Transferring bundle to bastion`);

    // Copy bundle from source server to bastion's EXPORT_DIR
    const scpRes = await scpFromHost(sourceServer, `${remoteTmp}/bundle.tar.gz`, bundlePath, 5 * 60);
    if (!scpRes.ok) throw new HttpError(500, `Bundle transfer failed: ${scpRes.stderr || scpRes.error}`);

    writeStatus(wizardId, 'cleanup', 95, 'Cleaning up temp files on source');
    // Cleanup remote tmp
    await sshExec(sourceServer, `rm -rf ${remoteTmp}`, 15);

    writeStatus(wizardId, 'done', 100, 'Export complete');
    setTimeout(() => clearStatus(wizardId), 30_000);
    const stat = statSync(bundlePath);
    return NextResponse.json({
      ok: true,
      filename: bundleName,
      size_bytes: stat.size,
      download_url: `/api/onboarding/${wizardId}/export/download?file=${encodeURIComponent(bundleName)}`,
    });
  } catch (e) {
    try {
      const { id: idStr } = await ctx.params;
      const wid = parseInt(idStr, 10);
      if (Number.isFinite(wid)) writeStatus(wid, 'error', 0, (e as Error)?.message ?? 'Unknown error');
    } catch { /* nested catch — ignore */ }
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error)?.message ?? 'Internal error' }, { status: 500 });
  }
}
