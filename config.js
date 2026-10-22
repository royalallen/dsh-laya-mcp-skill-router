/**
 * Router configuration: defaults, validation, and the `Config` schema Cordis
 * validates before `apply()` runs. Inside the harness `Config` is a
 * schemastery schema, which is what the settings GUI renders; outside it
 * (tests, the eval script) a Standard Schema validator stands in.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh')

export const DEFAULT_OPTIMIZER = Object.freeze({
  enabled: true,
  provider: '',
  model: '',
  concurrency: 1,
  writeBack: false,
  rewriteToolDescriptions: false,
  maxTokens: 1200,
})

export const DEFAULT_CONFIG = Object.freeze({
  selector: 'laya',
  coreTools: ['bash', 'pwsh', 'read', 'write', 'edit', 'glob', 'grep', 'skill', 'request_more'],
  alwaysInclude: [],
  groups: [],

  maxTools: 12,
  maxToolsPerGroup: 5,
  maxSkills: 8,
  indexGroups: 30,
  directoryCap: 300,

  reindexDebounceMs: 2000,
  cacheDir: '',

  keepTop: 2,
  groupKeep: 0.5,
  skillKeepTop: 3,
  skillKeep: 0.35,
  autoLoadThreshold: 0.85,
  maxAutoLoad: 2,

  historyTurns: 2,
  selectorTimeoutMs: 5000,
  layaBatchSize: 16,

  alwaysSkills: [],
  companions: {},
  skillCategories: {},

  optimizer: DEFAULT_OPTIMIZER,

  stickyTurns: 3,
  minChange: 2,
  maxEscalations: 2,

  embeddingsUrl: 'http://127.0.0.1:11434',
  embeddingModel: 'nomic-embed-text',

  apply: true,
  logLevel: 'info',
})

const LEVELS = ['silent', 'warn', 'info', 'debug']
const SELECTORS = ['laya', 'embeddings', 'bm25']

const POSITIVE_INTS = [
  'maxTools', 'maxToolsPerGroup', 'maxSkills', 'indexGroups', 'directoryCap',
  'selectorTimeoutMs', 'layaBatchSize',
]
const NON_NEGATIVE_INTS = [
  'reindexDebounceMs', 'keepTop', 'skillKeepTop', 'maxAutoLoad', 'historyTurns',
  'stickyTurns', 'minChange', 'maxEscalations',
]
const PROBABILITIES = ['groupKeep', 'skillKeep', 'autoLoadThreshold']
const STRING_ARRAYS = ['coreTools', 'alwaysInclude', 'alwaysSkills']

const issue = (message, path) => ({ issues: [{ message, path }] })
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Merge user config over defaults and check every field.
 * @param value - raw config from the Cordis patch, possibly undefined.
 * @returns `{ value }` or `{ issues }` in Standard Schema shape.
 */
export function validateConfig(value) {
  const input = isPlainObject(value) ? value : {}
  const config = {
    ...DEFAULT_CONFIG,
    ...input,
    optimizer: { ...DEFAULT_OPTIMIZER, ...(isPlainObject(input.optimizer) ? input.optimizer : {}) },
  }
  if (!config.cacheDir) config.cacheDir = join(dshHome(), 'storages', 'dsh-dynamic-router')

  if (!SELECTORS.includes(config.selector)) {
    return issue(`selector must be one of ${SELECTORS.join(', ')}`, ['selector'])
  }
  if (!LEVELS.includes(config.logLevel)) {
    return issue(`logLevel must be one of ${LEVELS.join(', ')}`, ['logLevel'])
  }
  for (const key of POSITIVE_INTS) {
    if (!Number.isInteger(config[key]) || config[key] <= 0) return issue(`${key} must be a positive integer`, [key])
  }
  for (const key of NON_NEGATIVE_INTS) {
    if (!Number.isInteger(config[key]) || config[key] < 0) return issue(`${key} must be a non-negative integer`, [key])
  }
  for (const key of PROBABILITIES) {
    if (typeof config[key] !== 'number' || config[key] < 0 || config[key] > 1) {
      return issue(`${key} must be a number between 0 and 1`, [key])
    }
  }
  for (const key of STRING_ARRAYS) {
    if (!Array.isArray(config[key]) || config[key].some((entry) => typeof entry !== 'string' || entry === '')) {
      return issue(`${key} must be an array of non-empty strings`, [key])
    }
  }
  if (!Array.isArray(config.groups)) return issue('groups must be an array', ['groups'])
  for (const [index, group] of config.groups.entries()) {
    if (!isPlainObject(group) || typeof group.id !== 'string' || group.id === '') {
      return issue('each group needs a non-empty string id', ['groups', index, 'id'])
    }
    if (!Array.isArray(group.tools) || group.tools.some((name) => typeof name !== 'string')) {
      return issue('each group needs a tools array of names or glob patterns', ['groups', index, 'tools'])
    }
    if (group.sections !== undefined && (!Array.isArray(group.sections) || group.sections.some((s) => typeof s !== 'string'))) {
      return issue('group sections must be an array of section names', ['groups', index, 'sections'])
    }
  }
  if (!isPlainObject(config.companions)) return issue('companions must map a skill name to an array of skill names', ['companions'])
  for (const [name, list] of Object.entries(config.companions)) {
    if (!Array.isArray(list) || list.some((entry) => typeof entry !== 'string')) {
      return issue(`companions.${name} must be an array of skill names`, ['companions', name])
    }
  }
  if (!isPlainObject(config.skillCategories)) {
    return issue('skillCategories must map a category to an array of skill names', ['skillCategories'])
  }
  for (const [category, list] of Object.entries(config.skillCategories)) {
    if (!Array.isArray(list) || list.some((entry) => typeof entry !== 'string')) {
      return issue(`skillCategories.${category} must be an array of skill names`, ['skillCategories', category])
    }
  }
  if (typeof config.embeddingsUrl !== 'string') return issue('embeddingsUrl must be a string', ['embeddingsUrl'])
  if (config.embeddingsUrl !== '') {
    try {
      const parsed = new URL(config.embeddingsUrl)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return issue('embeddingsUrl must be an http(s) URL', ['embeddingsUrl'])
      }
    } catch {
      return issue('embeddingsUrl is not a valid URL', ['embeddingsUrl'])
    }
  }
  if (typeof config.embeddingModel !== 'string' || config.embeddingModel === '') {
    return issue('embeddingModel must be a non-empty string', ['embeddingModel'])
  }
  if (typeof config.apply !== 'boolean') return issue('apply must be a boolean', ['apply'])

  const optimizer = config.optimizer
  for (const key of ['enabled', 'writeBack', 'rewriteToolDescriptions']) {
    if (typeof optimizer[key] !== 'boolean') return issue(`optimizer.${key} must be a boolean`, ['optimizer', key])
  }
  for (const key of ['provider', 'model']) {
    if (typeof optimizer[key] !== 'string') return issue(`optimizer.${key} must be a string`, ['optimizer', key])
  }
  if ((optimizer.provider === '') !== (optimizer.model === '')) {
    return issue('optimizer.provider and optimizer.model must be set together, or both left empty', ['optimizer', 'provider'])
  }
  for (const key of ['concurrency', 'maxTokens']) {
    if (!Number.isInteger(optimizer[key]) || optimizer[key] <= 0) {
      return issue(`optimizer.${key} must be a positive integer`, ['optimizer', key])
    }
  }
  return { value: config }
}

let z
try {
  ;({ default: z } = await import('@deepseek-ai/schemastery'))
} catch {
  z = undefined
}

const strings = (value, text) => z.array(z.string()).default([...value]).description(text)

/**
 * The settings-GUI schema. Field defaults mirror DEFAULT_CONFIG; `apply()`
 * runs the result through `resolveConfig` for the cross-field checks.
 * @returns a schemastery object schema.
 */
function buildSchema() {
  const d = DEFAULT_CONFIG
  const o = DEFAULT_OPTIMIZER
  const int = (value, min, text) => z.number().step(1).min(min).default(value).description(text)
  const prob = (value, text) => z.number().min(0).max(1).step(0.01).default(value).description(text)
  return z.object({
    selector: z.union(['laya', 'embeddings', 'bm25']).default(d.selector)
      .description('How skills and tool groups are judged. laya uses the dsh-laya service when mounted and falls back to recall.'),
    coreTools: strings(d.coreTools, 'Tools that are always sent. Names or * patterns.'),
    alwaysInclude: strings(d.alwaysInclude, 'Extra tools that are always sent. Names or * patterns.'),
    groups: z.array(z.object({
      id: z.string().required().description('Group id shown to the model in request_more.'),
      tools: z.array(z.string()).required().description('Tool names or * patterns in this group.'),
      sections: z.array(z.string()).description('Prompt sections dropped when the group is not selected.'),
      description: z.string().description('What the group is for.'),
    })).default([]).description('Explicit tool groups. Checked before MCP-server and name-prefix grouping.'),
    maxTools: int(d.maxTools, 1, 'Most optional tools sent per request.'),
    maxToolsPerGroup: int(d.maxToolsPerGroup, 1, 'Most tools sent from one group.'),
    maxSkills: int(d.maxSkills, 1, 'Most skills suggested per step, not counting alwaysSkills.'),
    indexGroups: int(d.indexGroups, 1, 'Tool groups judged by Laya and listed in request_more.'),
    directoryCap: int(d.directoryCap, 1, 'Most skill names listed in the skill directory.'),
    keepTop: int(d.keepTop, 0, 'Top recall tool groups kept even when Laya says no.'),
    groupKeep: prob(d.groupKeep, 'Laya probability needed to keep a tool group.'),
    skillKeepTop: int(d.skillKeepTop, 0, 'Top recall skills kept even when Laya says no.'),
    skillKeep: prob(d.skillKeep, 'Laya probability needed to suggest a skill.'),
    autoLoadThreshold: prob(d.autoLoadThreshold, 'Laya probability needed to load a skill before the model asks.'),
    maxAutoLoad: int(d.maxAutoLoad, 0, 'Most skills loaded up front per turn. 0 turns auto-loading off.'),
    alwaysSkills: strings(d.alwaysSkills, 'Skills suggested on every step.'),
    companions: z.dict(z.array(z.string())).default({}).description('Skills suggested together: skill name to a list of skill names.'),
    skillCategories: z.dict(z.array(z.string())).default({}).description('Directory categories: category to a list of skill names.'),
    historyTurns: int(d.historyTurns, 0, 'Earlier user requests included in the routing query.'),
    selectorTimeoutMs: int(d.selectorTimeoutMs, 1, 'Time allowed for Laya per step before falling back to recall.'),
    layaBatchSize: int(d.layaBatchSize, 1, 'Questions sent to Laya per call.'),
    stickyTurns: int(d.stickyTurns, 0, 'Turns a called or requested tool stays loaded.'),
    minChange: int(d.minChange, 0, 'Fewest tool removals worth changing the tool list (keeps the prompt cache warm).'),
    maxEscalations: int(d.maxEscalations, 0, 'request_more calls allowed per turn.'),
    reindexDebounceMs: int(d.reindexDebounceMs, 0, 'Quiet period before re-indexing after the catalog changes.'),
    embeddingsUrl: z.string().default(d.embeddingsUrl).description('Ollama URL for local embeddings. Leave empty to use keyword matching only.'),
    embeddingModel: z.string().default(d.embeddingModel).description('Ollama embedding model. Pull it once with `ollama pull <model>`.'),
    cacheDir: z.string().default('').description('Storage folder. Empty uses ~/.dsh/storages/dsh-dynamic-router.'),
    optimizer: z.object({
      enabled: z.boolean().default(o.enabled).description('Rewrite skill and tool descriptions for routing while no conversation is running.'),
      provider: z.string().default(o.provider).description('LLM provider id as configured in DeepSeek Harness. Leave empty to use the model your conversations use.'),
      model: z.string().default(o.model).description('Model id for that provider. Set together with provider.'),
      maxTokens: int(o.maxTokens, 1, 'Output token limit per description.'),
      concurrency: int(o.concurrency, 1, 'Descriptions written at a time.'),
      writeBack: z.boolean().default(o.writeBack).description('Also write improved descriptions into SKILL.md files (a backup is kept).'),
      rewriteToolDescriptions: z.boolean().default(o.rewriteToolDescriptions).description('Send optimized descriptions to the model in place of the originals.'),
    }).default({ ...o }).description('Background description optimizer.'),
    apply: z.boolean().default(d.apply).description('Off = dry run: log what would be selected but send everything.'),
    logLevel: z.union(['silent', 'warn', 'info', 'debug']).default(d.logLevel).description('Log detail.'),
  })
}

export const Config = z
  ? buildSchema()
  : { '~standard': { version: 1, vendor: 'dsh-dynamic-router', validate: validateConfig } }

/**
 * Resolve config without going through Cordis, for tests and the eval script.
 * @param raw - partial config.
 * @returns the merged config.
 * @throws when validation fails.
 */
export function resolveConfig(raw) {
  const result = validateConfig(raw)
  if (result.issues) throw new Error(`dsh-dynamic-router config: ${result.issues[0].message}`)
  return result.value
}

export const LOG_LEVELS = { silent: 0, warn: 1, info: 2, debug: 3 }
