exports.up = (pgm) => {
  pgm.createTable('users', {
    id: 'id',
    email: { type: 'varchar(255)', notNull: true, unique: true },
    display_name: { type: 'varchar(255)' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('webauthn_credentials', {
    id: 'id',
    user_id: { type: 'integer', notNull: true, references: 'users(id)', onDelete: 'CASCADE' },
    credential_id: { type: 'text', notNull: true, unique: true },
    public_key: { type: 'text', notNull: true },
    counter: { type: 'bigint', notNull: true, default: 0 },
    transports: { type: 'text[]' },
    name: { type: 'varchar(255)' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    last_used_at: { type: 'timestamptz' },
  });
  pgm.createIndex('webauthn_credentials', 'user_id');

  pgm.createTable('webauthn_challenges', {
    id: 'id',
    user_id: { type: 'integer', references: 'users(id)', onDelete: 'CASCADE' },
    challenge: { type: 'text', notNull: true, unique: true },
    type: { type: 'varchar(20)', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    expires_at: { type: 'timestamptz', notNull: true },
  });
  pgm.createIndex('webauthn_challenges', 'challenge');
  pgm.createIndex('webauthn_challenges', 'expires_at');

  pgm.createTable('audit_log', {
    id: 'id',
    actor_user_id: { type: 'integer', references: 'users(id)', onDelete: 'SET NULL' },
    action: { type: 'varchar(100)', notNull: true },
    target_type: { type: 'varchar(50)' },
    target_id: { type: 'varchar(100)' },
    before_state: { type: 'jsonb' },
    after_state: { type: 'jsonb' },
    ip_address: { type: 'inet' },
    user_agent: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('audit_log', 'actor_user_id');
  pgm.createIndex('audit_log', 'created_at');
  pgm.createIndex('audit_log', 'target_type');

  pgm.createTable('sessions', {
    id: { type: 'varchar(64)', primaryKey: true },
    user_id: { type: 'integer', notNull: true, references: 'users(id)', onDelete: 'CASCADE' },
    expires_at: { type: 'timestamptz', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('sessions', 'user_id');
  pgm.createIndex('sessions', 'expires_at');
};

exports.down = (pgm) => {
  pgm.dropTable('sessions');
  pgm.dropTable('audit_log');
  pgm.dropTable('webauthn_challenges');
  pgm.dropTable('webauthn_credentials');
  pgm.dropTable('users');
};
