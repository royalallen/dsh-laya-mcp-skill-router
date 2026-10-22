/**
 * Background description optimizer. While no agent turn is running, it asks
 * a model (through the harness's own `ctx.llm` providers) to write a routing
 * card for each skill, tool group and lone tool, checks the card against the
 * source text, and stores it in an overlay file. Source files are only
 * edited when `writeBack` is on.
 */

import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { hashOf, readJson, writeJsonAtomic } from './store.js'
import { tokenize } from './recall.js'

export const CARDS_VERSION = 1
const IDLE_MS = 20000
const RETRY_FAILED_MS = 6 * 60 * 60 * 1000
const SOURCE_CHARS = 6000

/** In-memory card overlay backed by `cards.json`. */
export class CardStore {
  /**
   * @param cacheDir - storage directory.
   */
  constructor(cacheDir) {
    this.file = join(cacheDir, 'cards.json')
    this.cards = new Map()
    this.loaded = false
  }

  async load() {
    const data = await readJson(this.file, undefined)
    if (data?.version === CARDS_VERSION && data.cards && typeof data.cards === 'object') {
      for (const [key, entry] of Object.entries(data.cards)) this.cards.set(key, entry)
    }
    this.loaded = true
    return this
  }

  get(key) {
    return this.cards.get(key)
  }

  set(key, entry) {
    this.cards.set(key, entry)
  }

  async save() {
    await writeJsonAtomic(this.file, { version: CARDS_VERSION, cards: Object.fromEntries(this.cards) })
  }

  /** Map view for catalog builders. */
  get map() {
    return this.cards
  }
}

const SYSTEM_PROMPT = [
  'You write routing cards. A router reads your card to decide whether a skill or tool set is relevant to a user request.',
  'Use only facts present in the SOURCE. Do not invent capabilities, products, or file types the source does not mention.',
  'Reply with one JSON object and nothing else:',
  '{"description": "<=300 chars: what it does and when to use it, concrete nouns and verbs a user would say>",',
  ' "triggers": ["5-10 short example user requests that should select it"],',
  ' "notFor": ["2-5 short requests that sound related but should NOT select it"],',
  ' "category": "<one or two lowercase words, e.g. design, frontend, devops, troubleshooting, data, writing>",',
  ' "group": "<only for a single tool: a short lowercase capability name it shares with related tools, else empty>"}',
].join('\n')

/**
 * Pull the first JSON object out of a model reply.
 * @param text - raw reply, possibly with fences or reasoning around it.
 * @returns the parsed object or undefined.
 */
export function extractJson(text) {
  const cleaned = String(text ?? '').replace(/<think>[\s\S]*?<\/think>/g, '')
  const start = cleaned.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < cleaned.length; i += 1) {
    const ch = cleaned[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1))
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

const strings = (value, max, each) =>
  Array.isArray(value)
    ? value.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim().slice(0, each)).slice(0, max)
    : []

/**
 * Normalize a raw card and check it is grounded in the source: enough of its
 * description words must appear in the source text.
 * @param raw - parsed model output.
 * @param source - source text the card was written from.
 * @param kind - `skill`, `group` or `tool`.
 * @returns `{ card }` or `{ error }`.
 */
export function validateCard(raw, source, kind) {
  if (!raw || typeof raw !== 'object') return { error: 'reply was not a JSON object' }
  const description = typeof raw.description === 'string' ? raw.description.replace(/\s+/g, ' ').trim() : ''
  if (description.length < 20) return { error: 'description too short' }
  const card = {
    description: description.slice(0, 300),
    triggers: strings(raw.triggers, 10, 120),
    notFor: strings(raw.notFor, 5, 120),
    category: typeof raw.category === 'string' ? raw.category.trim().toLowerCase().slice(0, 30) : '',
  }
  if (kind === 'tool' && typeof raw.group === 'string' && raw.group.trim()) card.group = raw.group.trim().toLowerCase().slice(0, 40)
  if (card.triggers.length < 2) return { error: 'fewer than two triggers' }
  const sourceTokens = new Set(tokenize(source))
  const words = [...new Set(tokenize(card.description))]
  const grounded = words.filter((word) => sourceTokens.has(word)).length
  if (words.length > 0 && grounded / words.length < 0.3) {
    return { error: `description is not grounded in the source (${grounded}/${words.length} words found)` }
  }
  return { card }
}

/**
 * Collect the text of a streamed reply.
 * @param stream - async iterable of LLM chunks.
 * @returns the text, or throws on an error finish.
 */
export async function collectText(stream) {
  let text = ''
  for await (const chunk of stream) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    else if (chunk?.type === 'finish' && chunk.reason && chunk.reason.kind !== 'stop' && chunk.reason.kind !== 'end' && chunk.reason.kind !== 'length') {
      if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
        throw new Error(chunk.reason.failure?.message ?? `model call ended with ${chunk.reason.kind}`)
      }
    }
  }
  return text
}

const userMessage = (text) => ({
  id: randomUUID(),
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})
const systemMessage = (text) => ({
  id: randomUUID(),
  role: 'system',
  content: [{ type: 'text', text }],
  source: { kind: 'system-prompt' },
})

/**
 * Replace the `description:` line of a SKILL.md frontmatter, keeping a backup.
 * @param path - skill directory.
 * @param description - new description.
 * @returns whether the file was changed.
 */
export async function writeBackDescription(path, description) {
  const file = join(path, 'SKILL.md')
  const text = await readFile(file, 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!match) return false
  const front = match[1]
  const line = `description: ${JSON.stringify(description)}`
  const nextFront = /^description:.*$/m.test(front) ? front.replace(/^description:.*$/m, line) : `${front}\n${line}`
  if (nextFront === front) return false
  await copyFile(file, `${file}.router-backup`)
  await writeFile(file, text.replace(front, nextFront), 'utf8')
  return true
}

/** Idle-only optimizer loop. */
export class Optimizer {
  /**
   * @param options - `config`, `store` (CardStore), `logger`, `llm` getter, `skills` getter,
   *   `items` (returns current `{ kind, key, item, source }` jobs), `onCards` (called after a save).
   */
  constructor({ config, store, logger, llm, loadSource, items, onCards, fallbackRoute }) {
    this.config = config
    this.fallbackRoute = fallbackRoute
    this.store = store
    this.logger = logger
    this.llm = llm
    this.loadSource = loadSource
    this.items = items
    this.onCards = onCards
    this.activeTurns = new Set()
    this.lastActivity = Date.now()
    this.running = false
    this.abort = undefined
    this.timer = undefined
    this.stopped = false
    this.done = 0
    this.failed = 0
    this.lastError = undefined
  }

  get idle() {
    return this.activeTurns.size === 0 && Date.now() - this.lastActivity >= IDLE_MS
  }

  /** A turn started somewhere; stop any in-flight optimizer call. */
  turnStarted(id) {
    this.activeTurns.add(id)
    this.lastActivity = Date.now()
    this.abort?.abort(new Error('agent turn started'))
  }

  turnEnded(id) {
    this.activeTurns.delete(id)
    this.lastActivity = Date.now()
  }

  start() {
    if (!this.config.optimizer.enabled) return
    const tick = () => {
      if (this.stopped) return
      this.runOnce().catch((error) => this.logger.debug(`[dynamic-router] optimizer pass failed: ${error?.message ?? error}`))
      this.timer = setTimeout(tick, IDLE_MS)
      this.timer.unref?.()
    }
    this.timer = setTimeout(tick, IDLE_MS)
    this.timer.unref?.()
  }

  stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.abort?.abort(new Error('router stopped'))
  }

  /** Jobs whose card is missing or stale, skipping pinned and recently failed ones. */
  pending() {
    const now = Date.now()
    return this.items().filter((job) => {
      const entry = this.store.get(job.key)
      if (!entry) return true
      if (entry.status === 'pinned') return false
      if (entry.sourceHash !== job.hash) return true
      if (entry.status === 'failed' || entry.status === 'rejected') return now - (entry.at ?? 0) > RETRY_FAILED_MS
      return false
    })
  }

  /**
   * The configured provider/model pair, or the route of the latest
   * conversation request when both are left empty.
   * @returns `{ provider, model }` or undefined.
   */
  route() {
    const { provider, model } = this.config.optimizer
    if (provider && model) return { provider, model }
    return this.fallbackRoute?.()
  }

  /** Process jobs one at a time while idle. */
  async runOnce() {
    if (this.running || !this.idle) return
    const llm = this.llm()
    if (!llm || typeof llm.stream !== 'function' || !this.route()) return
    const jobs = this.pending()
    if (jobs.length === 0) return
    this.running = true
    let changed = 0
    try {
      for (const job of jobs) {
        if (this.stopped || !this.idle) break
        const outcome = await this.optimize(llm, job)
        if (outcome === 'aborted') break
        changed += 1
        if (changed % 5 === 0) await this.store.save()
      }
    } finally {
      this.running = false
      if (changed > 0) {
        await this.store.save()
        this.onCards?.()
      }
    }
  }

  async optimize(llm, job) {
    const { maxTokens, writeBack } = this.config.optimizer
    const { provider, model } = this.route()
    const controller = new AbortController()
    this.abort = controller
    let source
    try {
      source = String(await this.loadSource(job, controller.signal)).slice(0, SOURCE_CHARS)
    } catch (error) {
      this.store.set(job.key, { status: 'failed', sourceHash: job.hash, at: Date.now(), error: `source: ${error?.message ?? error}` })
      return 'failed'
    }
    try {
      const prompt = `KIND: ${job.kind}\nNAME: ${job.name}\n\nSOURCE:\n${source}`
      const text = await collectText(
        llm.stream({
          provider,
          model,
          maxTokens,
          messages: [systemMessage(SYSTEM_PROMPT), userMessage(prompt)],
          signal: controller.signal,
        }),
      )
      const result = validateCard(extractJson(text), `${job.name}\n${source}`, job.kind)
      if (result.error) {
        this.failed += 1
        this.store.set(job.key, { status: 'rejected', sourceHash: job.hash, model, at: Date.now(), error: result.error })
        this.logger.debug(`[dynamic-router] card for ${job.key} rejected: ${result.error}`)
        return 'rejected'
      }
      this.store.set(job.key, { status: 'optimized', sourceHash: job.hash, model, at: Date.now(), card: result.card })
      this.done += 1
      if (writeBack && job.kind === 'skill' && job.path) {
        try {
          await writeBackDescription(job.path, result.card.description)
        } catch (error) {
          this.logger.warn(`[dynamic-router] could not write the description back to ${job.path}: ${error?.message ?? error}`)
        }
      }
      return 'optimized'
    } catch (error) {
      if (controller.signal.aborted) return 'aborted'
      this.failed += 1
      this.lastError = error?.message ?? String(error)
      this.store.set(job.key, { status: 'failed', sourceHash: job.hash, model, at: Date.now(), error: this.lastError })
      this.logger.warn(
        `[dynamic-router] optimizer call to ${provider}/${model} failed (${this.lastError}). ` +
          'Pick a working provider and model in the plugin settings (optimizer.provider / optimizer.model), or turn optimizer.enabled off.',
      )
      return 'failed'
    } finally {
      if (this.abort === controller) this.abort = undefined
    }
  }
}

/**
 * Hash identifying the source text a card was written from.
 * @param parts - source parts.
 * @returns hash.
 */
export const sourceHash = (...parts) => hashOf('card-v1', ...parts)
