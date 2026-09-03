exports.up = (pgm) => {
  pgm.createTable('alerts', {
    id: 'id',
    source: { type: 'varchar(50)', notNull: true, default: 'unknown' },
    severity: { type: 'varchar(20)', notNull: true, default: 'info' },
    subject: { type: 'varchar(500)' },
    from_address: { type: 'varchar(255)' },
    to_address: { type: 'varchar(255)' },
    site_domain: { type: 'varchar(255)' },
    server_id: { type: 'integer', references: 'servers(id)', onDelete: 'SET NULL' },
    raw_headers: { type: 'jsonb' },
    raw_body: { type: 'text' },
    parsed: { type: 'jsonb' },
    received_at: { type: 'timestamptz', notNull: true },
    imap_uid: { type: 'integer' },
    forwarded_at: { type: 'timestamptz' },
    acknowledged_at: { type: 'timestamptz' },
    acknowledged_by_user_id: { type: 'integer', references: 'users(id)', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('alerts', 'source');
  pgm.createIndex('alerts', 'severity');
  pgm.createIndex('alerts', 'received_at');
  pgm.createIndex('alerts', 'server_id');
  pgm.createIndex('alerts', 'acknowledged_at');
  pgm.addConstraint('alerts', 'alerts_imap_uid_uniq', { unique: ['imap_uid', 'to_address'] });
};

exports.down = (pgm) => pgm.dropTable('alerts');
