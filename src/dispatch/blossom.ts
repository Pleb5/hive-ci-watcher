import {createHash} from 'node:crypto'
import {Actions, createUploadAuth} from 'blossom-client-sdk'
import type {WatcherIdentity} from '../identity.js'
import type {WatcherDb} from '../db/index.js'
import {createLogger, errorMessage} from '../log.js'

const log = createLogger('blossom')

const CACHED_URL_KEY = 'runner_script_url'

export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function blobUrl(server: string, hash: string): string {
  return `${server.replace(/\/+$/, '')}/${hash}`
}

async function serverHasBlob(server: string, hash: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(blobUrl(server, hash), {method: 'HEAD', signal: controller.signal})
    return response.status === 200
  } catch (err) {
    log.debug('blob HEAD failed', {server, error: errorMessage(err)})
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resolves the runner script's Blossom URL.
 *
 * The script is a static template, so its sha256 is identical across every run
 * and every repo. The hash is computed once and probed with a conditional
 * `HEAD` — cached server first, then the rest in order — and a 200 means reuse
 * the URL and skip the upload entirely. Only when no server holds the blob do
 * we upload, signing the 24242 auth with the watcher key.
 *
 * The winning URL is cached in `kv`, but the `HEAD` still runs every dispatch:
 * servers garbage-collect blobs, and a cached URL that 404s at run time fails
 * the job on the runner instead of here, where it is recoverable.
 *
 * Practically this means one upload per script version, ever; the steady-state
 * cost of a dispatch is a single conditional `HEAD`.
 */
export async function resolveRunnerScriptUrl(args: {
  db: WatcherDb
  identity: WatcherIdentity
  servers: string[]
  script: string
  timeoutMs?: number
}): Promise<string> {
  const {db, identity, servers, script} = args
  const timeoutMs = args.timeoutMs ?? 10_000
  const hash = sha256Hex(script)

  const cached = db.getKv(CACHED_URL_KEY)
  const cachedServer = cached && cached.endsWith(`/${hash}`) ? cached.slice(0, -(hash.length + 1)) : null

  const ordered = cachedServer
    ? [cachedServer, ...servers.filter(server => server.replace(/\/+$/, '') !== cachedServer)]
    : servers

  for (const server of ordered) {
    if (await serverHasBlob(server, hash, timeoutMs)) {
      const url = blobUrl(server, hash)
      if (url !== cached) db.setKv(CACHED_URL_KEY, url)
      log.debug('runner script already hosted', {server, hash})
      return url
    }
  }

  log.info('uploading runner script', {hash, servers: servers.length})
  const url = await uploadRunnerScript({identity, servers, script})
  db.setKv(CACHED_URL_KEY, url)
  return url
}

async function uploadRunnerScript(args: {
  identity: WatcherIdentity
  servers: string[]
  script: string
}): Promise<string> {
  const signer = async (event: any) => args.identity.sign(event)
  const file = new File([args.script], 'run-workflow.sh', {type: 'text/plain'})

  const errors: string[] = []
  for (const server of args.servers) {
    try {
      const result = await Actions.uploadBlob(server, file, {
        // Force auth from the start: some servers answer the SDK's existence
        // probe with 401, which would short-circuit before `onAuth` ever fires.
        auth: true,
        onAuth: async (_server, sha256, authType) =>
          createUploadAuth(signer, sha256, {type: authType}),
      })
      return result.url
    } catch (err) {
      const message = errorMessage(err)
      errors.push(`${server}: ${message}`)
      log.warn('blossom upload failed', {server, error: message})
    }
  }

  throw new Error(`all Blossom servers failed:\n${errors.join('\n')}`)
}

/** The `args` a loom worker uses to fetch and execute the hosted script. */
export function buildRunnerArgs(url: string): string[] {
  return [
    '-c',
    `curl -fsSL "${url}" -o /tmp/run-workflow.sh && chmod +x /tmp/run-workflow.sh && /tmp/run-workflow.sh`,
  ]
}
