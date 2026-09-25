// Regenerate the checked-in oracle from the same pinned fixture strfry tests use.
import {createHash} from 'node:crypto'
import {mkdir, writeFile} from 'node:fs/promises'
import {URL} from 'node:url'

const revision = 'b574d2b78a98c2e07db4b02fead89da33d252a44'
const url = `https://raw.githubusercontent.com/Pleb5/strfry/${revision}/deploy/budabit/tests/vectors/budabit-policy-vectors.json`
const response = await globalThis.fetch(url)
if (!response.ok) throw new Error(`fixture fetch failed: ${response.status}`)
const raw = await response.text()
const data = JSON.parse(raw)
const fixture = {
  provenance: {url, revision, sha256: createHash('sha256').update(raw).digest('hex'), budabitCommit: data.budabitCommit},
  definitions: data.definitions,
  readers: data.readers,
}
await mkdir(new URL('../test/fixtures/', import.meta.url), {recursive: true})
await writeFile(new URL('../test/fixtures/community-vectors.json', import.meta.url), `${JSON.stringify(fixture, null, 2)}\n`)
