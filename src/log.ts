type Level = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<Level, number> = {debug: 10, info: 20, warn: 30, error: 40}

function threshold(): number {
  const raw = (process.env.HIVE_CI_WATCHER_LOG_LEVEL || 'info').toLowerCase()
  return ORDER[raw as Level] ?? ORDER.info
}

function emit(level: Level, scope: string, message: string, fields?: Record<string, unknown>) {
  if (ORDER[level] < threshold()) return
  const line = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg: message,
    ...(fields ?? {}),
  }
  const sink = level === 'error' || level === 'warn' ? process.stderr : process.stdout
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
