import {isSafeRelayURL, normalizeRelayUrl} from 'applesauce-core/helpers/relays'

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
    if (!trimmed || !isSafeRelayURL(trimmed)) continue
    try {
      const url = normalizeRelayUrl(trimmed)
      // No Tor transport here; an .onion relay would sit in every relay set
      // as a permanent never-connects entry.
      if (new URL(url).hostname.toLowerCase().endsWith('.onion')) continue
      out.add(url)
    } catch {
      // unparseable — skip
    }
  }
  return [...out].sort()
}
