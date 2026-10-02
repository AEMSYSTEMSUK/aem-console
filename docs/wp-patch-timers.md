# WordPress staged-patching timers (#220 phase 2)

Two timers drive the weekly cycle (times are **Europe/London**, so they follow BST/GMT):

| Timer | When | Route | What it does |
|---|---|---|---|
| `aem-console-wp-patch-staging` | Mon 06:00 | `POST /api/cron/wp-patch-staging-system` | Every enabled site (with a saved policy, mode not `report`) that has pending non-held items: clone to a protected staging subdomain on the same server, sanitise, apply the exact new versions, smoke test. Ends `awaiting_approval` (staff) or `approved` (auto). |
| `aem-console-wp-patch-live` | Tue 06:00 | `POST /api/cron/wp-patch-live-system` | Every `approved` site staged in the last 8 days: live smoke (pre-check), WP Toolkit backup, the same pinned versions, live smoke, auto-restore from that backup on failure. Then deletes the staging clones. |

The **security fast-track** has no timer of its own: the nightly scan (`aem-console-wp-update-scan`, 03:15) calls
it after scanning. `POST /api/cron/wp-patch-fasttrack-system` runs the same check by hand.

Both routes start the run in the background and return `{"ok":true,"runId":N}` immediately (or HTTP 409 if a
run of that kind is already going). Progress is on `/updates/runs/N`.

Same pattern as the other `aem-console-*` timers: a root oneshot reads `AEM_CRON_SECRET` from
`/etc/aem-console/config.env` at run time. No secret is stored in the unit files.

Install once on the bastion (`root@217.154.59.240`), **after** the Console deploy that ships the routes and the
`20261002100000_wp-patch-runs` migration. Paste one command at a time.

```bash
cat > /etc/systemd/system/aem-console-wp-patch-staging.service <<'EOF'
[Unit]
Description=AEM Console WordPress patching - staging run
After=network-online.target aem-console.service
Requires=aem-console.service

[Service]
Type=oneshot
User=root
ExecStart=/bin/bash -c 'SECRET=$(grep ^AEM_CRON_SECRET /etc/aem-console/config.env | cut -d= -f2-); /usr/bin/curl -sS -X POST -H "x-aem-cron-secret: $SECRET" --max-time 120 https://bastion.infra.aemsystems.co.uk/api/cron/wp-patch-staging-system'
EOF
```

```bash
cat > /etc/systemd/system/aem-console-wp-patch-staging.timer <<'EOF'
[Unit]
Description=AEM Console WordPress patching - staging run, Mondays 06:00 UK time

[Timer]
OnCalendar=Mon *-*-* 06:00:00 Europe/London
Persistent=true
Unit=aem-console-wp-patch-staging.service

[Install]
WantedBy=timers.target
EOF
```

```bash
cat > /etc/systemd/system/aem-console-wp-patch-live.service <<'EOF'
[Unit]
Description=AEM Console WordPress patching - live run
After=network-online.target aem-console.service
Requires=aem-console.service

[Service]
Type=oneshot
User=root
ExecStart=/bin/bash -c 'SECRET=$(grep ^AEM_CRON_SECRET /etc/aem-console/config.env | cut -d= -f2-); /usr/bin/curl -sS -X POST -H "x-aem-cron-secret: $SECRET" --max-time 120 https://bastion.infra.aemsystems.co.uk/api/cron/wp-patch-live-system'
EOF
```

```bash
cat > /etc/systemd/system/aem-console-wp-patch-live.timer <<'EOF'
[Unit]
Description=AEM Console WordPress patching - live run, Tuesdays 06:00 UK time

[Timer]
OnCalendar=Tue *-*-* 06:00:00 Europe/London
Persistent=true
Unit=aem-console-wp-patch-live.service

[Install]
WantedBy=timers.target
EOF
```

```bash
systemctl daemon-reload
```

```bash
systemctl enable --now aem-console-wp-patch-staging.timer aem-console-wp-patch-live.timer
```

Check the next fire times (should show 06:00 local / 05:00 UTC in summer):

```bash
systemctl list-timers | grep wp-patch
```

Run once by hand (staging run; the journal shows the run id):

```bash
systemctl start aem-console-wp-patch-staging.service; journalctl -u aem-console-wp-patch-staging.service -n 20 --no-pager
```

Fast-track check by hand:

```bash
SECRET=$(grep ^AEM_CRON_SECRET /etc/aem-console/config.env | cut -d= -f2-); curl -sS -X POST -H "x-aem-cron-secret: $SECRET" https://bastion.infra.aemsystems.co.uk/api/cron/wp-patch-fasttrack-system
```

## Notes

- `Persistent=true`: if the bastion was down at 06:00 the run fires at boot. For the **live** timer that means a
  late live run — still only for approved, recently staged sites.
- Only sites with a **saved** patch policy are included (`REQUIRE_SAVED_POLICY` in `src/lib/wp-patch/engine.ts`),
  so nothing runs until policies are saved for the pilot ring.
- A run left `running` by a Console restart is failed after 24 h; a site stuck mid-step for 2 h is failed with an
  "orphaned" error (for live steps the error names the WP Toolkit backup to restore by hand).
- Per-site failures are on the run page; run-level crashes are logged by the `aem-console` service
  (`journalctl -u aem-console | grep wp-patch`).
