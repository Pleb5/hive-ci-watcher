# hive-ci-watcher v0.1.0

**Released**: 2026-09-16

v0.1.0 is the first release of hive-ci-watcher: a headless daemon that
watches Nostr repositories for new commits and dispatches Hive CI runs on the
repository owner's behalf. It publishes exactly what the
`budabit-pipelines-extension` UI publishes when a human clicks "Run
workflow" — a kind 5401 run anchor and a kind 5100 loom job carrying the
extension's runner script, byte for byte — so a run it starts is
indistinguishable to a worker or a reader from one started by hand. What it
adds is the part a human used to be: noticing the push.

It is a v0.1. The trigger pipeline has been exercised end to end against
real repositories on `relay.ngit.dev` and real loom workers on the public
relays, and the review passes that shaped it are recorded in `DESIGN.md`.
It has not yet run unattended for weeks.

## At a glance

### Who this is for

- **A repository owner or maintainer** who wants `on: push` and
  `on: schedule` workflows to run without opening the pipelines tab. Follow
  the repo once; the watcher does the rest.
- **An operator** with access to one or more loom workers that will run
  unpaid jobs for a pubkey on their freelist. The watcher's pubkey has to be
  on that list; nothing here automates that.

### Before you deploy

- **Decide whether the identity is persistent, first.** The default is a
  fresh key on every boot, retracted on shutdown. That is right for a trial
  and wrong for anything whose pubkey is on a worker's freelist or in a
  repo's 30620 list, because both are keyed by it. `persistKey = true` on
  NixOS, or `HIVE_CI_WATCHER_KEY_FILE`, before the pubkey goes anywhere.
- **Put the watcher pubkey on each worker's `ALLOW_UNPAID_PUBKEYS`.** Every
  5100 goes out without a `payment` tag. A worker that has not been told to
  trust the pubkey rejects the job silently; the watcher cannot see that
  happen, and `list_runners` will still say `eligible: true`.
- **The allowlist is a high-trust set.** An allowlisted requester may follow
  any repo, unfollow anyone's, and spend the whole runner pool. `DESIGN.md`
  §8 states the trust model plainly; read it before adding a pubkey you
  would not hand the owner key to.

### What it does

- Follows repositories by `30617:<owner>:<id>` or naddr, finds their
  announcements and state events wherever their owners and maintainers
  publish them (NIP-65), and dispatches one run per matching workflow on
  every push and on schedule.
- Applies GitHub's `on.push` branch and tag semantics, reading triggers from
  the default branch's copy of each workflow so a push cannot rewrite the
  rules that decide whether it fires.
- Waits for a lagging grasp server to catch up with a state event, without
  cloning until one has, and lets a newer push supersede an older one still
  waiting.
- Is managed entirely over ContextVM: follow, unfollow, allowlist, runner
  pool, status — from a CLI or any MCP-over-Nostr client, encrypted.

## Following a repository

`follow_repo` takes a `30617:<owner-pubkey>:<identifier>` address or an
naddr. The watcher subscribes to the owner's announcement on the configured
relays, on any relays the naddr named, and on the owner's NIP-65 outboxes,
fetching the kind 10002 lazily and falling back to the index relays when it
is not on a relay already in use. The state subscription is built per
maintainer: the announcement's `relays` tag, plus each maintainer's own
outboxes, with `authors` on each relay narrowed to the maintainers known to
publish there. A maintainer added to the 30617 later reshapes the
subscription; nothing is torn down.

At follow time a bounded probe asks every reachable relay for the 30617 and
records whether it was found. `list_followed` shows the result, so a repo
that never does anything has a visible reason: the announcement is on no
relay the watcher can see, and the fix is a relay hint or an owner-published
10002.

**The first state event seeds and never dispatches.** The refs already
existed; nothing was pushed. Without this, following a repository with two
hundred tags fired two hundred runs.

## What a push does

A kind 30618 from a maintainer names every branch and tag with its commit.
The watcher diffs it against what it recorded last time. For each ref that is
new or moved:

1. **The default branch is read at its current state commit**, every time.
   That copy of each workflow decides what fires; a workflow present only at
   the pushed ref is the exception and speaks for itself. This is also where
   schedules are re-derived, so a push that edits a cron is seen before
   anything is evaluated against it.
2. **The pushed ref is read at its new commit**, and `on.push` is evaluated
   with GitHub's semantics: no `branches` or `tags` means both kinds fire;
   `branches` alone never fires for a tag; `tags` alone never fires for a
   branch; both apply each to its own kind. `*` does not cross `/`, `**`
   does, a leading `!` negates, the last match wins.
3. **One run per surviving workflow**, each a 5401 and a 5100, published to
   the configured relays and the repo's own, accepted by at least two.

`ref_state` is written only when the evaluation completed — trees fetched,
every matching workflow dispatched or nothing matched. A fetch miss, an empty
runner pool or a publish failure leaves the ref for the next state event.
Without that a thirty-second git outage skipped a commit forever with one
warning line.

A ref that disappears from a state event is tombstoned, not forgotten. Two
maintainers whose state events cover different ref subsets would otherwise
make every ref outside the overlap flap between deleted and new on each
alternate event, re-dispatching the same commit each time.

### The state event arrives before the objects

This is designed behavior in ngit and it will not change: the 30618 is
published, then the pack is uploaded to the grasp server. A watcher that
fetches on arrival sees the previous tip, and in the first builds that is
exactly what happened — every push was evaluated against a remote one push
behind, and "retry on the next state event" meant the next push.

v0.1.0 **probes, then polls, then fetches once.** Each poll is one
`git ls-remote <url> <ref> <ref>^{}` per clone URL — a single round trip, no
pack, no working tree, and the peeled line answers for annotated tags. The
tree is fetched only when at least one remote serves the announced commit,
from that remote first. Backoff runs 5 s doubling to 30 s for
`HIVE_CI_WATCHER_FETCH_RETRY_WINDOW` (600 s by default). One remote is
enough: it is what the runner will clone from too.

**A newer state event supersedes the poll.** Each repository has one
evaluation in flight. A second state event aborts it between attempts —
never mid-`git`, never mid-dispatch — and the new evaluation starts from the
latest state. A ref that moved twice before its objects landed is built once,
at the newer commit.

Measured on `test-ci` against `relay.ngit.dev`: 8 s from state event to a
remote serving the commit, one probe, one fetch.

### Why "nothing happened" is answerable from the log

Every step that used to be silent now logs at `info`: the tree fetch
(attempts, elapsed, which remote), each workflow file that fails to parse
(once per commit, with js-yaml's line and column), a push that matched no
workflow (with the candidates it considered and the unparseable set), the ref
being recorded, and an evaluation superseded by a newer state.
`list_followed` reports `unparseable_workflows`. This came out of a real
session in which a workflow with an unquoted `(trigger: $X)` in a `run:`
line was invisible for an afternoon; the parser was right to reject it and
wrong to say nothing.

## Selecting a runner

Eligible is **allowed ∩ online**: the owner-curated `runner_pool` table
intersected with workers whose kind 10100 was seen in the last five minutes,
round-robin with a cursor that survives restarts.

Advertised pricing is reported but does not gate. A kind 10100 is one public
replaceable event serving every reader, so a worker that runs unpaid jobs for
the pubkeys on its freelist still advertises its ordinary rate to everyone
else — `loom-free-tier-worker`, for instance, advertises 0.1 sat/s. Gating on
"advertises no price" excluded exactly the workers with which an arrangement
exists. Putting a pubkey in the pool *is* the operator asserting that
arrangement.

Some workers publish the arrangement: a `freelist_event` naddr on the 10100
pointing at a kind 30000 set of allowed pubkeys, on a relay of the worker's
choosing. `list_runners` resolves it through that relay hint and reports
`on_freelist` per worker. Workers that do not publish one report `null`.

## The runner script

The 5100's `args` fetch the extension's runner script from Blossom and run
it on the worker host. The script is a static template — everything
run-specific arrives as `env` tags — so its sha256 is the same for every run,
and the upload happens once per script version, ever; a dispatch costs one
conditional `HEAD`. The download is verified against that sha256 before it
executes. The URL already *is* the hash, but `curl` never checked it, and a
Blossom operator, a MITM or a DNS hijack serving other bytes at that path
would otherwise have owned every worker.

## Management over ContextVM

The daemon is an MCP server over Nostr. Ten tools: `follow_repo`,
`unfollow_repo`, `list_followed`, `status`, `list_runners` for the owner and
allowlisted requesters; `runners_add`, `runners_remove`, `allow_pubkey`,
`revoke_pubkey`, `list_allowed` for the owner alone. The owner needs no
allowlist entry. Every refusal is the same `not authorized`, so the daemon
never reveals whether a pubkey is on the list. Identity is the signed inner
event's, never the gift wrap's, and a request stamped more than five minutes
from the daemon's clock is refused — the transport's replay protection is a
bounded in-memory LRU, and a captured `allow_pubkey` replayed after a
`revoke` would otherwise re-grant.

Both gift-wrap kinds are accepted, 1059 and 21059, with the reply mirroring
the client. The first cut accepted only 21059, which meant a client on the
SDK's defaults — which sends 1059 until told otherwise, and a stateless
client is never told — published requests the server did not subscribe to.
Connecting worked; every call hung. The server also listens and announces on
`wss://relay.contextvm.org` and `wss://relay2.contextvm.org` in addition to
the configured relays, and its 11316 carries `['t', 'hive-ci-watcher']` as
the discovery filter.

`status` reports each relay separately: connected, liveness state, failure
count, last event, event count.

## Identity

The default identity is generated at boot and logged as hex and npub. On
shutdown its 11316–11320 announcements are retracted with a NIP-09 deletion
naming them by address *and* by id — `nos.lol` ignores the address form for
these kinds — and the deletion goes to the configured relays and the SDK's
bootstrap set. `relay2.contextvm.org` refuses kind 5 outright, so an
ephemeral announcement there ages out rather than being retracted.

`HIVE_CI_WATCHER_KEY_FILE` generates a key once, writes it at mode 0600 and
reads it back on every later boot. `HIVE_CI_WATCHER_NSEC` supplies one and
takes precedence. On NixOS these are `persistKey = true` and `nsecFile`; the
latter is fed through `LoadCredential` and never enters the store. The
watcher's secret key is stripped from the environment of every `git` child.

## Compatibility

- **Events.** 5401 is tag-for-tag the extension's plus `ref`; 5100 is
  tag-for-tag the extension's with a sha256 check added inside `args`. A
  worker or a reader that handles the extension's events handles these.
- **Runner script.** Identical to the extension's, sha256
  `664d3ff20259a4475179137fd08bbd2e63d449209c2d881c1fde1ae13019e5ea`.
- **Relays.** No relay-side requirement beyond NIP-01. NIP-65 lists are
  used when present and are not required.
- **Node 20+**, `git` on `PATH`. `better-sqlite3` is compiled against the
  pinned Node on Nix.

## Not in v0.1.0

- `paths` / `paths-ignore` filters: a shallow single-commit fetch has no diff
  to filter on, for a tag push least of all. This is the strongest argument
  for a future coordinator that keeps warm clones.
- Paid loom workers. Every 5100 is unpaid; the runner-selection seam is where
  payment slots in.
- Private (encrypted) entries in a repo's 30620 trusted-watcher list.
- A per-repo secret store. Watcher-triggered runs carry only `HIVE_CI_NSEC`;
  a workflow that needs repository secrets will not work under a watcher.
- Dispatch retries, run supersession, concurrency caps, `pull_request` and
  `workflow_dispatch` triggers.
- Any quota on allowlisted requesters. See `DESIGN.md` §8.

## What was measured

- 116 tests over trigger evaluation (the full branch/tag table, glob
  boundaries, negation), ref diffing (tombstones, seeding, maintainer race,
  annotated tags), cron (coalescing, floor, UTC), runner selection (fairness
  across restarts, priced workers selected), event construction (tag for tag
  against the extension), authorization (every tool against owner /
  allowlisted / unknown, freshness failing closed), git fetch against
  `file://` fixtures (drifted remote rejected, annotated tag peeled through
  the ref-name fallback, unreachable remote as `false`), the probe/poll loop
  (backoff, exhaustion, abort between attempts, abort cutting a sleep short),
  and a schema migration from the first-cut database.
- Live, against public relays and `relay.ngit.dev`: a follow by hex address
  and by naddr with a relay hint; the owner's 10002 pulling five outbox relays
  into the announcement subscription; the announcement's `relays` joining
  the state subscription; a worker's freelist set fetched from `nostr21.com`
  via the naddr hint; a publish with one dead relay refused in 3 s with the
  reason; the full push trace from state event through probe, poll, fetch,
  parse failure, no-match and ref recorded; a stateless ContextVM client on
  SDK defaults over `relay.contextvm.org` alone answered in 1.4 s; an
  ephemeral identity's announcement gone from `nos.lol` and `relay.primal.net`
  after shutdown.

## What was not measured

- A dispatched run completing on a worker. Every run dispatched during
  development went to a worker whose freelist did not contain the test key,
  or to an empty pool. The 5401/5100 pair was accepted by relays; execution
  was not observed.
- The daemon under sustained load or over more than a few hours.
- The Nix package build. `pnpmDeps.hash` in `flake.nix` is `lib.fakeHash`
  until the first `nix build` reports the real one.
- `paths` filtering, by design.

## Getting v0.1.0

- **From source**: `pnpm install && pnpm build` from a checkout of the
  `v0.1.0` tag (Node 20+, pnpm 10). `node dist/main.js` runs the daemon;
  `dist/cli/index.js` is the CLI.
- **Nix / NixOS**: `nix build .#default` from a checkout of the tag; the
  NixOS module is `nixosModules.default`. Replace `pnpmDeps.hash` with the
  value the first build prints.
- **Development**: `pnpm dev` runs under `tsx watch` with a persistent key
  and database under `.dev/`.

The repository lives on Nostr:
`nostr://npub1hw6amg8p24ne08c9gdq8hhpqx0t0pwanpae9z25crn7m9uy7yarse465gr/relay.ngit.dev/hive-ci-watcher`,
cloneable over https from `relay.ngit.dev`. The per-commit changelog is
`CHANGELOG.md`; the design and its trust model are `DESIGN.md`.

## Contributors

- Arjen ([@Origami74](https://github.com/Origami74)): design, review passes,
  every operational finding that reshaped the relay layer and the push
  pipeline, and the test repositories the trace above was measured on.
