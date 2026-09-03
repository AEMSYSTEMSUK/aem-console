// /opt/aem-console/src/app/api/onboarding/[id]/export-plugin/route.ts
//
// One-click: install + activate a free WP export/migration plugin on the SOURCE site
// (via wp-toolkit) so a non-technical customer can self-export to another host.
// Companion to the portable-bundle export route. Default: All-in-One WP Migration.
import { NextRequest, NextResponse } from 'next/server';
import { getWizard } from '@/lib/onboarding';
import { requireUser, HttpError } from '@/lib/rbac';
import { sshExec } from '@/lib/ssh';

// Allow-list of known-good free export/migration plugins (wordpress.org slugs).
const PLUGINS: Record<string, { name: string; steps: string }> = {
  'all-in-one-wp-migration': {
    name: 'All-in-One WP Migration',
    steps: 'WP admin -> All-in-One WP Migration -> Export -> Export To -> File. Download the .wpress file and import it on the destination host with the same plugin. Note: the FREE importer caps at 512MB on the destination - for larger sites use Migrate Guru.',
  },
  'migrate-guru': {
    name: 'Migrate Guru',
    steps: 'WP admin -> Migrate Guru -> enter destination host details -> migrates server-side (no size limit, ~200GB free). Best for pushing straight onto the new host rather than downloading a file.',
  },
  'wp-migrate-db': {
    name: 'WP Migrate Lite',
    steps: 'WP admin -> Tools -> WP Migrate -> Export -> choose what to include -> download the ZIP.',
  },
  'duplicator': {
    name: 'Duplicator',
    steps: 'WP admin -> Duplicator -> Create New -> Build -> download Installer + Archive, then run installer.php on the destination.',
  },
};

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    const { id } = await ctx.params;
    const wizardId = parseInt(id, 10);
    if (!Number.isFinite(wizardId)) throw new HttpError(400, 'Invalid wizard ID');
    const slug = (req.nextUrl.searchParams.get('plugin') || 'all-in-one-wp-migration').trim();
    const plugin = PLUGINS[slug];
    if (!plugin) throw new HttpError(400, `Unknown plugin '${slug}'. Allowed: ${Object.keys(PLUGINS).join(', ')}`);

    const data = await getWizard(wizardId);
    if (!data) throw new HttpError(404, 'Wizard not found');
    const { wizard } = data;
    const isLive = wizard.current_step > 6 && wizard.status === 'completed';
    const sourceServer = (isLive ? wizard.target_live_server : 'staging1') + '.infra.aemsystems.co.uk';
    const domain = isLive ? wizard.real_domain : `${wizard.staging_slug}.aemstaging.co.uk`;

    // Find the wp-toolkit instance for this domain on the source server (same approach as the export route).
    const listRes = await sshExec(sourceServer, 'plesk ext wp-toolkit --list -format json 2>/dev/null', 30);
    if (!listRes.ok) throw new HttpError(502, `wp-toolkit --list failed on ${sourceServer}: ${listRes.stderr || listRes.error}`);
    const instances = JSON.parse(listRes.stdout) as Array<{ id: number; siteUrl?: string; fullPath?: string }>;
    const inst = instances.find(i => (i.siteUrl || '').includes(domain) || (i.fullPath || '').includes(domain));
    if (!inst) throw new HttpError(404, `No wp-toolkit instance found for ${domain} on ${sourceServer}`);

    // Install + activate the plugin via wp-toolkit wp-cli.
    const cmd = `plesk ext wp-toolkit --wp-cli -instance-id ${inst.id} -- plugin install ${slug} --activate 2>&1 | tail -8`;
    const installRes = await sshExec(sourceServer, cmd, 120);
    if (!installRes.ok) throw new HttpError(500, `Plugin install failed on ${sourceServer}: ${installRes.stderr || installRes.stdout || installRes.error}`);
    const out = installRes.stdout || '';
    const installedOk = /installed|already installed|activated|Success/i.test(out);

    return NextResponse.json({
      ok: true,
      installed_ok: installedOk,
      plugin: plugin.name,
      slug,
      source_server: sourceServer,
      domain,
      instance_id: inst.id,
      admin_url: `https://${domain}/wp-admin/`,
      customer_steps: plugin.steps,
      wp_cli_output: out.slice(-1500),
    });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error)?.message ?? 'Internal error' }, { status: 500 });
  }
}
