import {BehaviorSubject, type Subscription} from 'rxjs'
import {normalizeUrl, tags} from './community/protocol.js'
import type {CommunityAccess} from './community/service.js'

export const IDENTITY_DISCOVERY_RELAYS = ['wss://purplepag.es']
export const GIT_DISCOVERY_RELAYS = ['wss://index.ngit.dev']
export const SERVICE_DISCOVERY_RELAYS = ['wss://relay.contextvm.org', 'wss://relay2.contextvm.org']

export interface InfrastructureOverrides {
  inbox?: string[]
  outbox?: string[]
  blossom?: string[]
}

export interface InfrastructureSnapshot {
  inbox: string[]
  outbox: string[]
  blossom: string[]
  git: string[]
  sources: Array<{address: string; eventId: string; relays: string[]; blossom: string[]; grasp: string[]}>
  provenance: Record<'inbox' | 'outbox' | 'blossom', 'explicit' | 'community' | 'unresolved'>
}

/** Missing is derivable; explicitly empty never resurrects an ambient fallback. */
export function endpointList(raw: string | undefined, blossom = false): string[] | undefined {
  if (raw === undefined) return undefined
  return [...new Set(raw.split(',').map(v => v.trim()).filter(Boolean).map(value => {
    const url = normalizeUrl(value, blossom ? ['https:', 'http:'] : ['wss:', 'ws:'])
    if (!url) throw new Error(`invalid ${blossom ? 'Blossom' : 'relay'} endpoint: ${value}`)
    return url
  }))]
}

/** Infrastructure can use verified cached definitions, independently of member readiness. */
export class ServiceInfrastructure {
  readonly routes$: BehaviorSubject<InfrastructureSnapshot>
  private readonly subscription: Subscription

  constructor(private readonly overrides: InfrastructureOverrides, private readonly communities: CommunityAccess) {
    this.routes$ = new BehaviorSubject(this.resolve())
    this.subscription = communities.changes.subscribe(() => {
      const next = this.resolve()
      if (JSON.stringify(next) !== JSON.stringify(this.routes$.value)) this.routes$.next(next)
    })
  }

  get current(): InfrastructureSnapshot { return this.routes$.value }

  private resolve(): InfrastructureSnapshot {
    const sources = this.communities.definitions().map(definition => ({
      address: definition.address, eventId: definition.event.id, relays: definition.relays,
      blossom: tags(definition.event, 'blossom').map(t => t[1]!),
      grasp: tags(definition.event, 'grasp').map(t => t[1]!),
    }))
    const relays = [...new Set(sources.flatMap(s => s.relays))]
    const blossom = [...new Set(sources.flatMap(s => s.blossom))]
    const derived = {inbox: relays, outbox: relays, blossom}
    const provenance = {} as InfrastructureSnapshot['provenance']
    for (const role of ['inbox', 'outbox', 'blossom'] as const) {
      provenance[role] = this.overrides[role] !== undefined ? 'explicit' : derived[role].length ? 'community' : 'unresolved'
    }
    return {
      inbox: this.overrides.inbox ?? relays, outbox: this.overrides.outbox ?? relays,
      blossom: this.overrides.blossom ?? blossom,
      git: [...new Set(sources.flatMap(s => [...s.relays, ...s.grasp]))], sources, provenance,
    }
  }

  close(): void { this.subscription.unsubscribe(); this.routes$.complete() }
}
