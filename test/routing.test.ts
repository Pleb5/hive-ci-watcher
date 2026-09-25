import '../src/env-defaults.js'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {firstValueFrom, of, take, timeout} from 'rxjs'
import {PrivateKeySigner} from '@contextvm/sdk/signer'
import {NostrClientTransport} from '@contextvm/sdk/transport'
import {EncryptionMode, GiftWrapMode} from '@contextvm/sdk/core'
import {Client} from '@contextvm/mcp-sdk/client/index.js'
import {NostrClient} from '../src/nostr/client.js'
import {loadConfig} from '../src/config.js'
import {WatcherDb} from '../src/db/index.js'
import {WatcherIdentity} from '../src/identity.js'
import {Watcher} from '../src/watcher.js'
import {dispatchRun} from '../src/dispatch/submit.js'
import {acceptJobEvidence} from '../src/dispatch/status.js'
import {DirectedRelayHandler} from '../src/cvm/relay-handler.js'
import {startCvmServer} from '../src/cvm/server.js'
import {relayFixture} from './relay-fixture.js'
import {event, OWNER, OTHER, secret} from './community-helpers.js'

vi.mock('../src/dispatch/blossom.js', async original => ({...await original<any>(), resolveRunnerScriptUrl: async () => 'https://blossom.example/script'}))
const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
async function relay(auth = false) { const r = await relayFixture(auth); cleanup.push(r.close); return r }
function database() { const db = new WatcherDb(':memory:'); cleanup.push(() => db.close()); return db }
const identity = new WatcherIdentity(Buffer.from(secret(1)).toString('hex'))

describe('role-specific actual relay traffic', () => {
  it('discovers an announcement on an indexer but hydrates and watches state only on its declared relays', async () => {
    const service = await relay(), index = await relay(), repo = await relay(), nextRepo = await relay()
    const db = database()
    const config = loadConfig({HIVE_CI_WATCHER_OWNER_PUBKEY: OWNER, HIVE_CI_WATCHER_RELAYS: service.url,
      HIVE_CI_WATCHER_IDENTITY_DISCOVERY_RELAYS: index.url, HIVE_CI_WATCHER_GIT_DISCOVERY_RELAYS: index.url,
      HIVE_CI_WATCHER_SERVICE_DISCOVERY_RELAYS: ''})
    index.events.push(event(10002, [['r', service.url, 'write']]))
    index.events.push(event(30617, [['d', 'repo'], ['relays', repo.url]]))
    repo.events.push(event(30618, [['d', 'repo'], ['refs/heads/main', '1'.repeat(40)]]))
    // A newer state visible on announcement/owner discovery must not win.
    const wrongRoute = event(30618, [['d', 'repo'], ['refs/heads/main', '2'.repeat(40)]], 1, 1002)
    index.events.push(wrongRoute)
    service.events.push(wrongRoute)
    const repoAddr = `30617:${OWNER}:repo`
    db.followRepo({repoAddr, repoOwner: OWNER, dTag: 'repo', addedBy: OWNER})
    const watcher = new Watcher(config, db, identity)
    cleanup.push(() => watcher.stop())
    await watcher.start()
    await vi.waitFor(() => expect(db.getRefStates(repoAddr)[0]?.commitId).toBe('1'.repeat(40)), {timeout: 5000})
    expect(index.requests.some(f => f.kinds?.includes(30618))).toBe(false)
    expect(service.requests.some(f => f.kinds?.includes(30618))).toBe(false)
    expect(repo.requests.some(f => f.kinds?.includes(30618))).toBe(true)
    nextRepo.events.push(repo.events[0]!)
    await watcher.nostr.publish([index.url], event(30617, [['d', 'repo'], ['relays', nextRepo.url]], 1, 1003), 1)
    await vi.waitFor(() => expect(nextRepo.requests.some(f => f.kinds?.includes(30618))).toBe(true), {timeout: 5000})
    expect(index.requests.some(f => f.kinds?.includes(30618))).toBe(false)
    expect(service.requests.some(f => f.kinds?.includes(30618))).toBe(false)
  }, 15000)

  it('does not add operational defaults to a repo read or a reporting publication', async () => {
    const service = await relay(), repo = await relay()
    const nostr = new NostrClient([service.url], [])
    cleanup.push(() => nostr.close())
    const signed = event(30618, [['d', 'repo']], 1, Math.floor(Date.now() / 1000))
    repo.events.push(signed)
    const done = firstValueFrom(nostr.store.timeline({kinds: [30618]}).pipe(timeout(3000), take(1)))
    const subscription = nostr.subscribe([repo.url], {kinds: [30618], authors: [OWNER]}, 'repo')
    cleanup.push(() => subscription.unsubscribe())
    await done
    await vi.waitFor(() => expect(repo.requests.some(f => f.kinds?.includes(30618))).toBe(true))
    await nostr.publish([repo.url], event(5401, []), 1)
    expect(service.requests).toEqual([])
    expect(service.events).toEqual([])
    expect(repo.events.map(e => e.kind)).toContain(5401)
  })

  it('delivers jobs to a disjoint worker inbox; reporting ACKs cannot claim job delivery', async () => {
    const service = await relay(), repo = await relay(), inbox = await relay(), outbox = await relay(), index = await relay()
    const db = database()
    const config = loadConfig({HIVE_CI_WATCHER_OWNER_PUBKEY: OWNER, HIVE_CI_WATCHER_RELAYS: service.url,
      HIVE_CI_WATCHER_BLOSSOM_SERVERS: 'https://blossom.example', HIVE_CI_WATCHER_IDENTITY_DISCOVERY_RELAYS: index.url})
    const nostr = new NostrClient([service.url], [index.url])
    cleanup.push(() => nostr.close())
    nostr.store.add(event(10002, [['r', inbox.url, 'read'], ['r', outbox.url, 'write']], 4))
    db.addRunner(OTHER)
    const deps = {config, db, identity, nostr, mayDispatch: () => true,
      workers: () => new Map([[OTHER, {pubkey: OTHER, name: 'worker', description: '', mints: [], lastSeen: Math.floor(Date.now() / 1000)}]])}
    const request = {repoAddr: `30617:${OWNER}:repo`, workflowPath: 'ci.yml', trigger: 'push' as const,
      ref: 'refs/heads/main', branch: 'main', commitId: '1'.repeat(40), repoRelays: [repo.url]}
    expect((await dispatchRun(deps, request)).status).toBe('dispatched')
    expect(repo.events.map(e => e.kind)).toEqual([5401])
    expect(inbox.events.map(e => e.kind)).toEqual([5100])
    const job = inbox.events[0]!
    expect(job.tags.find(t => t[0] === 'env' && t[1] === 'HIVE_CI_RELAYS')?.[2]).toBe(repo.url)
    expect([...service.events, ...outbox.events, ...index.events]).toEqual([])
    expect(db.jobs()[0]!.state).toBe('published')
    expect(acceptJobEvidence(db, event(30100, [['d', job.id], ['e', job.id], ['status', 'running']], 1))).toBe(false)
    expect(acceptJobEvidence(db, event(30100, [['d', job.id], ['e', job.id], ['status', 'running']], 4, 1001))).toBe(true)
    expect(acceptJobEvidence(db, event(30100, [['d', job.id], ['e', job.id], ['status', 'queued']], 4, 1000))).toBe(false)
    expect(acceptJobEvidence(db, event(5101, [['e', job.id], ['success', 'true']], 4, 1002))).toBe(true)
    db.updateJob(job.id, 'published')
    expect(db.jobs()[0]!.state).toBe('completed')

    inbox.accept = false
    const next = {...request, commitId: '2'.repeat(40)}
    const result = await dispatchRun(deps, next)
    expect(result.status).toBe('unconfirmed')
    expect(repo.events.filter(e => e.kind === 5401)).toHaveLength(2)
    expect(inbox.events).toHaveLength(1)
    const retry = await dispatchRun(deps, next)
    expect(retry).toEqual(result)
    expect(repo.events).toHaveLength(2)
    expect(db.pruneRuns(0)).toBe(0) // History pruning must not reopen uncertain execution.
    expect(db.pendingRunFor(next)?.runId).toBe('runId' in result ? result.runId : undefined)
    // Completing evaluation clears its latch. A later intentional rewind to
    // the same commit may run again, rather than being deduplicated forever.
    db.putRefState(request.repoAddr, request.ref, '3'.repeat(40))
    inbox.accept = true
    expect((await dispatchRun(deps, next)).status).toBe('dispatched')
    expect(repo.events).toHaveLength(3)
  }, 20000)

  it('runs encrypted ContextVM management through separate AUTH-protected inbox/outbox relays', async () => {
    const inbox = await relay(true), outbox = await relay(true), discovery = await relay()
    const db = database()
    const config = loadConfig({HIVE_CI_WATCHER_OWNER_PUBKEY: OWNER, HIVE_CI_WATCHER_NSEC: '0'.repeat(63) + '2',
      HIVE_CI_WATCHER_INBOX_RELAYS: inbox.url, HIVE_CI_WATCHER_OUTBOX_RELAYS: outbox.url,
      HIVE_CI_WATCHER_IDENTITY_DISCOVERY_RELAYS: discovery.url, HIVE_CI_WATCHER_SERVICE_DISCOVERY_RELAYS: discovery.url,
      HIVE_CI_WATCHER_GIT_DISCOVERY_RELAYS: ''})
    const daemon = new WatcherIdentity(config.secretKeyHex)
    const watcher = new Watcher(config, db, daemon)
    cleanup.push(() => watcher.stop())
    const server = await startCvmServer({config, db, identity: daemon, watcher, authorizer: watcher.authorizer})
    cleanup.push(() => server.close())
    const signer = new PrivateKeySigner(identity.secretKeyHex)
    const nostr = new NostrClient([], [], signer)
    cleanup.push(() => nostr.close())
    const handler = new DirectedRelayHandler(nostr, of([outbox.url]), () => [inbox.url], () => [inbox.url, outbox.url])
    const client = new Client({name: 'routing-test', version: '1'})
    cleanup.push(() => client.close())
    await client.connect(new NostrClientTransport({signer, relayHandler: handler, serverPubkey: daemon.pubkey,
      discoveryRelayUrls: [], encryptionMode: EncryptionMode.REQUIRED, giftWrapMode: GiftWrapMode.EPHEMERAL}))
    const response = await client.callTool({name: 'status', arguments: {}})
    expect(response.isError).not.toBe(true)
    expect(JSON.stringify(response)).toContain(daemon.pubkey)
    expect(inbox.events.some(e => e.kind === 21059)).toBe(true)
    expect(outbox.events.some(e => e.kind === 21059)).toBe(true)
    expect(discovery.events.every(e => e.kind === 10002 || (e.kind >= 11316 && e.kind <= 11320))).toBe(true)
    expect(inbox.authentications).toContain(daemon.pubkey)
    expect(outbox.authentications).toContain(OWNER)
    const mailbox = discovery.events.find(e => e.kind === 10002)!
    expect(mailbox.tags).toContainEqual(['r', inbox.url, 'read'])
    expect(mailbox.tags).toContainEqual(['r', outbox.url, 'write'])
  }, 20000)
})
