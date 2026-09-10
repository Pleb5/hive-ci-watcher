import {describe, expect, it} from 'vitest'
import type {NostrEvent} from 'nostr-tools'
import {parseRepoAnnouncement, parseRepoState} from '../src/nostr/events.js'
import {diffRefs, selectRepoState} from '../src/triggers/refs.js'

const OWNER = 'a'.repeat(64)
const MAINTAINER = 'b'.repeat(64)
const DEMOTED = 'c'.repeat(64)

const COMMIT_A = '1'.repeat(40)
const COMMIT_B = '2'.repeat(40)
const TAG_OBJECT = '3'.repeat(40)
const PEELED = '4'.repeat(40)

function event(partial: Partial<NostrEvent> & {kind: number; pubkey: string; tags: string[][]}): NostrEvent {
  return {
    id: partial.id ?? 'e'.repeat(64),
    pubkey: partial.pubkey,
    created_at: partial.created_at ?? 1_700_000_000,
    kind: partial.kind,
    tags: partial.tags,
    content: partial.content ?? '',
    sig: partial.sig ?? '0'.repeat(128),
  }
}

describe('30617 announcement parsing', () => {
  it('includes the owner in the maintainer set', () => {
    const parsed = parseRepoAnnouncement(
      event({
        kind: 30617,
        pubkey: OWNER,
        tags: [
          ['d', 'my-repo'],
          ['name', 'My Repo'],
          ['clone', 'https://example.com/repo.git', 'https://mirror.example/repo.git'],
          ['relays', 'wss://relay.example'],
          ['maintainers', MAINTAINER],
        ],
      }),
    )!

    expect(parsed.repoAddr).toBe(`30617:${OWNER}:my-repo`)
    expect(parsed.maintainers).toEqual([OWNER, MAINTAINER])
    expect(parsed.cloneUrls).toEqual(['https://example.com/repo.git', 'https://mirror.example/repo.git'])
    expect(parsed.relays).toEqual(['wss://relay.example'])
  })
})

describe('30618 state parsing', () => {
  it('prefers an annotated tag’s peeled commit over the tag object', () => {
    const parsed = parseRepoState(
      event({
        kind: 30618,
        pubkey: OWNER,
        tags: [
          ['d', 'my-repo'],
          ['HEAD', 'ref: refs/heads/main'],
          ['refs/heads/main', COMMIT_A],
          ['refs/tags/v1.0.0', TAG_OBJECT, PEELED],
        ],
      }),
      OWNER,
    )!

    expect(parsed.defaultBranch).toBe('main')
    expect(parsed.refs).toEqual([
      {ref: 'refs/heads/main', commitId: COMMIT_A, refValue: COMMIT_A},
      {ref: 'refs/tags/v1.0.0', commitId: PEELED, refValue: TAG_OBJECT},
    ])
  })

  it('ignores tags that are neither heads nor tags, and malformed commit ids', () => {
    const parsed = parseRepoState(
      event({
        kind: 30618,
        pubkey: OWNER,
        tags: [
          ['d', 'my-repo'],
          ['refs/notes/commits', COMMIT_A],
          ['refs/heads/broken', 'not-a-commit'],
          ['refs/heads/ok', COMMIT_B],
        ],
      }),
      OWNER,
    )!

    expect(parsed.refs.map(ref => ref.ref)).toEqual(['refs/heads/ok'])
  })
})

describe('maintainer race', () => {
  const state = (author: string, createdAt: number, id: string) => ({
    author,
    createdAt,
    event: {id},
  })

  it('lets the newest created_at win across maintainers', () => {
    const chosen = selectRepoState(
      [state(OWNER, 100, 'a'), state(MAINTAINER, 200, 'b')],
      [OWNER, MAINTAINER],
    )
    expect(chosen?.author).toBe(MAINTAINER)
  })

  it('drops an author outside the current maintainer set', () => {
    const chosen = selectRepoState(
      [state(OWNER, 100, 'a'), state(DEMOTED, 900, 'b')],
      [OWNER, MAINTAINER],
    )
    expect(chosen?.author).toBe(OWNER)
  })

  it('returns null when every candidate is outside the set', () => {
    expect(selectRepoState([state(DEMOTED, 900, 'b')], [OWNER])).toBeNull()
  })

  it('breaks a created_at tie deterministically on event id', () => {
    const forwards = selectRepoState([state(OWNER, 100, 'aaa'), state(MAINTAINER, 100, 'bbb')], [OWNER, MAINTAINER])
    const backwards = selectRepoState([state(MAINTAINER, 100, 'bbb'), state(OWNER, 100, 'aaa')], [OWNER, MAINTAINER])
    expect(forwards?.event.id).toBe('aaa')
    expect(backwards?.event.id).toBe('aaa')
  })
})

describe('ref diffing', () => {
  const stateRef = (ref: string, commitId: string) => ({ref, commitId, refValue: commitId})

  it('classifies new, moved, unchanged, and deleted refs', () => {
    const diff = diffRefs(
      [
        stateRef('refs/heads/main', COMMIT_B),
        stateRef('refs/heads/stable', COMMIT_A),
        stateRef('refs/tags/v1.0.0', PEELED),
      ],
      [
        {ref: 'refs/heads/main', commitId: COMMIT_A},
        {ref: 'refs/heads/stable', commitId: COMMIT_A},
        {ref: 'refs/heads/gone', commitId: COMMIT_A},
      ],
    )

    expect(diff.changed.map(change => change.descriptor.ref)).toEqual([
      'refs/heads/main',
      'refs/tags/v1.0.0',
    ])
    expect(diff.changed[0]!.previousCommitId).toBe(COMMIT_A)
    expect(diff.changed[1]!.previousCommitId).toBeNull()
    expect(diff.unchanged).toEqual(['refs/heads/stable'])
    expect(diff.deleted).toEqual(['refs/heads/gone'])
  })

  it('reports a branch and a tag landing on the same commit as two changes', () => {
    const diff = diffRefs(
      [stateRef('refs/heads/main', COMMIT_A), stateRef('refs/tags/v1.0.0', COMMIT_A)],
      [],
    )
    expect(diff.changed).toHaveLength(2)
  })
})
