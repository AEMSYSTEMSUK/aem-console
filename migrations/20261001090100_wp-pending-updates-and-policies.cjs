// #220 phase 1 — itemised pending updates (one row per plugin/theme/core update available, replaced wholesale
// on every scan of a site) and per-site patch policy (how/when a site may be patched; consumed by the phase 2
// staged-patching engine, displayed-only for now).
exports.up = (pgm) => {
  pgm.createTable('wp_pending_updates', {
    id: 'id',
    site_id: { type: 'integer', notNull: true, references: 'sites(id)', onDelete: 'cascade' },
    kind: { type: 'text', notNull: true, check: "kind IN ('plugin', 'theme', 'core')" },
    slug: { type: 'text', notNull: true },
    name: { type: 'text' },
    current_version: { type: 'text' },
    new_version: { type: 'text' },
    detected_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('wp_pending_updates', 'wp_pending_updates_site_kind_slug_key', {
    unique: ['site_id', 'kind', 'slug'],
  });

  pgm.createTable('wp_patch_policies', {
    site_id: { type: 'integer', primaryKey: true, references: 'sites(id)', onDelete: 'cascade' },
    enabled: { type: 'boolean', notNull: true, default: true },
    mode: { type: 'text', notNull: true, default: 'approve', check: "mode IN ('auto', 'approve', 'report')" },
    ring: { type: 'text', notNull: true, default: 'standard', check: "ring IN ('pilot', 'flagship', 'standard')" },
    exclude_slugs: { type: 'text[]', notNull: true, default: pgm.func("'{}'::text[]") },
    hold_core_major: { type: 'boolean', notNull: true, default: true },
    smoke_paths: { type: 'text[]', notNull: true, default: pgm.func("'{/}'::text[]") },
    expect_text: { type: 'text' },
    is_woocommerce: { type: 'boolean', notNull: true, default: false },
    notes: { type: 'text' },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('wp_patch_policies');
  pgm.dropTable('wp_pending_updates');
};
