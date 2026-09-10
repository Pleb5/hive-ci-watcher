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
| **Watcher** | `HIVE_CI_WATCHER_NSEC` (env, hex or nsec) | Signs 5401 / 5100 / Blossom 24242 auth / CVM responses. Must be present in each loom worker's `ALLOW_UNPAID_PUBKEYS` — added out of band, nothing here automates it. |
| **Watcher owner** | never held by the daemon | Human. Pubkey in `HIVE_CI_WATCHER_OWNER_PUBKEY`. Publishes the runner list (kind 30621). Implicitly authorized for every CVM tool; needs no allowlist entry. |
| **Requester** | — | Any pubkey in the watcher's allowlist. May follow/unfollow **any** repo. |
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
- **10100** loom worker advertisement → online status, pricing, mints, queue depth.

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
- **5100** loom job — `p` runner, `e` runId, `cmd bash`, `args` (curl+bash of the
  Blossom-hosted runner script), `env` tags, one `secret` tag
  (`HIVE_CI_NSEC` = the ephemeral secret key, NIP-44 encrypted to the runner).
  `HIVE_CI_BRANCH` carries the branch *or* tag name — `git clone --branch`
  accepts either, so the existing runner script needs no change. The extra
  `ref` tag on the 5401 is what disambiguates the two for readers that care.
  **No `payment` tag** — free runners only.
- **24242** Blossom upload auth for the runner script.
- **ContextVM announcements**, published by `@contextvm/sdk`:
  `11316` server announcement, `11317` tools list, plus a kind `0` profile and a
  kind `10002` relay list. Messages ride kind `25910`, gift-wrapped as `21059`.
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

Relay set = configured defaults (`wss://relay.budabit.club`, `wss://nos.lol`, …)
∪ every relay named by the followed repos' 30617 announcements. Same set is used
for publishing 5401/5100.

Per followed repo: `{kinds:[30617], authors:[repoOwner], '#d':[d]}` for the
announcement, then `{kinds:[30618], authors:[owner, ...maintainers], '#d':[d]}`
for state — the second filter is rebuilt whenever the owner's 30617 changes its
maintainer set. Globally: `{kinds:[10100]}` for runner ads.

The runner pool lives only in SQLite. It is set through owner-only CVM tools and
is never published — nothing outside the watcher needs to read it.

### 3.2 Push

1. New 30618 arrives from a maintainer (newest `created_at` wins across
   maintainers; authors outside the current maintainer set are dropped).
2. Parse refs. Default branch from the `HEAD` tag.
3. Diff both `refs/heads/*` and `refs/tags/*` against the `ref_state` table.
   - ref deleted → drop the row, no run
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
7. A candidate that matched but does not exist in the pushed ref's tree is
   skipped: there is nothing for `act` to run.
8. Dispatch one run per surviving workflow path (§5).
9. Write the new commit into `ref_state` unconditionally. No retries, so a
   dispatch failure is logged and dropped, not replayed.

Restart is safe: `ref_state` is durable, so a ref that moved while the daemon
was down produces a run on the next 30618 it sees.

### 3.3 Schedule

- Cron expressions come from `on.schedule[].cron` in the **default branch's**
  workflows only, re-derived whenever that branch's workflow set changes. UTC,
  standard 5-field syntax, as GitHub does.
- `schedules(repo_addr, workflow_path, cron, last_fired_at)`; a 60 s tick fires
  anything whose next occurrence after `last_fired_at` is now due, on the default
  branch at its current state commit.
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

1. Try each `clone` tag from the 30617 in order. Plain git, no ngit.
2. `git init` → `git remote add` → `git fetch --depth 1 origin <commit>`; if the
   remote refuses SHA-in-want, fall back to `git fetch --depth 1 origin <branch>`.
3. **Verify the fetched tip equals the expected commit.** Remotes drift out of
   sync with the announced repo state; a mismatch means try the next `clone` tag.
   This check is what makes step 2's branch-name fallback safe — a remote that
   has moved past the announced commit is a miss, never a silent build of the
   wrong tree. Never relax it.
4. Sparse-checkout `.github/workflows/` and `.ngit/workflows/`. Both directories
   hold the same GitHub Actions YAML schema; the union is the workflow set, with
   `.github` winning on a path collision.
5. All remotes exhausted → log and skip the evaluation. No run.

Results are cached by `(repo, commit)` so a push touching five refs doesn't
refetch the default branch five times — and a tag pointing at a commit already
fetched for a branch reuses that tree outright.

---

## 5. Dispatch

1. **Select a runner.** Allowed = the `runner_pool` table. Eligible = allowed ∩ online (10100 seen recently) ∩ free (`pricing == null` —
   a malformed paid ad is *not* treated as free). Round-robin over the eligible
   set, cursor persisted in SQLite. Empty set → log, no run, no retry.
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
   cost of a dispatch is a single conditional HEAD.
4. Publish 5401 → `runId`.
5. NIP-44-encrypt the ephemeral secret key to the runner pubkey, publish 5100
   with the env tags and the single `HIVE_CI_NSEC` secret.
6. Record the run in `runs`.

**No user secrets.** Watcher-triggered runs carry only `HIVE_CI_NSEC`. A
workflow needing repository secrets will not work under a watcher in v1.

---

## 6. ContextVM surface

The daemon is an MCP server exposed over Nostr via `@contextvm/sdk`, signing as
the watcher key, with `EncryptionMode.REQUIRED` and ephemeral gift wrap — repo
addresses and allowlist membership should not sit in the clear on relays.
Authorization is by the caller's pubkey, taken from the decrypted inner event
(never from the wrapper).

| Tool | Who | Effect |
|---|---|---|
| `follow_repo` | owner, allowlisted | Add a repo to the follow table. Any repo — no maintainer check. |
| `unfollow_repo` | owner, allowlisted | Remove it. |
| `list_followed` | owner, allowlisted | Followed repos + per-ref last-seen commit. |
| `status` | owner, allowlisted | Uptime, relay health, runner pool, recent runs. |
| `list_runners` | owner, allowlisted | Resolved pool: allowed ∩ online ∩ free, with the round-robin cursor. |
| `runners_add` | owner only | Add a runner pubkey to the pool. |
| `runners_remove` | owner only | Remove one. |
| `allow_pubkey` | owner only | Add a requester to the allowlist. |
| `revoke_pubkey` | owner only | Remove one. |
| `list_allowed` | owner only | Dump the allowlist. |

Unknown callers get a flat "not authorized" — the daemon does not disclose
whether a pubkey exists in the allowlist.

The CLI (`hive-ci-watcher`) is a thin ContextVM client over these tools — every
subcommand is one tool call.

---

## 7. Storage & config

```sql
followed_repos(repo_addr PK, repo_owner, d_tag, default_branch, added_by, added_at)
ref_state     (repo_addr, ref, commit_id, updated_at, PK(repo_addr,ref))
              -- ref is the full name: refs/heads/main, refs/tags/v1.2.0
schedules     (repo_addr, workflow_path, cron, last_fired_at, PK(repo_addr,workflow_path))
runs          (run_id PK, repo_addr, ref, commit_id, workflow_path, runner_pubkey,
               trigger, created_at)
allowlist     (pubkey PK, added_at)
runner_pool   (pubkey PK, added_at)   -- private, never published
kv            (key PK, value)   -- round-robin cursor, cached runner-script
                                 -- blob URL, relay bookkeeping
```

Env:

```
HIVE_CI_WATCHER_NSEC             required
HIVE_CI_WATCHER_OWNER_PUBKEY     required
HIVE_CI_WATCHER_DB               default ./watcher.db
HIVE_CI_WATCHER_RELAYS           comma-separated defaults
HIVE_CI_WATCHER_BLOSSOM_SERVERS  comma-separated, ordered
```

Plaintext nsec in env for v1; NIP-49 later.

---

## 8. Deliberately deferred

- **`paths` / `paths-ignore` filters.** Needs a real diff between two commits,
  which a shallow single-commit fetch cannot give (so a tag push cannot be
  path-filtered either). This is the strongest
  argument for a future coordinator model that keeps warm clones per repo and
  serves trigger evaluation to thin watchers.
- Paid loom workers. Free-only filter today; the runner-selection seam is where
  payment slots in.
- Private (encrypted) entries in the 30620 trusted-watcher list.
- Per-repo CI secret store.
- Dispatch retries, run supersession, concurrency caps.
- `pull_request` and `workflow_dispatch` triggers.

---

## 9. Layout

```
hive-ci-watcher/
  flake.nix              package + NixOS module + devShell
  .github/workflows/     test.yml — the watcher's own CI, run under act
  src/
    config.ts            env parsing, defaults
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

## 10. Nix

`flake.nix` ships three outputs:

- `packages.default` — the daemon + CLI, built with `buildNpmPackage` (or
  `pnpm.fetchDeps`), `better-sqlite3` compiled against the pinned nodejs.
- `nixosModules.default` — `services.hive-ci-watcher`: a hardened systemd unit
  (`DynamicUser`, `StateDirectory=hive-ci-watcher`, `ProtectSystem=strict`,
  `NoNewPrivileges`). The nsec never enters the Nix store — the module takes a
  `nsecFile` path and feeds it via `LoadCredential`/`EnvironmentFile`, sourced
  from sops-nix or agenix. Options mirror §7: `ownerPubkey`, `relays`,
  `blossomServers`, `databasePath`.
- `devShells.default` — node, pnpm, git, sqlite, `act`, `nak`.

`git` must be on the unit's `PATH`; §4 shells out to it.

---

## 11. Testing

Vitest, matching the extension. The trigger logic is the part that must not be
wrong, so it is written as pure functions over plain data and tested directly:

- **Trigger evaluation** — the §3.2 branch/tag table exercised exhaustively:
  `branches` only, `tags` only, both, neither, `*` vs `**` glob boundaries,
  `branches-ignore` precedence, `pull_request` never firing, a workflow present
  only at the pushed ref.
- **Ref diffing** — new / moved / deleted / unchanged refs, annotated tags with a
  peeled commit, a 30618 from a demoted maintainer, an older `created_at` losing
  to a newer one.
- **Cron** — next-occurrence maths, missed fires coalescing to one, a new
  schedule not firing on sight, DST and UTC handling.
- **Runner selection** — round-robin fairness across restarts, offline and paid
  runners excluded, a malformed paid ad *not* treated as free, empty pool.
- **Event construction** — 5401 and 5100 tag-for-tag against what
  `budabit-pipelines-extension` emits today; a paid-worker path must never
  produce a 5100 without a `payment` tag, and an unpaid one must omit the tag
  rather than send it empty.
- **Authorization** — every tool against owner / allowlisted / unknown callers,
  and caller identity read from the inner event rather than the gift wrap.
- **Git fetch** — commit-mismatch rejection and remote fallback, against a
  local fixture repo served over `file://`.

`.github/workflows/test.yml` runs lint + typecheck + vitest. It is deliberately
`act`-compatible, so the watcher can build itself through its own pipeline.
