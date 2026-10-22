import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../config.js'
import { Router } from '../router.js'

export const tempDir = () => mkdtempSync(join(tmpdir(), 'dsh-router-test-'))

export const quietLogger = () => {
  const lines = []
  return { lines, warn: (m) => lines.push(['warn', m]), info: (m) => lines.push(['info', m]), debug: () => {} }
}

export const tool = (name, description = `${name} tool`, properties = {}) => ({
  name,
  description,
  parameters: { type: 'object', properties },
})

export const skill = (name, description, extra = {}) => ({
  name,
  description,
  provider: 'test',
  invocation: { modelInvocable: true, userInvocable: true },
  ...extra,
})

export const userMsg = (text) => ({
  id: `u-${Math.random()}`,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})

/** Minimal in-memory session with the `seq` / `eventAt` surface the router reads. */
export class FakeSession {
  constructor() {
    this.events = []
  }
  get seq() {
    return this.events.length
  }
  eventAt(index) {
    return this.events[index]
  }
  push(type, data) {
    this.events.push({ type, seq: this.events.length, data })
  }
  user(text) {
    this.push('user/message', userMsg(text))
  }
  assistant(text, calls = []) {
    this.push('assistant/message', {
      message: {
        role: 'assistant',
        content: [
          ...(text ? [{ type: 'text', text }] : []),
          ...calls.map((call) => ({ type: 'tool-call', id: `c-${call.name}`, name: call.name, arguments: JSON.stringify(call.args ?? {}) })),
        ],
      },
    })
  }
}

export const fakeAgent = () => ({ id: `agent-${Math.random()}`, session: new FakeSession() })

/** Laya stub: `decide(question, state)` returns P(true). */
export const fakeLaya = (decide, { delayMs = 0, fail = false } = {}) => {
  const calls = []
  return {
    calls,
    async ask(body) {
      calls.push(body)
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
      if (fail) throw new Error('sidecar down')
      const answers = {}
      for (const [id, question] of Object.entries(body.questions)) {
        answers[id] = { type: 'noul', noul: decide(question, body.state) }
      }
      return { answers }
    },
  }
}

export const fakeSkills = (summaries, bodies = {}) => ({
  async snapshot() {
    return { skills: summaries, complete: true }
  },
  async get(name) {
    const summary = summaries.find((s) => s.name === name)
    return summary ? { ...summary, content: bodies[name] ?? `# ${name}\nBody of ${name}.` } : undefined
  },
})

export function makeRouter({ config = {}, laya, skills = [], bodies } = {}) {
  const resolved = resolveConfig({ embeddingsUrl: '', cacheDir: tempDir(), logLevel: 'silent', ...config })
  const logger = quietLogger()
  const skillService = fakeSkills(skills, bodies)
  const router = new Router({
    config: resolved,
    logger,
    cards: undefined,
    embeddings: undefined,
    services: () => ({ skills: skillService, laya, workingDirectory: undefined }),
  })
  return { router, config: resolved, logger }
}

export const assemblyOf = (tools, sections = []) => ({ sections, contexts: [], tools, variables: {} })
