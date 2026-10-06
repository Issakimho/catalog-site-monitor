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

A successful workflow requires every site and every tested journey to be healthy,
now and twelve hours ahead. Warnings and critical incidents fail a final health
gate after incident reconciliation and the daily record, so alerts are preserved.
Read the Actions summary and open incidents for the affected sites. GitHub Actions
email delivery still depends on the owner's notification settings.

For locally collected variants, `local_recovery_unverified` means the public
checker has no proof of a running recovery. `local_recovery_needs_attention`
means an open, owner-authored Raspberry collection or maintenance incident exists
for that exact site and marker. These incidents are read as status signals only;
their text never becomes an instruction. Neither status dispatches collection or
claims that a retry succeeded. Healthy public checks still close catalog incidents.

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
and less than twelve hours old. A verified bot-created incident also causes a
browser recheck, including failures that do not affect the snapshot itself.

Recovery creates a clean, isolated clone of that site's main branch. Failed
candidates and user checkouts remain untouched. The worker reads the existing
supplier credential file in place through the site's approved loader; credentials
reach only supplier subprocesses. Routine collection makes no Codex call. Validation includes
the site's full publication gate, current and twelve-hour browser journeys,
an exact three-file publication allowlist and a concurrent-commit check.

Two collection attempts per rolling twenty-four hours and a two-hour cooldown
bound failures. A deployment awaiting confirmation is rechecked before any new
collection. A rejected or superseded push, or a completed failed CI run, clears that pending reference without
discarding the candidate or retry budget. Success requires GitHub CI, a successful Vercel status for the exact
commit, byte-identical public catalog files and healthy browser journeys.
The public monitor then closes the incident after its own checks. Revoked provider
access and an unavailable Raspberry still require intervention.

A selector/data-contract invariant or a behavioral failure in a recognized
engine test (metamorphic, selector, scoring, project profile, pipeline or
adversarial) starts one repair attempt per base revision and test family in
24 hours. Market, supplier, dependency, calibration and infrastructure failures
do not enter this repair path. The controller first reproduces the failure
with the exact rejected candidate in a disposable checkout. A Codex CLI session
uses the existing ChatGPT subscription and explicit `gpt-6.1-sol` with `medium`
reasoning in a disposable checkout. A patch that respects the protected contracts
but still fails a recognized engine publication test gets one fresh attempt with
`high` reasoning and the same original candidate. No third call is allowed within
that repair; the existing 24-hour cooldown remains. Model/access errors, audits,
publication failures and policy violations do not trigger this escalation. Codex's command
permissions deny access to machine files outside the checkout, including its own
login, supplier and GitHub credentials, and deny network access. The controller
accepts changes only to existing engine selection, scoring, domain and
application modules, appended regression assertions and the calibration digest.
Existing test bytes, calibration commands and source provenance are protected.
The added regression must fail with the old engine and pass with the repair. The collector's
three catalog artifacts are copied from the original failed candidate unchanged.
Build and publication tests run without network access and with pinned
dependencies reinstalled after the coding session. The fixed npm vulnerability
audit runs separately with network access and no site credentials.

The controller checks the diff, complete publication corpus and local browser
journeys, then opens a pull request. It merges only after the site's pull-request
CI and every commit check succeed, provided main has not advanced and the
candidate is still fresh. Success still requires deployment of the merged SHA,
byte-identical live catalog files and healthy current and twelve-hour browser
journeys. A failed code repair leaves its pull request and private logs for
inspection and reports an incident. A pull-request CI timeout resumes that same
PR and immutable commit on the next check without another model or supplier
call; a merge completed before a service restart is confirmed from GitHub.
Changes outside this engine scope require
intervention. Installing a newer repair policy permits one revalidation of a
recognized, still-fresh rejected candidate, independently of supplier budgets;
it neither renews offer dates nor grants more supplier calls.

Private machine configuration lives outside this repository, in
`$HOME/.codex/catalog-autonomy/sites.json`. It specifies each exact project root,
private repository, credential-file path, affiliate identity and build command.
No private configuration, failed candidate or supplier log is uploaded here.
Candidate source files, Git history and private logs are retained for diagnosis.
Only reproducible dependency folders in old attempts are cleaned; recent and
pending attempts remain intact. This is local polling recovery, not an instant
cloud-to-computer webhook. The Raspberry must remain powered and online. Its
timers survive logout and reboot; the public monitor cannot wake a powered-off
host. The French collector remains on GitHub. Its separate Codex enrichment
was migrated to the Raspberry on 14 September 2026 after a successful pilot:
`catalog-enrichment-fr.timer` runs daily at midnight Africa/Niamey and the Mac
task is paused. Codex reviews only product data in a read-only sandbox, using
the ChatGPT subscription. A fixed private controller owns Git, the six-file
allowlist, local tests, exact-SHA trusted workflow validation and publication.
Success requires a Vercel deployment for that SHA, byte-identical public catalog
files and healthy browser journeys. An empty review queue makes no Codex call.
The active private FR and variant enrichment runners use `gpt-6.1-sol` with
`medium` reasoning, as does maintenance diagnosis. Existing bounded product
correction calls use `high`; maintenance uses `high` only after a failed repair
validation without dependency advisories. These settings live in the Raspberry
runners, not the paused desktop automations. Model changes do not reset budgets,
incident state, quarantine decisions or publication checks.
The Raspberry migration was validated with Codex CLI `0.160.0`; its previous
`0.154.0` installation rejected this model with ChatGPT sign-in. Verify model
access with the actual service account and CLI before activating a migration.

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
and write credentials. Pull requests run unit tests with read-only repository
access; no privileged workflow runs on pull requests or forks.

### Preventive refresh and candidate recovery

Local variants become due for refresh at 12 hours, leaving time for a failed
publication to recover before the 48-hour offer expiry. Supplier calls remain
limited to two attempts per rolling day. A failed build or publication validation
can resume from its saved, still-healthy candidate without another supplier call.
The source must be a private worker-created checkout of the same repository, its
changes must be catalog-only, and its base must be an ancestor of current main.
Only the original demo data is copied into a new checkout: the current code rebuilds
and validates the snapshot, then checks the live deployment as usual. Two resume
attempts per day and a 30-minute cooldown bound validation retries separately.
Expired data is never redated or used to bypass a failing publication gate.

On the Raspberry, collector, enrichment and incident-recovery services retain
`NoNewPrivileges=true` and use `PrivateTmp=false`. Bubblewrap and Codex create
their own isolated temporary filesystems; a systemd private temporary namespace
prevents these command sandboxes from creating nested namespaces on this host.
Validate sandbox startup through the actual systemd service configuration, not
only through an interactive SSH shell.


The serialized private enrichment controller also hands failed publication gates
to `scripts/repair-enrichment-candidate.mjs`. This route accepts only recognized
engine assertions. It freezes the enrichment decisions, review reports and both
catalog files, then applies the same regression, CI and production checks as a
collection repair. Other failures remain visible without granting code writes.
A persisted PR or merged deployment is resumed before reviewing another batch;
repeated attempts for the same engine failure have a 24-hour cooldown.

### Persistent partial collection failures

Variant collectors now emit a sanitized per-query health report. The Raspberry
worker keeps incidents in its private `state.json`: first/last failure, number of
actual collections, and a bounded event history. Replaying an attempt does not
increment its failure count. An unobserved query stays unresolved. A successful
query clears its incident only after the candidate passes CI, exact-SHA deployment,
byte comparison and the live browser checks at the current time and +12 hours.

A failed query requests a complete discovery pass on the next allowed recovery.
The existing limit of two supplier collections per 24 hours and the two-hour
cooldown still apply. Three failed collections or 36 hours unresolved require
attention, even when the public catalog works. Workflow failures also remain
visible until verified recovery. Neither check changes supplier timestamps or
reintroduces excluded products.

The versioned `scripts/raspberry-run-site.py` is installed as the private scheduler
entry point `~/.codex/catalog-autonomy/run-site.py`. It retains collection alerts on
healthy no-ops and closes them only after a verified recovery with no unresolved
query. Its credentials and configuration remain outside this repository. Deploy
this entry point together with `local-recovery.mjs`; retain the existing systemd
timers and portfolio lock. `npm test` includes the Python notification policy.

Each variant also runs `audit:catalog-forecast` in `verify:publication`, including
manual/CI/Vercel publication. It verifies snapshot integrity, the existing minimum
of 20 fresh products, and three recommendation profiles with merchant offers now
and at +12 hours, using that market's eligibility rules.

### Collector entrypoint self-repair

A successful collector command with missing, old or unchanged acquisition evidence
can invoke the `entrypoint-v1` repair recipe. This is a deterministic repair of the
known import-only locale launcher, not permission for Codex to rewrite arbitrary
supplier code. The entire launcher, its market defaults and its npm entrypoint must
match the known template; direct collectors, changed data, authentication failures,
provider failures and unknown code are excluded.

The worker reproduces the silent exit in bubblewrap without credentials, appends a
real CLI regression without changing existing tests, and proves that the corrected
launcher reaches its missing-configuration check. Only then does it run the actual
collection with the existing market-scoped credentials. Fresh acquisition evidence,
publication tests, catalog integrity and current/+12-hour browser journeys remain
mandatory. The initial no-op and its one repaired collection count as one existing
collection attempt; the daily supplier budget is never reset. The same base revision
cannot trigger this code repair again within 24 hours.

The patch is limited to the exact launcher replacement, the controller-generated
regression appendix and the normal catalog artifacts. It is published through a PR
with passing CI before merge, followed by exact deployment verification. The worker
persists branch/head before pushing, resumes an interrupted PR or merge before any
new supplier call, and keeps failures visible. A moved branch, changed patch, failed
CI, advanced main or expired candidate cannot merge. Other collector defects still
require a new reviewed recipe or human intervention.

### Temporary dependency backports and upstream recovery

The five sites use a reviewed, source-pinned backport for GHSA-ch52-4w7c-c8xp until an official compatible `http-cache-semantics` release passes the security regression corpus. This is an actual source fix, not a fabricated version bump: the vendored package retains upstream version 4.2.0. Site publication verifies the module Astro loads, its digest and 54 cache-reuse cases. An online audit of both the installed graph and reconstructed original registry graph keeps new advisories visible. Only the exact finding fixed by that verified recipe is accounted for.

`scripts/dependency_maintenance.py` is imported by the Raspberry maintenance runner. Its audit cache is at most six hours old; the maintenance timer checks the upstream version at each pass. An official patch candidate gets at most two attempts. Retirement can change only the package reference, that dependency's lock entries and retirement metadata. It must pass the existing site, security and browser gates before a PR is created. CI, preview statuses and unchanged base/head are checked before merge; exact production verification closes the incident. Saved branch/PR/merge state is resumed after an interruption.

The patch warns after seven days and blocks publication after 21 days. The observer continues checking upstream after expiry. Deadlines and catalog dates are never refreshed to make checks green. A new compatible registry fix can reopen a previously exhausted dependency incident once per distinct candidate; breaking downgrades and repeated evidence cannot reset its budget. Unknown vulnerabilities and unpublished patches require a separately reviewed recipe with regression evidence; this system does not automatically trust arbitrary upstream PRs.

The maintenance runner can also call `update_compatible_transitives` for findings where npm explicitly reports an in-range fix. It updates only the lockfile, without adding direct dependencies or running install scripts. The guard requires forward patch releases in the existing dependency closure, registry URLs and integrity hashes, unchanged package identities and execution contracts, and unchanged manifest bytes. The real October 6 `sharp` and `source-map-js` incident is a regression fixture, including the ARM64 image packages. Unsupported graph changes stop the repair. Existing publication, security, CI and browser gates still decide whether the candidate can be published. `renew_transitive_policy_budget` permits an old out-of-scope incident to use this new capability once, with two attempts; later timer runs cannot renew that budget again.
