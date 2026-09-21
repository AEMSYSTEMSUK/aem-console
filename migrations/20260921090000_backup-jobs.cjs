// Backups & Restore module — Phase 1. On-demand "Run backup now" jobs, one row per triggered
// Plesk server backup. Read-only history/detail needs no schema (it reads the live dumps repo over
// SSH + the existing server_health snapshots); this table just tracks operator-triggered runs.
exports.up = (pgm) => {
  pgm.createTable('backup_jobs', {
    id: 'id',
    server_id: { type: 'integer', notNull: true, references: 'servers(id)', onDelete: 'cascade' },
    kind: { type: 'text', notNull: true, default: 'server' }, // 'server' full backup (Phase 1); subscription/restore later
    status: { type: 'text', notNull: true, default: 'running' },
    pid: { type: 'integer' },              // detached pleskbackup PID on the remote host
    log_path: { type: 'text' },            // remote log file we tail for status
    triggered_by: { type: 'text' },        // operator name/email
    started_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    finished_at: { type: 'timestamptz' },
    output: { type: 'text' },              // log tail captured on completion
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('backup_jobs', 'server_id');
  pgm.createIndex('backup_jobs', 'status');
  pgm.addConstraint('backup_jobs', 'backup_jobs_status_check', {
    check: "status IN ('running', 'success', 'failed')",
  });
  pgm.addConstraint('backup_jobs', 'backup_jobs_kind_check', {
    check: "kind IN ('server', 'subscription')",
  });
};

exports.down = (pgm) => {
  pgm.dropTable('backup_jobs');
};
