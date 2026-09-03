#!/usr/bin/env bash
# AEM Console deploy — run on the bastion from /opt/aem-console: `git pull && bash deploy.sh`
# (mirrors the aem-crm flow). Pulls, installs, migrates, rebuilds, restarts the systemd service.
set -euo pipefail
cd /opt/aem-console

echo "==> [1/5] git pull"
git pull --ff-only origin main

echo "==> [2/5] npm install"
npm install --no-audit --no-fund

# Load DB + app config so node-pg-migrate has DATABASE_URL etc. config.env is a systemd EnvironmentFile,
# NOT guaranteed bash-source-safe, so parse KEY=VALUE lines ourselves and skip anything else.
if [ -f /etc/aem-console/config.env ]; then
  set +e
  while IFS= read -r __line || [ -n "$__line" ]; do
    case "$__line" in
      ''|\#*) continue ;;
      [A-Za-z_]*=*) export "$__line" 2>/dev/null || true ;;
    esac
  done < /etc/aem-console/config.env
  set -e
fi

echo "==> [3/5] db migrate (node-pg-migrate)"
npm run migrate:up || echo "   (migrate:up skipped/failed — apply manually if a new migration needs it)"

echo "==> [4/5] build (next build)"
npm run build

echo "==> [5/5] restart aem-console + health check"
systemctl restart aem-console
sleep 2
if systemctl is-active --quiet aem-console; then
  echo "OK — aem-console restarted and running on :3200."
else
  echo "!! aem-console did NOT come back up — check: journalctl -u aem-console -n 50"
  exit 1
fi
