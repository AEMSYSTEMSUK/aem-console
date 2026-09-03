exports.up = (pgm) => {
  pgm.alterColumn('integration_tokens', 'server_id', { notNull: false });
};
exports.down = (pgm) => {
  pgm.alterColumn('integration_tokens', 'server_id', { notNull: true });
};
