import {describe, expect, it} from 'vitest'
import {globMatch, matchesPatternList} from '../src/triggers/glob.js'
import {buildCandidates, evaluatePush, pushTriggerMatches} from '../src/triggers/push.js'
import {describeRef} from '../src/triggers/refs.js'
import {parseWorkflow, type ParsedWorkflow} from '../src/triggers/workflow.js'

const branch = (name: string) => describeRef(`refs/heads/${name}`)!
const tag = (name: string) => describeRef(`refs/tags/${name}`)!

describe('glob boundaries', () => {
  it('does not let * cross a path separator', () => {
    expect(globMatch('release/*', 'release/1.x')).toBe(true)
    expect(globMatch('release/*', 'release/1/x')).toBe(false)
  })

  it('lets ** cross a path separator', () => {
    expect(globMatch('release/**', 'release/1/x')).toBe(true)
    expect(globMatch('**', 'a/b/c')).toBe(true)
  })

  it('matches ? against exactly one non-separator character', () => {
    expect(globMatch('v?', 'v1')).toBe(true)
    expect(globMatch('v?', 'v12')).toBe(false)
    expect(globMatch('a?b', 'a/b')).toBe(false)
  })

  it('treats regex metacharacters as literals', () => {
    expect(globMatch('v1.2.0', 'v1.2.0')).toBe(true)
    expect(globMatch('v1.2.0', 'v1X2X0')).toBe(false)
  })

  it('lets the last matching pattern decide', () => {
    expect(matchesPatternList(['release/*', '!release/legacy'], 'release/legacy')).toBe(false)
    expect(matchesPatternList(['release/*', '!release/legacy'], 'release/1.x')).toBe(true)
  })

  it('treats a negation-only list as match-all-but', () => {
    expect(matchesPatternList(['!main'], 'feature')).toBe(true)
    expect(matchesPatternList(['!main'], 'main')).toBe(false)
  })
})

describe('§3.2 branch/tag table', () => {
  it('fires on both when neither branches nor tags is declared', () => {
    expect(pushTriggerMatches({}, branch('main'))).toBe(true)
    expect(pushTriggerMatches({}, tag('v1.0.0'))).toBe(true)
  })

  it('never fires on a tag when only branches is declared', () => {
    const trigger = {branches: ['main']}
    expect(pushTriggerMatches(trigger, branch('main'))).toBe(true)
    expect(pushTriggerMatches(trigger, branch('dev'))).toBe(false)
    expect(pushTriggerMatches(trigger, tag('main'))).toBe(false)
  })

  it('never fires on a branch when only tags is declared', () => {
    const trigger = {tags: ['v*']}
    expect(pushTriggerMatches(trigger, tag('v1.0.0'))).toBe(true)
    expect(pushTriggerMatches(trigger, tag('rc1'))).toBe(false)
    expect(pushTriggerMatches(trigger, branch('v1.0.0'))).toBe(false)
  })

  it('applies each side of a both-declared trigger to its own ref kind', () => {
    const trigger = {branches: ['main'], tags: ['v*']}
    expect(pushTriggerMatches(trigger, branch('main'))).toBe(true)
    expect(pushTriggerMatches(trigger, branch('v1.0.0'))).toBe(false)
    expect(pushTriggerMatches(trigger, tag('v1.0.0'))).toBe(true)
    expect(pushTriggerMatches(trigger, tag('main'))).toBe(false)
  })

  it('honours branches-ignore, which still bars every tag', () => {
    const trigger = {branchesIgnore: ['wip/**']}
    expect(pushTriggerMatches(trigger, branch('main'))).toBe(true)
    expect(pushTriggerMatches(trigger, branch('wip/thing'))).toBe(false)
    expect(pushTriggerMatches(trigger, tag('v1.0.0'))).toBe(false)
  })

  it('honours tags-ignore, which still bars every branch', () => {
    const trigger = {tagsIgnore: ['nightly-*']}
    expect(pushTriggerMatches(trigger, tag('v1.0.0'))).toBe(true)
    expect(pushTriggerMatches(trigger, tag('nightly-2026'))).toBe(false)
    expect(pushTriggerMatches(trigger, branch('main'))).toBe(false)
  })
})

describe('workflow parsing', () => {
  it('reads push filters and schedules, and drops paths filters', () => {
    const parsed = parseWorkflow(
      '.github/workflows/ci.yml',
      [
        'name: CI',
        'on:',
        '  push:',
        '    branches: [main]',
        '    paths:',
        "      - 'src/**'",
        '  schedule:',
        "    - cron: '0 3 * * *'",
        'jobs: {}',
      ].join('\n'),
    )!

    expect(parsed.push).toEqual({branches: ['main']})
    expect(parsed.schedules).toEqual(['0 3 * * *'])
    expect(Object.keys(parsed.push!)).not.toContain('paths')
  })

  it('never honours pull_request', () => {
    const parsed = parseWorkflow(
      '.github/workflows/pr.yml',
      ['on:', '  pull_request:', '    branches: [main]', 'jobs: {}'].join('\n'),
    )!
    expect(parsed.push).toBeUndefined()
  })

  it('treats a bare or list-form push as an unfiltered trigger', () => {
    expect(parseWorkflow('a.yml', 'on: push\njobs: {}')!.push).toEqual({})
    expect(parseWorkflow('b.yml', 'on: [push, pull_request]\njobs: {}')!.push).toEqual({})
    expect(parseWorkflow('c.yml', 'on:\n  push:\njobs: {}')!.push).toEqual({})
  })

  it('returns null rather than throwing on unparseable yaml', () => {
    expect(parseWorkflow('bad.yml', 'on: [\n  unclosed')).toBeNull()
  })
})

function workflow(path: string, push?: ParsedWorkflow['push']): ParsedWorkflow {
  return {path, name: path, push, schedules: []}
}

describe('candidate selection', () => {
  it('reads triggers from the default branch for a path present on both', () => {
    const candidates = buildCandidates(
      [workflow('.github/workflows/ci.yml', {branches: ['main']})],
      [workflow('.github/workflows/ci.yml', {branches: ['**']})],
    )

    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.triggerSource).toBe('default-branch')
    expect(candidates[0]!.trigger).toEqual({branches: ['main']})
  })

  it('lets a workflow present only at the pushed ref speak for itself', () => {
    const paths = evaluatePush({
      ref: branch('feature'),
      defaultBranchWorkflows: [],
      pushedRefWorkflows: [workflow('.github/workflows/new.yml', {branches: ['feature']})],
    })
    expect(paths).toEqual(['.github/workflows/new.yml'])
  })

  it('skips a matched workflow that does not exist in the pushed ref tree', () => {
    const paths = evaluatePush({
      ref: branch('main'),
      defaultBranchWorkflows: [workflow('.github/workflows/ci.yml', {branches: ['main']})],
      pushedRefWorkflows: [],
    })
    expect(paths).toEqual([])
  })

  it('cannot be rewritten by the push itself', () => {
    // The pushed ref widens its own filter to `**`; the default branch's copy
    // still restricts to `main`, and that is the copy that decides.
    const paths = evaluatePush({
      ref: branch('feature'),
      defaultBranchWorkflows: [workflow('.github/workflows/ci.yml', {branches: ['main']})],
      pushedRefWorkflows: [workflow('.github/workflows/ci.yml', {branches: ['**']})],
    })
    expect(paths).toEqual([])
  })
})

describe('parse errors are kept, not swallowed', () => {
  it('reports the yaml error with its position', async () => {
    const {parseWorkflowDetailed, parseWorkflowTree} = await import('../src/triggers/workflow.js')
    const bad = ['on: push', 'jobs:', '  deploy:', '    steps:', '      - run: echo "deploying (trigger: $X)"'].join('\n')
    const result = parseWorkflowDetailed('.github/workflows/demo.yaml', bad)
    expect(result.workflow).toBeUndefined()
    expect(result.error).toMatchObject({path: '.github/workflows/demo.yaml'})
    expect(result.error!.error).toMatch(/bad indentation|mapping/i)
    expect(result.error!.error).toMatch(/\(5:\d+\)/)

    const tree = new Map([
      ['.github/workflows/demo.yaml', {path: '.github/workflows/demo.yaml', content: bad}],
      ['.github/workflows/ok.yaml', {path: '.github/workflows/ok.yaml', content: 'on: push\njobs: {}\n'}],
    ])
    const parsed = parseWorkflowTree(tree)
    expect(parsed.workflows.map(w => w.path)).toEqual(['.github/workflows/ok.yaml'])
    expect(parsed.errors.map(e => e.path)).toEqual(['.github/workflows/demo.yaml'])
  })
})
