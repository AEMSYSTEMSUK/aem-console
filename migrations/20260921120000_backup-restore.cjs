// Backups & Restore — Phase 2. Extend backup_jobs to also track subscription restores and the automatic
// safety backup taken immediately before a restore. target_domain = the subscription being restored;
// source_dump = the dump timestamp/ref restored from.
exports.up = (pgm) => {
  pgm.addColumns('backup_jobs', {
    target_domain: { type: 'text' },
    source_dump: { type: 'text' },
  });
  pgm.dropConstraint('backup_jobs', 'backup_jobs_kind_check');
  pgm.addConstraint('backup_jobs', 'backup_jobs_kind_check', {
    check: "kind IN ('server', 'subscription', 'restore', 'safety-backup')",
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint('backup_jobs', 'backup_jobs_kind_check');
  pgm.addConstraint('backup_jobs', 'backup_jobs_kind_check', {
    check: "kind IN ('server', 'subscription')",
  });
  pgm.dropColumns('backup_jobs', ['target_domain', 'source_dump']);
};
