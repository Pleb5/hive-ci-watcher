import {isWorkerOnline, type LoomWorker} from '../nostr/events.js'

export interface EligibleRunner {
  pubkey: string
  worker: LoomWorker
}

/**
 * Eligible = allowed ∩ online.
 *
 * "Allowed" is the private `runner_pool` table, which only the owner can write
 * (`runners_add`). Putting a pubkey in it asserts that the watcher is on that
 * worker's Nostr freelist — an operator arrangement, readable when advertised.
 *
 * A worker's advertised pricing is therefore **not** a gate. A kind 10100 is
 * one public replaceable event serving every reader, so a worker that runs
 * unpaid jobs for its freelist still advertises its ordinary rate to everyone
 * else; gating on `pricing == null` would exclude exactly the workers we have
 * an arrangement with. Pricing is still parsed and surfaced by `list_runners`
 * so an operator can see what a pool member charges the public.
 */
export function eligibleRunners(args: {
  allowed: string[]
  workers: Map<string, LoomWorker>
  now?: number
}): EligibleRunner[] {
  const now = args.now ?? Date.now()
  const eligible: EligibleRunner[] = []

  for (const pubkey of args.allowed) {
    const worker = args.workers.get(pubkey)
    if (!worker) continue
    if (!isWorkerOnline(worker, now)) continue
    eligible.push({pubkey, worker})
  }

  // Stable order so the round-robin cursor means the same thing across
  // restarts and across arbitrary Map iteration order.
  return eligible.sort((a, b) => a.pubkey.localeCompare(b.pubkey))
}

export interface RoundRobinResult {
  selected: EligibleRunner
  /** Cursor to persist for the next dispatch. */
  nextCursor: number
}

/**
 * Round-robin over the eligible set with a persisted cursor.
 *
 * The cursor is a monotonically increasing counter rather than an index into
 * the current set: the eligible set changes shape between dispatches as
 * workers come and go, and a counter keeps the rotation fair across those
 * changes instead of snapping back to the front whenever the set shrinks.
 */
export function selectRunner(eligible: EligibleRunner[], cursor: number): RoundRobinResult | null {
  if (eligible.length === 0) return null
  const index = ((cursor % eligible.length) + eligible.length) % eligible.length
  return {
    selected: eligible[index]!,
    // Wrap well below Number.MAX_SAFE_INTEGER so a long-lived daemon's cursor
    // never loses integer precision mid-rotation.
    nextCursor: (cursor + 1) % 1_000_000_007,
  }
}
