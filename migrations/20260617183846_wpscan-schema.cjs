exports.up = (pgm) => {
  pgm.createTable('wpscan_plugin_data', {
    id: 'id',
    slug: { type: 'varchar(255)', notNull: true, unique: true },
    friendly_name: { type: 'varchar(255)' },
    latest_version: { type: 'varchar(50)' },
    popular: { type: 'boolean' },
    vulnerabilities: { type: 'jsonb' },
    raw: { type: 'jsonb' },
    not_found: { type: 'boolean', notNull: true, default: false },
    fetched_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('wpscan_plugin_data', 'slug');
  pgm.createIndex('wpscan_plugin_data', 'fetched_at');
};
exports.down = (pgm) => pgm.dropTable('wpscan_plugin_data');
