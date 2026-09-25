# Community access and owned watch registrations

## Local configuration

The operator chooses communities through a local file. There is no Nostr
configuration/control event for this list. Set:

```sh
HIVE_CI_WATCHER_COMMUNITIES_FILE=/etc/hive-ci-watcher/communities.json
```

Example shape (replace every placeholder with a real lowercase 64-hex value):

```json
{
  "communities": [
    {
      "address": "32222:<first-owner-hex>:<first-community-id>",
      "relays": ["wss://relay.budabit.club"]
    },
    {
      "address": "32222:<second-owner-hex>:<second-community-id>",
      "relays": ["wss://relay.example.com"]
    }
  ],
  "refreshSeconds": 60,
  "maxAgeSeconds": 300
}
```

Configuration is validated at startup. Unknown fields, duplicate community
coordinates, invalid coordinates/URLs, or a maximum age no greater than the
refresh interval fail startup. Each entry requires 1–20 `wss://` bootstrap
relays; at most 100 communities are supported. Refresh interval: 5–3600 seconds;
maximum age: 10–86400 seconds. An absent file setting or an empty community array
enables operator/manual-grant access only.

Edit the file through the server's configuration workflow, then restart the
service. Membership updates within those communities arrive live. The NixOS
module exposes `services.hive-ci-watcher.communitiesFile` as a runtime path.
The [systemd unit](../deploy/hive-ci-watcher.service) uses the same environment
variable through `/etc/hive-ci-watcher/watcher.env`.

## Eligibility

A requester is eligible if they are the watcher operator, have an explicit
SQLite grant, or belong to **any ready configured community**. Community
branches are exact `32222:owner:id` coordinates: matching only `id` is never
sufficient. A ban in one branch does not veto another qualifying branch or
an explicit grant.

Within a ready branch:

- The configured owner qualifies, including after a successful empty sync.
- Every owner of a referenced kind-30000 profile list is a structural member,
  including pending/missing or declined lists.
- Valid lowercase-hex `p` grants from current, non-declined referenced lists
  qualify. All content sections participate, not just the repository section.
- Current valid replacements win by newest `created_at`, then lowest event ID.
  Removed grants and removed list references take effect.
- Effective person bans remove non-owner members. Only the owner or an active
  all-sections moderator can person-ban; moderators are protected from other
  moderators. A banned reporter loses their banning authority.
- A retraction must have the protocol's exact same-author, community-scoped,
  marked report reference (and either no `k` tag or a `1984` tag). Tombstones
  survive restart and work when delivered before the report.
- Personal renunciations/exclusions are client preferences, not service access.

Community owners acquire membership access, **not watcher-operator authority**.
Only the operator changes runners, explicit grants, or other users' registrations.

### Intentional deletion exception

The private authority view ignores deletion requests targeting definitions
(`32222`) and grant lists (`30000`), including address, event-ID and kind targets.
It does not pass authority data through Applesauce EventStore's automatic
NIP-09 deletion manager. Updates must be replacements: remove `p` tags, remove
definition references, or apply effective bans. Valid report retractions still
work. An authority cache retains the latest observed valid protected events;
an empty relay response does not erase previously observed authority.
The latest observed list version is retained even when its reference is removed
from the definition, including in persisted snapshots. Only current references
grant membership; restoring a reference cannot roll back a known revocation by
replaying an older list version.

This is an explicit v1 exception to the Budabit/strfry historical-deletion
semantics, not a claim of full deletion parity. It matches the chosen watcher
behavior while the relay protects kinds 30000 and 32222 against new deletions.

## Synchronization and freshness

Each community tracks its own loading/ready/unavailable/stale state. Cached
authority is verified again on startup but grants no access until a fresh
dependency synchronization finishes. Queries cover the exact definition,
referenced lists, person reports and report retractions; definition/list relay
hints widen the bootstrap relay set.

Raw Nostr events are signature/ID verified. A query needs actual EOSE from at
least one queried relay for every required filter, with results unioned from
all successful relays. A timeout, error, CLOSED, or cached result is not EOSE.
Empty completed responses are valid. The service relies on the configured and
authority-advertised relays serving their retained history; EOSE cannot prove
that a relay stores every event ever published elsewhere.

History requests paginate with overlapping timestamps. An unpageable saturated
timestamp or an exceeded page/history bound fails the refresh. Individual
pages have a 15-second deadline, the synchronization pass has a 60-second
deadline, and query concurrency is capped at four. Each synchronization owner
(community or repository hydration pass) gets at most one active relay attempt;
waiting owners rotate after attempts, and queued requests cancel immediately.
One owner's relay fan-out cannot occupy all four slots ahead of another owner.

Live changes apply immediately; only completed synchronization renews freshness.
A changed definition invalidates completeness until its dependencies are
loaded. A failed refresh preserves already-completed authority only until its
maximum age, measured from the start of that synchronization. Expiry is checked
on access as well as by a timer. Communities fail independently. No ready
membership source means no community-derived access, including for its owner.
Manual/operator grants remain separate sources.

## Registrations, API, and lifecycle

`follow_repo` creates/upserts only the caller's `(repo_addr, requester)` entry;
repeated calls merge that caller's hints and retain their original registration
time. Eligible registrations' hints feed one live watch pipeline per repository.

`unfollow_repo` removes the caller's entry by default. Operator-only options:

```json
{"repo_addr": "30617:<owner>:<id>", "requester_pubkey": "<requester-hex>"}
{"repo_addr": "30617:<owner>:<id>", "all": true}
```

Corresponding CLI commands:

```sh
hive-ci-watcher unfollow 30617:<owner>:<id>
hive-ci-watcher unfollow 30617:<owner>:<id> <requester-hex>
hive-ci-watcher unfollow 30617:<owner>:<id> --all
```

`list_followed` reports a `registrations` array with requester, time, hints,
eligibility and access provenance; `active` describes shared repository
activation. The old single `added_by`, `added_at`, and aggregate `relay_hints`
API fields are replaced by that array. A caller sees their own entries and
repository state; the operator sees all entries. `status` scopes repository
counts and recent runs similarly and includes the caller's access sources.
`list_allowed` preserves `allowed` for explicit grants and adds `derived` and
`communities`; operator `status` also includes community readiness. `revoke_pubkey`
removes only the explicit grant and returns remaining access sources.

When the last eligible registration disappears, new dispatch stops immediately,
queued evaluations are aborted, and ref/schedule baselines are reset. Suspended
registrations stay in SQLite. Their owners can still list/status/unfollow them
after losing eligibility. Returning eligibility reactivates watching; deleting
the last registration removes shared watch state after pending evaluation ends.

Every start or resume waits for a completed repository announcement/state sync,
then seeds current refs without dispatch. The selected announcement and any
existing selected state must actually occur in that synchronization's responses;
empty EOSE cannot validate a cached pre-suspension candidate. Incomplete baselines
retry, while a genuinely new repository can seed its first future state. Suspension
immediately invalidates a live watch's baseline, and serialized reconciliation
rechecks current activation after earlier repositories' teardowns. Missed
scheduled runs are not replayed. Dispatch checks
current eligibility and the activation epoch after async preparation and before
both the 5401 announcement and 5100 job publication. Suspension invalidates old
work even if access returns quickly. A published announcement may have no job
if eligibility is lost between the two publications. Already submitted jobs
continue on the workers.

## Database migration

Startup creates `repo_registrations`, adds `followed_repos.active`, and
transactionally backfills each old row's `added_by`, `added_at`, and relay hints.
A migration marker prevents removed legacy registrations from reappearing on
subsequent boots. Existing explicit grants, runner pool and run history remain.
Startup recomputes activation and resets repository baselines; old work is not
replayed. Stop the service and back up its SQLite database before upgrading.

## Conformance and source provenance

The headless TypeScript derivation follows Budabit's `community-protocol.ts`,
`community-membership.ts`, `community-reports.ts`, and `community-read-access.ts`
(reviewed at `2dc37a23eae2d6a285655ff085e4ac9008f3d73e`), with the exception above.
The upstream MIT notice is retained in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

`test/fixtures/community-vectors.json` pins the shared oracle from strfry
`b574d2b78a98c2e07db4b02fead89da33d252a44`, including its original Budabit source
commit and SHA-256. It contains 35 definition vectors and 22 reader scenarios
(seven callers each). Nineteen reader scenarios use unchanged expectations;
three protected-deletion scenarios use explicit expectations independently
checked against the Python reader with protected deletions omitted.

Regenerate with `node scripts/sync-community-vectors.mjs`; tests need no network.
Additional tests exercise signed ingress, malformed retractions, freshness,
outages, same-ID branches, persistence, migration, actual MCP ownership handlers,
shared subscriptions, restart/resume seeding, and asynchronous dispatch revocation.

```sh
pnpm verify
pnpm build
```
