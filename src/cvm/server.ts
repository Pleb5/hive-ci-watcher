import {DEFAULT_BOOTSTRAP_RELAY_URLS, EncryptionMode, GiftWrapMode} from '@contextvm/sdk/core'
import {mergeRelaySets} from 'applesauce-core/helpers/relays'
import {ApplesauceRelayPool} from '@contextvm/sdk/relay'
import {PrivateKeySigner} from '@contextvm/sdk/signer'
import {NostrServerTransport} from '@contextvm/sdk/transport'
import {McpServer} from '@contextvm/mcp-sdk/server/mcp.js'
import type {NostrEvent} from 'nostr-tools'
import {z} from 'zod'
import {CVM_RELAYS, type WatcherConfig} from '../config.js'
import type {WatcherDb} from '../db/index.js'
import type {WatcherIdentity} from '../identity.js'
import {createLogger, errorMessage} from '../log.js'
import {nip19} from 'nostr-tools'
import {normalizeRelays} from '../nostr/client.js'
import {isFreeWorker, isWorkerOnline, KIND_REPO_ANNOUNCEMENT, parseRepoAddress, repoAddress} from '../nostr/events.js'
import type {Watcher} from '../watcher.js'
import {assertPubkey, Authorizer, NOT_AUTHORIZED, type ToolAudience} from './auth.js'

const log = createLogger('cvm')

/**
 * Discovery tag on the 11316 server announcement. There is no custom
 * watcher-announcement kind: `{kinds:[11316], '#t':['hive-ci-watcher']}` is the
 * filter the management site uses, and a reader holding a pubkey from a repo's
 * 30620 can skip discovery and fetch that pubkey's 11316 directly.
 */
export const WATCHER_DISCOVERY_TAG = 'hive-ci-watcher'

const CURSOR_KEY = 'runner_round_robin_cursor'

interface ToolContext {
  config: WatcherConfig
  db: WatcherDb
  identity: WatcherIdentity
  watcher: Watcher
  authorizer: Authorizer
  /** Resolves the signed inner request event for a handled call, for replay checks. */
  getRequestEvent?: (requestEventId: string) => NostrEvent | undefined
}

/**
 * A request whose inner event is stamped outside this window is refused.
 *
 * The transport deduplicates by event id, but only in a bounded in-memory
 * LRU, and a captured gift wrap re-published with the same bytes is otherwise
 * indistinguishable from the original. Requiring the caller's own signed
 * timestamp to be recent turns a captured `allow_pubkey` into a dead letter
 * after five minutes instead of a re-grant after five thousand requests.
 */
export const REQUEST_MAX_AGE_SECONDS = 5 * 60

type ToolResult = {content: Array<{type: 'text'; text: string}>; isError?: boolean}

function ok(payload: unknown): ToolResult {
  return {content: [{type: 'text', text: JSON.stringify(payload, null, 2)}]}
}

function fail(message: string): ToolResult {
  return {content: [{type: 'text', text: message}], isError: true}
}

function callerPubkey(extra: {_meta?: Record<string, unknown> | undefined}): string | undefined {
  // Taken from the decrypted inner event by the transport's
  // `injectClientPubkey`, never from the gift wrap.
  const value = extra._meta?.clientPubkey
  return typeof value === 'string' ? value.toLowerCase() : undefined
}

/**
 * Checks the inner event's `created_at` against the clock. Fails closed:
 * without the event there is nothing to check, and a request we cannot date
 * is treated like one that is stale.
 */
export function isFreshRequest(
  event: {created_at: number; pubkey: string} | undefined,
  caller: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!event || !caller) return false
  if (event.pubkey.toLowerCase() !== caller) return false
  return Math.abs(nowSeconds - event.created_at) <= REQUEST_MAX_AGE_SECONDS
}

/**
 * Wraps a tool handler in its authorization check.
 *
 * Every refusal is the same flat string regardless of why — the daemon does
 * not disclose whether a pubkey exists in the allowlist.
 */
function guarded(
  ctx: ToolContext,
  tool: string,
  audience: ToolAudience,
  handler: (args: any, caller: string) => Promise<ToolResult> | ToolResult,
) {
  return async (args: any, extra: any): Promise<ToolResult> => {
    const caller = callerPubkey(extra ?? {})
    log.info('tool call', {tool, caller: caller?.slice(0, 12) ?? 'anonymous'})
    if (!ctx.authorizer.authorize(caller, audience)) {
      log.warn('tool call refused', {tool, audience, caller: caller?.slice(0, 12) ?? 'anonymous'})
      return fail(NOT_AUTHORIZED)
    }

    if (ctx.getRequestEvent) {
      const requestEventId = extra?._meta?.requestEventId
      const event = typeof requestEventId === 'string' ? ctx.getRequestEvent(requestEventId) : undefined
      if (!isFreshRequest(event, caller)) {
        log.warn('tool call refused as stale or undated', {
          tool,
          caller: caller?.slice(0, 12),
          createdAt: event?.created_at ?? null,
        })
        return fail(NOT_AUTHORIZED)
      }
    }
    try {
      return await handler(args ?? {}, caller!)
    } catch (err) {
      log.warn('tool call failed', {tool, error: errorMessage(err)})
      return fail(errorMessage(err))
    }
  }
}

/**
 * Normalises a repo address argument.
 *
 * `follow_repo` accepts either a full `30617:<owner>:<d>` address or an
 * explicit owner + identifier pair; a 30618-flavoured address is rewritten to
 * its 30617 form, since the announcement is the trust root and the only thing
 * the follow table keys on.
 */
function resolveRepoAddress(args: {
  repo_addr?: string
  repo_owner?: string
  d_tag?: string
  relays?: string[]
}): {
  repoAddr: string
  repoOwner: string
  dTag: string
  relayHints: string[]
} {
  const explicitHints = Array.isArray(args.relays) ? args.relays.filter(r => typeof r === 'string') : []

  if (args.repo_addr) {
    const raw = args.repo_addr.trim().replace(/^nostr:/, '')

    // An naddr carries the relays the repo lives on. Those are the hints that
    // make a repo findable when its owner's announcement is nowhere on our
    // defaults and they publish no kind 10002.
    if (raw.startsWith('naddr1')) {
      const decoded = nip19.decode(raw)
      if (decoded.type !== 'naddr') throw new Error('repo_addr decoded to a non-naddr entity')
      const {kind, pubkey, identifier, relays} = decoded.data
      if (kind !== KIND_REPO_ANNOUNCEMENT && kind !== 30618) {
        throw new Error(`naddr kind ${kind} is not a repo announcement`)
      }
      if (!identifier) throw new Error('naddr has no identifier')
      return {
        repoAddr: repoAddress(pubkey, identifier),
        repoOwner: pubkey,
        dTag: identifier,
        relayHints: normalizeRelays([...(relays ?? []), ...explicitHints]),
      }
    }

    const parsed = parseRepoAddress(raw)
    if (!parsed) throw new Error('repo_addr must be <kind>:<owner-pubkey-hex>:<identifier> or an naddr')
    return {
      repoAddr: repoAddress(parsed.owner, parsed.dTag),
      repoOwner: parsed.owner,
      dTag: parsed.dTag,
      relayHints: normalizeRelays(explicitHints),
    }
  }

  const repoOwner = assertPubkey(args.repo_owner, 'repo_owner')
  const dTag = (args.d_tag ?? '').trim()
  if (!dTag) throw new Error('d_tag is required when repo_addr is omitted')
  return {repoAddr: repoAddress(repoOwner, dTag), repoOwner, dTag, relayHints: normalizeRelays(explicitHints)}
}

const repoAddressShape = {
  repo_addr: z
    .string()
    .optional()
    .describe('Full repo address, 30617:<owner-pubkey-hex>:<identifier>, or an naddr (relay hints are used)'),
  repo_owner: z.string().optional().describe('Repo owner pubkey (hex) — alternative to repo_addr'),
  d_tag: z.string().optional().describe('Repo identifier (the 30617 d tag) — alternative to repo_addr'),
  relays: z.array(z.string()).optional().describe('Extra relay hints where the repo publishes'),
}

export function registerTools(server: McpServer, ctx: ToolContext): void {
  const {db, watcher, authorizer} = ctx

  server.registerTool(
    'follow_repo',
    {
      description:
        'Register a repo for the caller. Any repo; multiple callers share one watch pipeline.',
      inputSchema: repoAddressShape,
    },
    guarded(ctx, 'follow_repo', 'allowlisted', async (args, caller) => {
      const {repoAddr, repoOwner, dTag, relayHints} = resolveRepoAddress(args)
      db.followRepo({repoAddr, repoOwner, dTag, addedBy: caller, relayHints})
      await watcher.reconcileAccess()
      const stored = db.listRegistrations(repoAddr).find(r => r.requester === caller)
      log.info('repo followed', {repoAddr, by: caller.slice(0, 12), hints: relayHints.length})
      return ok({followed: repoAddr, requester: caller, relay_hints: stored?.relayHints ?? relayHints})
    }),
  )

  server.registerTool(
    'unfollow_repo',
    {
      description: 'Remove your registration. The operator may target another requester or remove all registrations.',
      inputSchema: {
        ...repoAddressShape,
        requester_pubkey: z.string().optional().describe('Operator only: requester whose registration to remove'),
        all: z.boolean().optional().describe('Operator only: remove every registration for this repo'),
      },
    },
    guarded(ctx, 'unfollow_repo', 'registered', async (args, caller) => {
      if ((args.all || args.requester_pubkey) && !authorizer.isOwner(caller)) return fail(NOT_AUTHORIZED)
      if (args.all && args.requester_pubkey) throw new Error('choose all or requester_pubkey, not both')
      const {repoAddr} = resolveRepoAddress(args)
      const requester = args.all ? undefined : args.requester_pubkey ? assertPubkey(args.requester_pubkey, 'requester_pubkey') : caller
      const removed = db.removeRegistration(repoAddr, requester)
      await watcher.reconcileAccess()
      return ok({unfollowed: repoAddr, existed: removed, ...(authorizer.isOwner(caller) ? {registrations_remaining: db.listRegistrations(repoAddr).length} : {})})
    }),
  )

  server.registerTool(
    'list_followed',
    {
      description: 'Your registrations and repo state; the operator sees every registration.',
      inputSchema: {},
    },
    guarded(ctx, 'list_followed', 'registered', (_args, caller) =>
      ok({
        repos: db.listFollowedRepos().filter(repo => authorizer.isOwner(caller) || db.hasRegistration(caller, repo.repoAddr)).map(repo => ({
          repo_addr: repo.repoAddr,
          repo_owner: repo.repoOwner,
          d_tag: repo.dTag,
          default_branch: repo.defaultBranch,
          registrations: db.listRegistrations(repo.repoAddr).filter(r => authorizer.isOwner(caller) || r.requester === caller).map(r => ({
            requester: r.requester, added_at: r.addedAt, relay_hints: r.relayHints,
            eligible: authorizer.authorize(r.requester, 'allowlisted'), access: authorizer.sources(r.requester),
          })),
          active: repo.active && watcher.isEligible(repo.repoAddr),
          seeded_at: repo.seededAt,
          announcement_probe: watcher.repoProbe(repo.repoAddr),
          unparseable_workflows: watcher.unparseableWorkflows(repo.repoAddr),
          refs: db.getRefStates(repo.repoAddr).map(state => ({
            ref: state.ref,
            commit: state.commitId,
            updated_at: state.updatedAt,
            deleted_at: state.deletedAt,
          })),
          schedules: db.listSchedules(repo.repoAddr).map(schedule => ({
            workflow_path: schedule.workflowPath,
            cron: schedule.cron,
            last_fired_at: schedule.lastFiredAt,
          })),
        })),
      }),
    ),
  )

  server.registerTool(
    'status',
    {
      description: 'Uptime, relay health, runner pool size, and recent runs.',
      inputSchema: {},
    },
    guarded(ctx, 'status', 'registered', (_args, caller) => ok({
      ...watcher.status(authorizer.isOwner(caller) ? undefined : caller),
      access: authorizer.sources(caller),
      ...(authorizer.isOwner(caller) ? {communities: watcher.communities.status()} : {}),
    })),
  )

  server.registerTool(
    'list_runners',
    {
      description:
        'The resolved runner pool: allowed ∩ online, with the round-robin cursor. ' +
        'Advertised pricing is reported but does not gate eligibility — pool ' +
        'membership asserts an unpaid arrangement with the worker.',
      inputSchema: {},
    },
    guarded(ctx, 'list_runners', 'allowlisted', async () => {
      const workers = watcher.knownWorkers()
      const now = Date.now()
      const cursorRaw = db.getKv(CURSOR_KEY)

      const runners = await Promise.all(
        db.listRunnerPool().map(async entry => {
          const worker = workers.get(entry.pubkey)
          const online = !!worker && isWorkerOnline(worker, now)
          return {
            pubkey: entry.pubkey,
            added_at: entry.addedAt,
            known: !!worker,
            name: worker?.name ?? null,
            online,
            // Informational only. A worker on our freelist still advertises
            // its public rate, since a 10100 is one event for every reader.
            advertises_pricing: !!worker && !isFreeWorker(worker),
            pricing: worker?.pricing ?? null,
            // Verified against the worker's published freelist set when it
            // advertises one; null when it does not.
            on_freelist: worker ? await watcher.freelistStatus(entry.pubkey) : null,
            queue_depth: worker?.currentQueueDepth ?? null,
            last_seen: worker?.lastSeen ?? null,
            eligible: online,
          }
        }),
      )

      return ok({cursor: cursorRaw === null ? 0 : Number.parseInt(cursorRaw, 10) || 0, runners})
    }),
  )

  server.registerTool(
    'runners_add',
    {
      description: 'Add a runner pubkey to the private pool. The pool is never published.',
      inputSchema: {pubkey: z.string().describe('Loom worker pubkey (hex)')},
    },
    guarded(ctx, 'runners_add', 'owner', args => {
      const pubkey = assertPubkey(args.pubkey, 'pubkey')
      db.addRunner(pubkey)
      return ok({added: pubkey})
    }),
  )

  server.registerTool(
    'runners_remove',
    {
      description: 'Remove a runner pubkey from the pool.',
      inputSchema: {pubkey: z.string().describe('Loom worker pubkey (hex)')},
    },
    guarded(ctx, 'runners_remove', 'owner', args => {
      const pubkey = assertPubkey(args.pubkey, 'pubkey')
      return ok({removed: pubkey, existed: db.removeRunner(pubkey)})
    }),
  )

  server.registerTool(
    'allow_pubkey',
    {
      description: 'Add a requester to the allowlist.',
      inputSchema: {pubkey: z.string().describe('Requester pubkey (hex)')},
    },
    guarded(ctx, 'allow_pubkey', 'owner', async args => {
      const pubkey = assertPubkey(args.pubkey, 'pubkey')
      db.allowPubkey(pubkey)
      await watcher.reconcileAccess()
      return ok({allowed: pubkey})
    }),
  )

  server.registerTool(
    'revoke_pubkey',
    {
      description: 'Remove an explicit grant. Membership in a configured community may still authorize the requester.',
      inputSchema: {pubkey: z.string().describe('Requester pubkey (hex)')},
    },
    guarded(ctx, 'revoke_pubkey', 'owner', async args => {
      const pubkey = assertPubkey(args.pubkey, 'pubkey')
      const existed = db.revokePubkey(pubkey)
      await watcher.reconcileAccess()
      return ok({revoked: pubkey, existed, access: authorizer.sources(pubkey)})
    }),
  )

  server.registerTool(
    'list_allowed',
    {
      description: 'Explicit grants and community-derived membership, with per-community readiness. Operator only.',
      inputSchema: {},
    },
    guarded(ctx, 'list_allowed', 'owner', () =>
      ok({
        owner: ctx.config.ownerPubkey,
        allowed: db.listAllowed().map(entry => ({pubkey: entry.pubkey, added_at: entry.addedAt})),
        derived: watcher.communities.listMembers(),
        communities: watcher.communities.status(),
      }),
    ),
  )
}

export interface CvmServerHandle {
  close(): Promise<void>
  /** Publishes NIP-09 deletions for the 11316/11317 announcements. */
  retract(reason: string): Promise<void>
}

/**
 * Starts the daemon's MCP server over Nostr.
 *
 * `EncryptionMode.REQUIRED` with ephemeral gift wrap: repo addresses and
 * allowlist membership should not sit in the clear on relays, and the wraps
 * themselves should not accumulate on them either.
 *
 * The transport is left `isAnnouncedServer` so the management site can find
 * the watcher, but authorization is entirely ours — `allowedPublicKeys` is not
 * used, because tool-level audiences (owner-only vs allowlisted) are finer
 * than a transport-wide gate, and the flat refusal has to come from us to stay
 * uniform.
 */
export async function startCvmServer(ctx: ToolContext): Promise<CvmServerHandle> {
  const server = new McpServer(
    {name: 'hive-ci-watcher', version: '0.1.0'},
    {capabilities: {tools: {}}},
  )

  // The management surface lives on the configured defaults plus ContextVM's
  // relays. Relays learned from followed repos are for watching those repos,
  // and a bad one must not be able to keep the CVM server from starting.
  const relayPool = new ApplesauceRelayPool(ctx.config.cvmRelays)
  const transport = new NostrServerTransport({
    signer: new PrivateKeySigner(ctx.identity.secretKeyHex),
    relayHandler: relayPool,
    encryptionMode: EncryptionMode.REQUIRED,
    // OPTIONAL accepts both persistent (1059) and ephemeral (21059) wraps and
    // mirrors the client's choice on the reply. EPHEMERAL would subscribe to
    // 21059 only — and a client that has not yet learned
    // `support_encryption_ephemeral` (a stateless client connecting off the
    // 11316 alone never does) sends 1059, which the server would then never
    // even see. The announcement still advertises ephemeral support, so
    // clients that can use it do.
    giftWrapMode: GiftWrapMode.OPTIONAL,
    isAnnouncedServer: true,
    // Announcements also go to these discoverability-only targets.
    bootstrapRelayUrls: mergeRelaySets(DEFAULT_BOOTSTRAP_RELAY_URLS, CVM_RELAYS),
    // The caller's pubkey has to reach the tool handlers; the transport reads
    // it off the decrypted inner event. The request event id lets the guard
    // fetch that same signed event and check its timestamp.
    injectClientPubkey: true,
    injectRequestEventId: true,
    serverInfo: {
      name: 'hive-ci-watcher',
      about: 'Watches Nostr repositories and dispatches Hive CI runs on the owner’s behalf.',
    },
  })

  // No custom watcher-announcement kind: this extra tag on the 11316 is what
  // makes `{kinds:[11316], '#t':['hive-ci-watcher']}` the discovery filter.
  transport.setAnnouncementExtraTags([['t', WATCHER_DISCOVERY_TAG]])

  registerTools(server, {
    ...ctx,
    getRequestEvent: id => transport.getNostrRequestEvent(id),
  })

  await server.connect(transport)
  log.info('contextvm server announced', {pubkey: ctx.identity.pubkey, tag: WATCHER_DISCOVERY_TAG})

  return {
    async close() {
      await server.close().catch(() => undefined)
      await relayPool.disconnect().catch(() => undefined)
    },
    async retract(reason) {
      // The SDK's deleteAnnouncement collects ids from a subscription it never
      // awaits, so it always finds nothing. Replaceable kinds need no ids
      // anyway: a NIP-09 `a` tag addresses them by kind and author. Publish
      // where the announcements went — our defaults plus the SDK's bootstrap
      // relays — best-effort, one accept is enough.
      const kinds = [11316, 11317, 11318, 11319, 11320]
      const targets = mergeRelaySets(ctx.config.cvmRelays, DEFAULT_BOOTSTRAP_RELAY_URLS, CVM_RELAYS)
      // Some relays only act on `e` tags for these kinds, so fetch our own
      // announcements and name them by id as well as by address.
      const own = await ctx.watcher.nostr.requestAll(
        targets,
        {kinds, authors: [ctx.identity.pubkey]},
        5_000,
        'retract:self',
        1_500,
      )
      const deletion = ctx.identity.sign({
        kind: 5,
        created_at: Math.floor(Date.now() / 1000),
        content: reason,
        tags: [
          ...kinds.map(kind => ['a', `${kind}:${ctx.identity.pubkey}:`]),
          ...[...new Set(own.map(event => event.id))].map(id => ['e', id]),
          ...kinds.map(kind => ['k', String(kind)]),
        ],
      })
      const outcome = await ctx.watcher.nostr.publish(targets, deletion, 1, 8_000)
      log.info('announcements retracted', {byId: own.length, acceptedBy: outcome.accepted, rejected: outcome.rejected})
    },
  }
}
