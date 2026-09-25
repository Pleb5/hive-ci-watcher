import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import Database from 'better-sqlite3'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {WatcherDb} from '../src/db/index.js'
import {Authorizer} from '../src/cvm/auth.js'
import {registerTools} from '../src/cvm/server.js'
import {MEMBER, OTHER, OWNER} from './community-helpers.js'

const REPO = `30617:${OWNER}:test`
const cleanups: Array<() => void> = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))
function setup() {
  const db = new WatcherDb(':memory:')
  cleanups.push(() => db.close())
  const follow = (requester: string, relayHints: string[] = []) => db.followRepo({repoAddr: REPO, repoOwner: OWNER, dTag: 'test', addedBy: requester, relayHints})
  return {db, follow}
}

describe('owned registrations', () => {
  it('shares repository state and unions hints without transferring ownership', () => {
    const {db, follow} = setup()
    follow(MEMBER, ['wss://one.example/'])
    db.seedRefStates(REPO, [{ref: 'refs/heads/main', commitId: '1'.repeat(40)}])
    follow(OTHER, ['wss://two.example/'])
    follow(MEMBER, ['wss://three.example/'])
    expect(db.listRegistrations(REPO)).toHaveLength(2)
    expect(db.getFollowedRepo(REPO)!.seededAt).not.toBeNull()
    expect(new Set(db.getFollowedRepo(REPO)!.relayHints)).toEqual(new Set(['wss://one.example/', 'wss://two.example/', 'wss://three.example/']))
    expect(db.removeRegistration(REPO, MEMBER)).toBe(true)
    expect(db.removeRegistration(REPO, MEMBER)).toBe(false)
    expect(db.listRegistrations(REPO).map(r => r.requester)).toEqual([OTHER])
    expect(db.getRefStates(REPO)).toHaveLength(1)
    expect(db.getFollowedRepo(REPO)!.relayHints).toEqual(['wss://two.example/'])
  })
  it('migrates old added_by once and never resurrects a removed registration on reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'watcher-registration-'))
    cleanups.push(() => rmSync(dir, {recursive: true, force: true}))
    const path = join(dir, 'watcher.db'), old = new Database(path)
    old.exec(`CREATE TABLE followed_repos (repo_addr TEXT PRIMARY KEY, repo_owner TEXT NOT NULL, d_tag TEXT NOT NULL,
      default_branch TEXT, added_by TEXT NOT NULL, added_at INTEGER NOT NULL)`)
    old.prepare('INSERT INTO followed_repos VALUES (?, ?, ?, NULL, ?, 123)').run(REPO, OWNER, 'test', MEMBER)
    old.close()
    const db = new WatcherDb(path)
    expect(db.listRegistrations(REPO)).toMatchObject([{requester: MEMBER, addedAt: 123, relayHints: []}])
    db.followRepo({repoAddr: REPO, repoOwner: OWNER, dTag: 'test', addedBy: OTHER})
    db.removeRegistration(REPO, MEMBER)
    db.close()
    const restored = new WatcherDb(path)
    expect(restored.listRegistrations(REPO).map(r => r.requester)).toEqual([OTHER])
    restored.close()
  })
})

function api() {
  const {db, follow} = setup()
  db.allowPubkey(MEMBER)
  db.allowPubkey(OTHER)
  const authorizer = new Authorizer(db, OWNER)
  const handlers = new Map<string, (args: any, extra: any) => Promise<any>>()
  const watcher = {
    reconcileAccess: vi.fn(async () => {}), isEligible: () => true,
    repoProbe: () => null, unparseableWorkflows: () => [],
    status: vi.fn(() => ({})), communities: {status: () => [], listMembers: () => []},
  }
  registerTools({registerTool: (name: string, _options: any, handler: any) => handlers.set(name, handler)} as any,
    {db, authorizer, watcher, config: {ownerPubkey: OWNER}} as any)
  const call = async (tool: string, caller: string, args = {}) => {
    const result = await handlers.get(tool)!(args, {_meta: {clientPubkey: caller}})
    return result.isError ? result.content[0].text : JSON.parse(result.content[0].text)
  }
  return {db, follow, watcher, call}
}

describe('actual MCP tool handlers', () => {
  it('limits unfollow to oneself, including after access is revoked', async () => {
    const {call, db, follow} = api()
    follow(MEMBER); follow(OTHER)
    for (const args of [{all: true}, {requester_pubkey: OTHER}]) {
      expect(await call('unfollow_repo', MEMBER, {repo_addr: REPO, ...args})).toBe('not authorized')
    }
    db.revokePubkey(MEMBER)
    expect(await call('follow_repo', MEMBER, {repo_addr: REPO})).toBe('not authorized')
    expect((await call('unfollow_repo', MEMBER, {repo_addr: REPO})).existed).toBe(true)
    expect(db.listRegistrations(REPO).map(r => r.requester)).toEqual([OTHER])
  })
  it('does not let a registered user remove a different repo owner registration', async () => {
    const {call, db, follow} = api()
    follow(OTHER)
    const ownRepo = `30617:${OWNER}:own`
    db.followRepo({repoAddr: ownRepo, repoOwner: OWNER, dTag: 'own', addedBy: MEMBER})
    db.revokePubkey(MEMBER)
    expect((await call('unfollow_repo', MEMBER, {repo_addr: REPO})).existed).toBe(false)
    expect(db.hasRegistration(OTHER, REPO)).toBe(true)
  })
  it('filters lists and status to the caller, with operator targeting and all-removal', async () => {
    const {call, db, follow, watcher} = api()
    follow(MEMBER); follow(OTHER)
    const visible = await call('list_followed', MEMBER)
    expect(visible.repos[0].registrations.map((r: any) => r.requester)).toEqual([MEMBER])
    expect(visible.repos[0]).not.toHaveProperty('added_by')
    await call('status', MEMBER)
    expect(watcher.status).toHaveBeenCalledWith(MEMBER)
    expect((await call('list_followed', OWNER)).repos[0].registrations).toHaveLength(2)
    await call('unfollow_repo', OWNER, {repo_addr: REPO, requester_pubkey: MEMBER})
    expect(db.listRegistrations(REPO).map(r => r.requester)).toEqual([OTHER])
    await call('unfollow_repo', OWNER, {repo_addr: REPO, all: true})
    expect(db.listRegistrations(REPO)).toEqual([])
  })
})
