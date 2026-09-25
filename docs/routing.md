# Optional community infrastructure and relay roles

Community membership and transport configuration are independent. Both the
watcher and Loom can run standalone with explicit endpoints. Registering an
external repository or selecting an external worker does not move their traffic
onto the watcher's communities.

## Watcher configuration

`HIVE_CI_WATCHER_COMMUNITIES_FILE` optionally selects exact community coordinates
and bootstrap hints; the existing JSON format is unchanged. For each own service
role, an explicit setting wins, otherwise accepted community definitions provide
`r` inbox/outbox relays and `blossom` artifact servers. An explicitly supplied
`HIVE_CI_WATCHER_RELAYS` remains shorthand for both service directions, below the
role-specific `INBOX_RELAYS` and `OUTBOX_RELAYS` overrides.

Discovery has three independently configurable lists: `IDENTITY_DISCOVERY_RELAYS`
(Purple Pages), `GIT_DISCOVERY_RELAYS` (index.ngit.dev), and
`SERVICE_DISCOVERY_RELAYS` (the two ContextVM relays). Prefix each with
`HIVE_CI_WATCHER_`. Explicit empty discovery lists disable those paths.
They are never fallback job destinations. Community `grasp` endpoints contribute
to Git announcement discovery, not generic worker/service communication.

Explicit settings are not automatically merged with community endpoints.
Multiple configured communities supply a deduplicated shared service endpoint
set; per-community source event IDs and per-role provenance are exposed in
operator `status`. That set does not broaden repository or worker routes.

## Lifecycle

Signed, canonical, coordinate-matching definition replacements update
infrastructure live. Last-known-good signed definitions persist in the watcher
database and remain usable for transport through temporary lookup failures or
restart. Cached transport does **not** confer membership authorization after
restart: the existing freshness/completeness rules still apply.

Valid replacements remove retired destinations; a removed Blossom entry is not
restored by a built-in fallback. Operational management subscriptions and replies
have a 30-second handover overlap before retired endpoints are dropped.
Worker job monitoring retains the original outboxes for in-flight runs and also
follows subsequent signed worker mailboxes. Configuration-file coordinate changes
require restart. Definition and grant-list deletions remain ignored under the
community access policy.

The service publishes a marked NIP-65 list (`read` = inbox, `write` = outbox).
Management replies use service outboxes; CLI requests use service inboxes.
Both use signer-backed NIP-42 AUTH on relays requiring it. Service announcements
use service outboxes plus service-discovery targets, with no hidden SDK pools.

## Repository and worker traffic

Repository announcement lookup uses supplied hints, community relay/GRASP
infrastructure, owner outboxes and Git indexers. Subsequent `30618` subscriptions
and baseline queries use only the accepted `30617` relay list and maintainers.
Changing that scope invalidates the baseline until fresh state is synchronized.
No declared repository relays means unresolved activity/reporting.

The watcher resolves operator-approved runner pubkeys directly through signed
`10002`, then reads `10100` from their outboxes. Jobs (`5100`) go only to the
selected runner's inboxes and require acceptance there. A `5401` reporting ACK
cannot satisfy job delivery. `HIVE_CI_RELAYS` contains repository reporting relays;
native worker `30100`/`5101` results use their separate mailbox routes.

Job publication intent and job ID are persisted before sending. Relay acceptance
means `published`; worker-signed, job-correlated status/results mean queued,
running, completed or failed. A published job without worker evidence becomes
visibly unconfirmed after two minutes. Missing ACKs after a publication attempt
are also unconfirmed; push evaluation does not issue another job for that run.
Workers subscribe to new jobs at startup, so stored relay events do not guarantee
pickup after downtime. Automatic retry of uncertain execution is not introduced.

## Migration / rollback

1. Preserve the existing database and persistent key. Back up the database while
   the daemon is stopped (include WAL/SHM if copying while live).
2. Choose optional communities or explicit standalone endpoints. Remove previous
   `RELAYS`/Blossom settings if community derivation is intended; a legacy value
   now deliberately overrides derivation. Nix module defaults are nullable for
   the same reason.
3. Configure current Loom with `nostr.inbox`, `nostr.outbox` (or `nostr.relays`),
   or optional `community.sources`; enable the intended `freelist.event_id` list
   and include the persistent watcher pubkey. Community derivation grants no
   execution access by itself.
4. Verify published worker/service mailboxes and real relay AUTH, then use the
   local operator signer to call watcher `status` and `runners`.
5. Follow one repository, verify a fresh baseline and a representative completed
   job before expanding the pilot.

The database migration adds `run_jobs`; existing identities, runs, registrations
and access state remain intact. Rolling back the executable also requires the
previous configuration semantics; use the saved stopped database if necessary.
