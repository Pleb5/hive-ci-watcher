import {afterEach, describe, expect, it, vi} from 'vitest'
import {BehaviorSubject, of, Subscription} from 'rxjs'
import {loadConfig} from '../src/config.js'
import {WatcherDb} from '../src/db/index.js'
import {WatcherIdentity} from '../src/identity.js'
import {Watcher} from '../src/watcher.js'
import {MEMBER, OTHER, OWNER, event} from './community-helpers.js'

vi.mock('../src/dispatch/blossom.js', async importOriginal => ({
  ...await importOriginal<any>(),
  resolveRunnerScriptUrl: vi.fn(async () => 'https://blossom.example/script'),
}))
import {resolveRunnerScriptUrl} from '../src/dispatch/blossom.js'

const REPO = `30617:${OWNER}:test`
const REF = 'refs/heads/main'
const COMMIT = '1'.repeat(40)
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.restoreAllMocks()
  vi.mocked(resolveRunnerScriptUrl).mockReset().mockResolvedValue('https://blossom.example/script')
})

function setup() {
  const db = new WatcherDb(':memory:')
  const config = loadConfig({HIVE_CI_WATCHER_OWNER_PUBKEY: OWNER,
    HIVE_CI_WATCHER_RELAYS: 'wss://service.example', HIVE_CI_WATCHER_BLOSSOM_SERVERS: 'https://blossom.example'})
  const watcher = new Watcher(config, db, new WatcherIdentity(config.secretKeyHex))
  const internal = watcher as any
  internal.running = true
  db.allowPubkey(MEMBER)
  db.followRepo({repoAddr: REPO, repoOwner: OWNER, dTag: 'test', addedBy: MEMBER})
  db.setRepoActive(REPO, true)
  db.seedRefStates(REPO, [{ref: REF, commitId: COMMIT}])
  db.addRunner(OTHER)
  internal.workers.set(OTHER, {pubkey: OTHER, name: 'worker', description: '', mints: [], lastSeen: Math.floor(Date.now() / 1000)})
  const publish = vi.spyOn(watcher.nostr, 'publish').mockResolvedValue({accepted: ['wss://one', 'wss://two'], rejected: []})
  vi.spyOn(watcher.nostr, 'loadReplaceable').mockResolvedValue(event(10002,
    [['r', 'wss://worker-outbox.example', 'write'], ['r', 'wss://worker-inbox.example', 'read']], 4))
  vi.spyOn(watcher.nostr, 'subscribe').mockImplementation(() => new Subscription())
  vi.spyOn(watcher.nostr, 'outboxes$').mockReturnValue(of([]))
  cleanups.push(async () => { await watcher.stop(); db.close() })
  return {db, watcher, internal, publish}
}
const request = {repoAddr: REPO, workflowPath: '.github/workflows/test.yml', trigger: 'push', ref: REF, branch: 'main', commitId: COMMIT, repoRelays: ['wss://repo.example']}

describe('eligibility at submission boundaries', () => {
  it('refuses dispatch without any eligible registration', async () => {
    const {db, internal, publish} = setup()
    db.revokePubkey(MEMBER)
    expect(await internal.dispatch(request)).toEqual({status: 'inactive'})
    expect(publish).not.toHaveBeenCalled()
  })
  it('rechecks after Blossom upload even when access is subsequently restored', async () => {
    const {db, watcher, internal, publish} = setup()
    vi.mocked(resolveRunnerScriptUrl).mockImplementationOnce(async () => {
      db.revokePubkey(MEMBER)
      await watcher.reconcileAccess()
      db.allowPubkey(MEMBER)
      db.setRepoActive(REPO, true)
      db.seedRefStates(REPO, [{ref: REF, commitId: COMMIT}])
      return 'https://blossom.example/script'
    })
    expect(await internal.dispatch(request)).toEqual({status: 'inactive'})
    expect(publish).not.toHaveBeenCalled()
  })
  it('rechecks after run announcement, before publishing the actual worker job', async () => {
    const {db, watcher, internal, publish} = setup()
    publish.mockImplementationOnce(async () => {
      db.revokePubkey(MEMBER)
      await watcher.reconcileAccess()
      return {accepted: ['wss://one', 'wss://two'], rejected: []}
    })
    expect(await internal.dispatch(request)).toEqual({status: 'inactive'})
    expect(publish.mock.calls.map(call => call[1].kind)).toEqual([5401])
    expect(db.recentRuns()).toEqual([])
  })
  it('continues one shared pipeline when another eligible registration survives', async () => {
    const {db, watcher, internal, publish} = setup()
    db.followRepo({repoAddr: REPO, repoOwner: OWNER, dTag: 'test', addedBy: OWNER})
    db.revokePubkey(MEMBER)
    await watcher.reconcileAccess()
    expect((await internal.dispatch(request)).status).toBe('dispatched')
    expect(publish.mock.calls.map(call => call[1].kind)).toEqual([5401, 5100])
    expect(db.recentRuns()).toHaveLength(1)
  })
})

describe('activation and suspension', () => {
  it('can bootstrap a genuinely new repository after an empty completed state query', async () => {
    const {db, watcher, internal, publish} = setup()
    const announcement = event(30617, [['d', 'test'], ['relays', 'wss://repo.example'], ['clone', 'https://git.example/repo']])
    db.setRepoActive(REPO, true)
    const watch = {repoAddr: REPO, owner: OWNER, dTag: 'test', subscriptions: [], hints: new BehaviorSubject([]), baselineReady: false}
    internal.repos.set(REPO, watch)
    vi.spyOn(watcher.nostr, 'loadReplaceable').mockResolvedValue(undefined)
    vi.spyOn(internal, 'loadWorkflows').mockResolvedValue({workflows: [], fetched: true})
    vi.spyOn(internal.authorityTransport, 'query').mockImplementation(async (_relays, filter: any) => filter.kinds[0] === 30617 ? [announcement] : [])
    await internal.hydrateRepo(watch)
    await internal.repoQueues.get(REPO)
    expect(watch.baselineReady).toBe(true)
    expect(db.getFollowedRepo(REPO)!.seededAt).toBeNull()
    watcher.nostr.store.add(event(30618, [['d', 'test'], [REF, COMMIT]]))
    await internal.evaluateRepo(REPO, new AbortController().signal)
    expect(db.getRefStates(REPO)).toMatchObject([{commitId: COMMIT}])
    expect(publish).not.toHaveBeenCalled()
  })
  it.each([30617, 30618])('does not validate cached baseline evidence with an empty kind-%s response', async missingKind => {
    const {db, watcher, internal, publish} = setup()
    const announcement = event(30617, [['d', 'test'], ['relays', 'wss://repo.example'], ['clone', 'https://git.example/repo']])
    const oldState = event(30618, [['d', 'test'], [REF, COMMIT]])
    const suspendedState = event(30618, [['d', 'test'], [REF, '2'.repeat(40)]], 1, 1001)
    watcher.nostr.store.add(announcement)
    watcher.nostr.store.add(oldState)
    db.setRepoActive(REPO, true)
    const watch = {repoAddr: REPO, owner: OWNER, dTag: 'test', subscriptions: [], hints: new BehaviorSubject([]), baselineReady: false}
    internal.repos.set(REPO, watch)
    vi.spyOn(watcher.nostr, 'loadReplaceable').mockResolvedValue(undefined)
    vi.spyOn(internal, 'loadWorkflows').mockResolvedValue({workflows: [], fetched: true})
    const changes = vi.spyOn(internal, 'evaluateRefChange').mockResolvedValue('complete')
    const query = vi.spyOn(internal.authorityTransport, 'query').mockImplementation(async (_relays, filter: any) => {
      if (filter.kinds[0] === missingKind) return []
      return filter.kinds[0] === 30617 ? [announcement] : [oldState]
    })
    await internal.hydrateRepo(watch)
    await internal.repoQueues.get(REPO)
    expect(db.getFollowedRepo(REPO)!.seededAt).toBeNull()
    expect(watch.baselineReady).toBe(false)
    watcher.nostr.store.add(suspendedState)
    await internal.evaluateRepo(REPO, new AbortController().signal)
    expect(changes).not.toHaveBeenCalled()
    query.mockImplementation(async (_relays, filter: any) => filter.kinds[0] === 30617 ? [announcement] : [suspendedState])
    await internal.hydrateRepo(watch)
    await internal.repoQueues.get(REPO)
    expect(db.getRefStates(REPO)).toMatchObject([{commitId: '2'.repeat(40)}])
    expect(changes).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })
  it('recreates a revoked/restored watch delayed behind another repository teardown', async () => {
    const {db, watcher, internal} = setup()
    internal.readyForRepos = true
    vi.spyOn(watcher.nostr, 'outboxes$').mockReturnValue(of([]))
    vi.spyOn(watcher.nostr, 'subscribe').mockImplementation(() => new Subscription())
    vi.spyOn(watcher.nostr, 'subscribeOutbox').mockImplementation(() => new Subscription())
    const hydrate = vi.spyOn(internal, 'hydrateRepo').mockResolvedValue(undefined)
    const later = `30617:${OWNER}:later`
    db.allowPubkey(OTHER)
    db.followRepo({repoAddr: later, repoOwner: OWNER, dTag: 'later', addedBy: OTHER})
    await watcher.reconcileAccess()
    const originalWatch = internal.repos.get(later)
    originalWatch.baselineReady = true
    hydrate.mockClear()
    let release!: () => void
    internal.repoQueues.set(REPO, new Promise<void>(resolve => { release = resolve }))
    db.revokePubkey(MEMBER)
    const pending = watcher.reconcileAccess()
    await Promise.resolve() // The loop snapshots both rows and blocks on REPO's queue.
    db.revokePubkey(OTHER)
    void watcher.reconcileAccess()
    db.allowPubkey(OTHER)
    void watcher.reconcileAccess()
    const invalidatedImmediately = !originalWatch.baselineReady
    release()
    await pending
    expect(invalidatedImmediately).toBe(true)
    expect(internal.repos.get(later)).not.toBe(originalWatch)
    expect(internal.repos.get(later).baselineReady).toBe(false)
    expect(hydrate).toHaveBeenCalledWith(internal.repos.get(later))
  })
  it('discards offline progress on startup and re-establishes registration access', async () => {
    const {db, watcher, internal} = setup()
    internal.running = false
    vi.spyOn(watcher.nostr, 'requestAll').mockResolvedValue([])
    vi.spyOn(watcher.nostr, 'subscribe').mockReturnValue(new Subscription())
    const watch = vi.spyOn(watcher, 'watchRepo').mockResolvedValue()
    db.replaceSchedules(REPO, [{workflowPath: 'test.yml', cron: '* * * * *'}])
    await watcher.start()
    expect(db.getFollowedRepo(REPO)).toMatchObject({active: true, seededAt: null})
    expect(db.getRefStates(REPO)).toEqual([])
    expect(db.listSchedules(REPO)).toEqual([])
    expect(watch).toHaveBeenCalledTimes(1)
  })
  it('suspends and reseeds, retaining registrations but dropping missed schedules and cursors', async () => {
    const {db, watcher, internal} = setup()
    internal.readyForRepos = true
    const watch = vi.spyOn(watcher, 'watchRepo').mockResolvedValue()
    const unwatch = vi.spyOn(watcher, 'unwatchRepo').mockResolvedValue()
    db.replaceSchedules(REPO, [{workflowPath: 'test.yml', cron: '* * * * *'}])
    db.revokePubkey(MEMBER)
    await watcher.reconcileAccess()
    expect(db.getFollowedRepo(REPO)!.active).toBe(false)
    expect(db.getRefStates(REPO)).toEqual([])
    expect(db.listSchedules(REPO)).toEqual([])
    expect(db.hasRegistration(MEMBER, REPO)).toBe(true)
    expect(unwatch).toHaveBeenCalledWith(REPO)
    db.allowPubkey(MEMBER)
    await watcher.reconcileAccess()
    expect(db.getFollowedRepo(REPO)).toMatchObject({active: true, seededAt: null})
    expect(watch).toHaveBeenCalledTimes(1)
    db.removeRegistration(REPO, MEMBER)
    await watcher.reconcileAccess()
    expect(db.getFollowedRepo(REPO)).toBeNull()
  })
  it('first evaluation after resume seeds the current commit instead of dispatching past changes', async () => {
    const {db, watcher, internal, publish} = setup()
    const commit = '2'.repeat(40)
    watcher.nostr.store.add(event(30617, [['d', 'test'], ['relays', 'wss://repo.example'], ['clone', 'https://git.example/repo']]))
    watcher.nostr.store.add(event(30618, [['d', 'test'], [REF, commit], ['HEAD', 'ref: refs/heads/main']]))
    internal.repos.set(REPO, {repoAddr: REPO, owner: OWNER, dTag: 'test', subscriptions: [], hints: {complete() {}}, baselineReady: true})
    db.setRepoActive(REPO, true)
    vi.spyOn(internal, 'loadWorkflows').mockResolvedValue({workflows: [], fetched: true})
    await internal.evaluateRepo(REPO, new AbortController().signal)
    expect(db.getRefStates(REPO)).toMatchObject([{ref: REF, commitId: commit}])
    expect(db.getFollowedRepo(REPO)!.seededAt).not.toBeNull()
    expect(publish).not.toHaveBeenCalled()
  })
  it('waits for a fresh baseline before using cached state and seeds the synchronized commit', async () => {
    const {db, watcher, internal, publish} = setup()
    const announcement = event(30617, [['d', 'test'], ['relays', 'wss://repo.example'], ['clone', 'https://git.example/repo']])
    const state = (commit: string, time: number) => event(30618, [['d', 'test'], [REF, commit]], 1, time)
    watcher.nostr.store.add(announcement)
    watcher.nostr.store.add(state(COMMIT, 1000))
    db.setRepoActive(REPO, true)
    const watch = {repoAddr: REPO, owner: OWNER, dTag: 'test', subscriptions: [], hints: new BehaviorSubject([]), baselineReady: false}
    internal.repos.set(REPO, watch)
    vi.spyOn(watcher.nostr, 'loadReplaceable').mockResolvedValue(undefined)
    vi.spyOn(internal, 'loadWorkflows').mockResolvedValue({workflows: [], fetched: true})
    let release!: (events: any[]) => void
    let queried!: () => void
    const queryStarted = new Promise<void>(resolve => { queried = resolve })
    vi.spyOn(internal.authorityTransport, 'query').mockImplementation(async (_relays, filter: any) => {
      if (filter.kinds[0] === 30617) return [announcement]
      queried()
      return new Promise(resolve => { release = resolve })
    })
    const hydration = internal.hydrateRepo(watch)
    await queryStarted
    await internal.evaluateRepo(REPO, new AbortController().signal)
    expect(db.getRefStates(REPO)).toEqual([])
    release([state('2'.repeat(40), 1001)])
    await hydration
    await internal.repoQueues.get(REPO)
    expect(db.getRefStates(REPO)).toMatchObject([{commitId: '2'.repeat(40)}])
    expect(publish).not.toHaveBeenCalled()
  })
  it('keeps one actual live pipeline when two users register the same repo', async () => {
    const {db, watcher, internal} = setup()
    internal.readyForRepos = true
    vi.spyOn(watcher.nostr, 'outboxes$').mockReturnValue(of([]))
    const announcements = vi.spyOn(watcher.nostr, 'subscribe').mockReturnValue(new Subscription())
    const states = vi.spyOn(watcher.nostr, 'subscribeOutbox').mockReturnValue(new Subscription())
    vi.spyOn(internal, 'hydrateRepo').mockResolvedValue(undefined)
    await watcher.reconcileAccess()
    db.followRepo({repoAddr: REPO, repoOwner: OWNER, dTag: 'test', addedBy: OWNER, relayHints: ['wss://relay.example.com/']})
    await watcher.reconcileAccess()
    expect(announcements).toHaveBeenCalledTimes(1)
    expect(states).toHaveBeenCalledTimes(1)
    expect(internal.repos.get(REPO).hints.value).toContain('wss://relay.example.com')
    db.removeRegistration(REPO, MEMBER)
    await watcher.reconcileAccess()
    expect(internal.repos.size).toBe(1)
    expect(db.getFollowedRepo(REPO)!.seededAt).not.toBeNull()
  })
  it('aborts a fetch evaluation on revocation and blocks due scheduled work', async () => {
    const {db, watcher, internal, publish} = setup()
    const controller = new AbortController()
    internal.inflight.set(REPO, controller)
    db.replaceSchedules(REPO, [{workflowPath: 'test.yml', cron: '* * * * *'}])
    db.markScheduleFired(REPO, 'test.yml', 1)
    db.revokePubkey(MEMBER)
    await watcher.reconcileAccess()
    expect(controller.signal.aborted).toBe(true)
    await watcher.runScheduleTick()
    expect(publish).not.toHaveBeenCalled()
  })
  it('drops the rest of a due schedule batch after suspension, even if access returns', async () => {
    const {db, watcher, internal, publish} = setup()
    watcher.nostr.store.add(event(30617, [['d', 'test'], ['relays', 'wss://repo.example'], ['clone', 'https://git.example/repo']]))
    internal.repos.set(REPO, {repoAddr: REPO, owner: OWNER, dTag: 'test', subscriptions: [], hints: new BehaviorSubject([]), baselineReady: true})
    db.replaceSchedules(REPO, ['one.yml', 'two.yml'].map(workflowPath => ({workflowPath, cron: '* * * * *'})))
    for (const path of ['one.yml', 'two.yml']) db.markScheduleFired(REPO, path, 1)
    vi.mocked(resolveRunnerScriptUrl).mockImplementationOnce(async () => {
      db.revokePubkey(MEMBER)
      await watcher.reconcileAccess()
      db.allowPubkey(MEMBER)
      db.setRepoActive(REPO, true)
      db.seedRefStates(REPO, [{ref: REF, commitId: COMMIT}])
      return 'https://blossom.example/script'
    })
    await watcher.runScheduleTick()
    expect(resolveRunnerScriptUrl).toHaveBeenCalledTimes(1)
    expect(publish).not.toHaveBeenCalled()
  })
})
