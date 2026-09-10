import {matchesPatternList} from './glob.js'
import type {RefDescriptor} from './refs.js'
import type {ParsedWorkflow, PushTrigger} from './workflow.js'

function hasBranchFilters(trigger: PushTrigger): boolean {
  return trigger.branches !== undefined || trigger.branchesIgnore !== undefined
}

function hasTagFilters(trigger: PushTrigger): boolean {
  return trigger.tags !== undefined || trigger.tagsIgnore !== undefined
}

/**
 * GitHub's branch/tag semantics for `on.push`:
 *
 * | `on.push` declares              | branch push  | tag push   |
 * |---------------------------------|--------------|------------|
 * | neither `branches` nor `tags`   | fires        | fires      |
 * | `branches` / `branches-ignore`  | glob match   | never      |
 * | `tags` / `tags-ignore`          | never        | glob match |
 * | both                            | branches glob| tags glob  |
 *
 * `paths` / `paths-ignore` are ignored in v1 — a shallow single-commit fetch
 * gives no diff to filter on, for a tag push least of all.
 */
export function pushTriggerMatches(trigger: PushTrigger, ref: RefDescriptor): boolean {
  const branchFilters = hasBranchFilters(trigger)
  const tagFilters = hasTagFilters(trigger)

  if (!branchFilters && !tagFilters) return true

  if (ref.kind === 'branch') {
    if (!branchFilters) return false
    if (trigger.branchesIgnore !== undefined) {
      return !matchesPatternList(trigger.branchesIgnore, ref.shortName)
    }
    return matchesPatternList(trigger.branches ?? [], ref.shortName)
  }

  if (!tagFilters) return false
  if (trigger.tagsIgnore !== undefined) {
    return !matchesPatternList(trigger.tagsIgnore, ref.shortName)
  }
  return matchesPatternList(trigger.tags ?? [], ref.shortName)
}

export interface CandidateWorkflow {
  path: string
  /** Which tree the `on.push` block was read from. */
  triggerSource: 'default-branch' | 'pushed-ref'
  trigger: PushTrigger
}

/**
 * Builds the candidate set for a push (§3.2 step 5).
 *
 * - every workflow path present on the **default** branch → its triggers are
 *   read from the default branch's copy, so a push cannot rewrite the rules
 *   that decide whether it fires;
 * - every workflow path present **only** at the pushed ref → triggers come
 *   from that ref's own copy. That is the escape hatch for brand-new
 *   workflows, and the only case where the pushed ref gets to speak for
 *   itself.
 */
export function buildCandidates(
  defaultBranchWorkflows: ParsedWorkflow[],
  pushedRefWorkflows: ParsedWorkflow[],
): CandidateWorkflow[] {
  const candidates: CandidateWorkflow[] = []
  const defaultPaths = new Set<string>()

  for (const workflow of defaultBranchWorkflows) {
    defaultPaths.add(workflow.path)
    if (!workflow.push) continue
    candidates.push({path: workflow.path, triggerSource: 'default-branch', trigger: workflow.push})
  }

  for (const workflow of pushedRefWorkflows) {
    if (defaultPaths.has(workflow.path)) continue
    if (!workflow.push) continue
    candidates.push({path: workflow.path, triggerSource: 'pushed-ref', trigger: workflow.push})
  }

  return candidates
}

/**
 * Resolves a push into the workflow paths to dispatch.
 *
 * A candidate that matched but does not exist in the pushed ref's tree is
 * dropped: there is nothing for `act` to run.
 */
export function evaluatePush(args: {
  ref: RefDescriptor
  defaultBranchWorkflows: ParsedWorkflow[]
  pushedRefWorkflows: ParsedWorkflow[]
}): string[] {
  const executable = new Set(args.pushedRefWorkflows.map(workflow => workflow.path))

  return buildCandidates(args.defaultBranchWorkflows, args.pushedRefWorkflows)
    .filter(candidate => pushTriggerMatches(candidate.trigger, args.ref))
    .filter(candidate => executable.has(candidate.path))
    .map(candidate => candidate.path)
}
