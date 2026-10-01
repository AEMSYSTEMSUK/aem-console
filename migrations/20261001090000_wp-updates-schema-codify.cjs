// #220 phase 0 — codify the WP updates schema that setup-m9-wp-updates.sh created by hand with psql, OUTSIDE
// migrations (schema drift). Every statement is IF NOT EXISTS with the exact column types from that script, so on
// the live DB (where all of this already exists) this is a no-op; on a fresh DB it builds the same schema.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE sites
      ADD COLUMN IF NOT EXISTS pending_plugin_updates INTEGER,
      ADD COLUMN IF NOT EXISTS pending_theme_updates  INTEGER,
      ADD COLUMN IF NOT EXISTS pending_core_update    BOOLEAN,
      ADD COLUMN IF NOT EXISTS wp_instance_id         INTEGER,
      ADD COLUMN IF NOT EXISTS last_update_scan_at    TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS wp_update_jobs (
      id                    SERIAL PRIMARY KEY,
      site_id               INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      instance_id           INTEGER NOT NULL,
      kind                  TEXT    NOT NULL CHECK (kind IN ('plugins','themes','core','all')),
      status                TEXT    NOT NULL DEFAULT 'pending'
                                      CHECK (status IN ('pending','running','success','failed','rolled_back')),
      backup_filename       TEXT,
      pre_update            JSONB,
      post_update           JSONB,
      output                TEXT,
      error                 TEXT,
      progress_pct          INTEGER,
      started_at            TIMESTAMPTZ DEFAULT NOW(),
      completed_at          TIMESTAMPTZ,
      triggered_by_user_id  INTEGER REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS wp_update_jobs_site_id_idx ON wp_update_jobs(site_id);
    CREATE INDEX IF NOT EXISTS wp_update_jobs_status_idx  ON wp_update_jobs(status);
  `);
};

// Deliberately a no-op: these objects pre-date this migration on the live DB and hold real job history, so
// rolling this migration back must never drop them.
exports.down = () => {};
