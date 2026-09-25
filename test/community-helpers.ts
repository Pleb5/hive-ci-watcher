import {finalizeEvent, getPublicKey, matchFilter, type Filter, type NostrEvent} from 'nostr-tools'
import type {AuthorityTransport} from '../src/community/transport.js'

export const secret = (n: number) => Uint8Array.from([...Array(31).fill(0), n])
export const OWNER = getPublicKey(secret(1))
export const MOD = getPublicKey(secret(2))
export const MEMBER = getPublicKey(secret(3))
export const OTHER = getPublicKey(secret(4))
export const COMMUNITY = 'a'.repeat(64)
export const ADDRESS = `32222:${OWNER}:${COMMUNITY}`
export const LIST = `30000:${MOD}:${COMMUNITY}-general`
export const RELAY = 'wss://relay.example'

export function event(kind: number, tags: string[][], n = 1, time = 1000, content = ''): NostrEvent {
  return JSON.parse(JSON.stringify(finalizeEvent({kind, tags, created_at: time, content}, secret(n))))
}
export function definition(time = 1000, owner = 1, id = COMMUNITY, refs = [LIST]) {
  return event(32222, [['d', id], ['name', 'Community'], ['r', RELAY], ['content', 'General'], ['k', '1111'],
    ...refs.map(address => ['a', address])], owner, time)
}
export const list = (members = [MEMBER], time = 1000, declined = false) => event(30000,
  [['d', `${COMMUNITY}-general`], ...members.map(member => ['p', member]), ...(declined ? [['status', 'declined']] : [])], 2, time)
export const ban = (target = MEMBER, time = 1001) => event(1984,
  [['h', COMMUNITY], ['a', ADDRESS, '', 'community'], ['p', target, 'spam']], 1, time)
export const retract = (report: NostrEvent) => event(5,
  [['h', COMMUNITY], ['e', report.id, '', report.pubkey, 'report'], ['k', '1984']], 1, report.created_at + 1)

export class MemoryTransport implements AuthorityTransport {
  events: NostrEvent[] = []
  fail = false
  failedRelays = new Set<string>()
  queries: Filter[] = []
  private listeners: Array<{filters: Filter[]; receive: (event: NostrEvent) => void}> = []
  async query(relays: string[], filter: Filter, signal: AbortSignal) {
    this.queries.push(filter)
    if (signal.aborted || this.fail || relays.every(url => this.failedRelays.has(url))) throw new Error('offline')
    return this.events.filter(event => matchFilter(filter, event))
  }
  subscribe(_relays: string[], filters: Filter[], receive: (event: NostrEvent) => void) {
    const listener = {filters, receive}
    this.listeners.push(listener)
    return () => { this.listeners = this.listeners.filter(item => item !== listener) }
  }
  emit(event: NostrEvent) {
    this.events.push(event)
    for (const listener of [...this.listeners]) if (listener.filters.some(filter => matchFilter(filter, event))) listener.receive(event)
  }
}
