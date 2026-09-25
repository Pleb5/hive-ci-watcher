import {describe, expect, it} from 'vitest'
import type {NostrEvent} from 'nostr-tools'
import vectors from './fixtures/community-vectors.json'
import {CommunityView} from '../src/community/membership.js'
import {parseDefinition} from '../src/community/protocol.js'
import {ADDRESS, COMMUNITY, LIST, MEMBER, MOD, OTHER, OWNER, ban, definition, event, list, retract} from './community-helpers.js'

// Independent Python Branch oracle run on these scenarios with protected
// deletion events omitted. All other expectations are the untouched TS oracle.
const deletionExceptions: Record<string, string[]> = {
  'owner tombstones a shard by address': ['owner', 'modGeneral', 'modCode', 'modAll', 'member', 'member2'],
  'last grant deleted by id': ['owner', 'modGeneral', 'modCode', 'modAll', 'member'],
  'definition tombstoned owner bootstrap': ['owner', 'modGeneral', 'modCode', 'modAll', 'member', 'member2'],
}

describe('shared Budabit/strfry conformance', () => {
  for (const scenario of vectors.readers.scenarios) {
    it(scenario.name, () => {
      const view = new CommunityView(scenario.branch)
      const events = [...scenario.authority].sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
      for (const event of events) view.apply(event as NostrEvent)
      const allowed = view.members()
      for (const reader of scenario.cases) {
        const expected = deletionExceptions[scenario.name]?.includes(reader.name) ?? reader.allowed
        expect([reader.name, scenario.ready && allowed.has(reader.pubkey)]).toEqual([reader.name, expected])
      }
    })
  }
  for (const scenario of vectors.definitions) {
    it(`definition: ${scenario.name}`, () => {
      expect(!!parseDefinition(scenario.event as NostrEvent)).toBe(scenario.valid)
    })
  }
})

describe('authority view deletion exception and replacement', () => {
  it('ignores coordinate, kind and event-ID deletion before and after protected events', () => {
    const original = definition(), shard = list()
    const deletions = [
      event(5, [['a', ADDRESS], ['k', '32222']]),
      event(5, [['e', original.id]]),
      event(5, [['a', LIST], ['k', '30000']], 2),
      event(5, [['e', shard.id]], 2),
    ]
    for (const events of [[...deletions, original, shard], [original, shard, ...deletions]]) {
      const view = new CommunityView(ADDRESS)
      events.forEach(e => view.apply(e))
      expect(view.members()).toEqual(new Set([OWNER, MOD, MEMBER]))
      expect(view.snapshot().filter(e => e.kind === 5)).toEqual([])
    }
  })
  it('replaces grants, preserves structural roles, and ignores invalid newer evidence', () => {
    const view = new CommunityView(ADDRESS)
    for (const e of [definition(), list(), list([], 1002)]) view.apply(e)
    expect(view.members()).toEqual(new Set([OWNER, MOD]))
    view.apply(list([OTHER], 1003, true))
    expect(view.members()).toEqual(new Set([OWNER, MOD]))
    view.apply(list([MEMBER], 1004))
    view.apply(event(30000, [['d', `${COMMUNITY}-general`], ['d', 'duplicate'], ['p', OTHER]], 2, 2000))
    expect(view.members()).toEqual(new Set([OWNER, MOD, MEMBER]))
    view.apply(definition(1005, 1, COMMUNITY, []))
    expect(view.members()).toEqual(new Set([OWNER]))
  })
  it('processes report retractions before or after bans and across snapshot restoration', () => {
    const report = ban(), deletion = retract(report)
    for (const events of [[report, deletion], [deletion, report]]) {
      const view = new CommunityView(ADDRESS)
      for (const e of [definition(), list(), ...events]) view.apply(e)
      const restored = new CommunityView(ADDRESS)
      view.snapshot().forEach(e => restored.apply(e))
      expect(restored.members().has(MEMBER)).toBe(true)
      restored.apply(report)
      expect(restored.members().has(MEMBER)).toBe(true)
    }
  })
  it('does not allow a forged-author retraction to remove a ban', () => {
    const view = new CommunityView(ADDRESS), report = ban()
    for (const e of [definition(), list(), report, event(5, [['h', COMMUNITY], ['e', report.id]], 4)]) view.apply(e)
    expect(view.members().has(MEMBER)).toBe(false)
  })
  it('requires the exact scoped, marked retraction shape, even from the report author', () => {
    const report = ban()
    const ref = ['e', report.id, '', OWNER, 'report']
    for (const deletionTags of [
      [['e', report.id]],
      [ref],
      [['h', COMMUNITY], ['e', report.id]],
      [['h', COMMUNITY], ref, ['k', '30000']],
      [['h', COMMUNITY], ref, ref],
      [['h', COMMUNITY], ['e', report.id, '', MOD, 'report']],
      [['h', COMMUNITY], ['a', `32222:${OTHER}:${COMMUNITY}`, '', 'community'], ref],
    ]) {
      const view = new CommunityView(ADDRESS)
      for (const e of [definition(), list(), report, event(5, deletionTags)]) view.apply(e)
      expect(view.members().has(MEMBER)).toBe(false)
    }
  })
})
