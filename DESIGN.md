# hive-ci-watcher — design

A headless daemon that watches Nostr repositories for new commits and dispatches
Hive CI runs on behalf of the repository owner, mirroring exactly what the
`budabit-pipelines-extension` UI does when a human clicks "Run workflow".

Standalone repo. Node + TypeScript + pnpm. Nostr via `applesauce-*`.
State in SQLite (`better-sqlite3`). Remote control via ContextVM (MCP over Nostr).

---

## 1. Identities

| Identity | Key material | Role |
|---|---|---|
| **Watcher** | **Default: a fresh key generated at every boot**, logged as hex + npub on startup, its 11316 retracted (NIP-09 by address) on shutdown. `HIVE_CI_WATCHER_KEY_FILE` generates once and reuses; `HIVE_CI_WATCHER_NSEC` (hex or nsec) supplies one and wins. | Signs 5401 / 5100 / Blossom 24242 auth / CVM responses. Must be present in each loom worker's `ALLOW_UNPAID_PUBKEYS` — added out of band, nothing here automates it. Persist the key once it is on freelists or in 30620 lists; both bind to the pubkey. |
| **Watcher owner** | never held by the daemon | Human. Pubkey in `HIVE_CI_WATCHER_OWNER_PUBKEY`. Publishes the runner list (kind 30621). Implicitly authorized for every CVM tool; needs no allowlist entry. |
| **Requester** | — | Explicitly allowed pubkey or effective member of any ready configured community. May register any repo and remove their own registration. |
| **Repo owner** | — | Author of the repo's kind 30617. Their announcement is the trust root: it defines the maintainer set. |
| **Repo maintainer** | — | The repo owner plus every pubkey in the owner's 30617 `maintainers` tag. Any of them may publish the kind 30618 the watcher triggers on. |

---

## 2. Events

### Consumed

- **30617** repo announcement (author = repo owner, `d` = repo identifier)
  → `clone` tags (git URLs), `relays` tags, `maintainers`, repo name.
- **30618** repo state, author = **any maintainer** of the repo (owner, or a
  pubkey listed in the owner's 30617 `maintainers` tag)
  → `refs/heads/<branch>` and `refs/tags/<tag>` → commit id;
  `HEAD` → `ref: refs/heads/<default>`. An annotated tag may carry a peeled
  commit as a third value; when present that is the commit to build.
  Newest `created_at` wins across maintainers; a maintainer dropped from the
  owner's 30617 stops being accepted from that moment on.
- **10100** loom worker advertisement → online status, pricing, mints, queue depth,
  and — when the worker publishes one — a `freelist_event` naddr pointing at
  its kind **30000** follow set of unpaid-allowed pubkeys.
- **10002** NIP-65 relay lists for repo owners and maintainers → the outbox
  relays their 30617/30618 are actually published to. Fetched lazily through
  the store loader, falling back to the index relays (`purplepag.es`,
  `index.hzrd149.com`, `relay.nostr.band`).
- **5** NIP-09 deletion of a followed 30617 by its owner → the store drops the
  announcement and evaluation suspends until a newer one arrives.

### Published

- **5401** workflow run anchor, signed by the watcher:
  ```
  a            30617:<repoOwner>:<d>
  workflow     .github/workflows/ci.yml
  triggered-by <watcher pubkey>
  publisher    <ephemeral pubkey>
  trigger      push | schedule
  branch       <branch or tag name>
  ref          refs/heads/<branch> | refs/tags/<tag>
  commit       <commit>
  t            hive-ci
  ```
- **5100** loom job — `p` runner, `e` runId, `cmd bash`, `args` (curl of the
  Blossom-hosted runner script, **sha256-verified before it runs**), `env`
  tags, one `secret` tag
  (`HIVE_CI_NSEC` = the ephemeral secret key, NIP-44 encrypted to the runner).
  `HIVE_CI_BRANCH` carries the branch *or* tag name — `git clone --branch`
  accepts either, so the existing runner script needs no change. The extra
  `ref` tag on the 5401 is what disambiguates the two for readers that care.
  **No `payment` tag** — free runners only.
- **24242** Blossom upload auth for the runner script.
- **ContextVM announcements**, published by `@contextvm/sdk`:
  `11316` server announcement, `11317` tools list, plus a kind `0` profile and a
  kind `10002` relay list. Messages ride kind `25910`, gift-wrapped as `21059`.
  The CVM server listens and announces on the configured defaults ∪
  `wss://relay.contextvm.org` ∪ `wss://relay2.contextvm.org`, and announces
  additionally on the SDK's bootstrap relays.
  No custom watcher-announcement kind — the watcher instead sets
  `['t', 'hive-ci-watcher']` as an extra common tag (`setExtraCommonTags`) on its
  11316, which makes `{kinds:[11316], '#t':['hive-ci-watcher']}` the discovery
  filter for the management site. Readers holding a pubkey from a repo's 30620
  can skip discovery and fetch that pubkey's 11316 directly.

### Read by other clients, not by the watcher

- **30620** trusted-watchers list — author = **repo owner**, `d` = **repo d-tag**,
  `p` tags = trusted watcher pubkeys. Public items only for v1 (NIP-51 private
  encrypted items are a later addition). This is display/trust metadata for the
  UI. **It does not gate the daemon**: the watcher acts on any repo present in
  its own follow table, and removal from a 30620 does not silently unfollow.

---

## 3. Trigger pipeline

### 3.1 Subscriptions

One `applesauce-relay` `RelayPool` and one `applesauce-core` `EventStore`. Every
event heard goes through `store.add`; the store is the source of truth for the
latest 30617 per repo, the latest 30618 per maintainer and the latest 10100 per
worker, and it applies kind-5 deletions itself. Relay sets and filters are
**streams** — `pool.subscription(relays$, filters$)` adds and removes REQs as
either changes; nothing is torn down wholesale when a maintainer is added or a
10002 arrives late.

Per-relay liveness (`enablePing`) reconnects a relay that stops answering on
its own. `RelayLiveness` tracks failures and backs off dead relays;
`ignoreUnhealthyRelays` drops them from every relay stream, so a dead relay in
someone's 30617 costs nothing.

Relay sets, per followed repo:

- **announcement**: defaults ∪ the follower's relay hints (an naddr's) ∪ the
  owner's NIP-65 outboxes.
- **state**, per maintainer: the above ∪ the 30617's `relays` ∪ that
  maintainer's own outboxes — via `pool.outboxSubscription`, one REQ per relay
  with `authors` narrowed to the maintainers known to publish there.

At follow time a bounded one-shot probe asks every reachable relay for the
30617 and records whether it was found; `list_followed` reports the result, so
"followed but nothing ever happens" has a visible reason.

Globally: `{kinds:[10100]}` on the defaults for runner ads.

**Startup order matters.** Relays replay the latest 30618 for every followed
repo the moment we subscribe; if that lands before any 10100 has been seen the
pool looks empty and every pending push is dropped. Startup first runs a
one-shot 10100 request that completes when every default relay has EOSE'd
(bounded at 10 s), and only then wires the repos.

The runner pool lives only in SQLite. It is set through owner-only CVM tools and
is never published on Nostr. Allowlisted requesters can read it through
`list_runners` — they are trusted enough to see which workers their runs land
on and whether any is online.

### 3.2 Push

1. New 30618 arrives from a maintainer (newest `created_at` wins across
   maintainers; authors outside the current maintainer set are dropped).
2. Parse refs. Default branch from the `HEAD` tag.
3. Diff both `refs/heads/*` and `refs/tags/*` against the `ref_state` table.
   Ref names are validated against git's own `check-ref-format` rules first;
   anything git would refuse is dropped at parse time (it ends up in
   `HIVE_CI_BRANCH`, which the runner script word-splits on the worker host).
   - ref absent → **tombstone** the row (`deleted_at`), keep its commit, no run.
     Two maintainers whose 30618s cover different ref subsets would otherwise
     flap every non-overlapping ref between "deleted" and "new" on each
     alternate event; with the tombstone a reappearance at the commit we
     already built is unchanged, and only a reappearance at a new commit is
     a push.
   - ref new or commit changed → evaluate
4. **Workflow discovery** (see §4) for two trees:
   - default branch at its current state commit → *trigger source*
   - the pushed ref at its new commit → *execution source*
5. Candidate set:
   - every workflow path present on the **default** branch → triggers read from
     the default branch's copy
   - every workflow path present **only** at the pushed ref → triggers read from
     that ref's own copy (this is the escape hatch for brand-new workflows;
     `pull_request` is never honored in either case)
6. Evaluate `on.push` for each candidate against the ref, with GitHub's
   branch/tag semantics:

   | `on.push` declares | branch push | tag push |
   |---|---|---|
   | neither `branches` nor `tags` | fires | fires |
   | `branches` / `branches-ignore` only | glob match | never |
   | `tags` / `tags-ignore` only | never | glob match |
   | both | `branches` glob | `tags` glob |

   Globs match the short name (`main`, `v1.2.0`), `*` not crossing `/` and `**`
   crossing it, as GitHub does. **`paths` / `paths-ignore` ignored in v1** (no
   cheap diff from a shallow fetch — see §8).

   A workflow file that does not parse never fires and never takes the
   evaluation down — but it is logged (once per commit, with js-yaml's
   line:column) and listed by `list_followed`, and a push that matches nothing
   logs the candidates it considered. "I pushed and nothing happened" must be
   answerable from the log alone.
7. A candidate that matched but does not exist in the pushed ref's tree is
   skipped: there is nothing for `act` to run.
8. Dispatch one run per surviving workflow path (§5).
9. Write the new commit into `ref_state` **only for a complete evaluation**:
   both trees fetched, and every matching workflow dispatched (or nothing
   matched). A fetch miss, an empty runner pool or a publish failure leaves
   the row untouched, so the next 30618 for the repo — or a relay replaying
   this one — evaluates the ref again. There is still no retry *loop*; the
   retry is whatever event arrives next. Without this a thirty-second git
   outage skips a commit's CI forever with one warn line.

**First sight seeds, never dispatches.** The first 30618 recorded for a follow
writes every ref into `ref_state` and fires nothing (`followed_repos.seeded_at`).
The refs already exist; nothing was pushed. Otherwise following a repo with
200 tags fires 200 runs on sight, and so does every re-follow.

Restart is safe: `ref_state` is durable, so a ref that moved while the daemon
was down produces a run on the next 30618 it sees.

### 3.3 Schedule

- Cron expressions come from `on.schedule[].cron` in the **default branch's**
  workflows only, re-derived whenever that branch's workflow set changes. UTC,
  standard 5-field syntax, as GitHub does.
- `schedules(repo_addr, workflow_path, cron, last_fired_at)`; a 60 s tick fires
  anything whose next occurrence after `last_fired_at` is now due, on the default
  branch at its current state commit.
- **Floor of five minutes**, as GitHub. Enforced on the fire rate — a schedule
  never fires within 5 min of its `last_fired_at` — which makes it exact for
  any expression without having to reason about a cron's minimum interval.
- **Missed fires coalesce into one.** A watcher down for a day with an hourly cron
  runs once on startup, then resumes its normal cadence — the anacron rule. A
  brand-new schedule seeds `last_fired_at = now`, so adding a nightly job does not
  immediately fire it.

### 3.4 Concurrency

No caps. A push to a ref whose previous run is still in flight fires anyway. One
30618 that moves a branch and adds a tag at the same commit produces two runs —
GitHub behaves the same way.
De-duplication between multiple watchers trusted by the same repo is explicitly
out of scope.

---

## 4. Fetching workflows

Given a repo and a target commit:

1. Try each `clone` tag from the 30617 in order. Plain git, no ngit. Only
   `https://`, `http://` and `git://` are accepted: `file://` would let an
   announcement point the watcher at its own filesystem, `ssh://` hangs on
   host-key and agent prompts under a daemon, `ext::` executes a command.
   `GIT_ALLOW_PROTOCOL` pins the same set on the git side regardless of what
   a redirect claims.
2. `git init` → `git remote add` → `git fetch --depth 1 --filter=blob:none
   origin <commit>`; if the remote refuses SHA-in-want, fall back to the ref
   name. `--depth 1` bounds history, not size — it still pulls every blob in
   the commit's tree, and sparse checkout only decides what gets written
   afterwards. The blob filter makes the fetch tree-only and the checkout
   then pulls just the workflow blobs. Servers without partial clone ignore
   the filter with a warning.
3. **Verify the fetched tip equals the expected commit.** Compare
   `FETCH_HEAD^{commit}`, not `FETCH_HEAD`: a ref-name fetch of an annotated
   tag lands on the tag *object*, while the 30618 announced the peeled
   commit. Remotes drift out of sync with the announced repo state; a
   mismatch means try the next `clone` tag. This check is what makes step 2's
   ref-name fallback safe — a remote that has moved past the announced commit
   is a miss, never a silent build of the wrong tree. Never relax it.
4. Sparse-checkout `.github/workflows/` and `.ngit/workflows/`. Both directories
   hold the same GitHub Actions YAML schema; the union is the workflow set, with
   `.github` winning on a path collision.
5. **Probe before fetching, and poll.** A repo's state event arrives before
   its objects by design — ngit publishes the 30618, then uploads to the
   grasp server — so a miss right after a push is expected, not final. Each
   poll is `git ls-remote <url> <ref> <ref>^{}` per clone URL: one round
   trip, no pack, and the `^{}` line answers for annotated tags. Only once
   **at least one** remote serves the announced commit is the tree fetched,
   from that remote first. Backoff 5 s doubling to 30 s for
   `HIVE_CI_WATCHER_FETCH_RETRY_WINDOW` (default 10 min); only when the
   window closes is the evaluation left incomplete. One remote is enough —
   it is what the runner will clone from too.

   **A newer state event supersedes the poll.** Each repo has one evaluation
   in flight; enqueuing another fires its abort signal, the poll stops between
   attempts (never mid-`git`), and the new evaluation starts from the latest
   state. A ref that moved twice before its objects landed is built once, at
   the newer commit. Dispatch itself is never interrupted.

Workflow filenames must match `[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml` (they become
`HIVE_CI_WORKFLOW`, which the runner script word-splits into a `nak` tag), and a
file over 512 KiB is skipped (YAML alias expansion is otherwise unbounded). At
most four `git fetch` processes run at once across every repo.

Results are cached by `(repo, commit)` so a push touching five refs doesn't
refetch the default branch five times — and a tag pointing at a commit already
fetched for a branch reuses that tree outright. Misses are never cached: a
remote that is down now may be up on the next push, and a cached miss on the
default branch would blank the trigger source for the life of the process.

---

## 5. Dispatch

1. **Select a runner.** Allowed = the `runner_pool` table. Eligible = allowed ∩
   online (10100 seen recently). Round-robin over the eligible set, cursor
   persisted in SQLite. Empty set → log, no run, no retry.

   **Advertised pricing does not gate selection.** A kind 10100 is one public
   replaceable event serving every reader, so a worker that runs unpaid jobs
   for the pubkeys in its `ALLOW_UNPAID_PUBKEYS` still advertises its ordinary
   rate to everyone else. Filtering on `pricing == null` would exclude exactly
   the workers we have an arrangement with. The pool is owner-only
   (`runners_add`), and putting a pubkey in it *is* the operator asserting that
   arrangement — which is the only thing the watcher could go on, since the
   freelist itself is out of band and unreadable from Nostr. Pricing is still
   parsed and surfaced by `list_runners` so an operator can see what a pool
   member charges the public.
2. Generate an ephemeral keypair for the run.
3. Resolve the runner script's Blossom URL. The script is a static template —
   everything run-specific arrives through `env` tags — so its sha256 is
   identical across every run and every repo. Compute the hash once, then:
   `HEAD <server>/<sha256>` against the cached server first, then the rest in
   order; a 200 means reuse the URL and skip the upload entirely. Only when no
   server holds it do we upload, signing the 24242 auth with the watcher key.
   The winning URL is cached in `kv`, but the HEAD still runs every dispatch —
   servers garbage-collect blobs, and a cached URL that 404s at run time
   fails the job on the runner instead of here.

   Practically this means one upload per script version, ever; the steady-state
   cost of a dispatch is a single conditional HEAD. The upload itself is
   bounded (30 s per server) and the whole dispatch has a 120 s deadline, so a
   stalled server fails the run rather than wedging the repo's queue.

   The `args` verify the download against that same sha256 before executing
   it. The URL *is* the hash — Blossom is content-addressed — but nothing
   makes `curl` check that, and the script runs on the worker **host**,
   outside act's container. A Blossom operator, a MITM or a DNS hijack
   serving different bytes at the same path would otherwise own every runner.
4. Publish 5401 → `runId`. Target = defaults ∪ the repo's 30617 `relays`.
   **Acceptance from at least two relays is required** (or all, when fewer are
   healthy); one relay's OK is not delivery, since workers listen on the
   defaults and readers on the repo's relays. Fewer accepts = the dispatch
   failed and the ref is left for retry.
5. NIP-44-encrypt the ephemeral secret key to the runner pubkey, publish 5100
   with the env tags and the single `HIVE_CI_NSEC` secret, same rule.
6. Record the run in `runs`.

**No user secrets.** Watcher-triggered runs carry only `HIVE_CI_NSEC`. A
workflow needing repository secrets will not work under a watcher in v1.

**No `payment` tag, ever.** Every run goes out unpaid on the strength of the
freelist arrangement above. The tag is omitted rather than sent empty — a loom
worker only treats a job as trusted-unpaid when it is absent.

---

## 6. ContextVM surface

The daemon is an MCP server exposed over Nostr via `@contextvm/sdk`, signing as
the watcher key, with `EncryptionMode.REQUIRED` and ephemeral gift wrap — repo
addresses and allowlist membership should not sit in the clear on relays.
Authorization is by the caller's pubkey, taken from the decrypted inner event
(never from the wrapper).

| Tool | Who | Effect |
|---|---|---|
| `follow_repo` | owner, eligible requester | Register any repo for the caller — no maintainer check. Accepts a `30617:…` address or an **naddr**, whose relay hints are stored and subscribed; extra `relays` may be passed. |
| `unfollow_repo` | owner, eligible or registered requester | Remove the caller's registration. Owner can target a requester or remove all registrations. |
| `list_followed` | owner, eligible or registered requester | Caller's registrations, eligibility/provenance, activation, per-ref state, schedules, announcement probe and workflow errors. Owner sees all registrations. |
| `status` | owner, eligible or registered requester | Uptime, relay health, runner pool, scoped repo count and recent runs, caller's access sources. Owner also sees community readiness. |
| `list_runners` | owner, eligible requester | Resolved pool: allowed ∩ online, with round-robin cursor, advertised pricing (reported, not gated), and published `on_freelist` status. |
| `runners_add` | owner only | Add a runner pubkey to the pool. |
| `runners_remove` | owner only | Remove one. |
| `allow_pubkey` | owner only | Add a requester to the allowlist. |
| `revoke_pubkey` | owner only | Remove an explicit grant; community-derived access remains independent. |
| `list_allowed` | owner only | Explicit grants, derived members with community sources, and per-community readiness. |

Unknown callers get a flat "not authorized" — the daemon does not disclose
whether a pubkey exists in the allowlist.

A request whose signed inner event is stamped more than five minutes from the
daemon's clock gets the same refusal. The transport deduplicates by event id,
but only in a bounded in-memory LRU, and a captured gift wrap re-published
with the same bytes is otherwise indistinguishable from the original; the
caller's own timestamp turns a captured `allow_pubkey` into a dead letter
instead of a re-grant.

Registrations are keyed by `(repo_addr, requester)`. Several requesters share
one repository pipeline. Removing or suspending one registration leaves the
pipeline active while another eligible registration remains. Losing the last
eligible registration aborts evaluation and prevents new submissions. Restart
and resume require a completed relay synchronization and seed current refs
without replaying suspended work or old schedules. An activation epoch also
invalidates work prepared before a suspension, even if access returns before
the asynchronous work finishes. Submitted worker jobs are not canceled.

Community eligibility is the union of effective memberships across independently
fresh exact community coordinates; a ban in one community does not override
another source. Protected authority deletions are intentionally ignored. See
[community-access.md](docs/community-access.md) for derivation and freshness rules.

The CLI (`hive-ci-watcher`) is a thin ContextVM client over these tools — every
subcommand is one tool call.

---

## 7. Storage & config

```sql
followed_repos(repo_addr PK, repo_owner, d_tag, default_branch, added_by, added_at,
               seeded_at,   -- NULL until the first 30618 has been recorded
               relay_hints, active) -- aggregate hints; attribution retained for migration
repo_registrations(repo_addr FK, requester, added_at, relay_hints,
                   PK(repo_addr,requester))
ref_state     (repo_addr, ref, commit_id, updated_at, deleted_at, PK(repo_addr,ref))
              -- ref is the full name: refs/heads/main, refs/tags/v1.2.0
              -- deleted_at set = tombstone; commit kept so a reappearance
              -- at it is not a push
schedules     (repo_addr, workflow_path, cron, last_fired_at, PK(repo_addr,workflow_path))
runs          (run_id PK, repo_addr, ref, commit_id, workflow_path, runner_pubkey,
               trigger, created_at)   -- pruned to the newest 5000 hourly
allowlist     (pubkey PK, added_at)
runner_pool   (pubkey PK, added_at)   -- private, never published
kv            (key PK, value)   -- round-robin cursor, cached runner-script
                                 -- blob URL, relay bookkeeping, authority projections and migration marker
```

Env:

```
HIVE_CI_WATCHER_NSEC             optional; wins over the key file
HIVE_CI_WATCHER_KEY_FILE         optional; generated once, reused. Unset: new key per boot
HIVE_CI_WATCHER_OWNER_PUBKEY     required
HIVE_CI_WATCHER_DB               default ./watcher.db
HIVE_CI_WATCHER_COMMUNITIES_FILE optional; local JSON, read on start
HIVE_CI_WATCHER_RELAYS           comma-separated defaults
HIVE_CI_WATCHER_BLOSSOM_SERVERS  comma-separated, ordered
HIVE_CI_WATCHER_FETCH_RETRY_WINDOW  seconds to keep polling a lagging remote, default 600
```

When given, plaintext nsec in env for v1; NIP-49 later.

---

## 8. Trust model, stated plainly

Trust is delegated in a chain and each hop is unbounded:

- the **watcher owner** selects communities and explicit grants whose members
  may register any repo and consume the runner pool without per-user quotas;
- **community owners and moderators** control their community's memberships
  and effective bans; they do not become watcher operators;
- each **requester** trusts every owner of every repo they follow — that owner
  controls the clone URLs the watcher fetches from, the relays it connects to
  and publishes on, and (via workflows) the code that runs on the worker;
- each **repo owner** trusts every maintainer they list, who can publish the
  30618 that decides what gets built.

The watcher enforces registration ownership, membership freshness, signature
checks, and the validations in §3–§5. Runner-pool changes and explicit grants
remain operator-only. Per-requester quotas are deferred.

Repo owners cannot opt out of being CI'd by someone else's watcher. They do
not have to pay attention to it either: a watcher they have not named in
their 30620 is one whose runs a client need not show.

## 9. Deliberately deferred

- **`paths` / `paths-ignore` filters.** Needs a real diff between two commits,
  which a shallow single-commit fetch cannot give (so a tag push cannot be
  path-filtered either). This is the strongest
  argument for a future coordinator model that keeps warm clones per repo and
  serves trigger evaluation to thin watchers.
- Paid loom workers. Every 5100 goes out unpaid today, so a pool member must
  have the watcher on its `ALLOW_UNPAID_PUBKEYS`; the runner-selection seam is
  where payment slots in. Until then a worker added to the pool without that
  arrangement fails at the worker, not here — the watcher cannot read a
  freelist to check.
- Private (encrypted) entries in the 30620 trusted-watcher list.
- Per-repo CI secret store.
- Dispatch retries, run supersession, concurrency caps.
- `pull_request` and `workflow_dispatch` triggers.

---

## 10. Layout

```
hive-ci-watcher/
  flake.nix              package + NixOS module + devShell
  .github/workflows/     test.yml — the watcher's own CI, run under act
  src/
    config.ts            env parsing, defaults
    community/           headless membership, verified authority intake and freshness
    identity.ts          watcher signer, NIP-44
    db/                  schema + typed accessors
    nostr/               relay pool, 30617/30618, 10100 workers
    git/                 shallow fetch with commit verification, workflow reading
    triggers/            YAML parse, push evaluation, cron scheduler
    dispatch/            runner selection, blossom upload, 5401+5100 submit
    cvm/                 MCP server, tool handlers, authorization
    cli/                 contextvm client
  DESIGN.md
```

---

## 11. Nix

`flake.nix` ships three outputs:

- `packages.default` — the daemon + CLI, built with `buildNpmPackage` (or
  `pnpm.fetchDeps`), `better-sqlite3` compiled against the pinned nodejs.
- `nixosModules.default` — `services.hive-ci-watcher`: a hardened systemd unit
  (`DynamicUser`, `StateDirectory=hive-ci-watcher`, `ProtectSystem=strict`,
  `NoNewPrivileges`). The nsec never enters the Nix store — the module takes a
  `nsecFile` path and feeds it via `LoadCredential`/`EnvironmentFile`, sourced
  from sops-nix or agenix. Options mirror §7: `ownerPubkey`, `relays`,
  `blossomServers`, `databasePath`, `communitiesFile`.
- `devShells.default` — node, pnpm, git, sqlite, `act`, `nak`.

`git` must be on the unit's `PATH`; §4 shells out to it. The git child never
sees `HIVE_CI_WATCHER_NSEC`: the daemon strips it from the subprocess
environment, so a client-side bug reached through a hostile remote yields at
most a shell, never the identity.

---

## 12. Testing

Vitest, matching the extension. The trigger logic is the part that must not be
wrong, so it is written as pure functions over plain data and tested directly:

- **Trigger evaluation** — the §3.2 branch/tag table exercised exhaustively:
  `branches` only, `tags` only, both, neither, `*` vs `**` glob boundaries,
  `branches-ignore` precedence, `pull_request` never firing, a workflow present
  only at the pushed ref.
- **Ref diffing** — new / moved / deleted / unchanged refs, annotated tags with a
  peeled commit, a 30618 from a demoted maintainer, an older `created_at` losing
  to a newer one, tombstoned refs reappearing at the old vs a new commit, the
  first-sight seed, git ref-name validation.
- **Cron** — next-occurrence maths, missed fires coalescing to one, a new
  schedule not firing on sight, the five-minute floor, DST and UTC handling.
- **Runner selection** — round-robin fairness across restarts, offline and
  unknown runners excluded, a *priced* runner still selected (pool membership
  asserts the freelist arrangement), empty pool.
- **Event construction** — 5401 and 5100 tag-for-tag against what
  `budabit-pipelines-extension` emits today; the 5100 must omit the `payment`
  tag rather than send it empty, including for a runner whose ad carries a
  price.
- **Authorization** — every tool against owner / allowlisted / unknown callers,
  caller identity read from the inner event rather than the gift wrap, and the
  request-freshness window failing closed.
- **Git fetch** — commit-mismatch rejection and remote fallback, an annotated
  tag through the ref-name fallback (peeled) and the same fallback rejected
  when the peeled commit is wrong, clone-URL scheme filtering, all against
  local fixture repos served over `file://`.
- **Runner args** — the sha256 check sits between download and execution.
- **Relay URLs** — onion, malformed and non-websocket entries dropped before
  they can reach the pool.
- **Schema migration** — an older database gains the added columns on open.

`.github/workflows/test.yml` runs lint + typecheck + vitest. It is deliberately
`act`-compatible, so the watcher can build itself through its own pipeline.
