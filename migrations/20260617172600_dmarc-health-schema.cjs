exports.up = (pgm) => {
  pgm.createTable('dmarc_health', {
    id: 'id',
    site_id: { type: 'integer', references: 'sites(id)', onDelete: 'CASCADE' },
    domain: { type: 'varchar(255)', notNull: true },
    captured_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    has_spf: { type: 'boolean' },
    spf_record: { type: 'text' },
    spf_includes_aem_relay: { type: 'boolean' },
    spf_qualifier: { type: 'varchar(10)' },
    has_dkim_default: { type: 'boolean' },
    dkim_default_record: { type: 'text' },
    has_dmarc: { type: 'boolean' },
    dmarc_record: { type: 'text' },
    dmarc_policy: { type: 'varchar(20)' },
    dmarc_pct: { type: 'integer' },
    severity: { type: 'varchar(20)' },
    notes: { type: 'text' },
    raw: { type: 'jsonb' },
  });
  pgm.createIndex('dmarc_health', 'site_id');
  pgm.createIndex('dmarc_health', 'domain');
  pgm.createIndex('dmarc_health', 'captured_at');
  pgm.createIndex('dmarc_health', 'severity');
};
exports.down = (pgm) => pgm.dropTable('dmarc_health');
