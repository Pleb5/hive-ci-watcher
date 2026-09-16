import type {RepoStateRef} from '../nostr/events.js'

export type RefKind = 'branch' | 'tag'

export interface RefDescriptor {
  /** Full name: `refs/heads/main`. */
  ref: string
  kind: RefKind
  /** Short name used for glob matching and for `git clone --branch`. */
  shortName: string
}

/**
 * git's own ref-name rules (`git check-ref-format`), applied to the short
 * name. A 30618 is signed by a maintainer, not produced by git, so nothing
 * upstream has enforced these — and the short name ends up in
 * `HIVE_CI_BRANCH`, which the runner script word-splits into `git clone
 * --branch` on the worker *host*, outside act's container. Anything git
 * itself would refuse is refused here first.
 */
export function isValidRefShortName(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false
  if (name === '@') return false
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/')) return false
  if (name.startsWith('.') || name.endsWith('.') || name.endsWith('.lock')) return false
  if (name.includes('..') || name.includes('//') || name.includes('@{') || name.includes('/.')) return false
  // ASCII control chars, DEL, space, and git's reserved punctuation.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false
  for (const component of name.split('/')) {
    if (component.endsWith('.lock')) return false
  }
  return true
}

export function describeRef(ref: string): RefDescriptor | null {
  if (ref.startsWith('refs/heads/')) {
    const shortName = ref.slice('refs/heads/'.length)
    return isValidRefShortName(shortName) ? {ref, kind: 'branch', shortName} : null
  }
  if (ref.startsWith('refs/tags/')) {
    const shortName = ref.slice('refs/tags/'.length)
    return isValidRefShortName(shortName) ? {ref, kind: 'tag', shortName} : null
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
  /** Live refs gone from the state event — tombstoned, no run. */
  deleted: string[]
  /** Refs present and unchanged (including a tombstone reappearing at its old commit). */
  unchanged: string[]
}

/**
 * Diffs a 30618's refs against the persisted `ref_state`.
 *
 * Both `refs/heads/*` and `refs/tags/*` participate. Anything else in the
 * event (`HEAD`, arbitrary tags, malformed names) is ignored by `describeRef`.
 *
 * A ref absent from the event is *tombstoned*, not forgotten: its last commit
 * stays in `known` with `deletedAt` set. Two maintainers whose 30618s cover
 * different ref subsets otherwise make every ref outside the overlap flap
 * between "deleted" and "new" on each alternate event, re-dispatching the
 * same commit each time. With the tombstone, a ref reappearing at the commit
 * we already built is unchanged; only a reappearance at a *new* commit is a
 * push.
 */
export function diffRefs(
  stateRefs: RepoStateRef[],
  known: Array<{ref: string; commitId: string; deletedAt?: number | null}>,
): RefDiff {
  const knownByRef = new Map(known.map(entry => [entry.ref, entry] as const))
  const seen = new Set<string>()

  const changed: RefChange[] = []
  const unchanged: string[] = []

  for (const stateRef of stateRefs) {
    const descriptor = describeRef(stateRef.ref)
    if (!descriptor) continue
    seen.add(stateRef.ref)

    const prior = knownByRef.get(stateRef.ref)
    const previousCommitId = prior?.commitId ?? null
    if (previousCommitId === stateRef.commitId) {
      unchanged.push(stateRef.ref)
      continue
    }

    changed.push({descriptor, commitId: stateRef.commitId, previousCommitId})
  }

  // Only a *live* row transitions to deleted; an existing tombstone stays as
  // it is rather than being reported again on every event.
  const deleted = [...knownByRef.values()]
    .filter(entry => !seen.has(entry.ref) && !entry.deletedAt)
    .map(entry => entry.ref)

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
