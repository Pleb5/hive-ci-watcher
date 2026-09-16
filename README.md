# hive-ci-watcher

A headless daemon that watches Nostr repositories for new commits and dispatches
Hive CI runs on behalf of the repository owner, mirroring exactly what the
`budabit-pipelines-extension` UI does when a human clicks "Run workflow".

See [DESIGN.md](./DESIGN.md) for the full design. This README is the operating
manual.

## Quick start

```sh
pnpm install
pnpm build

export HIVE_CI_WATCHER_NSEC=nsec1...              # or 64 hex chars
export HIVE_CI_WATCHER_OWNER_PUBKEY=npub1...      # or 64 hex chars
node dist/main.js
```

The watcher pubkey it prints on startup must be present in each loom worker's
`ALLOW_UNPAID_PUBKEYS`. That is added out of band — nothing here automates it.

## Configuration

| Variable | Required | Default |
|---|---|---|
| `HIVE_CI_WATCHER_NSEC` | yes | — |
| `HIVE_CI_WATCHER_OWNER_PUBKEY` | yes | — |
| `HIVE_CI_WATCHER_DB` | no | `./watcher.db` |
| `HIVE_CI_WATCHER_RELAYS` | no | `wss://relay.budabit.club,wss://nos.lol,wss://relay.damus.io` |
| `HIVE_CI_WATCHER_BLOSSOM_SERVERS` | no | `https://blossom.budabit.club,https://blossom.primal.net,https://cdn.sovbit.host` |
| `HIVE_CI_WATCHER_LOG_LEVEL` | no | `info` |

The nsec is read in plaintext for v1; NIP-49 is deferred.

## CLI

The CLI is a thin ContextVM client — every subcommand is one tool call against
a running daemon.

```sh
export HIVE_CI_WATCHER_CLI_NSEC=nsec1...   # owner, or an allowlisted requester
export HIVE_CI_WATCHER_PUBKEY=<daemon pubkey>

hive-ci-watcher status
hive-ci-watcher runners-add <loom-worker-pubkey>   # owner only
hive-ci-watcher allow <requester-pubkey>           # owner only
hive-ci-watcher follow 30617:<owner-pubkey>:<identifier>
hive-ci-watcher follow naddr1...                    # relay hints in the naddr are used
hive-ci-watcher follow 30617:<owner>:<id> wss://relay.example   # or pass hints explicitly
hive-ci-watcher list                                # includes the announcement probe result
```

If `list` shows `announcement_probe.found: false`, the repo's 30617 is on no
relay the watcher can see. The watcher already consults the owner's NIP-65
relay list; the remaining fix is to follow with an naddr carrying the right
relay, or ask the owner to publish a kind 10002.

`runners-add`, `runners-remove`, `allow`, `revoke` and `allowed` are owner-only.
Everything else is open to the allowlist. Unknown callers get a flat
"not authorized" — the daemon does not disclose whether a pubkey exists in the
allowlist.

## Order of operations for a new deployment

1. Start the daemon and note its pubkey.
2. Add that pubkey to each loom worker's `ALLOW_UNPAID_PUBKEYS`.
3. `runners-add` each worker you want to use — only workers that now have the
   watcher pubkey on their `ALLOW_UNPAID_PUBKEYS`. The pool is private and is
   never published; an empty pool means no runs.
4. `follow` the repos you want watched.
5. Optionally publish a kind 30620 trusted-watchers list naming the daemon, so
   clients can show it. It is display metadata only — it does not gate the
   daemon, and removal from a 30620 does not silently unfollow.

## Operational note: the runner pool is a freelist assertion

A runner is eligible when it is **allowed ∩ online**. "Allowed" is the private
`runner_pool` table, writable only by the owner via `runners-add`.

Advertised pricing does **not** gate selection. A kind 10100 is one public
replaceable event serving every reader, so a worker that runs unpaid jobs for
the pubkeys in its `ALLOW_UNPAID_PUBKEYS` still advertises its ordinary rate to
everyone else — `loom-free-tier-worker`, for instance, advertises 0.1 sat/sec.
Gating on "advertises no price" would exclude exactly the workers you have an
arrangement with.

So `runners-add <pubkey>` means: *the watcher pubkey is on that worker's
`ALLOW_UNPAID_PUBKEYS`*. The watcher cannot verify this — a freelist is out of
band and unreadable from Nostr — so getting it wrong shows up as jobs silently
dropped at the worker, not as an error here. `hive-ci-watcher runners` reports
each member's `advertises_pricing` and `pricing` so you can see what a worker
charges the public, but neither field affects eligibility.

Every 5100 the watcher publishes omits the `payment` tag entirely.

## NixOS

```nix
{
  inputs.hive-ci-watcher.url = "github:...";

  # ...
  imports = [inputs.hive-ci-watcher.nixosModules.default];

  services.hive-ci-watcher = {
    enable = true;
    ownerPubkey = "npub1...";
    nsecFile = config.sops.secrets.hive-ci-watcher-nsec.path;
  };
}
```

The nsec never enters the Nix store: the module takes a path and feeds it in
via `LoadCredential`.

`packages.default` pins its `pnpmDeps` hash. On the first build it is
`lib.fakeHash`; run `nix build .#default` and replace it with the `got:` value.

## Development

```sh
pnpm dev        # tsx watch
pnpm verify     # lint + typecheck + test
```

`.github/workflows/test.yml` is deliberately `act`-compatible, so the watcher
can build itself through its own pipeline.

## Not in v1

- `paths` / `paths-ignore` filters (needs a real diff, which a shallow
  single-commit fetch cannot give)
- paid loom workers — every run goes out unpaid, on the strength of the
  worker's freelist
- private (encrypted) entries in the 30620 trusted-watcher list
- a per-repo CI secret store; watcher-triggered runs carry only `HIVE_CI_NSEC`
- dispatch retries, run supersession, concurrency caps
- `pull_request` and `workflow_dispatch` triggers

## Trust model

Allowlisted requesters are trusted as near co-owners: any repo, unfollow
anyone's, no quotas. Each repo they follow hands its owner control of the
clone URLs the watcher fetches from and the relays it connects to. See
DESIGN.md §8 before growing the allowlist beyond people you would hand the
owner key to.
