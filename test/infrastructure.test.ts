import {describe, it, expect, vi} from 'vitest'
import {ServiceInfrastructure} from '../src/infrastructure.js'
import {CommunityAccess} from '../src/community/service.js'
import {parseCommunityConfig} from '../src/community/config.js'
import {WatcherDb} from '../src/db/index.js'
import {loadConfig} from '../src/config.js'
import {resolveRunnerScriptUrl, sha256Hex} from '../src/dispatch/blossom.js'
import {WatcherIdentity} from '../src/identity.js'
import {ADDRESS, COMMUNITY, MEMBER, MemoryTransport, definition, event, list} from './community-helpers.js'

describe('optional community infrastructure', () => {
  it('does not resurrect a retired Blossom endpoint through the script cache', async () => {
    const db = new WatcherDb(':memory:')
    const script = 'test script'
    db.setKv('runner_script_url', `https://retired.example/${sha256Hex(script)}`)
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, {status: 200}))
    try {
      const url = await resolveRunnerScriptUrl({db, identity: new WatcherIdentity('1'.repeat(64)), servers: ['https://current.example'], script})
      expect(url).toBe(`https://current.example/${sha256Hex(script)}`)
      expect(fetch.mock.calls.map(call => call[0])).toEqual([url])
    } finally { fetch.mockRestore(); db.close() }
  })

  it('requires explicit standalone endpoints, treats empty discovery as disabled, and has no generic fallbacks', () => {
    const owner = {HIVE_CI_WATCHER_OWNER_PUBKEY: '1'.repeat(64)}
    expect(() => loadConfig(owner)).toThrow(/INBOX_RELAYS/)
    const config = loadConfig({...owner, HIVE_CI_WATCHER_RELAYS: 'wss://relay.damus.io', HIVE_CI_WATCHER_IDENTITY_DISCOVERY_RELAYS: ''})
    expect(config.infrastructure).toEqual({inbox: ['wss://relay.damus.io'], outbox: ['wss://relay.damus.io'], blossom: undefined})
    expect(config.identityDiscoveryRelays).toEqual([])
    expect(config.gitDiscoveryRelays).toEqual(['wss://index.ngit.dev'])
    expect(config.blossomServers).toEqual([])
    expect(() => loadConfig({...owner, HIVE_CI_WATCHER_RELAYS: ''})).toThrow(/INBOX_RELAYS/)
  })

  it('keeps verified cached transport through authority failure without restoring member authorization', async () => {
    const db = new WatcherDb(':memory:')
    const transport = new MemoryTransport()
    const source = parseCommunityConfig({communities: [{address: ADDRESS, relays: ['wss://bootstrap.example']}]})
    transport.events = [definition(), list()]
    const access = new CommunityAccess(source, transport, db)
    const infrastructure = new ServiceInfrastructure({inbox: ['wss://explicit.example']}, access)
    try {
      await access.start()
      expect(access.sources(MEMBER)).toEqual([ADDRESS])
      expect(infrastructure.current.outbox).toEqual(['wss://relay.example'])
      expect(infrastructure.current.inbox).toEqual(['wss://explicit.example'])
      const replacement = event(32222, [['d', COMMUNITY], ['name', 'Community'], ['r', 'wss://replacement.example'],
        ['blossom', 'https://blossom.example'], ['grasp', 'wss://git.example'], ['content', 'General'], ['k', '1111']], 1, 1001)
      transport.emit(replacement)
      expect(infrastructure.current.outbox).toEqual(['wss://replacement.example'])
      expect(infrastructure.current.blossom).toEqual(['https://blossom.example'])
      expect(infrastructure.current.git).toEqual(['wss://replacement.example', 'wss://git.example'])
      transport.emit(event(5, [['a', ADDRESS]], 1, 1002))
      expect(infrastructure.current.outbox).toEqual(['wss://replacement.example'])
      await access.stop()
      infrastructure.close()
      transport.fail = true
      const restored = new CommunityAccess(source, transport, db)
      const routes = new ServiceInfrastructure({}, restored)
      try {
        expect(restored.sources(MEMBER)).toEqual([])
        expect(routes.current.outbox).toEqual(['wss://replacement.example'])
        await restored.start()
        expect(restored.sources(MEMBER)).toEqual([])
        expect(routes.current.outbox).toEqual(['wss://replacement.example'])
      } finally { routes.close(); await restored.stop() }
    } finally { infrastructure.close(); await access.stop(); db.close() }
  })
})
