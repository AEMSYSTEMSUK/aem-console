exports.up = (pgm) => {
  pgm.sql(`
    DO \$\$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'role'
      ) THEN
        ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'web';
        ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'web'));
      END IF;
    END \$\$;
  `);
  pgm.sql(`UPDATE users SET role = 'admin' WHERE email = 'andy@aemsystems.co.uk'`);
  pgm.sql(`UPDATE users SET role = 'admin' WHERE email = 'lewis@aemsystems.co.uk'`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`);
  pgm.sql(`ALTER TABLE users DROP COLUMN IF EXISTS role`);
};
