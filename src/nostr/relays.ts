import {normalizeUrl} from '../community/protocol.js'

/**
 * Normalises and validates relay URLs. Relays arrive from the environment, from
 * any repo owner's 30617 and from anyone's kind 10002; a string that is not a
 * usable `ws(s)://` URL is dropped here rather than allowed to throw inside the
 * pool, where one bad entry would take a whole subscription with it.
 */
export function normalizeRelays(urls: Iterable<string | undefined | null>): string[] {
  const out = new Set<string>()
  for (const raw of urls) {
    if (!raw) continue
    const trimmed = raw.trim()
    const url = normalizeUrl(trimmed, ['wss:', 'ws:'])
    // This client has no Tor transport.
    if (url && !new URL(url).hostname.toLowerCase().endsWith('.onion')) out.add(url)
  }
  return [...out].sort()
}
