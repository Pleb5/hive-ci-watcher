import {generateSecretKey, getPublicKey} from 'nostr-tools'
import type {WatcherConfig} from '../config.js'
import type {WatcherDb} from '../db/index.js'
import type {WatcherIdentity} from '../identity.js'
import {createLogger, errorMessage} from '../log.js'
import type {LoomWorker} from '../nostr/events.js'
import {normalizeRelays, type NostrClient} from '../nostr/client.js'
import {buildRunnerArgs, resolveRunnerScriptUrl, sha256Hex} from './blossom.js'
import {
  buildLoomJobEvent,
  buildRunEnv,
  buildWorkflowRunEvent,
  toRepoNostrUrl,
  type TriggerKind,
} from './events.js'
import {WORKFLOW_RUNNER_SCRIPT} from './runner-script.js'
import {eligibleRunners, selectRunner} from './select.js'

const log = createLogger('dispatch')

const CURSOR_KEY = 'runner_round_robin_cursor'

export interface DispatchRequest {
  repoAddr: string
  workflowPath: string
  trigger: TriggerKind
  /** Full ref name, e.g. `refs/heads/main`. */
  ref: string
  /** Short name — branch or tag. */
  branch: string
  commitId: string
  /** Relays named by the repo's 30617, used to build the `nostr://` clone url. */
  repoRelays: string[]
}

export interface DispatchDeps {
  config: WatcherConfig
  db: WatcherDb
  identity: WatcherIdentity
  nostr: NostrClient
  /** Latest 10100 per worker pubkey. */
  workers: () => Map<string, LoomWorker>
  /** Rechecked after asynchronous work, immediately before either publication. */
  mayDispatch: () => boolean
  jobPrepared?: (runId: string, runnerPubkey: string) => void
}

/** Repository reporting is scoped to the accepted announcement, not worker delivery. */
export function publishRelaysFor(_config: WatcherConfig, repoRelays: string[]): string[] {
  return normalizeRelays(repoRelays)
}

const MIN_ACCEPTING_RELAYS = 2

export type DispatchOutcome =
  | {status: 'dispatched'; runId: string; runnerPubkey: string}
  | {status: 'no-runner'}
  | {status: 'failed'; error: string}
  | {status: 'inactive'}
  | {status: 'unconfirmed'; runId: string; runnerPubkey: string}

function hexFromBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

function readCursor(db: WatcherDb): number {
  const raw = db.getKv(CURSOR_KEY)
  const parsed = raw === null ? 0 : Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Dispatches one run: select a runner, resolve the runner script, publish the
 * 5401 anchor, then the 5100 job carrying the run's ephemeral secret key
 * encrypted to that runner.
 *
 * The 5100 carries no `payment` tag. Selection does not consult the worker's
 * advertised price: pool membership is the operator asserting that the watcher
 * is on that worker's configured Nostr freelist, which is the thing that
 * makes an unpaid job run.
 *
 * **No user secrets.** Watcher-triggered runs carry only `HIVE_CI_NSEC`; a
 * workflow needing repository secrets will not work under a watcher in v1.
 *
 * Pre-publication failures may be retried by evaluation. Once job publication
 * is attempted, a missing ACK is unconfirmed and must not create another job.
 */
export async function dispatchRun(
  deps: DispatchDeps,
  request: DispatchRequest,
): Promise<DispatchOutcome> {
  const {config, db, identity, nostr} = deps
  if (!deps.mayDispatch()) return {status: 'inactive'}
  // Once a job publication was attempted, retries need a separate execution
  // policy. In particular a missing relay OK does not prove the job was lost.
  if (request.trigger === 'push') {
    const prior = db.pendingRunFor(request)
    if (prior) return {status: 'unconfirmed', runId: prior.runId, runnerPubkey: prior.runnerPubkey}
  }

  const allowed = db.listRunnerPool().map(entry => entry.pubkey)
  const eligible = eligibleRunners({allowed, workers: deps.workers()})
  const choice = selectRunner(eligible, readCursor(db))

  if (!choice) {
    log.warn('no eligible runner, dropping dispatch', {
      repoAddr: request.repoAddr,
      workflowPath: request.workflowPath,
      allowed: allowed.length,
    })
    return {status: 'no-runner'}
  }

  // Advance the cursor before the run is attempted: a runner that fails to
  // dispatch should not be handed the next run as well.
  db.setKv(CURSOR_KEY, String(choice.nextCursor))
  const runnerPubkey = choice.selected.pubkey
  let attemptedRunId: string | undefined

  try {
    const relayList = await nostr.loadReplaceable({kind: 10002, pubkey: runnerPubkey})
    // Both directions belong to one signed routing snapshot.
    const inboxes = normalizeRelays(relayList?.tags.filter(t => t[0] === 'r' && (!t[2] || t[2] === 'read')).map(t => t[1]!) ?? [])
    const outboxes = normalizeRelays(relayList?.tags.filter(t => t[0] === 'r' && (!t[2] || t[2] === 'write')).map(t => t[1]!) ?? [])
    if (!inboxes.length || !outboxes.length) throw new Error('selected worker inbox/outbox unresolved')
    if (!request.repoRelays.length) throw new Error('repository reporting relays unresolved')
    if (!config.blossomServers.length) throw new Error('runner artifact routing unavailable: configure Blossom or a community source')
    const scriptUrl = await resolveRunnerScriptUrl({
      db,
      identity,
      servers: config.blossomServers,
      script: WORKFLOW_RUNNER_SCRIPT,
    })

    const ephemeralSecretKey = generateSecretKey()
    const ephemeralPubkey = getPublicKey(ephemeralSecretKey)

    const publishRelays = publishRelaysFor(config, request.repoRelays)
    const runEvent = identity.sign(
      buildWorkflowRunEvent({
        repoAddr: request.repoAddr,
        workflowPath: request.workflowPath,
        watcherPubkey: identity.pubkey,
        ephemeralPubkey,
        trigger: request.trigger,
        branch: request.branch,
        ref: request.ref,
        commitId: request.commitId,
      }),
    )

    if (!deps.mayDispatch()) return {status: 'inactive'}
    const runPublish = await nostr.publish(publishRelays, runEvent, MIN_ACCEPTING_RELAYS)
    const runId = runEvent.id

    const env = buildRunEnv({
      runId,
      repoNostrUrl: toRepoNostrUrl(request.repoAddr, request.repoRelays),
      workflowPath: request.workflowPath,
      branch: request.branch,
      commitId: request.commitId,
      relays: publishRelays,
      blossomServer: config.blossomServers[0] ?? '',
    })

    const encryptedNsec = identity.nip44Encrypt(runnerPubkey, hexFromBytes(ephemeralSecretKey))

    const jobEvent = identity.sign(
      buildLoomJobEvent({
        runnerPubkey,
        runId,
        args: buildRunnerArgs(scriptUrl, sha256Hex(WORKFLOW_RUNNER_SCRIPT)),
        env,
        encryptedNsec,
      }),
    )

    if (!deps.mayDispatch()) return {status: 'inactive'}
    db.recordRun({
      runId,
      repoAddr: request.repoAddr,
      ref: request.ref,
      commitId: request.commitId,
      workflowPath: request.workflowPath,
      runnerPubkey,
      trigger: request.trigger,
      createdAt: runEvent.created_at,
    })
    db.recordJob({runId, jobId: jobEvent.id, inboxes, outboxes, state: 'unconfirmed'})
    attemptedRunId = runId
    deps.jobPrepared?.(runId, runnerPubkey)
    const jobPublish = await nostr.publish(inboxes, jobEvent, 1)
    db.updateJob(jobEvent.id, 'published')

    log.info('run dispatched', {
      runId,
      repoAddr: request.repoAddr,
      workflowPath: request.workflowPath,
      ref: request.ref,
      commit: request.commitId.slice(0, 12),
      runnerPubkey: runnerPubkey.slice(0, 12),
      trigger: request.trigger,
      acceptedBy: {run: runPublish.accepted, job: jobPublish.accepted},
    })

    return {status: 'dispatched', runId, runnerPubkey}
  } catch (err) {
    const error = errorMessage(err)
    log.error('dispatch failed', {
      repoAddr: request.repoAddr,
      workflowPath: request.workflowPath,
      ref: request.ref,
      error,
    })
    return attemptedRunId ? {status: 'unconfirmed', runId: attemptedRunId, runnerPubkey} : {status: 'failed', error}
  }
}
