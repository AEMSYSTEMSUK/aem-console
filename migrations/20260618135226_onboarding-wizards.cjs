exports.up = (pgm) => {
  pgm.createTable('onboarding_wizards', {
    id: 'id',
    customer_name: { type: 'text', notNull: true },
    customer_contact_email: { type: 'text', notNull: true },
    staging_slug: { type: 'text', notNull: true },
    real_domain: { type: 'text', notNull: true },
    target_live_server: { type: 'text', notNull: true, default: 'live1' },
    current_step: { type: 'integer', notNull: true, default: 1 },
    status: { type: 'text', notNull: true, default: 'in_progress' },
    created_by_user_id: { type: 'integer', notNull: true, references: 'users(id)' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    completed_at: { type: 'timestamptz' },
    staging_drop_at: { type: 'timestamptz' },
    staging_dropped_at: { type: 'timestamptz' },
    notes: { type: 'text' },
  });
  pgm.createIndex('onboarding_wizards', 'status');
  pgm.createIndex('onboarding_wizards', 'created_by_user_id');
  pgm.addConstraint('onboarding_wizards', 'onboarding_wizards_status_check', {
    check: "status IN ('in_progress', 'completed', 'failed', 'abandoned')",
  });
  pgm.addConstraint('onboarding_wizards', 'onboarding_wizards_slug_format', {
    check: "staging_slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'",
  });

  pgm.createTable('onboarding_steps', {
    id: 'id',
    wizard_id: { type: 'integer', notNull: true, references: 'onboarding_wizards(id)', onDelete: 'cascade' },
    step_number: { type: 'integer', notNull: true },
    step_name: { type: 'text', notNull: true },
    role_required: { type: 'text', notNull: true, default: 'web' },
    status: { type: 'text', notNull: true, default: 'pending' },
    started_at: { type: 'timestamptz' },
    completed_at: { type: 'timestamptz' },
    output: { type: 'text' },
    error: { type: 'text' },
  });
  pgm.addConstraint('onboarding_steps', 'onboarding_steps_unique_step', {
    unique: ['wizard_id', 'step_number'],
  });
  pgm.addConstraint('onboarding_steps', 'onboarding_steps_status_check', {
    check: "status IN ('pending', 'running', 'success', 'failed', 'skipped')",
  });
  pgm.addConstraint('onboarding_steps', 'onboarding_steps_role_check', {
    check: "role_required IN ('admin', 'web')",
  });
  pgm.createIndex('onboarding_steps', 'wizard_id');
};

exports.down = (pgm) => {
  pgm.dropTable('onboarding_steps');
  pgm.dropTable('onboarding_wizards');
};
