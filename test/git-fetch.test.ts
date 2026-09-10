import {execFileSync} from 'node:child_process'
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import {fetchWorkflowTree, WorkflowTreeCache} from '../src/git/fetch.js'

let repoDir: string
/** A remote that drifted out of sync with the announced repo state. */
let driftDir: string
let secondCommit: string

function git(args: string[], cwd = repoDir): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.com',
    },
  }).trim()
}

beforeAll(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'hive-ci-fixture-'))
  git(['init', '--quiet', '--initial-branch', 'main'])
  // A depth-1 fetch of an arbitrary SHA needs the server side to allow it.
  git(['config', 'uploadpack.allowAnySHA1InWant', 'true'])

  mkdirSync(join(repoDir, '.github', 'workflows'), {recursive: true})
  writeFileSync(
    join(repoDir, '.github', 'workflows', 'ci.yml'),
    'name: CI\non:\n  push:\n    branches: [main]\njobs: {}\n',
  )
  mkdirSync(join(repoDir, '.ngit', 'workflows'), {recursive: true})
  writeFileSync(join(repoDir, '.ngit', 'workflows', 'extra.yml'), 'name: Extra\non: push\njobs: {}\n')
  // Same basename in both roots — `.github` must win.
  writeFileSync(join(repoDir, '.ngit', 'workflows', 'ci.yml'), 'name: SHOULD NOT WIN\non: push\njobs: {}\n')
  writeFileSync(join(repoDir, 'README.md'), 'fixture\n')

  git(['add', '-A'])
  git(['commit', '--quiet', '-m', 'first'])

  writeFileSync(join(repoDir, 'README.md'), 'fixture moved on\n')
  git(['add', '-A'])
  git(['commit', '--quiet', '-m', 'second'])
  secondCommit = git(['rev-parse', 'HEAD'])

  driftDir = mkdtempSync(join(tmpdir(), 'hive-ci-drift-'))
  git(['init', '--quiet', '--initial-branch', 'main'], driftDir)
  git(['config', 'uploadpack.allowAnySHA1InWant', 'true'], driftDir)
  mkdirSync(join(driftDir, '.github', 'workflows'), {recursive: true})
  writeFileSync(
    join(driftDir, '.github', 'workflows', 'ci.yml'),
    'name: DRIFTED\non: push\njobs: {}\n',
  )
  git(['add', '-A'], driftDir)
  git(['commit', '--quiet', '-m', 'drifted'], driftDir)
})

afterAll(() => {
  rmSync(repoDir, {recursive: true, force: true})
  rmSync(driftDir, {recursive: true, force: true})
})

describe('shallow fetch with commit verification', () => {
  it('reads the union of both workflow roots, with .github winning a collision', async () => {
    const tree = await fetchWorkflowTree({
      cloneUrls: [`file://${repoDir}`],
      commitId: secondCommit,
      refName: 'refs/heads/main',
    })

    expect(tree).not.toBeNull()
    expect([...tree!.keys()].sort()).toEqual([
      '.github/workflows/ci.yml',
      '.ngit/workflows/ci.yml',
      '.ngit/workflows/extra.yml',
    ])
    expect(tree!.get('.github/workflows/ci.yml')!.content).toContain('name: CI')
    // The `.ngit` copy is kept under its own path; it never overwrites the
    // `.github` one.
    expect(tree!.get('.github/workflows/ci.yml')!.content).not.toContain('SHOULD NOT WIN')
  })

  it('rejects a drifted remote rather than building the tree it happens to serve', async () => {
    // `driftDir` does not contain `secondCommit` at all, so the SHA fetch
    // fails and the ref-name fallback pulls whatever its `main` points at.
    // Only the tip check stands between that and a silent build of the wrong
    // tree.
    const tree = await fetchWorkflowTree({
      cloneUrls: [`file://${driftDir}`],
      commitId: secondCommit,
      refName: 'refs/heads/main',
    })

    expect(tree).toBeNull()
  })

  it('falls through to the next remote when the first is missing or drifted', async () => {
    for (const bad of [`file://${repoDir}-does-not-exist`, `file://${driftDir}`]) {
      const tree = await fetchWorkflowTree({
        cloneUrls: [bad, `file://${repoDir}`],
        commitId: secondCommit,
        refName: 'refs/heads/main',
      })
      expect(tree).not.toBeNull()
      expect(tree!.get('.github/workflows/ci.yml')!.content).toContain('name: CI')
    }
  })

  it('returns null once every remote is exhausted', async () => {
    const tree = await fetchWorkflowTree({
      cloneUrls: [`file://${repoDir}-nope`],
      commitId: secondCommit,
      refName: 'refs/heads/main',
    })
    expect(tree).toBeNull()
  })
})

describe('tree cache', () => {
  it('fetches once per (repo, commit), including for concurrent callers', async () => {
    const cache = new WorkflowTreeCache()
    let calls = 0
    const load = async () => {
      calls += 1
      return new Map()
    }

    await Promise.all([
      cache.get('repo', 'abc', load),
      cache.get('repo', 'abc', load),
      cache.get('repo', 'ABC', load),
    ])
    expect(calls).toBe(1)

    await cache.get('repo', 'def', load)
    expect(calls).toBe(2)
  })

  it('does not cache a failed fetch as a permanent miss', async () => {
    const cache = new WorkflowTreeCache()
    let calls = 0

    await expect(
      cache.get('repo', 'abc', async () => {
        calls += 1
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    await cache.get('repo', 'abc', async () => {
      calls += 1
      return new Map()
    })
    expect(calls).toBe(2)
  })
})
