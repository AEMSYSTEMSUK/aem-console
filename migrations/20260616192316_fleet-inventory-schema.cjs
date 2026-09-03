exports.up = (pgm) => {
  pgm.createTable('servers', {
    id: 'id',
    name: { type: 'varchar(100)', notNull: true, unique: true },
    fqdn: { type: 'varchar(255)', notNull: true, unique: true },
    role: { type: 'varchar(50)', notNull: true },
    plesk_api_url: { type: 'varchar(255)' },
    notes: { type: 'text' },
    enabled: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('integration_tokens', {
    id: 'id',
    server_id: { type: 'integer', notNull: true, references: 'servers(id)', onDelete: 'CASCADE' },
    type: { type: 'varchar(50)', notNull: true },
    encrypted_token: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('integration_tokens', 'server_id');

  pgm.createTable('server_health', {
    id: 'id',
    server_id: { type: 'integer', notNull: true, references: 'servers(id)', onDelete: 'CASCADE' },
    captured_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    plesk_version: { type: 'varchar(50)' },
    os_version: { type: 'varchar(100)' },
    kernel_version: { type: 'varchar(100)' },
    disk_usage_pct: { type: 'integer' },
    disk_total_gb: { type: 'integer' },
    last_backup_at: { type: 'timestamptz' },
    last_backup_status: { type: 'varchar(50)' },
    last_backup_size_mb: { type: 'bigint' },
    uptime_seconds: { type: 'bigint' },
    raw: { type: 'jsonb' },
  });
  pgm.createIndex('server_health', 'server_id');
  pgm.createIndex('server_health', 'captured_at');

  pgm.createTable('sites', {
    id: 'id',
    domain: { type: 'varchar(255)', notNull: true },
    host_server_id: { type: 'integer', references: 'servers(id)', onDelete: 'SET NULL' },
    subscription_id: { type: 'integer' },
    lifecycle_stage: { type: 'varchar(50)', notNull: true, default: 'unknown' },
    is_wordpress: { type: 'boolean', notNull: true, default: false },
    wp_version: { type: 'varchar(50)' },
    has_mu_plugin: { type: 'boolean' },
    last_seen_at: { type: 'timestamptz' },
    notes: { type: 'text' },
    raw: { type: 'jsonb' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('sites', 'host_server_id');
  pgm.createIndex('sites', 'domain');
  pgm.createIndex('sites', 'lifecycle_stage');
  pgm.addConstraint('sites', 'sites_domain_server_uniq', { unique: ['domain', 'host_server_id'] });

  pgm.createTable('standards', {
    id: 'id',
    name: { type: 'varchar(100)', notNull: true, unique: true },
    severity: { type: 'varchar(20)', notNull: true },
    description: { type: 'text' },
    canonical_value: { type: 'jsonb' },
    propagation_rule: { type: 'varchar(50)', notNull: true, default: 'manual' },
    enabled: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('drift_records', {
    id: 'id',
    server_id: { type: 'integer', references: 'servers(id)', onDelete: 'CASCADE' },
    site_id: { type: 'integer', references: 'sites(id)', onDelete: 'CASCADE' },
    standard_id: { type: 'integer', notNull: true, references: 'standards(id)', onDelete: 'CASCADE' },
    current_value: { type: 'jsonb' },
    expected_value: { type: 'jsonb' },
    status: { type: 'varchar(20)', notNull: true },
    detected_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    resolved_at: { type: 'timestamptz' },
    notes: { type: 'text' },
  });
  pgm.createIndex('drift_records', 'server_id');
  pgm.createIndex('drift_records', 'site_id');
  pgm.createIndex('drift_records', 'standard_id');
  pgm.createIndex('drift_records', 'status');

  pgm.createTable('server_exceptions', {
    id: 'id',
    server_id: { type: 'integer', notNull: true, references: 'servers(id)', onDelete: 'CASCADE' },
    standard_id: { type: 'integer', notNull: true, references: 'standards(id)', onDelete: 'CASCADE' },
    reason: { type: 'text', notNull: true },
    owner_user_id: { type: 'integer', references: 'users(id)', onDelete: 'SET NULL' },
    expires_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('server_exceptions', 'server_id');
};

exports.down = (pgm) => {
  pgm.dropTable('server_exceptions');
  pgm.dropTable('drift_records');
  pgm.dropTable('standards');
  pgm.dropTable('sites');
  pgm.dropTable('server_health');
  pgm.dropTable('integration_tokens');
  pgm.dropTable('servers');
};
