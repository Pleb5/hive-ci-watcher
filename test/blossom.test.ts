import {afterEach, describe, expect, it, vi} from 'vitest'
import {buildRunnerArgs, resolveRunnerScriptUrl, sha256Hex} from '../src/dispatch/blossom.js'
import {WORKFLOW_RUNNER_SCRIPT} from '../src/dispatch/runner-script.js'
import {WatcherDb} from '../src/db/index.js'
import {WatcherIdentity} from '../src/identity.js'

const identity = new WatcherIdentity('1'.repeat(64))
const SERVERS = ['https://a.example', 'https://b.example']

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubHead(has: (url: string) => boolean) {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: any, init: any) => {
      calls.push(String(url))
      expect(init.method).toBe('HEAD')
      return {status: has(String(url)) ? 200 : 404} as Response
    }),
  )
  return calls
}

describe('runner script hosting', () => {
  it('is a static template, so its hash is stable across runs', () => {
    // Everything run-specific arrives through the 5100 `env` tags — nothing is
    // interpolated into the script — which is what makes the upload a
    // one-time cost.
    for (const name of [
      'HIVE_CI_RUN_ID',
      'HIVE_CI_REPOSITORY',
      'HIVE_CI_WORKFLOW',
      'HIVE_CI_BRANCH',
      'HIVE_CI_COMMIT',
      'HIVE_CI_RELAYS',
      'HIVE_CI_NSEC',
    ]) {
      expect(WORKFLOW_RUNNER_SCRIPT).toContain(name)
    }

    // Nothing run-specific is baked in: no repo url, no commit id, no key.
    expect(WORKFLOW_RUNNER_SCRIPT).not.toMatch(/nostr:\/\/npub1/)
    expect(WORKFLOW_RUNNER_SCRIPT).not.toMatch(/\bnsec1[a-z0-9]{10}/)
    expect(WORKFLOW_RUNNER_SCRIPT).not.toMatch(/\b[0-9a-f]{40}\b/)
  })

  it('reuses a hosted blob instead of uploading', async () => {
    const db = new WatcherDb(':memory:')
    const hash = sha256Hex(WORKFLOW_RUNNER_SCRIPT)
    const calls = stubHead(url => url === `https://a.example/${hash}`)

    const url = await resolveRunnerScriptUrl({
      db,
      identity,
      servers: SERVERS,
      script: WORKFLOW_RUNNER_SCRIPT,
    })

    expect(url).toBe(`https://a.example/${hash}`)
    expect(calls).toEqual([`https://a.example/${hash}`])
    expect(db.getKv('runner_script_url')).toBe(url)
    db.close()
  })

  it('probes the cached server first on the next dispatch', async () => {
    const db = new WatcherDb(':memory:')
    const hash = sha256Hex(WORKFLOW_RUNNER_SCRIPT)
    db.setKv('runner_script_url', `https://b.example/${hash}`)

    const calls = stubHead(url => url === `https://b.example/${hash}`)
    const url = await resolveRunnerScriptUrl({
      db,
      identity,
      servers: SERVERS,
      script: WORKFLOW_RUNNER_SCRIPT,
    })

    expect(url).toBe(`https://b.example/${hash}`)
    // Cached server first — the steady-state cost of a dispatch is one
    // conditional HEAD.
    expect(calls).toEqual([`https://b.example/${hash}`])
    db.close()
  })

  it('still probes every dispatch, because servers garbage-collect blobs', async () => {
    const db = new WatcherDb(':memory:')
    const hash = sha256Hex(WORKFLOW_RUNNER_SCRIPT)
    db.setKv('runner_script_url', `https://a.example/${hash}`)

    // `a` has dropped the blob; `b` still holds it, so the cached URL is
    // replaced rather than handed to a runner that would 404 at run time.
    const calls = stubHead(url => url === `https://b.example/${hash}`)
    const url = await resolveRunnerScriptUrl({
      db,
      identity,
      servers: SERVERS,
      script: WORKFLOW_RUNNER_SCRIPT,
    })

    expect(url).toBe(`https://b.example/${hash}`)
    expect(calls).toHaveLength(2)
    expect(db.getKv('runner_script_url')).toBe(`https://b.example/${hash}`)
    db.close()
  })

  it('builds curl+bash args pointing at the resolved url', () => {
    const hash = sha256Hex(WORKFLOW_RUNNER_SCRIPT)
    const args = buildRunnerArgs(`https://a.example/${hash}`, hash)
    expect(args[0]).toBe('-c')
    expect(args[1]).toContain(`curl -fsSL "https://a.example/${hash}"`)
    expect(args[1]).toContain('/tmp/run-workflow.sh')
  })
})
