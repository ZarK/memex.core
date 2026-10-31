import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { createRegistry, defineRead } from '@tjalve/memex-surfaces'
import { helloIdentity } from './identity.mjs'

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const startedAt = new Date().toISOString()

export function greeting(name) {
  return { text: `Hello, ${name || 'Memex'}!`, startedAt, pid: process.pid }
}

export const registry = createRegistry({
  app: helloIdentity().app,
  name: helloIdentity().productName,
  version,
  capabilities: [
    defineRead({
      id: `${helloIdentity().app}.greetings.get`,
      title: 'Get a greeting',
      description: 'Returns a greeting for a name, the time the server started and its process id.',
      input: z.object({ name: z.string().max(80).optional() }),
      output: z.object({ text: z.string(), startedAt: z.string(), pid: z.number() }),
      handler: async ({ name }) => greeting(name),
    }),
  ],
})
