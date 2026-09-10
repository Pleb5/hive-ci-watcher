import {isFreeWorker, isWorkerOnline, type LoomWorker} from '../nostr/events.js'

export interface EligibleRunner {
  pubkey: string
  worker: LoomWorker
}

/**
 * Eligible = allowed ∩ online ∩ free.
 *
 * "Allowed" is the private `runner_pool` table; "online" is a 10100 seen
 * within the online window; "free" is an ad that declares no pricing at all —
 * a malformed paid ad is *not* treated as free, because a 5100 with no
 * `payment` tag is exactly what such a worker silently rejects.
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
    if (!isFreeWorker(worker)) continue
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
