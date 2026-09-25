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

export HIVE_CI_WATCHER_OWNER_PUBKEY=npub1...      # or 64 hex chars
node dist/main.js
```

By default the watcher **generates a fresh identity on every boot** and logs
its pubkey (hex and npub) at startup; when it stops it retracts its ContextVM
announcement so nothing discoverable points at a dead key.

For an identity that survives restarts — which you will want once the pubkey
is on workers' freelists and in repos' 30620 lists, since both are keyed by it
— either:

- `HIVE_CI_WATCHER_KEY_FILE=/path/to/watcher.key` — generated once on first
  boot (mode 0600), read back on every later one; or
- `HIVE_CI_WATCHER_NSEC=…` — a key you manage yourself. Takes precedence.

Whichever way, the watcher pubkey must be present in each Loom worker's
Nostr freelist (`freelist.enabled: true`, with `freelist.event_id` referencing
the list). The worker operator maintains that list.

## Configuration

| Variable | Required | Default |
|---|---|---|
| `HIVE_CI_WATCHER_NSEC` | no | — (wins over the key file) |
| `HIVE_CI_WATCHER_KEY_FILE` | no | — (unset: a fresh key per boot) |
| `HIVE_CI_WATCHER_OWNER_PUBKEY` | yes | — |
| `HIVE_CI_WATCHER_DB` | no | `./watcher.db` |
| `HIVE_CI_WATCHER_COMMUNITIES_FILE` | no | — (operator and explicit grants only) |
| `HIVE_CI_WATCHER_RELAYS` | standalone shorthand | — (explicit service inbox + outbox) |
| `HIVE_CI_WATCHER_INBOX_RELAYS` | standalone, unless shorthand supplied | — (otherwise community-derived) |
| `HIVE_CI_WATCHER_OUTBOX_RELAYS` | standalone, unless shorthand supplied | — (otherwise community-derived) |
| `HIVE_CI_WATCHER_BLOSSOM_SERVERS` | needed for dispatch | — (otherwise community-derived) |
| `HIVE_CI_WATCHER_IDENTITY_DISCOVERY_RELAYS` | no | `wss://purplepag.es` |
| `HIVE_CI_WATCHER_GIT_DISCOVERY_RELAYS` | no | `wss://index.ngit.dev` |
| `HIVE_CI_WATCHER_SERVICE_DISCOVERY_RELAYS` | no | `wss://relay.contextvm.org,wss://relay2.contextvm.org` |
| `HIVE_CI_WATCHER_FETCH_RETRY_WINDOW` | no | `600` (seconds; state events precede object uploads, so the remote is polled) |
| `HIVE_CI_WATCHER_LOG_LEVEL` | no | `info` |

When given, the nsec is read in plaintext for v1; NIP-49 is deferred.

Community configuration is **optional**. A standalone deployment supplies its
operational endpoints explicitly, for example:

```sh
HIVE_CI_WATCHER_INBOX_RELAYS=wss://inbox.example.com
HIVE_CI_WATCHER_OUTBOX_RELAYS=wss://outbox.example.com
HIVE_CI_WATCHER_BLOSSOM_SERVERS=https://blossom.example.com
```

With communities configured, omit a role's explicit setting to derive it from
the accepted definitions. Precedence is per-role override > explicitly supplied
`RELAYS` shorthand > community infrastructure. An empty optional discovery list
disables that path. Empty operational lists are configuration errors. Missing
Blossom routes disable artifact-dependent dispatch rather than selecting an
unrelated upload host. Damus and Primal are not defaults; explicitly configured
or advertised use is permitted.

Identity, repository-announcement, and watcher discovery are separate roles.
Jobs go to the selected worker's signed NIP-65 **inboxes**. Worker capabilities
and status come from its **outboxes**. Repository state and Hive `5401`/`5402`
reporting use the accepted repository announcement's `relays` only.
See [routing and migration](docs/routing.md) for live updates and failure behavior.

### Community-derived access

Set `HIVE_CI_WATCHER_COMMUNITIES_FILE=/etc/hive-ci-watcher/communities.json`
to admit effective members of multiple Communikeys V2 communities. The JSON
contains a `communities` array of `{address, relays}` entries, plus optional
`refreshSeconds` (default 60) and `maxAgeSeconds` (default 300). Each address is
an exact `32222:<owner-hex>:<community-id>` coordinate; each entry needs at least
one `wss://` relay. Edit the file over SSH and restart the service to apply it.

Membership in **any ready configured community** qualifies. Definitions and
grant-list replacements, effective person bans, and valid report retractions
are applied live. Deletion requests for kind **32222** definitions and kind
**30000** grant lists are deliberately ignored. Operator authority and manual
`allow` grants remain independent access sources.

See [community access](docs/community-access.md) for a complete example,
freshness/restart behavior, API changes, migration, and protocol provenance.
An [Ubuntu/systemd unit](deploy/hive-ci-watcher.service) is included for a
small pilot; it limits the daemon to one CPU and 1.5 GiB RAM.

## CLI

The CLI is a thin ContextVM client — every subcommand is one tool call against
a running daemon. It discovers the daemon's signed NIP-65 list through the
configured identity/service indexers, sends to its inboxes, and reads replies
from its outboxes. `HIVE_CI_WATCHER_RELAYS` is an explicit CLI override for both
directions. Failed discovery never turns an indexer into an operational relay.

```sh
nak-account status five                 # use your own local account alias
export HIVE_CI_WATCHER_CLI_ACCOUNT=five   # operator, explicitly allowed requester, or community member
export HIVE_CI_WATCHER_PUBKEY=<daemon pubkey>

hive-ci-watcher status
hive-ci-watcher runners-add <loom-worker-pubkey>   # owner only
hive-ci-watcher allow <requester-pubkey>           # owner only
hive-ci-watcher follow 30617:<owner-pubkey>:<identifier>
hive-ci-watcher follow naddr1...                    # relay hints in the naddr are used
hive-ci-watcher follow 30617:<owner>:<id> wss://relay.example   # or pass hints explicitly
hive-ci-watcher list                                # includes the announcement probe result
hive-ci-watcher unfollow 30617:<owner>:<id>            # remove your registration
hive-ci-watcher unfollow 30617:<owner>:<id> --all      # operator: remove every registration
```

With `HIVE_CI_WATCHER_CLI_ACCOUNT`, run the CLI on the machine with your
`nak-account` installation and an authorized signer. If needed, run
`nak-account start five` in a terminal first. The CLI delegates event signing
and NIP-44 encryption/decryption to `nak-account run --as five -- …`; it does
not read the operator key, bunker profiles, or the account client's key file.
The SDK handles ContextVM requests, encrypted gift wraps, and responses.
`nak` alone does not provide this management protocol. Tested with nak 0.19.7.

Only the operator **public** key belongs in the daemon configuration. The
daemon has its own persistent key, which is the identity authorized on Loom
workers. The local signer must be trusted: an authorized application can ask
it to sign as your operator. Also, nak 0.19.7 accepts NIP-44 message inputs as
process arguments, so local process inspection can expose management payloads.
The operator secret is never supplied in those arguments.

Alternatively, the CLI still accepts `HIVE_CI_WATCHER_CLI_NSEC`, loaded from
private storage. Set exactly one signer option; configuring both is an error.

If `list` shows `announcement_probe.found: false`, the repo's 30617 is on no
relay the watcher can see. The watcher already consults the owner's NIP-65
relay list; the remaining fix is to follow with an naddr carrying the right
relay, or ask the owner to publish a kind 10002.

`runners-add`, `runners-remove`, `allow`, `revoke` and `allowed` are operator-only.
Eligible requesters may register any repo. Each requester owns a separate
registration; multiple registrations share one pipeline. `unfollow` removes
only your registration, and watching continues while another eligible
registration remains. `list` and recent runs in `status` are scoped to your
registrations; the operator sees all of them. After losing eligibility you
can still inspect and remove your existing registrations. Unknown callers
get a flat "not authorized".

`allowed` shows explicit grants, derived members and their community sources,
and per-community readiness. `revoke` removes only the explicit grant.

## Order of operations for a new deployment

1. Start the daemon and note its pubkey. Decide now whether it should be
   persistent (`HIVE_CI_WATCHER_KEY_FILE` or `HIVE_CI_WATCHER_NSEC`) — steps 2
   and 5 bind to it.
2. Add that pubkey to each Loom worker's configured Nostr freelist.
3. `runners-add` each worker you want to use — only workers that now have the
   watcher pubkey on their freelist. The pool is private and is
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
the pubkeys in its freelist still advertises its ordinary rate to
everyone else — `loom-free-tier-worker`, for instance, advertises 0.1 sat/sec.
Gating on "advertises no price" would exclude exactly the workers you have an
arrangement with.

So `runners-add <pubkey>` asserts an unpaid arrangement with that worker.
`hive-ci-watcher runners` reports NIP-65 routes, advertisement freshness, pricing,
and membership in a freelist when the worker advertises its list reference.
Missing mailboxes prevent dispatch. Relay acceptance is recorded as `published`,
not execution; signed worker `30100` and `5101` events provide execution evidence.
A publication without worker confirmation is shown as `unconfirmed` after two
minutes. Uncertain job publication is not automatically resubmitted.

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
    persistKey = true;   # keep a generated key in /var/lib/hive-ci-watcher
    communitiesFile = "/etc/hive-ci-watcher/communities.json";
    logLevel = "debug";      # watcher logger
    sdkLogLevel = "warn";    # ContextVM / applesauce (pino); "trace" for every relay message
    # nsecFile = config.sops.secrets.hive-ci-watcher-nsec.path;  # or bring your own
  };
}
```

Without `persistKey` or `nsecFile` the unit gets a new identity each start.
`nsecFile` never enters the Nix store: the module takes a path and feeds it in
via `LoadCredential`.

`packages.default` pins its `pnpmDeps` hash. On the first build it is
`lib.fakeHash`; run `nix build .#default` and replace it with the `got:` value.

## Development

```sh
pnpm dev        # tsx watch; key and db under ./.dev (gitignored)
pnpm verify     # lint + typecheck + test
```

`pnpm dev` keeps a **persistent** identity in `.dev/watcher.key` (generated on
the first run) and its database in `.dev/watcher.db`, so restarts during
development keep the same pubkey — whitelist it once. Only
`HIVE_CI_WATCHER_OWNER_PUBKEY` needs to be in the environment. Logs are
pretty-printed on a TTY; `HIVE_CI_WATCHER_LOG_FORMAT=json` forces JSON.

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

Eligible requesters can register any repo and consume the configured runner
pool, with no per-requester quotas. They control only their own registrations.
Community owners manage membership but gain no watcher-operator authority.
Each registered repo's owner controls its clone URLs, relays, maintainers,
and workflows. See DESIGN.md §8.
