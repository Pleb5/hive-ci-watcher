import {generateSecretKey, getPublicKey} from 'nostr-tools'
import type {WatcherConfig} from '../config.js'
import type {WatcherDb} from '../db/index.js'
import type {WatcherIdentity} from '../identity.js'
import {createLogger, errorMessage} from '../log.js'
import type {LoomWorker} from '../nostr/events.js'
import type {RelayManager} from '../nostr/pool.js'
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
  relays: RelayManager
  /** Latest 10100 per worker pubkey. */
  workers: () => Map<string, LoomWorker>
}

export type DispatchOutcome =
  | {status: 'dispatched'; runId: string; runnerPubkey: string}
  | {status: 'no-runner'}
  | {status: 'failed'; error: string}

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
 * is on that worker's `ALLOW_UNPAID_PUBKEYS`, which is the only thing that
 * makes an unpaid job run.
 *
 * **No user secrets.** Watcher-triggered runs carry only `HIVE_CI_NSEC`; a
 * workflow needing repository secrets will not work under a watcher in v1.
 *
 * There are no retries. A failure is logged and dropped — the caller still
 * writes the new commit into `ref_state`, so a dropped dispatch is not
 * replayed on the next 30618 for an unrelated ref.
 */
export async function dispatchRun(
  deps: DispatchDeps,
  request: DispatchRequest,
): Promise<DispatchOutcome> {
  const {config, db, identity, relays} = deps

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

  try {
    const scriptUrl = await resolveRunnerScriptUrl({
      db,
      identity,
      servers: config.blossomServers,
      script: WORKFLOW_RUNNER_SCRIPT,
    })

    const ephemeralSecretKey = generateSecretKey()
    const ephemeralPubkey = getPublicKey(ephemeralSecretKey)

    const publishRelays = relays.getRelayUrls()
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

    await relays.publish(runEvent)
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

    await relays.publish(jobEvent)

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

    log.info('run dispatched', {
      runId,
      repoAddr: request.repoAddr,
      workflowPath: request.workflowPath,
      ref: request.ref,
      commit: request.commitId.slice(0, 12),
      runnerPubkey: runnerPubkey.slice(0, 12),
      trigger: request.trigger,
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
    return {status: 'failed', error}
  }
}
