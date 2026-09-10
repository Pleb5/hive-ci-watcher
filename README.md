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
hive-ci-watcher list
```

`runners-add`, `runners-remove`, `allow`, `revoke` and `allowed` are owner-only.
Everything else is open to the allowlist. Unknown callers get a flat
"not authorized" — the daemon does not disclose whether a pubkey exists in the
allowlist.

## Order of operations for a new deployment

1. Start the daemon and note its pubkey.
2. Add that pubkey to each loom worker's `ALLOW_UNPAID_PUBKEYS`.
3. `runners-add` each worker you want to use. The pool is private and is never
   published; an empty pool means no runs.
4. `follow` the repos you want watched.
5. Optionally publish a kind 30620 trusted-watchers list naming the daemon, so
   clients can show it. It is display metadata only — it does not gate the
   daemon, and removal from a 30620 does not silently unfollow.

## Operational note: what counts as a free runner

A runner is eligible only when it is **allowed ∩ online ∩ free**, and "free"
means its kind 10100 advertises **no `price` tag at all**. That is deliberate
and matches `budabit-pipelines-extension`: a 5100 with no `payment` tag is
exactly what a worker advertising a price silently rejects, so a malformed or
zero-rate paid ad keeps the paid path rather than failing open.

At the time of writing, every *named* worker advertising on the public relays
carries a `price` tag — including one called `loom-free-tier-worker`, whose
free tier comes from its own `ALLOW_UNPAID_PUBKEYS` rather than from its ad.
Under this rule none of them is eligible, so `list_runners` will report
`eligible: false` for them and nothing will dispatch.

Check with `hive-ci-watcher runners` before expecting runs. Until paid workers
land (see DESIGN.md §8), a usable pool needs a worker that both advertises no
pricing and has the watcher pubkey in its `ALLOW_UNPAID_PUBKEYS`.

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
- paid loom workers — free-only today
- private (encrypted) entries in the 30620 trusted-watcher list
- a per-repo CI secret store; watcher-triggered runs carry only `HIVE_CI_NSEC`
- dispatch retries, run supersession, concurrency caps
- `pull_request` and `workflow_dispatch` triggers
