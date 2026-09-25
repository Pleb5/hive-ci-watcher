import {readFileSync} from 'node:fs'
import {z} from 'zod'
import {communityPointer, normalizeUrl} from './protocol.js'

const schema = z.object({
  communities: z.array(z.object({
    address: z.string().refine(value => !!communityPointer(value), 'expected 32222:<owner-hex>:<community-id>'),
    relays: z.array(z.string().refine(value => !!normalizeUrl(value), 'expected a wss relay URL')).min(1).max(20),
  }).strict()).max(100),
  refreshSeconds: z.number().int().min(5).max(3600).default(60),
  maxAgeSeconds: z.number().int().min(10).max(86400).default(300),
}).strict().refine(value => value.maxAgeSeconds > value.refreshSeconds, 'maxAgeSeconds must exceed refreshSeconds')

export type CommunityConfig = z.infer<typeof schema>
export type CommunitySource = CommunityConfig['communities'][number]

export function parseCommunityConfig(value: unknown): CommunityConfig {
  const config = schema.parse(value)
  const addresses = config.communities.map(source => source.address)
  if (new Set(addresses).size !== addresses.length) throw new Error('duplicate community address')
  return {...config, communities: config.communities.map(source => ({
    ...source, relays: [...new Set(source.relays.map(relay => normalizeUrl(relay)!))],
  }))}
}

export function loadCommunityConfig(path?: string): CommunityConfig {
  return path ? parseCommunityConfig(JSON.parse(readFileSync(path, 'utf8'))) : parseCommunityConfig({communities: []})
}
