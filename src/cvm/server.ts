import {EncryptionMode, GiftWrapMode} from '@contextvm/sdk/core'
import {ApplesauceRelayPool} from '@contextvm/sdk/relay'
import {PrivateKeySigner} from '@contextvm/sdk/signer'
import {NostrServerTransport} from '@contextvm/sdk/transport'
import {McpServer} from '@contextvm/mcp-sdk/server/mcp.js'
import {z} from 'zod'
import type {WatcherConfig} from '../config.js'
import type {WatcherDb} from '../db/index.js'
import type {WatcherIdentity} from '../identity.js'
import {createLogger, errorMessage} from '../log.js'
import {isFreeWorker, isWorkerOnline, parseRepoAddress, repoAddress} from '../nostr/events.js'
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
}

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
 * Wraps a tool handler in its authorization check.
 *
 * Every refusal is the same flat string regardless of why — the daemon does
 * not disclose whether a pubkey exists in the allowlist.
 */
function guarded(
  ctx: ToolContext,
  audience: ToolAudience,
  handler: (args: any, caller: string) => Promise<ToolResult> | ToolResult,
) {
  return async (args: any, extra: any): Promise<ToolResult> => {
    const caller = callerPubkey(extra ?? {})
    if (!ctx.authorizer.authorize(caller, audience)) {
      log.warn('tool call refused', {audience, caller: caller?.slice(0, 12) ?? 'anonymous'})
      return fail(NOT_AUTHORIZED)
    }
    try {
      return await handler(args ?? {}, caller!)
    } catch (err) {
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
function resolveRepoAddress(args: {repo_addr?: string; repo_owner?: string; d_tag?: string}): {
  repoAddr: string
  repoOwner: string
  dTag: string
} {
  if (args.repo_addr) {
    const parsed = parseRepoAddress(args.repo_addr.trim())
    if (!parsed) throw new Error('repo_addr must be <kind>:<owner-pubkey-hex>:<identifier>')
    return {repoAddr: repoAddress(parsed.owner, parsed.dTag), repoOwner: parsed.owner, dTag: parsed.dTag}
  }

  const repoOwner = assertPubkey(args.repo_owner, 'repo_owner')
  const dTag = (args.d_tag ?? '').trim()
  if (!dTag) throw new Error('d_tag is required when repo_addr is omitted')
  return {repoAddr: repoAddress(repoOwner, dTag), repoOwner, dTag}
}

const repoAddressShape = {
  repo_addr: z.string().optional().describe('Full repo address, 30617:<owner-pubkey-hex>:<identifier>'),
  repo_owner: z.string().optional().describe('Repo owner pubkey (hex) — alternative to repo_addr'),
  d_tag: z.string().optional().describe('Repo identifier (the 30617 d tag) — alternative to repo_addr'),
}

export function registerTools(server: McpServer, ctx: ToolContext): void {
  const {db, watcher, authorizer} = ctx

  server.registerTool(
    'follow_repo',
    {
      description:
        'Add a repo to the follow table. Any repo — the watcher performs no maintainer check on the caller.',
      inputSchema: repoAddressShape,
    },
    guarded(ctx, 'allowlisted', async (args, caller) => {
      const {repoAddr, repoOwner, dTag} = resolveRepoAddress(args)
      db.followRepo({repoAddr, repoOwner, dTag, addedBy: caller})
      await watcher.watchRepo(repoAddr, repoOwner, dTag)
      log.info('repo followed', {repoAddr, by: caller.slice(0, 12)})
      return ok({followed: repoAddr})
    }),
  )

  server.registerTool(
    'unfollow_repo',
    {
      description: 'Remove a repo from the follow table, along with its ref state and schedules.',
      inputSchema: repoAddressShape,
    },
    guarded(ctx, 'allowlisted', args => {
      const {repoAddr} = resolveRepoAddress(args)
      const removed = db.unfollowRepo(repoAddr)
      watcher.unwatchRepo(repoAddr)
      return ok({unfollowed: repoAddr, existed: removed})
    }),
  )

  server.registerTool(
    'list_followed',
    {
      description: 'Followed repos with their per-ref last-seen commit.',
      inputSchema: {},
    },
    guarded(ctx, 'allowlisted', () =>
      ok({
        repos: db.listFollowedRepos().map(repo => ({
          repo_addr: repo.repoAddr,
          repo_owner: repo.repoOwner,
          d_tag: repo.dTag,
          default_branch: repo.defaultBranch,
          added_by: repo.addedBy,
          added_at: repo.addedAt,
          refs: db.getRefStates(repo.repoAddr).map(state => ({
            ref: state.ref,
            commit: state.commitId,
            updated_at: state.updatedAt,
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
    guarded(ctx, 'allowlisted', () => ok(watcher.status())),
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
    guarded(ctx, 'allowlisted', () => {
      const workers = watcher.knownWorkers()
      const now = Date.now()
      const cursorRaw = db.getKv(CURSOR_KEY)

      return ok({
        cursor: cursorRaw === null ? 0 : Number.parseInt(cursorRaw, 10) || 0,
        runners: db.listRunnerPool().map(entry => {
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
            queue_depth: worker?.currentQueueDepth ?? null,
            last_seen: worker?.lastSeen ?? null,
            eligible: online,
          }
        }),
      })
    }),
  )

  server.registerTool(
    'runners_add',
    {
      description: 'Add a runner pubkey to the private pool. The pool is never published.',
      inputSchema: {pubkey: z.string().describe('Loom worker pubkey (hex)')},
    },
    guarded(ctx, 'owner', args => {
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
    guarded(ctx, 'owner', args => {
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
    guarded(ctx, 'owner', args => {
      const pubkey = assertPubkey(args.pubkey, 'pubkey')
      db.allowPubkey(pubkey)
      return ok({allowed: pubkey})
    }),
  )

  server.registerTool(
    'revoke_pubkey',
    {
      description: 'Remove a requester from the allowlist.',
      inputSchema: {pubkey: z.string().describe('Requester pubkey (hex)')},
    },
    guarded(ctx, 'owner', args => {
      const pubkey = assertPubkey(args.pubkey, 'pubkey')
      return ok({revoked: pubkey, existed: db.revokePubkey(pubkey)})
    }),
  )

  server.registerTool(
    'list_allowed',
    {
      description: 'Dump the allowlist. The owner is implicitly authorized and is not listed.',
      inputSchema: {},
    },
    guarded(ctx, 'owner', () =>
      ok({
        owner: ctx.config.ownerPubkey,
        allowed: db.listAllowed().map(entry => ({pubkey: entry.pubkey, added_at: entry.addedAt})),
      }),
    ),
  )

  void authorizer
}

export interface CvmServerHandle {
  close(): Promise<void>
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

  registerTools(server, ctx)

  const relayPool = new ApplesauceRelayPool(ctx.watcher.relays.getRelayUrls())
  const transport = new NostrServerTransport({
    signer: new PrivateKeySigner(ctx.identity.secretKeyHex),
    relayHandler: relayPool,
    encryptionMode: EncryptionMode.REQUIRED,
    giftWrapMode: GiftWrapMode.EPHEMERAL,
    isAnnouncedServer: true,
    // The caller's pubkey has to reach the tool handlers; the transport reads
    // it off the decrypted inner event.
    injectClientPubkey: true,
    serverInfo: {
      name: 'hive-ci-watcher',
      about: 'Watches Nostr repositories and dispatches Hive CI runs on the owner’s behalf.',
    },
  })

  // No custom watcher-announcement kind: this extra tag on the 11316 is what
  // makes `{kinds:[11316], '#t':['hive-ci-watcher']}` the discovery filter.
  transport.setAnnouncementExtraTags([['t', WATCHER_DISCOVERY_TAG]])

  await server.connect(transport)
  log.info('contextvm server announced', {pubkey: ctx.identity.pubkey, tag: WATCHER_DISCOVERY_TAG})

  return {
    async close() {
      await server.close().catch(() => undefined)
      await relayPool.disconnect().catch(() => undefined)
    },
  }
}
