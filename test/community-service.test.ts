import {afterEach, describe, expect, it} from 'vitest'
import {parseCommunityConfig} from '../src/community/config.js'
import {CommunityAccess} from '../src/community/service.js'
import {Authorizer} from '../src/cvm/auth.js'
import {WatcherDb} from '../src/db/index.js'
import {ADDRESS, COMMUNITY, MEMBER, MOD, OTHER, OWNER, RELAY, MemoryTransport, ban, definition, event, list, retract} from './community-helpers.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
function setup(communities = [{address: ADDRESS, relays: [RELAY]}]) {
  const db = new WatcherDb(':memory:'), transport = new MemoryTransport()
  let now = 1000000
  const config = parseCommunityConfig({communities, refreshSeconds: 5, maxAgeSeconds: 10})
  const service = new CommunityAccess(config, transport, db, () => now)
  cleanups.push(async () => { await service.stop(); db.close() })
  return {service, transport, db, config, clock: (value: number) => { now = value }}
}

describe('community configuration', () => {
  it('requires exact branches, explicit relay hints, and valid freshness settings', () => {
    for (const value of [
      {communities: [{address: COMMUNITY, relays: [RELAY]}]},
      {communities: [{address: ADDRESS, relays: []}]},
      {communities: [{address: ADDRESS, relays: ['https://example.com']}]},
      {communities: [{address: ADDRESS, relays: [RELAY]}, {address: ADDRESS, relays: [RELAY]}]},
      {communities: [], refreshSeconds: 60, maxAgeSeconds: 30},
      {communities: [], typo: true},
    ]) expect(() => parseCommunityConfig(value)).toThrow()
  })
})

describe('community access lifecycle', () => {
  it('warms only after completed intake; applies live grants, bans, retractions and replacements', async () => {
    const {service, transport} = setup()
    transport.events = [definition(), list()]
    expect(service.sources(MEMBER)).toEqual([])
    await service.refresh()
    expect(service.sources(MEMBER)).toEqual([ADDRESS])
    const report = ban()
    transport.emit(report)
    expect(service.sources(MEMBER)).toEqual([])
    transport.emit(retract(report))
    expect(service.sources(MEMBER)).toEqual([ADDRESS])
    transport.emit(list([], 1005))
    expect(service.sources(MEMBER)).toEqual([])
    expect(service.sources(MOD)).toEqual([ADDRESS])
  })
  it('does not renew freshness on failure, live traffic, or cache restoration', async () => {
    const {service, transport, clock, db, config} = setup()
    transport.events = [definition(), list()]
    await service.refresh()
    clock(1009000)
    transport.fail = true
    await service.refresh()
    expect(service.sources(MEMBER)).toEqual([ADDRESS])
    transport.emit(list([MEMBER], 2000))
    clock(1010000)
    expect(service.sources(MEMBER)).toEqual([])
    expect(service.status()[0]!.state).toBe('stale')
    const restored = new CommunityAccess(config, transport, db)
    expect(restored.sources(OWNER)).toEqual([])
    await restored.stop()
    transport.fail = false
    await service.refresh()
    expect(service.sources(MEMBER)).toEqual([ADDRESS])
  })
  it('isolates same-ID branches and one community outage; unions eligibility', async () => {
    const second = `32222:${OTHER}:${COMMUNITY}`
    const {service, transport, clock} = setup([
      {address: ADDRESS, relays: [RELAY]}, {address: second, relays: ['wss://second.example']},
    ])
    transport.events = [definition(), definition(1000, 4), list(), ban()]
    await service.refresh()
    expect(service.sources(MEMBER)).toEqual([second])
    transport.failedRelays.add(RELAY)
    clock(1010000)
    await service.refresh()
    expect(service.sources(MEMBER)).toEqual([second])
    expect(service.status().map(s => s.state)).toEqual(['stale', 'ready'])
  })
  it('does not treat an invalid signature as an authority grant', async () => {
    const {service, transport} = setup()
    const invalid = list()
    invalid.sig = '0'.repeat(128)
    transport.events = [definition(), invalid]
    await service.refresh()
    expect(service.sources(MEMBER)).toEqual([])
    expect(service.sources(MOD)).toEqual([ADDRESS])
  })
  it('invalidates completeness when a definition changes and requires its new dependencies', async () => {
    const {service, transport} = setup()
    transport.events = [definition(), list()]
    await service.refresh()
    transport.fail = true
    transport.emit(definition(1002))
    expect(service.sources(MEMBER)).toEqual([])
    await service.refresh()
    expect(service.sources(MEMBER)).toEqual([])
    transport.fail = false
    await service.refresh()
    expect(service.sources(MEMBER)).toEqual([ADDRESS])
  })
  it('preserves protected authority and retracted bans across restart', async () => {
    const {service, transport, db, config} = setup()
    const report = ban()
    transport.events = [definition(), list(), report, retract(report), event(5, [['a', ADDRESS]])]
    await service.refresh()
    await service.stop()
    transport.events = [report] // retained projection must resist a replay after restart
    const restored = new CommunityAccess(config, transport, db)
    expect(restored.sources(MEMBER)).toEqual([])
    await restored.refresh()
    expect(restored.sources(MEMBER)).toEqual([ADDRESS])
    await restored.stop()
  })
  it('keeps operator/manual grants separate from community eligibility', async () => {
    const {service, transport, db} = setup()
    const auth = new Authorizer(db, OTHER, service)
    transport.events = [definition(), list()]
    await service.refresh()
    expect(auth.authorize(MEMBER, 'owner')).toBe(false)
    expect(auth.authorize(MEMBER, 'allowlisted')).toBe(true)
    db.allowPubkey(MEMBER)
    db.revokePubkey(MEMBER)
    expect(auth.authorize(MEMBER, 'allowlisted')).toBe(true)
    transport.emit(list([], 2000))
    expect(auth.authorize(MEMBER, 'allowlisted')).toBe(false)
    expect(auth.authorize(OTHER, 'owner')).toBe(true)
  })
})
