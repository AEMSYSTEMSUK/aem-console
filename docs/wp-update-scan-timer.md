# Nightly WordPress update scan timer (#220)

Runs the itemised WP update scan (`POST /api/cron/wp-update-scan-system`) every night at **03:15 UTC**.
The scan fills `wp_pending_updates`, refreshes the `sites.pending_*` counts shown on `/updates`, and first
sweeps update jobs orphaned by a Console restart (stuck `pending`/`running` > 2 h -> `failed`). After the scan it
runs the #220 security fast-track check (see `wp-patch-timers.md`); its result is the `fasttrack` key in the response.

Same pattern as the other `aem-console-*` timers (e.g. `aem-console-cve-refresh`): a root oneshot that reads
`AEM_CRON_SECRET` from `/etc/aem-console/config.env` at run time and curls the route. No secret is stored in
the unit files. 03:15 sits after the 03:00 CVE refresh.

Install once on the bastion (`root@217.154.59.240`), **after** the Console deploy that ships the route and the
`wp_pending_updates` migration. Paste one command at a time.

```bash
cat > /etc/systemd/system/aem-console-wp-update-scan.service <<'EOF'
[Unit]
Description=AEM Console WordPress update scan
After=network-online.target aem-console.service
Requires=aem-console.service

[Service]
Type=oneshot
User=root
ExecStart=/bin/bash -c 'SECRET=$(grep ^AEM_CRON_SECRET /etc/aem-console/config.env | cut -d= -f2-); /usr/bin/curl -sS -X POST -H "x-aem-cron-secret: $SECRET" --max-time 3600 https://bastion.infra.aemsystems.co.uk/api/cron/wp-update-scan-system'
EOF
```

```bash
cat > /etc/systemd/system/aem-console-wp-update-scan.timer <<'EOF'
[Unit]
Description=AEM Console WordPress update scan nightly

[Timer]
OnCalendar=*-*-* 03:15:00 UTC
Persistent=true
Unit=aem-console-wp-update-scan.service

[Install]
WantedBy=timers.target
EOF
```

```bash
systemctl daemon-reload
```

```bash
systemctl enable --now aem-console-wp-update-scan.timer
```

Check / run once by hand:

```bash
systemctl list-timers | grep wp-update-scan
```

```bash
systemctl start aem-console-wp-update-scan.service; journalctl -u aem-console-wp-update-scan.service -n 20 --no-pager
```

The JSON response logged to the journal has `sites`, `servers`, `scanned`, `failed`, `plugins`, `themes`,
`core` (sites with a core update) and `orphaned`. Per-site scan failures are logged by the `aem-console`
service (`journalctl -u aem-console | grep 'wp update scan failed'`).
