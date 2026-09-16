# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-09-16

First release. A headless daemon that watches Nostr repositories for new
commits and dispatches Hive CI runs on behalf of the repository owner,
publishing the same kind 5401 / 5100 pair that `budabit-pipelines-extension`
publishes when a human clicks "Run workflow". Design in `DESIGN.md`.

### Added

#### Trigger pipeline

- Push evaluation with GitHub's `on.push` branch/tag semantics: no filter
  fires on both, `branches`/`branches-ignore` only fires on branches,
  `tags`/`tags-ignore` only on tags, both apply each to its own kind. Globs
  match the short name with `*` not crossing `/` and `**` crossing it; a
  leading `!` negates and the last matching pattern decides. Triggers are
  read from the **default branch's** copy of a workflow, so a push cannot
  rewrite the rules that decide whether it fires; a workflow present only at
  the pushed ref speaks for itself. A candidate absent from the pushed ref's
  tree is skipped. `paths` / `paths-ignore`, `pull_request` and
  `workflow_dispatch` are not honored.

- Ref diffing against a durable `ref_state`, so a ref that moved while the
  daemon was down produces a run on the next state event it sees. Annotated
  tags build the peeled commit the 30618 carries as a third value. Among
  several maintainers' 30618s the newest `created_at` wins, ties break on
  event id, and an author outside the owner's current `maintainers` tag is
  dropped from the moment the owner's 30617 drops them.

- **First sight seeds, never dispatches.** The first 30618 recorded for a
  follow writes every ref and fires nothing; otherwise following a repo with
  two hundred tags fires two hundred runs, and so does every re-follow.

- **Ref tombstones.** A ref absent from a state event keeps its last commit
  with `deleted_at` set rather than being forgotten, so two maintainers whose
  30618s cover different ref subsets do not flap every non-overlapping ref
  between "deleted" and "new" and re-dispatch the same commit on each
  alternation. A reappearance at a new commit is still a push.

- `ref_state` is written only for a **complete** evaluation — both trees
  fetched and every matching workflow dispatched or nothing matched. A fetch
  miss, an empty runner pool or a publish failure leaves the ref for the next
  state event. Without this a thirty-second git outage, or a restart racing
  worker discovery, skipped a commit's CI forever.

- Cron schedules from the default branch's workflows, UTC, five-field, with
  missed fires coalescing into one (a day of hourly misses runs once), a new
  schedule seeded to `now` so it does not fire on sight, and a five-minute
  floor on the fire rate as GitHub applies.

- Silent outcomes are logged: the tree fetch (attempts, elapsed, which
  remote), each workflow file that fails to parse (once per commit, with
  js-yaml's line:column), a push that matched no workflow (with the
  candidates considered and the unparseable set), the ref being recorded,
  and an evaluation superseded by a newer state.

#### Fetching workflows

- Shallow, blob-filtered fetch of `.github/workflows/` and
  `.ngit/workflows/` at one commit, over `https`, `http` or `git` only, with
  a mandatory check that `FETCH_HEAD^{commit}` equals the announced commit —
  a remote that has moved past the announced commit is a miss, never a
  silent build of the wrong tree. Each clone URL is tried in order; the
  ref-name fallback for remotes that refuse SHA-in-want is what the tip check
  makes safe.

- **Probe before fetching, and poll.** A repo's state event arrives before
  its objects by design — ngit publishes the 30618, then uploads to the grasp
  server — so a miss right after a push is expected. Each poll is one
  `git ls-remote <url> <ref> <ref>^{}` per clone URL, no pack; the tree is
  fetched once at least one remote serves the commit, from that remote
  first. Backoff 5 s doubling to 30 s for `HIVE_CI_WATCHER_FETCH_RETRY_WINDOW`
  (default 600 s).

- **A newer state event supersedes an evaluation in flight.** Each repo has
  one; enqueuing another fires its abort signal, a poll stops between
  attempts (never mid-`git`), and the new evaluation starts from the latest
  state. A ref that moved twice before its objects landed is built once, at
  the newer commit. Dispatch itself is never interrupted.

- Trees cached by `(repo, commit)` with in-flight sharing, so a push
  touching five refs fetches the default branch once; misses are never
  cached. At most four concurrent fetches. Workflow filenames restricted to a
  plain charset; files over 512 KiB skipped. `git` runs with
  `GIT_ALLOW_PROTOCOL` pinned and with the watcher's secret key stripped from
  its environment.

#### Dispatch

- Runner selection is allowed ∩ online: the owner-curated `runner_pool` table
  intersected with workers whose kind 10100 was seen within five minutes,
  round-robin with a cursor persisted across restarts. Advertised pricing is
  reported, not gated — a kind 10100 is one public event serving every
  reader, so a worker that runs unpaid jobs for its `ALLOW_UNPAID_PUBKEYS`
  freelist still advertises its rate. Pool membership is the operator
  asserting that arrangement.

- The runner script is the extension's, byte for byte, hosted on Blossom and
  resolved by a conditional `HEAD` against the cached server first: one
  upload per script version, ever. The 5100's `args` verify the download's
  sha256 before executing it — the URL already is the hash, `curl` never
  checked it, and the script runs on the worker host.

- Kind 5401 carries the extension's tags plus `ref`, which is the only thing
  telling a reader whether `v1.2.0` was a branch or a tag; `branch` keeps
  the short name because that is what `git clone --branch` wants. Kind 5100
  carries the env tags and a single NIP-44-encrypted `HIVE_CI_NSEC` secret,
  and never a `payment` tag — omitted entirely, not sent empty.

- Publish requires acceptance from at least two relays (defaults ∪ the
  repo's own relays); one relay's OK is not delivery. Every dispatch has a
  120 s deadline and the Blossom upload 30 s per server, so a stalled
  server fails a run instead of wedging a repo's queue.

#### Nostr

- One `applesauce-relay` `RelayPool` and one `applesauce-core` `EventStore`.
  Relay sets and filters are observables the pool follows, so a maintainer
  added to a 30617 or a 10002 arriving late reshapes the REQs without a
  teardown. Per-relay liveness ping reconnects a stuck relay alone;
  `RelayLiveness` backs off dead relays and keeps them out of every stream.
  The store holds the latest 30617 per repo, 30618 per maintainer and 10100
  per worker, and applies kind 5 deletions itself.

- NIP-65 discovery: owner and maintainer kind 10002 relay lists are fetched
  lazily through the store loader (index relays as fallback). The
  announcement subscription adds the owner's outboxes; state goes per
  maintainer over their outboxes with `authors` narrowed to those known on
  each relay. `follow_repo` accepts an naddr and keeps its relay hints. A
  bounded probe at follow time records whether the 30617 was found on any
  reachable relay, reported by `list_followed`.

- Startup waits for every default relay to EOSE the kind 10100 request
  (bounded) before wiring repos, so the first evaluation after a restart does
  not see an empty pool. Malformed and `.onion` relay URLs are dropped before
  they can reach the pool.

#### ContextVM management surface

- An MCP server over Nostr via `@contextvm/sdk`: `follow_repo`,
  `unfollow_repo`, `list_followed`, `status`, `list_runners` for the owner
  and allowlisted requesters; `runners_add`, `runners_remove`,
  `allow_pubkey`, `revoke_pubkey`, `list_allowed` for the owner only. The
  owner is implicitly authorized and needs no allowlist entry. Every refusal
  is a flat `not authorized`, so the daemon does not disclose whether a pubkey
  is allowlisted. Caller identity comes from the signed inner event, and a
  request stamped more than five minutes from the daemon's clock is refused.

- Encryption required; both persistent (1059) and ephemeral (21059) gift
  wraps accepted, the reply mirroring the client. The server listens and
  announces on the configured relays plus `wss://relay.contextvm.org` and
  `wss://relay2.contextvm.org`, with `['t', 'hive-ci-watcher']` on the 11316
  as the discovery filter. `list_runners` reports `on_freelist`, resolved
  from a worker's published `freelist_event` naddr through its relay hint.

- The CLI (`hive-ci-watcher`) is a thin ContextVM client, one tool call per
  subcommand.

#### Identity

- The default identity is a fresh key generated at every boot, logged as hex
  and npub, its 11316–11320 announcements retracted on shutdown by NIP-09
  address and id. `HIVE_CI_WATCHER_KEY_FILE` generates once and reuses;
  `HIVE_CI_WATCHER_NSEC` supplies a key and wins. `pnpm dev` keeps
  `.dev/watcher.key`.

#### Packaging

- `flake.nix`: `packages.default`, a hardened NixOS module
  (`services.hive-ci-watcher` with `ownerPubkey`, `persistKey`, `nsecFile`
  via `LoadCredential`, `relays`, `blossomServers`, `databasePath`,
  `logLevel`, `sdkLogLevel`) and a devShell. Logs are pretty on a TTY and
  JSON otherwise.

### Security

- Ref short names are validated against git's `check-ref-format` before
  they can reach `HIVE_CI_BRANCH`, which the runner script word-splits on the
  worker host outside act's container. Clone URLs are restricted to
  credential-free network transports; `file://`, `ssh://` and `ext::` are
  refused, as is any URL starting with `-`.

[Unreleased]: https://relay.ngit.dev/npub1hw6amg8p24ne08c9gdq8hhpqx0t0pwanpae9z25crn7m9uy7yarse465gr/hive-ci-watcher.git
[0.1.0]: https://relay.ngit.dev/npub1hw6amg8p24ne08c9gdq8hhpqx0t0pwanpae9z25crn7m9uy7yarse465gr/hive-ci-watcher.git
