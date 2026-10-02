// #220 phase 2 — staged WordPress patching engine.
//   wp_patch_runs  : one row per cycle (Monday staging run, Tuesday live run, same-day security fast-track).
//   wp_patch_sites : one row per site per staging/fast-track run; the SAME row carries on through the live run
//                    (live_run_id is set when the live run picks it up), so a site's whole journey is one row.
//   wp_patch_items : the exact plugin/theme/core updates (from -> to) tested on staging and then pinned on live.
// Also adds wp_patch_policies.client_approval (opt-in per site: everything needs approval; recorded only).
exports.up = (pgm) => {
  pgm.addColumns('wp_patch_policies', {
    client_approval: { type: 'boolean', notNull: true, default: false },
  });

  pgm.createTable('wp_patch_runs', {
    id: 'id',
    kind: { type: 'text', notNull: true, check: "kind IN ('staging', 'live', 'fasttrack')" },
    started_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    finished_at: { type: 'timestamptz' },
    status: { type: 'text', notNull: true, default: 'running', check: "status IN ('running', 'done', 'failed')" },
    triggered_by: { type: 'text' },   // 'timer', 'scan', 'user:<id>'
    summary: { type: 'jsonb' },
  });
  pgm.createIndex('wp_patch_runs', 'started_at');

  pgm.createTable('wp_patch_sites', {
    id: 'id',
    run_id: { type: 'integer', notNull: true, references: 'wp_patch_runs(id)', onDelete: 'cascade' },
    live_run_id: { type: 'integer', references: 'wp_patch_runs(id)', onDelete: 'set null' },
    site_id: { type: 'integer', notNull: true, references: 'sites(id)', onDelete: 'cascade' },
    state: {
      type: 'text', notNull: true, default: 'pending',
      check: `state IN ('pending','skipped','cloning','sanitising','patching','smoke','staged_ok','staged_failed',
                        'awaiting_approval','approved','live_backup','live_patching','live_smoke','done',
                        'rolled_back','failed')`,
    },
    staging_host: { type: 'text' },        // server FQDN the clone lives on
    staging_domain: { type: 'text' },      // Plesk subdomain created for the clone
    staging_url: { type: 'text' },
    staging_instance_id: { type: 'integer' },
    staging_user: { type: 'text' },        // basic-auth user for the staging vhost
    staging_password: { type: 'text' },    // basic-auth password (staging only, throwaway)
    staging_deleted_at: { type: 'timestamptz' },
    staged_at: { type: 'timestamptz' },    // when the staging smoke passed
    needs_staging1: { type: 'boolean', notNull: true, default: false },
    is_woocommerce: { type: 'boolean', notNull: true, default: false },
    backup_ref: { type: 'text' },          // WP Toolkit backup filename taken on LIVE before patching
    needs_approval: { type: 'boolean', notNull: true, default: false },
    approved_by: { type: 'integer', references: 'users(id)', onDelete: 'set null' },
    approved_at: { type: 'timestamptz' },
    security: { type: 'boolean', notNull: true, default: false },
    error: { type: 'text' },
    log: { type: 'text', notNull: true, default: '' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('wp_patch_sites', 'run_id');
  pgm.createIndex('wp_patch_sites', 'live_run_id');
  pgm.createIndex('wp_patch_sites', 'site_id');
  pgm.createIndex('wp_patch_sites', 'state');

  pgm.createTable('wp_patch_items', {
    id: 'id',
    patch_site_id: { type: 'integer', notNull: true, references: 'wp_patch_sites(id)', onDelete: 'cascade' },
    kind: { type: 'text', notNull: true, check: "kind IN ('plugin', 'theme', 'core')" },
    slug: { type: 'text', notNull: true },
    name: { type: 'text' },
    from_version: { type: 'text' },
    to_version: { type: 'text', notNull: true },
    is_major: { type: 'boolean', notNull: true, default: false },
    security: { type: 'boolean', notNull: true, default: false },
    applied_staging: { type: 'boolean', notNull: true, default: false },
    applied_live: { type: 'boolean', notNull: true, default: false },
  });
  pgm.createIndex('wp_patch_items', 'patch_site_id');
};

exports.down = (pgm) => {
  pgm.dropTable('wp_patch_items');
  pgm.dropTable('wp_patch_sites');
  pgm.dropTable('wp_patch_runs');
  pgm.dropColumns('wp_patch_policies', ['client_approval']);
};
