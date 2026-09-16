import yaml from 'js-yaml'

export interface PushTrigger {
  branches?: string[]
  branchesIgnore?: string[]
  tags?: string[]
  tagsIgnore?: string[]
}

export interface ParsedWorkflow {
  path: string
  name: string
  /** Absent when the workflow declares no `on.push`. */
  push?: PushTrigger
  /** Cron expressions from `on.schedule[].cron`, in declaration order. */
  schedules: string[]
}

function asStringArray(value: unknown): string[] | undefined {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === 'string')
    return items
  }
  return undefined
}

/**
 * Reads the workflow's `on:` section.
 *
 * js-yaml 4 parses with the YAML 1.2 core schema, where the bare key `on`
 * stays the string `'on'`. YAML 1.1 parsers fold it to boolean `true` (which
 * JavaScript then keys as `'true'`), so that spelling is accepted too — a
 * workflow that came through such a parser upstream must not silently lose
 * every one of its triggers.
 */
function readOnSection(doc: any): unknown {
  if (!doc || typeof doc !== 'object') return undefined
  const record = doc as Record<string, unknown>
  if ('on' in record) return record.on
  return record['true']
}

function parsePushTrigger(value: unknown): PushTrigger | undefined {
  // `on: push`, `on: [push]`, or `on: {push: null}` — a push trigger with no
  // filters at all.
  if (value === null || value === undefined) return {}
  if (typeof value !== 'object') return {}

  const raw = value as Record<string, unknown>
  const trigger: PushTrigger = {}

  const branches = asStringArray(raw.branches)
  if (branches) trigger.branches = branches
  const branchesIgnore = asStringArray(raw['branches-ignore'])
  if (branchesIgnore) trigger.branchesIgnore = branchesIgnore
  const tags = asStringArray(raw.tags)
  if (tags) trigger.tags = tags
  const tagsIgnore = asStringArray(raw['tags-ignore'])
  if (tagsIgnore) trigger.tagsIgnore = tagsIgnore

  // `paths` / `paths-ignore` are deliberately dropped in v1: a shallow
  // single-commit fetch cannot produce the diff they need.
  return trigger
}

function parseSchedules(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const crons: string[] = []
  for (const entry of value) {
    const cron = entry && typeof entry === 'object' ? (entry as any).cron : undefined
    if (typeof cron === 'string' && cron.trim()) crons.push(cron.trim())
  }
  return crons
}

export interface WorkflowParseError {
  path: string
  /** js-yaml's message, first line — includes line:column when it has one. */
  error: string
}

export type WorkflowParseResult = {workflow: ParsedWorkflow; error?: never} | {workflow?: never; error: WorkflowParseError}

/**
 * Parses one workflow's trigger surface, keeping the reason when it cannot.
 * An unreadable workflow never fires — it must not take the evaluation down
 * with it — but the reason has to reach the operator, or "my workflow never
 * runs" is undiagnosable from outside.
 */
export function parseWorkflowDetailed(path: string, content: string): WorkflowParseResult {
  let doc: unknown
  try {
    doc = yaml.load(content)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {error: {path, error: message.split('\n')[0] ?? message}}
  }
  if (!doc || typeof doc !== 'object') {
    return {error: {path, error: 'workflow is not a YAML mapping'}}
  }
  return {workflow: parseWorkflowDocument(path, doc)}
}

/** `parseWorkflowDetailed` without the reason. */
export function parseWorkflow(path: string, content: string): ParsedWorkflow | null {
  return parseWorkflowDetailed(path, content).workflow ?? null
}

function parseWorkflowDocument(path: string, doc: object): ParsedWorkflow {

  const name = typeof (doc as any).name === 'string' ? (doc as any).name : path
  const onSection = readOnSection(doc)

  const parsed: ParsedWorkflow = {path, name, schedules: []}

  if (typeof onSection === 'string') {
    if (onSection === 'push') parsed.push = {}
    return parsed
  }

  if (Array.isArray(onSection)) {
    if (onSection.includes('push')) parsed.push = {}
    return parsed
  }

  if (onSection && typeof onSection === 'object') {
    const raw = onSection as Record<string, unknown>
    if ('push' in raw) parsed.push = parsePushTrigger(raw.push)
    if ('schedule' in raw) parsed.schedules = parseSchedules(raw.schedule)
    // `pull_request` and `workflow_dispatch` are never honored in v1 and are
    // dropped here rather than downstream, so no later code can act on them.
  }

  return parsed
}

export function parseWorkflowTree(tree: Map<string, {path: string; content: string}>): {
  workflows: ParsedWorkflow[]
  errors: WorkflowParseError[]
} {
  const workflows: ParsedWorkflow[] = []
  const errors: WorkflowParseError[] = []
  for (const file of tree.values()) {
    const result = parseWorkflowDetailed(file.path, file.content)
    if (result.workflow) workflows.push(result.workflow)
    else errors.push(result.error)
  }
  return {workflows, errors}
}
