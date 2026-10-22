/**
 * Builds the router's catalog from what the harness already loaded: tool
 * schemas and prompt sections from the assembly, and skill summaries from
 * `ctx.skills`. Nothing here scans the filesystem or talks to MCP servers.
 */

import { basename, dirname } from 'node:path'
import { globMatch, hashOf } from './store.js'

export const ROUTER_GROUP = 'router'
export const ROUTER_TOOLS = ['router_preview', 'router_stats', 'router_cards', 'router_configure']
const ROUTER_GROUP_DESCRIPTION =
  'Inspect the tool and skill router itself: preview what it would select for a request, ' +
  'show token savings and missed skills, list description cards.'

const MCP_NAME = /^mcp__([A-Za-z0-9_-]+?)__(.+)$/
const GENERIC_FOLDERS = new Set(['skills', '.agents', '.dsh', 'agents', 'lib', 'src', 'node_modules', ''])
const CARD_STATUSES_IN_USE = new Set(['optimized', 'pinned'])

const clip = (text, max) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/**
 * Read an overlay card if it is in use.
 * @param cards - map of key to card entry.
 * @param key - `skill:<name>`, `group:<id>` or `tool:<name>`.
 * @returns the card body, or undefined.
 */
export function activeCard(cards, key) {
  const entry = cards?.get?.(key) ?? cards?.[key]
  if (!entry || !CARD_STATUSES_IN_USE.has(entry.status) || !entry.card) return undefined
  return entry.card
}

/**
 * Parameter names of a JSON-schema tool parameter object.
 * @param parameters - JSON schema.
 * @returns property names.
 */
export function parameterNames(parameters) {
  const props = parameters && typeof parameters === 'object' ? parameters.properties : undefined
  return props && typeof props === 'object' ? Object.keys(props) : []
}

/**
 * Split tool schemas into core (never filtered) and routable.
 * @param tools - assembly tool schemas.
 * @param config - router config.
 * @returns `{ core, routable }` arrays of schemas, original order kept.
 */
export function partitionTools(tools, config) {
  const keep = [...config.coreTools, ...config.alwaysInclude]
  const core = []
  const routable = []
  for (const tool of tools) {
    const setup = tool.name === 'router_configure' && config.setupPending
    if (setup || tool.name === 'run_code' || keep.some((pattern) => globMatch(pattern, tool.name))) core.push(tool)
    else routable.push(tool)
  }
  return { core, routable }
}

/**
 * Group routable tools. First match wins: config groups, MCP server, an
 * optimizer-assigned group, a shared name prefix, then a single-tool group.
 * @param routable - routable tool schemas.
 * @param sections - assembly prompt sections (`{ name, text }`).
 * @param config - router config.
 * @param cards - optimizer card overlay.
 * @returns `{ groups, groupOf, tools }`: groups by id, tool name to group id, tool items by name.
 */
export function buildToolCatalog(routable, sections, config, cards) {
  const sectionText = new Map((sections ?? []).map((section) => [section.name, String(section.text ?? '')]))
  const groups = new Map()
  const groupOf = new Map()
  const tools = new Map()

  const ensureGroup = (id, init) => {
    let group = groups.get(id)
    if (!group) {
      group = { kind: 'group', id, label: id, description: '', tools: [], sections: [], source: 'single', ...init }
      groups.set(id, group)
    }
    return group
  }
  const assign = (name, group) => {
    group.tools.push(name)
    groupOf.set(name, group.id)
  }

  for (const schema of routable) {
    tools.set(schema.name, {
      kind: 'tool',
      id: schema.name,
      name: schema.name,
      description: String(schema.description ?? ''),
      params: parameterNames(schema.parameters),
    })
  }

  const pending = []
  for (const schema of routable) {
    const name = schema.name
    const configured = config.groups.find((group) => group.tools.some((pattern) => globMatch(pattern, name)))
    if (configured) {
      assign(name, ensureGroup(configured.id, {
        description: configured.description ?? '',
        sections: configured.sections ?? [],
        source: 'config',
      }))
      continue
    }
    if (ROUTER_TOOLS.includes(name)) {
      assign(name, ensureGroup(ROUTER_GROUP, { description: ROUTER_GROUP_DESCRIPTION, source: 'router' }))
      continue
    }
    const mcp = MCP_NAME.exec(name)
    if (mcp) {
      const server = mcp[1]
      const sectionName = `mcp:${server}`
      assign(name, ensureGroup(sectionName, {
        label: server,
        description: clip(sectionText.get(sectionName) ?? '', 600),
        sections: sectionText.has(sectionName) ? [sectionName] : [],
        source: 'mcp',
      }))
      continue
    }
    const cardGroup = activeCard(cards, `tool:${name}`)?.group
    if (typeof cardGroup === 'string' && cardGroup.trim() !== '') {
      assign(name, ensureGroup(`card:${cardGroup.trim()}`, { label: cardGroup.trim(), source: 'card' }))
      continue
    }
    pending.push(name)
  }

  const prefixOf = (name) => {
    const token = name.split(/[_\-.]/)[0]
    return token.length >= 2 && token !== name ? token : undefined
  }
  const prefixCounts = new Map()
  for (const name of pending) {
    const prefix = prefixOf(name)
    if (prefix) prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1)
  }
  for (const name of pending) {
    const prefix = prefixOf(name)
    if (prefix && prefixCounts.get(prefix) >= 2) {
      assign(name, ensureGroup(`prefix:${prefix}`, { label: prefix, source: 'prefix' }))
    } else {
      assign(name, ensureGroup(`tool:${name}`, { label: name, source: 'single' }))
    }
  }

  for (const group of groups.values()) {
    const card = activeCard(cards, `group:${group.id}`)
    if (card) group.card = card
    if (!group.description) {
      group.description = clip(group.tools.map((tool) => tools.get(tool)?.description ?? '').join(' '), 600)
    }
    group.hash = hashOf(group.id, group.description, ...group.tools.map((tool) => `${tool}:${tools.get(tool)?.description ?? ''}`))
  }
  for (const tool of tools.values()) {
    tool.hash = hashOf(tool.name, tool.description, tool.params.join(','))
    const card = activeCard(cards, `tool:${tool.name}`)
    if (card) tool.card = card
  }
  return { groups, groupOf, tools }
}

/**
 * Category for one skill. Config wins, then frontmatter, then an optimizer
 * card, then the parent folder name, then `general`.
 * @param summary - skill summary from `ctx.skills`.
 * @param config - router config.
 * @param card - optional optimizer card.
 * @returns a category label.
 */
export function skillCategory(summary, config, card) {
  for (const [category, names] of Object.entries(config.skillCategories ?? {})) {
    if (names.includes(summary.name)) return category
  }
  const fromMeta = summary.metadata?.category
  if (typeof fromMeta === 'string' && fromMeta.trim()) return fromMeta.trim().toLowerCase()
  if (typeof card?.category === 'string' && card.category.trim()) return card.category.trim().toLowerCase()
  const base = summary.resourceBase
  if (base?.kind === 'directory' && typeof base.path === 'string') {
    const parent = basename(dirname(base.path))
    if (!GENERIC_FOLDERS.has(parent.toLowerCase())) return parent.toLowerCase()
  }
  return 'general'
}

/**
 * Skill items for model-invocable skills.
 * @param summaries - `ctx.skills.snapshot().skills`.
 * @param config - router config.
 * @param cards - optimizer card overlay.
 * @param headings - map of skill name to `{ hash, headings }` read at index time.
 * @returns skill items by name, in the snapshot's order.
 */
export function buildSkillCatalog(summaries, config, cards, headings) {
  const skills = new Map()
  for (const summary of summaries ?? []) {
    if (summary?.invocation?.modelInvocable === false) continue
    const card = activeCard(cards, `skill:${summary.name}`)
    const item = {
      kind: 'skill',
      id: summary.name,
      name: summary.name,
      description: String(summary.description ?? ''),
      whenToUse: typeof summary.whenToUse === 'string' ? summary.whenToUse : '',
      provider: summary.provider,
      path: summary.resourceBase?.kind === 'directory' ? summary.resourceBase.path : undefined,
      resourceBase: summary.resourceBase,
      metadata: summary.metadata,
    }
    item.hash = hashOf(item.name, item.description, item.whenToUse, item.provider, item.path)
    const known = headings?.get?.(summary.name)
    item.headings = known && known.hash === item.hash ? known.headings : []
    item.category = skillCategory(summary, config, card)
    if (card) item.card = card
    skills.set(item.name, item)
  }
  return skills
}

/**
 * Text used for embeddings and BM25. Prefers an optimized card when present.
 * @param item - tool, group or skill item.
 * @param tools - tool items, for group member text.
 * @returns index text.
 */
export function indexText(item, tools) {
  const card = item.card
  const parts = [item.label ?? item.name ?? item.id]
  if (card) {
    parts.push(card.description, ...(card.triggers ?? []))
    if (card.category) parts.push(card.category)
  }
  parts.push(item.description)
  if (item.kind === 'skill') {
    parts.push(item.whenToUse, item.category, ...(item.headings ?? []))
  } else if (item.kind === 'group') {
    for (const name of item.tools) {
      const tool = tools?.get(name)
      parts.push(name.replace(/^mcp__[^_]+__/, '').replace(/[_-]+/g, ' '), tool?.card?.description ?? tool?.description ?? '')
    }
  } else if (item.kind === 'tool') {
    parts.push(item.name.replace(/[_-]+/g, ' '), item.params.join(' '))
  }
  return parts.filter(Boolean).join('\n')
}

/**
 * Short description for Laya questions and the skill hint, at most `max` characters.
 * @param item - tool, group or skill item.
 * @param max - character cap.
 * @returns clipped text, card first.
 */
export function shortDescription(item, max = 300) {
  const card = item.card
  if (card?.description) {
    const triggers = (card.triggers ?? []).slice(0, 6).join('; ')
    return clip(triggers ? `${card.description} Typical requests: ${triggers}.` : card.description, max)
  }
  const parts = [item.description]
  if (item.kind === 'skill' && item.whenToUse) parts.push(`When to use: ${item.whenToUse}`)
  if (item.kind === 'group') parts.push(`Tools: ${item.tools.map((t) => t.replace(/^mcp__[^_]+__/, '')).join(', ')}`)
  return clip(parts.filter(Boolean).join(' '), max)
}

/**
 * Digest of the routable surface, used to detect when re-indexing is needed.
 * @param items - iterable of items with `hash`.
 * @returns a short hash.
 */
export function catalogDigest(items) {
  return hashOf(...[...items].map((item) => `${item.kind}:${item.id}:${item.hash}`).sort())
}
