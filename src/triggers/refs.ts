import type {RepoStateRef} from '../nostr/events.js'

export type RefKind = 'branch' | 'tag'

export interface RefDescriptor {
  /** Full name: `refs/heads/main`. */
  ref: string
  kind: RefKind
  /** Short name used for glob matching and for `git clone --branch`. */
  shortName: string
}

export function describeRef(ref: string): RefDescriptor | null {
  if (ref.startsWith('refs/heads/')) {
    const shortName = ref.slice('refs/heads/'.length)
    return shortName ? {ref, kind: 'branch', shortName} : null
  }
  if (ref.startsWith('refs/tags/')) {
    const shortName = ref.slice('refs/tags/'.length)
    return shortName ? {ref, kind: 'tag', shortName} : null
  }
  return null
}

export interface RefChange {
  descriptor: RefDescriptor
  commitId: string
  previousCommitId: string | null
}

export interface RefDiff {
  /** Refs that are new or whose commit moved — these get evaluated. */
  changed: RefChange[]
  /** Refs gone from the state event — the row is dropped, no run. */
  deleted: string[]
  /** Refs present and unchanged; kept so callers can reason about coverage. */
  unchanged: string[]
}

/**
 * Diffs a 30618's refs against the persisted `ref_state`.
 *
 * Both `refs/heads/*` and `refs/tags/*` participate. Anything else in the
 * event (`HEAD`, arbitrary tags) is ignored by `describeRef`.
 */
export function diffRefs(
  stateRefs: RepoStateRef[],
  known: Array<{ref: string; commitId: string}>,
): RefDiff {
  const knownByRef = new Map(known.map(entry => [entry.ref, entry.commitId] as const))
  const seen = new Set<string>()

  const changed: RefChange[] = []
  const unchanged: string[] = []

  for (const stateRef of stateRefs) {
    const descriptor = describeRef(stateRef.ref)
    if (!descriptor) continue
    seen.add(stateRef.ref)

    const previousCommitId = knownByRef.get(stateRef.ref) ?? null
    if (previousCommitId === stateRef.commitId) {
      unchanged.push(stateRef.ref)
      continue
    }

    changed.push({descriptor, commitId: stateRef.commitId, previousCommitId})
  }

  const deleted = [...knownByRef.keys()].filter(ref => !seen.has(ref))

  return {changed, deleted, unchanged}
}

/**
 * Picks the state event to act on when several maintainers publish for the
 * same repo: newest `created_at` wins, and a maintainer who has since been
 * dropped from the owner's 30617 is not accepted at all.
 *
 * Ties on `created_at` break on event id so two watchers seeing the same pair
 * of events in different arrival orders converge on the same choice.
 */
export function selectRepoState<T extends {author: string; createdAt: number; event: {id: string}}>(
  candidates: T[],
  maintainers: Iterable<string>,
): T | null {
  const allowed = new Set([...maintainers].map(pubkey => pubkey.toLowerCase()))

  let best: T | null = null
  for (const candidate of candidates) {
    if (!allowed.has(candidate.author.toLowerCase())) continue
    if (!best) {
      best = candidate
      continue
    }
    if (candidate.createdAt > best.createdAt) best = candidate
    else if (candidate.createdAt === best.createdAt && candidate.event.id < best.event.id) best = candidate
  }

  return best
}
