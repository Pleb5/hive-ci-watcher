import {inspect} from 'node:util'

type Level = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<Level, number> = {debug: 10, info: 20, warn: 30, error: 40}

function threshold(): number {
  const raw = (process.env.HIVE_CI_WATCHER_LOG_LEVEL || 'info').toLowerCase()
  return ORDER[raw as Level] ?? ORDER.info
}

/**
 * `json` (one object per line, for journald and log shippers) or `pretty`
 * (for a terminal). Defaults to pretty when stdout is a TTY, json otherwise;
 * `HIVE_CI_WATCHER_LOG_FORMAT` overrides either way.
 */
function format(): 'json' | 'pretty' {
  const raw = process.env.HIVE_CI_WATCHER_LOG_FORMAT?.toLowerCase()
  if (raw === 'json' || raw === 'pretty') return raw
  return process.stdout.isTTY ? 'pretty' : 'json'
}

const COLOR = {
  debug: '\x1b[2m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  reset: '\x1b[0m',
  dim: '\x1b[2m',
}

function prettyValue(value: unknown): string {
  if (typeof value === 'string') return /[\s"=]/.test(value) ? JSON.stringify(value) : value
  if (value === null || typeof value !== 'object') return String(value)
  return inspect(value, {depth: 3, breakLength: Infinity, compact: true, colors: false})
}

function prettyLine(level: Level, scope: string, message: string, fields?: Record<string, unknown>): string {
  const useColor = process.stdout.isTTY && !process.env.NO_COLOR
  const paint = (code: string, text: string) => (useColor ? `${code}${text}${COLOR.reset}` : text)
  const time = new Date().toISOString().slice(11, 19)
  const tag = paint(COLOR[level], level.toUpperCase().padEnd(5))
  const extras = Object.entries(fields ?? {})
    .map(([key, value]) => `${paint(COLOR.dim, `${key}=`)}${prettyValue(value)}`)
    .join(' ')
  return `${paint(COLOR.dim, time)} ${tag} ${paint(COLOR.dim, `[${scope}]`)} ${message}${extras ? ` ${extras}` : ''}`
}

function emit(level: Level, scope: string, message: string, fields?: Record<string, unknown>) {
  if (ORDER[level] < threshold()) return
  const sink = level === 'error' || level === 'warn' ? process.stderr : process.stdout

  if (format() === 'pretty') {
    sink.write(`${prettyLine(level, scope, message, fields)}\n`)
    return
  }

  const line = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg: message,
    ...(fields ?? {}),
  }
  sink.write(`${JSON.stringify(line)}\n`)
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
  child(scope: string): Logger
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, f) => emit('debug', scope, m, f),
    info: (m, f) => emit('info', scope, m, f),
    warn: (m, f) => emit('warn', scope, m, f),
    error: (m, f) => emit('error', scope, m, f),
    child: (sub: string) => createLogger(`${scope}:${sub}`),
  }
}

/** Never let a caught value reach a log line as `[object Object]`. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return typeof err === 'string' ? err : JSON.stringify(err)
}
