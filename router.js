/**
 * The router: per-agent state, the per-step selection, and the pieces the
 * plugin entry wires into harness hooks.
 */

import { readFile, appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  buildSkillCatalog, buildToolCatalog, catalogDigest, indexText, partitionTools, shortDescription, activeCard,
} from './catalog.js'
import { Bm25, rankItems } from './recall.js'
import { askAll, buildState, unionMerge } from './laya.js'
import { buildQuery, isUserInput, messageText, readHistory, toolsCalledInRecentTurns } from './history.js'
import { filterAssembly, hiddenToolReason, stickySet, toolsForGroups } from './filter.js'
import { chooseAutoLoad, chooseSkills, renderDirectory, renderHint, renderSkillContent } from './skills.js'
import { requestMoreDescription } from './tools.js'
import { estimateTokens, hashOf } from './store.js'
import { sourceHash } from './optimize.js'

export const HINT_CONTEXT = 'dynamic-router:skills'
const STATS_TURNS = 50
const MISS_LIMIT = 200

let hostCreateUserMessage
try {
  ;({ createUserMessage: hostCreateUserMessage } = await import('@deepseek-ai/dsh-llm'))
} catch {
  hostCreateUserMessage = undefined
}

/**
 * A frozen user-role message, through dsh-llm when it resolves.
 * @param input - `content` and `source`.
 * @returns the message.
 */
export function userMessage(input) {
  if (hostCreateUserMessage) return hostCreateUserMessage(input)
  return Object.freeze({ ...structuredClone(input), role: 'user', id: randomUUID() })
}

const readHeadings = async (path) => {
  try {
    const text = await readFile(join(path, 'SKILL.md'), 'utf8')
    return text
      .split(/\r?\n/)
      .filter((line) => /^#{1,3}\s+\S/.test(line))
      .map((line) => line.replace(/^#+\s+/, '').trim())
      .slice(0, 30)
  } catch {
    return []
  }
}

/** Router state and behavior. Harness services are passed in, so tests can fake them. */
export class Router {
  /**
   * @param options - `config`, `logger`, `cards` (CardStore), `embeddings` (EmbeddingIndex),
   *   `services()` returning `{ tools, skills, laya, workingDirectory }`.
   */
  constructor({ config, logger, cards, embeddings, services }) {
    this.config = config
    this.logger = logger
    this.cards = cards
    this.embeddings = embeddings
    this.services = services
    this.agents = new WeakMap()
    this.catalog = undefined
    this.headings = new Map()
    this.turnStats = []
    this.misses = []
    this.cardsVersion = 0
    this.missFile = join(config.cacheDir, 'misses.jsonl')
  }

  /** Settings changed: rebuild the catalog and start every conversation's selection fresh. */
  reconfigure() {
    this.catalog = undefined
    this.agents = new WeakMap()
  }

  // ---------------------------------------------------------------- state

  stateOf(agent) {
    let state = this.agents.get(agent)
    if (!state) {
      state = {
        claimed: [],
        claimedTurn: undefined,
        turn: 0,
        active: undefined,
        routable: new Set(),
        groupOf: new Map(),
        pins: new Set(),
        pinTurn: undefined,
        extraSkills: [],
        escalations: 0,
        escalationTurn: undefined,
        cache: undefined,
        suggested: [],
        autoLoad: [],
        autoLoadTurn: undefined,
        hint: '',
        remembered: [],
        loaded: new Set(),
        lastSelection: undefined,
      }
      this.agents.set(agent, state)
    }
    return state
  }

  /** `agent/inbox/claimed`: keep this step's direct user text. */
  noteClaimed(agent, message, turn) {
    if (!agent) return
    const state = this.stateOf(agent)
    if (state.claimedTurn !== turn) {
      state.claimed = []
      state.claimedTurn = turn
    }
    if (isUserInput(message)) {
      const text = messageText(message)
      if (text) state.claimed.push(text)
    }
    if (state.turn !== turn) {
      state.turn = turn
      if (state.pinTurn !== undefined && turn - state.pinTurn > this.config.stickyTurns) state.pins.clear()
      if (state.escalationTurn !== turn) {
        state.escalations = 0
        state.escalationTurn = turn
      }
      state.extraSkills = []
    }
  }

  // ---------------------------------------------------------------- catalog

  /**
   * Build or reuse the catalog for these tool schemas, sections and skills.
   * @returns the catalog with BM25 indexes and the digest.
   */
  catalogFor(tools, sections, skillSummaries) {
    const { core, routable } = partitionTools(tools, this.config)
    const key = hashOf(
      this.cardsVersion,
      ...routable.map((tool) => `${tool.name}:${tool.description ?? ''}`),
      ...(sections ?? []).filter((s) => s.name.startsWith('mcp:')).map((s) => `${s.name}:${s.text?.length ?? 0}`),
      ...(skillSummaries ?? []).map((s) => `${s.name}:${s.description ?? ''}:${s.whenToUse ?? ''}`),
    )
    if (this.catalog?.key === key) return this.catalog
    const cardMap = this.cards?.map
    const { groups, groupOf, tools: toolItems } = buildToolCatalog(routable, sections, this.config, cardMap)
    const skills = buildSkillCatalog(skillSummaries, this.config, cardMap, this.headings)
    const groupDocs = [...groups.values()].map((group) => ({ id: group.id, text: indexText(group, toolItems) }))
    const toolDocs = [...toolItems.values()].map((tool) => ({ id: tool.id, text: indexText(tool) }))
    const skillDocs = [...skills.values()].map((skill) => ({ id: skill.id, text: indexText(skill) }))
    const catalog = {
      key,
      core: new Set(core.map((tool) => tool.name)),
      routable: new Set(routable.map((tool) => tool.name)),
      groups,
      groupOf,
      tools: toolItems,
      skills,
      groupDocs,
      toolDocs,
      skillDocs,
      groupBm25: new Bm25(groupDocs),
      toolBm25: new Bm25(toolDocs),
      skillBm25: new Bm25(skillDocs),
      digest: catalogDigest([...groups.values(), ...skills.values()]),
    }
    this.catalog = catalog
    this.reindex(catalog).catch((error) => this.logger.debug(`[dynamic-router] reindex failed: ${error?.message ?? error}`))
    return catalog
  }

  /** Embed new item text and read skill headings, in the background. */
  async reindex(catalog) {
    let headingsChanged = false
    for (const skill of catalog.skills.values()) {
      if (!skill.path) continue
      const known = this.headings.get(skill.name)
      if (known?.hash === skill.hash) continue
      const headings = await readHeadings(skill.path)
      this.headings.set(skill.name, { hash: skill.hash, headings })
      if (headings.length > 0) headingsChanged = true
    }
    if (headingsChanged && this.catalog === catalog) {
      for (const skill of catalog.skills.values()) skill.headings = this.headings.get(skill.name)?.headings ?? []
      catalog.skillDocs = [...catalog.skills.values()].map((skill) => ({ id: skill.id, text: indexText(skill) }))
      catalog.skillBm25 = new Bm25(catalog.skillDocs)
    }
    if (this.embeddings?.enabled) {
      await this.embeddings.ensure([...catalog.groupDocs, ...catalog.toolDocs, ...catalog.skillDocs].map((doc) => doc.text))
    }
  }

  /** Called after the optimizer saves cards, so the next step rebuilds with them. */
  cardsChanged() {
    this.cardsVersion += 1
  }

  /** Optimizer jobs for every current item. */
  optimizerJobs() {
    const catalog = this.catalog
    if (!catalog) return []
    const jobs = []
    for (const skill of catalog.skills.values()) {
      jobs.push({ kind: 'skill', key: `skill:${skill.name}`, name: skill.name, path: skill.path, hash: sourceHash(skill.hash), item: skill })
    }
    for (const group of catalog.groups.values()) {
      if (group.source === 'single' || group.source === 'router') continue
      jobs.push({ kind: 'group', key: `group:${group.id}`, name: group.label, hash: sourceHash(group.hash), item: group })
    }
    for (const group of catalog.groups.values()) {
      if (group.source !== 'single' && group.source !== 'prefix') continue
      for (const name of group.tools) {
        const tool = catalog.tools.get(name)
        jobs.push({ kind: 'tool', key: `tool:${name}`, name, hash: sourceHash(tool.hash), item: tool })
      }
    }
    return jobs
  }

  /** Source text for one optimizer job. */
  async optimizerSource(job, signal) {
    const { skills } = this.services()
    if (job.kind === 'skill') {
      let body = ''
      if (skills?.get) {
        try {
          const skill = await skills.get(job.name, { signal })
          body = skill?.content ?? ''
        } catch {
          body = ''
        }
      }
      if (!body && job.path) body = await readFile(join(job.path, 'SKILL.md'), 'utf8').catch(() => '')
      return [`Description: ${job.item.description}`, job.item.whenToUse ? `When to use: ${job.item.whenToUse}` : '', body].filter(Boolean).join('\n\n')
    }
    if (job.kind === 'group') {
      const lines = [job.item.description, '', 'Tools:']
      for (const name of job.item.tools) {
        const tool = this.catalog?.tools.get(name)
        lines.push(`- ${name}: ${tool?.description ?? ''} (params: ${tool?.params.join(', ') ?? ''})`)
      }
      return lines.join('\n')
    }
    return `${job.item.name}: ${job.item.description}\nParameters: ${job.item.params.join(', ')}`
  }

  // ---------------------------------------------------------------- selection

  /**
   * Rank and ask Laya. Pure with respect to agent state.
   * @param catalog - current catalog.
   * @param query - from buildQuery.
   * @param signal - abort signal.
   * @returns the selection details.
   */
  async rank(catalog, query, signal) {
    const started = Date.now()
    const queryVector = this.embeddings?.healthy && query.text ? await this.embeddings.query(query.text, signal) : undefined
    const groupRanked = rankItems({ items: catalog.groupDocs, bm25: catalog.groupBm25, query: query.text, queryVector, embeddings: this.embeddings })
    const toolRanked = rankItems({ items: catalog.toolDocs, bm25: catalog.toolBm25, query: query.text, queryVector, embeddings: this.embeddings })
    const skillRanked = rankItems({ items: catalog.skillDocs, bm25: catalog.skillBm25, query: query.text, queryVector, embeddings: this.embeddings })

    const { laya } = this.services()
    const useLaya = this.config.selector === 'laya' && laya
    const askGroups = groupRanked.slice(0, this.config.indexGroups).map((entry) => catalog.groups.get(entry.id))
    const askSkills = [...catalog.skills.values()]
    const layaResult = useLaya && query.current
      ? await askAll(laya, buildState(query), [...askSkills, ...askGroups], {
        batchSize: this.config.layaBatchSize,
        timeoutMs: this.config.selectorTimeoutMs,
        signal,
      })
      : { probs: new Map(), latencyMs: 0, failed: this.config.selector === 'laya', error: useLaya ? 'empty query' : 'laya not used' }
    const layaOk = Boolean(useLaya) && !layaResult.failed

    const groupMerged = unionMerge({
      ranked: groupRanked, kind: 'group', probs: layaResult.probs, threshold: this.config.groupKeep,
      floor: this.config.keepTop, layaOk, fallbackCount: Math.max(this.config.keepTop, 3),
    })
    const skillMerged = unionMerge({
      ranked: skillRanked, kind: 'skill', probs: layaResult.probs, threshold: this.config.skillKeep,
      floor: this.config.skillKeepTop, layaOk, fallbackCount: Math.max(this.config.skillKeepTop, 5),
    })
    const toolRank = new Map(toolRanked.map((entry) => [entry.id, entry.rank]))
    return {
      groupRanked, skillRanked, toolRank, groupMerged, skillMerged,
      laya: { ok: layaOk, latencyMs: layaResult.latencyMs, error: layaResult.error, truncated: layaResult.truncated },
      embeddings: Boolean(queryVector),
      latencyMs: Date.now() - started,
    }
  }

  /**
   * Full per-step selection for an agent; cached per query within a turn.
   * @returns the selection, or undefined when routing is off for this request.
   */
  async select(agent, assembly, signal) {
    const state = this.stateOf(agent)
    const skillSummaries = await this.skillSnapshot(agent, signal)
    const catalog = this.catalogFor(assembly.tools, assembly.sections, skillSummaries)
    const history = readHistory(agent.session, { turns: this.config.historyTurns })
    const query = buildQuery(state.claimedTurn === state.turn ? state.claimed : [], history, this.config.historyTurns)
    state.loaded = history.loadedSkills

    const cacheKey = hashOf(catalog.key, query.current, ...query.earlier, [...state.pins].sort().join(','), state.extraSkills.join(','))
    const cached = state.cache?.key === cacheKey
    const ranked = cached ? state.cache.ranked : await this.rank(catalog, query, signal)
    if (!cached) state.cache = { key: cacheKey, ranked }
    return { catalog, query, ranked, history, cached }
  }

  async skillSnapshot(agent, signal) {
    const { skills, workingDirectory } = this.services()
    if (!skills?.snapshot) return []
    try {
      const cwd = workingDirectory?.ensure ? await workingDirectory.ensure(agent, signal) : undefined
      const snapshot = await skills.snapshot({ ...(cwd ? { cwd } : {}), signal, scope: agent })
      return snapshot?.skills ?? []
    } catch (error) {
      this.logger.debug(`[dynamic-router] skill snapshot failed: ${error?.message ?? error}`)
      return []
    }
  }

  // ---------------------------------------------------------------- hooks

  /**
   * `system-prompt/assemble` listener body, run on the post-waterfall assembly.
   * @param assembled - assembly returned by `next()`.
   * @param context - assemble context (`agent`, `signal`).
   * @returns the filtered assembly.
   */
  async onAssemble(assembled, context) {
    const agent = context?.agent
    if (!agent || !Array.isArray(assembled?.tools)) return assembled
    const signal = context.signal
    const state = this.stateOf(agent)
    const route = agent.session?.requestHeader?.()?.config
    if (route?.provider && route?.model) this.lastRoute = { provider: route.provider, model: route.model }
    let selection
    try {
      selection = await this.select(agent, assembled, signal)
    } catch (error) {
      if (signal?.aborted) throw error
      this.logger.warn(`[dynamic-router] selection failed (${error?.message ?? error}); sending every tool this step.`)
      return assembled
    }
    const { catalog, ranked, history, query } = selection
    const ptc = assembled.tools.some((tool) => tool.name === 'run_code')

    // Tools
    const groupIds = ranked.groupMerged.map((entry) => entry.id)
    const selectedTools = toolsForGroups({
      groupIds, groups: catalog.groups, toolRank: ranked.toolRank,
      maxTools: this.config.maxTools, maxToolsPerGroup: this.config.maxToolsPerGroup,
    })
    const desired = new Set([...selectedTools, ...[...state.pins].filter((name) => catalog.routable.has(name))])
    const recent = toolsCalledInRecentTurns(agent.session, this.config.stickyTurns)
    const keep = new Set([...recent].filter((name) => catalog.routable.has(name)))
    const previous = state.active ? new Set([...state.active].filter((name) => catalog.routable.has(name))) : undefined
    const sticky = stickySet({ previous, desired, keep }, this.config.minChange)
    state.active = sticky.active
    state.routable = catalog.routable
    state.groupOf = catalog.groupOf

    // Skills
    const suggestedNames = chooseSkills({
      merged: ranked.skillMerged, skills: catalog.skills, config: this.config,
      remembered: state.remembered.filter((entry) => state.turn - entry.turn <= this.config.stickyTurns).map((entry) => entry.name),
      extra: state.extraSkills,
    })
    const autoLoad = state.autoLoadDoneTurn === state.turn
      ? []
      : chooseAutoLoad({ merged: ranked.skillMerged, config: this.config, loaded: history.loadedSkills })
    state.suggested = suggestedNames.map((name) => catalog.skills.get(name))
    state.autoLoad = autoLoad
    state.autoLoadTurn = state.turn
    for (const name of suggestedNames.slice(0, 3)) {
      state.remembered = state.remembered.filter((entry) => entry.name !== name)
      state.remembered.push({ name, turn: state.turn })
    }
    state.remembered = state.remembered.slice(-12)
    state.hint = renderHint({ suggested: state.suggested, loaded: history.loadedSkills, autoLoaded: autoLoad })
    state.lastSelection = { query: query.current, ranked, active: [...sticky.active], skills: suggestedNames, autoLoad }

    // Request-more index lives in its own schema description.
    const index = this.groupIndex(catalog)
    let output = {
      ...assembled,
      tools: assembled.tools.map((tool) => (tool.name === 'request_more' ? { ...tool, description: requestMoreDescription(index) } : tool)),
      contexts: assembled.contexts?.map((entry) => (entry.name === HINT_CONTEXT ? { ...entry, text: state.hint } : entry)),
    }
    if (this.config.optimizer.rewriteToolDescriptions) {
      output.tools = output.tools.map((tool) => {
        const card = catalog.routable.has(tool.name) ? activeCard(this.cards?.map, `tool:${tool.name}`) : undefined
        return card ? { ...tool, description: card.description } : tool
      })
    }
    const filtered = ptc ? output : filterAssembly(output, { routable: catalog.routable, active: sticky.active, groups: catalog.groups })
    this.record(assembled, filtered, selection, sticky, suggestedNames.length)
    if (this.config.apply) return filtered
    state.hint = ''
    return assembled
  }

  /** Group index for the request_more description, stable order. */
  groupIndex(catalog) {
    return [...catalog.groups.values()]
      .filter((group) => group.source !== 'single' || catalog.groups.size <= this.config.indexGroups)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, this.config.indexGroups)
      .map((group) => ({
        id: group.id,
        count: group.tools.length,
        blurb: shortDescription(group, 90),
      }))
  }

  /**
   * `agent/pre-step` listener body after `next()`: swap the full catalog text
   * for the directory and inject auto-loaded skills.
   * @param agent - the agent.
   * @param decision - decision from `next()`.
   * @param signal - abort signal.
   * @returns the rewritten decision.
   */
  async onPreStep(agent, decision, signal) {
    if (!agent || decision?.kind === 'reject' || !Array.isArray(decision?.messages)) return decision
    const state = this.stateOf(agent)
    const catalog = this.catalog
    let messages = decision.messages
    let changed = false

    const index = messages.findIndex((message) => message?.source?.kind === 'skill-catalog' && Array.isArray(message.source.entries))
    if (index >= 0 && this.config.apply) {
      const original = messages[index]
      const items = new Map()
      for (const entry of original.source.entries) {
        const item = catalog?.skills.get(entry.name)
        items.set(entry.name, item ?? { name: entry.name, category: 'general', description: entry.description })
      }
      const text = renderDirectory(items, { cap: this.config.directoryCap, update: original.source.update === true })
      const replacement = userMessage({ content: [{ type: 'text', text }], source: original.source })
      messages = messages.map((message, i) => (i === index ? replacement : message))
      changed = true
      this.lastCatalogSaving = estimateTokens(messageText(original)) - estimateTokens(text)
    }

    if (this.config.apply && state.autoLoadTurn === state.turn && state.autoLoad.length > 0) {
      const { skills, workingDirectory } = this.services()
      const injected = []
      for (const name of state.autoLoad) {
        if (state.loaded.has(name)) continue
        if (messages.some((message) => message?.source?.kind === 'skill-invocation' && message.source.name === name)) continue
        try {
          const cwd = workingDirectory?.ensure ? await workingDirectory.ensure(agent, signal) : undefined
          const skill = await skills?.get?.(name, { ...(cwd ? { cwd } : {}), signal, scope: agent })
          if (!skill || skill.invocation?.modelInvocable === false) continue
          injected.push(userMessage({
            content: [{ type: 'text', text: renderSkillContent(skill) }],
            source: { kind: 'skill-invocation', name, form: 'instructions' },
          }))
          state.loaded.add(name)
        } catch (error) {
          if (signal?.aborted) throw error
          this.logger.debug(`[dynamic-router] auto-load of ${name} failed: ${error?.message ?? error}`)
        }
      }
      state.autoLoad = []
      state.autoLoadDoneTurn = state.turn
      if (injected.length > 0) {
        messages = [...messages, ...injected]
        changed = true
      }
    }
    return changed ? { ...decision, messages } : decision
  }

  /**
   * Synchronous tool guard: deny routable tools that are not active for this
   * agent, and note `skill` calls for skills that were not suggested.
   * @param exec - tool execution (`name`, `agent`, `arguments`, `parent`).
   * @returns a denial reason, or undefined.
   */
  guard(exec) {
    const agent = exec?.agent
    if (!agent || exec.parent !== undefined) return undefined
    const state = this.agents.get(agent)
    if (!state) return undefined
    if (exec.name === 'skill') {
      const name = exec.arguments?.name
      if (typeof name === 'string' && !state.suggested.some((item) => item?.name === name) && !state.loaded.has(name)) {
        this.noteMiss({ type: 'skill', name, query: state.lastSelection?.query ?? '' })
      }
      return undefined
    }
    if (!this.config.apply || !state.active || !state.routable.has(exec.name) || state.active.has(exec.name)) return undefined
    this.noteMiss({ type: 'tool', name: exec.name, query: state.lastSelection?.query ?? '' })
    return hiddenToolReason(exec.name, state.groupOf.get(exec.name))
  }

  noteMiss(miss) {
    const entry = { ...miss, at: new Date().toISOString() }
    this.misses.push(entry)
    if (this.misses.length > MISS_LIMIT) this.misses.splice(0, this.misses.length - MISS_LIMIT)
    mkdir(this.config.cacheDir, { recursive: true })
      .then(() => appendFile(this.missFile, `${JSON.stringify(entry)}\n`, 'utf8'))
      .catch(() => {})
  }

  hintFor(agent) {
    return agent ? this.agents.get(agent)?.hint ?? '' : ''
  }

  // ---------------------------------------------------------------- tools

  /**
   * `request_more`: pin tools or groups for the next steps, or search skills.
   * @returns the tool output `{ text, data }`.
   */
  async requestMore(agent, args, signal) {
    if (!agent) return { text: 'request_more only works inside an agent turn.' }
    const state = this.stateOf(agent)
    const catalog = this.catalog
    if (!catalog) return { text: 'The router has not indexed any tools yet; every tool is already available.' }
    if (state.escalationTurn !== state.turn) {
      state.escalations = 0
      state.escalationTurn = state.turn
    }
    if (state.escalations >= this.config.maxEscalations) {
      return {
        text: `request_more was already used ${state.escalations} times this turn (limit ${this.config.maxEscalations}). ` +
          'Continue with the tools you have, or tell the user what is missing.',
      }
    }
    state.escalations += 1
    const lines = []
    const data = {}

    const names = new Set()
    if (typeof args.group === 'string' && args.group) {
      const group = catalog.groups.get(args.group) ?? [...catalog.groups.values()].find((g) => g.label === args.group)
      if (group) for (const name of group.tools) names.add(name)
      else lines.push(`Unknown group "${args.group}". Known groups: ${[...catalog.groups.keys()].slice(0, 40).join(', ')}.`)
    }
    for (const name of args.tools ?? []) {
      if (catalog.routable.has(name)) names.add(name)
      else if (catalog.core.has(name)) lines.push(`${name} is always available.`)
      else lines.push(`Unknown tool "${name}".`)
    }
    if (names.size > 0) {
      for (const name of names) state.pins.add(name)
      state.pinTurn = state.turn
      state.active = new Set([...(state.active ?? []), ...names])
      lines.unshift(`Loaded ${names.size} tool${names.size === 1 ? '' : 's'}: ${[...names].join(', ')}. They are callable from your next step.`)
      data.tools = [...names]
    }

    if (typeof args.skills === 'string' && args.skills.trim()) {
      const query = { current: args.skills.trim(), earlier: [], lastReply: '', recentTools: [], text: args.skills.trim() }
      const ranked = await this.rank(catalog, query, signal)
      const top = ranked.skillMerged.length > 0 ? ranked.skillMerged.slice(0, 8) : ranked.skillRanked.slice(0, 5)
      const found = top.map((entry) => catalog.skills.get(entry.id)).filter(Boolean)
      if (found.length === 0) lines.push('No installed skill matches that description.')
      else {
        lines.push('Matching skills (load one with the `skill` tool):')
        for (const item of found) lines.push(`- \`${item.name}\`: ${shortDescription(item, 240)}`)
        state.extraSkills = [...new Set([...state.extraSkills, ...found.slice(0, 3).map((item) => item.name)])]
      }
      data.skills = found.map((item) => item.name)
    }
    if (lines.length === 0) lines.push('Pass "group", "tools", or "skills".')
    return { text: lines.join('\n'), data }
  }

  /** `router_preview`. */
  async preview(agent, request, signal) {
    const catalog = this.catalog
    if (!catalog) return { text: 'Nothing indexed yet. Send one message first so the router sees the tool list.' }
    const query = { current: request, earlier: [], lastReply: '', recentTools: [], text: request }
    const ranked = await this.rank(catalog, query, signal)
    const tools = toolsForGroups({
      groupIds: ranked.groupMerged.map((entry) => entry.id), groups: catalog.groups, toolRank: ranked.toolRank,
      maxTools: this.config.maxTools, maxToolsPerGroup: this.config.maxToolsPerGroup,
    })
    const skills = chooseSkills({ merged: ranked.skillMerged, skills: catalog.skills, config: this.config })
    const autoLoad = chooseAutoLoad({ merged: ranked.skillMerged, config: this.config, loaded: new Set() })
    const fmt = (entry) => `${entry.id} (p=${entry.p === undefined ? '-' : entry.p.toFixed(2)}, rank=${entry.rank + 1}, ${entry.reason})`
    const text = [
      `Laya: ${ranked.laya.ok ? `ok, ${ranked.laya.latencyMs} ms` : `not used (${ranked.laya.error ?? 'off'})`} · embeddings: ${ranked.embeddings ? 'on' : 'off (BM25 only)'}`,
      `Groups: ${ranked.groupMerged.map(fmt).join('; ') || 'none'}`,
      `Tools sent: ${[...catalog.core].join(', ')}${tools.length ? `, ${tools.join(', ')}` : ''}`,
      `Skills suggested: ${skills.join(', ') || 'none'}`,
      `Skills auto-loaded: ${autoLoad.join(', ') || 'none'}`,
      `Top skill scores: ${ranked.skillMerged.slice(0, 10).map(fmt).join('; ') || 'none'}`,
    ].join('\n')
    return { text, data: { groups: ranked.groupMerged, tools, skills, autoLoad } }
  }

  /** `router_stats`. */
  stats() {
    const turns = this.turnStats
    const n = turns.length
    const sum = (key) => turns.reduce((total, turn) => total + (turn[key] ?? 0), 0)
    const layaTurns = turns.filter((turn) => turn.layaMs !== undefined)
    const misses = this.misses.slice(-15)
    const lines = [
      `Steps recorded: ${n}`,
      n ? `Tool schema tokens: ${sum('fullTokens')} full → ${sum('sentTokens')} sent (saved ~${sum('fullTokens') - sum('sentTokens')})` : '',
      this.lastCatalogSaving !== undefined ? `Skill catalog: last rewrite saved ~${this.lastCatalogSaving} tokens` : '',
      layaTurns.length ? `Laya: avg ${Math.round(layaTurns.reduce((t, x) => t + x.layaMs, 0) / layaTurns.length)} ms, failures ${turns.filter((t) => t.layaFailed).length}` : 'Laya: not used yet',
      `Embeddings: ${this.embeddings?.enabled ? (this.embeddings.healthy ? 'healthy' : `failing (${this.embeddings.lastError})`) : 'off'}`,
      misses.length ? `Recent misses (loaded or called without being selected):\n${misses.map((m) => `- ${m.type} ${m.name} for "${String(m.query).slice(0, 80)}"`).join('\n')}` : 'No misses recorded.',
    ].filter(Boolean)
    return { text: lines.join('\n'), data: { turns: turns.slice(-10), misses } }
  }

  /** `router_cards`. */
  cardsReport(key) {
    const store = this.cards
    if (!store) return { text: 'The optimizer is off; no cards.' }
    if (key) {
      const entry = store.get(key)
      return entry ? { text: JSON.stringify(entry, null, 2), data: entry } : { text: `No card for ${key}.` }
    }
    const counts = {}
    for (const entry of store.map.values()) counts[entry.status] = (counts[entry.status] ?? 0) + 1
    const keys = [...store.map.keys()].sort()
    return {
      text: [`Cards: ${Object.entries(counts).map(([status, count]) => `${status} ${count}`).join(', ') || 'none yet'}`, ...keys.slice(0, 200).map((k) => `- ${k} (${store.get(k).status})`)].join('\n'),
      data: counts,
    }
  }

  record(full, sent, selection, sticky, skillCount) {
    const entry = {
      at: Date.now(),
      fullTokens: estimateTokens(full.tools),
      sentTokens: estimateTokens(sent.tools),
      toolsFull: full.tools.length,
      toolsSent: sent.tools.length,
      changed: sticky.changed,
      layaMs: selection.ranked.laya.ok ? selection.ranked.laya.latencyMs : undefined,
      layaFailed: this.config.selector === 'laya' && !selection.ranked.laya.ok,
      cached: selection.cached,
    }
    this.turnStats.push(entry)
    if (this.turnStats.length > STATS_TURNS) this.turnStats.shift()
    this.logger.info(
      `[dynamic-router] ${this.config.apply ? '' : '(dry run) '}tools ${entry.toolsSent}/${entry.toolsFull} ` +
        `(~${entry.fullTokens - entry.sentTokens} tokens saved)${sticky.changed ? '' : ' unchanged'} · ` +
        `skills ${skillCount}/${selection.catalog.skills.size} suggested · ` +
        `${selection.ranked.laya.ok ? `laya ${selection.ranked.laya.latencyMs} ms` : `laya off (${selection.ranked.laya.error ?? 'n/a'})`}`,
    )
  }
}
