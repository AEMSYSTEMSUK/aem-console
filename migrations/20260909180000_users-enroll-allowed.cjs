exports.up = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'enroll_allowed'
      ) THEN
        ALTER TABLE users ADD COLUMN enroll_allowed BOOLEAN NOT NULL DEFAULT false;
      END IF;
    END $$;
  `);
  // One-time backfill: anyone WITHOUT a passkey yet keeps the ability to complete
  // their initial enrollment; anyone who already has a passkey is protected from
  // a fresh unauthenticated enroll (the account-takeover vector this closes).
  pgm.sql(`
    UPDATE users SET enroll_allowed = true
    WHERE id NOT IN (SELECT DISTINCT user_id FROM webauthn_credentials)
  `);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE users DROP COLUMN IF EXISTS enroll_allowed`);
};
