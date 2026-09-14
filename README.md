# Public catalog checks

This repository tests the public recommendation journeys on pcarchitecte.com,
architectlaptops.com, architektenrechner.com, pcarquitectos.com and archiscelta.com.
It contains original generic monitoring code and public URL configuration. Site
source code, product snapshots, supplier credentials and local Codex settings stay
outside this repository.

## What runs

One standard Ubuntu job runs every two hours, at minute 43, and after changes to
the monitor. A manual run is also available. GitHub schedules are best effort and
can be delayed. The job checks:

- The public snapshot and manifest, including their byte count, checksum, version
  and publication dates. Reads are bounded and retried.
- Catalog age and the number of records seen within the applications' current
  48-hour listing window. These counts are diagnostics, not a copied eligibility
  engine or permission to cache merchant data for 48 hours.
- Three real browser journeys, now and twelve hours ahead with the browser clock
  changed. Each journey must show at least one recommendation and a visible,
  enabled purchase button on every recommendation. The future check assumes no
  new collection; it gives an early warning, not a forecast of scheduled updates.

The browser never clicks affiliate links. Third-party requests, analytics,
images, fonts, media and service workers are blocked. Browser processes receive
only PATH and HOME, not GitHub or repair credentials.

The age threshold is 16 hours for the twice-daily French collection and 26 hours
for the daily local variant collections. Test budgets are 1,500 for drawing,
1,800 for BIM and 2,200 for rendering, in each site's displayed currency.
These are sample journeys, not exhaustive questionnaire coverage.

## Incidents and email

A failed check on a locally collected variant creates one GitHub issue, assigned
to the repository owner. Unchanged incidents produce no additional comments. A
change in the failure category adds a comment. A healthy snapshot, current
journey and twelve-hour journey close the incident automatically.

Enable email for assignments and mentions in
[GitHub notification settings](https://github.com/settings/notifications), and
enable Actions notifications for failed workflow runs. The latter covers a
broken monitor, such as a missing browser or a rejected GitHub API request. This
repository cannot change or verify the owner's email-delivery preferences.

A successful workflow means the monitor completed, not that every site is
healthy. Read the Actions summary and open incidents for site health.

Only scalar test results are published. The Actions log includes dates and
counts; `status/latest.json` records one real check per UTC day with each
journey's outcome. Its commit history provides a daily regression record and
keeps the repository active. GitHub can disable public schedules after
[60 days without repository activity](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows).
Daily records do not trigger another monitoring run. No artifacts or raw product
records are uploaded.

## Collection and bounded recovery

The existing collection authority for each site is unchanged. Local Codex
collection/enrichment uses the existing subscription. Variant recovery schedules
are described below; enrichment schedules are unchanged. This monitor
does not call an AI API, wake a sleeping computer, start a second collector or
change merchant freshness timestamps.

For the French site, a limited credential can request the private
repository's existing controller using `workflow_dispatch`. The private
controller independently re-checks the live site before deciding whether to
collect. Its existing guards and two-retries-per-six-hours limit remain active.
The public bridge also allows no more than two dispatches per six hours, does
not duplicate an active dispatch and gives deployment time to finish. Failures
of the bridge open an incident here without publishing private API details.

The other four sites use `scripts/local-recovery.mjs` from exact-project systemd
user timers on an always-on Raspberry Pi. They were migrated on 14 September
2026 after successful collection, publication and live verification for each
market; their previous Mac Codex collectors are paused. Each timer checks every
four hours, with a small randomized delay and a shared serialization lock.
It exits without installing or collecting while the public catalog is healthy
and less than twenty hours old. A verified bot-created incident also causes a
browser recheck, including failures that do not affect the snapshot itself.

Recovery creates a clean, isolated clone of that site's main branch. Failed
candidates and user checkouts remain untouched. The worker reads the existing
supplier credential file in place through the site's approved loader; credentials
reach only supplier subprocesses. It never calls an AI API. Validation includes
the site's full publication gate, current and twelve-hour browser journeys,
an exact three-file publication allowlist and a concurrent-commit check.

Two collection attempts per rolling twenty-four hours and a two-hour cooldown
bound failures. A deployment awaiting confirmation is rechecked before any new
collection. A rejected or superseded push clears that pending reference without
discarding the candidate or retry budget. Success requires GitHub CI, a successful Vercel status for the exact
commit, byte-identical public catalog files and healthy browser journeys.
The public monitor then closes the incident after its own checks. Code defects,
revoked provider access and an unavailable Raspberry can still require intervention.

Private machine configuration lives outside this repository, in
`$HOME/.codex/catalog-autonomy/sites.json`. It specifies each exact project root,
private repository, credential-file path, affiliate identity and build command.
No private configuration, failed candidate or supplier log is uploaded here.
Candidate source files, Git history and private logs are retained for diagnosis.
Only reproducible dependency folders in old attempts are cleaned; recent and
pending attempts remain intact. This is local polling recovery, not an instant
cloud-to-computer webhook. The Raspberry must remain powered and online. Its
timers survive logout and reboot; the public monitor cannot wake a powered-off
host. The French collector remains on GitHub, and its separate Codex enrichment
task remains on the Mac until its Git-permission migration is validated.

### French bridge and credential renewal

The bridge was verified on 13 September 2026 by dispatching the guarded private
controller from this repository and waiting for its successful completion. The
redundant private two-hour schedule has been removed; private collection,
post-publication checks and local Codex enrichment are unchanged. Renewal uses
the same scope:

1. Create a GitHub fine-grained personal access token, selecting only the French
   site's private repository. Grant repository **Actions: read and write**;
   Metadata read is implicit. Do not grant Contents or other write permissions.
2. Add the value directly as `PCARCHITECTE_ACTIONS_TOKEN` in this repository's
   [Actions secrets](https://github.com/Issakimho/catalog-site-monitor/settings/secrets/actions).
   Never paste the token in an issue, commit, chat or workflow log.
3. The destination is supplied separately in `PCARCHITECTE_REPAIR_REPOSITORY`.
   The private workflow must declare `workflow_dispatch` and restrict execution
   to its main branch. The bridge always requests `catalog-watchdog.yml` on
   `main`; it accepts no site-supplied workflow name, branch or payload.
4. Run **Public catalog checks** manually with `verify_repair_bridge` enabled.
   This sends one fixed main-branch dispatch and waits for that exact private
   run to succeed. A healthy ordinary check alone does not prove dispatch
   permission. The smoke test does not force collection on a healthy site.
5. Keep private post-publication checks, the collector, local Codex enrichment,
   recovery limits and email settings. Never add a second collector for a site.

Use a fine-grained token or a GitHub App, never the owner's general-purpose CLI
token. Set a suitable expiry and replace it before expiry. Every monitoring run
also checks read access to the enabled private controller. Missing, revoked or
expired access produces a `repair_bridge_unavailable` incident even when the
public recommendations remain healthy. There is no guarantee of
automatic recovery from revoked credentials or a persistent code regression.

## Cost and limits

[GitHub's standard runners are free for public repositories](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
These public checks consume no private-repository runner minutes and no AI API
tokens. Larger runners are not used. Existing private collections, deployment
checks, repairs and unrelated CI still consume their usual quota.

The monitor, schedule and issue alerts share GitHub as a dependency. A GitHub
outage or disabled Actions can interrupt all three. This is not an independent
dead-man monitor or a guarantee that a catalog can never become empty. The
computer must remain available for local collectors to run.

## Run locally without writes

Node 22+ and Google Chrome are required on macOS and Linux x64. On Linux
ARM64 (including Raspberry Pi), the checker uses Playwright's bundled Chromium:

```sh
npm ci --ignore-scripts
node node_modules/playwright-core/cli.js install chromium
# Requires administrator access to install OS libraries:
node node_modules/playwright-core/cli.js install-deps chromium
```

Installing the browser does not move or enable any recurring collector. A host
migration must separately validate project paths, credentials, scheduler identity,
publication and live checks before disabling the previous collector. Scheduled
commands must explicitly include the Node installation directory in their PATH.

```sh
npm ci --ignore-scripts
npm test
npm run check
```

`check` only reads public sites and writes `reports/latest.json` locally.
Do not run `notify` locally: it requires the trusted main-branch GitHub context
and write credentials. No privileged workflow runs on pull requests or forks.
