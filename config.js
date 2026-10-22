/**
 * Router configuration: defaults, validation, and the `Config` schema Cordis
 * validates before `apply()` runs. Inside the harness `Config` is a
 * schemastery schema whose `.volatile()` fields reach the running plugin as
 * `loader/volatile-update` when the profile patch changes. Outside the
 * harness (tests, the eval script) a Standard Schema validator stands in.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh')

export const DEFAULT_OPTIMIZER = Object.freeze({
  enabled: true,
  baseUrl: '',
  apiKey: '',
  provider: '',
  model: '',
  concurrency: 1,
  writeBack: false,
  rewriteToolDescriptions: false,
  maxTokens: 1200,
})

/** Must match dsh-laya's default `sidecarUrl`; used when neither dsh-laya nor a Laya URL is present. */
export const DSH_LAYA_URL = 'http://127.0.0.1:8787'

/** The Laya sidecar URL to call directly, or undefined to go through dsh-laya. */
export const directLayaUrl = (config, hasPlugin) => config.layaUrl || (hasPlugin ? undefined : DSH_LAYA_URL)

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
  layaUrl: '',

  alwaysSkills: [],
  companions: {},
  skillCategories: {},

  optimizer: DEFAULT_OPTIMIZER,

  stickyTurns: 3,
  minChange: 2,
  maxEscalations: 2,

  embeddingsUrl: 'http://127.0.0.1:11434',
  embeddingModel: 'nomic-embed-text',
  embeddingsApiKey: '',
  layaApiKey: '',

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
 * Check an optional http(s) URL field.
 * @returns an issue, or undefined when the value is empty or valid.
 */
const urlIssue = (value, name, path) => {
  if (typeof value !== 'string') return issue(`${name} must be a string`, path)
  if (value === '') return undefined
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return issue(`${name} must be an http(s) URL`, path)
  } catch {
    return issue(`${name} is not a valid URL`, path)
  }
  return undefined
}

/**
 * Replace volatile references (`{ get() }`) with their current values.
 * @param value - config as Cordis passed it.
 * @returns plain data.
 */
export function unwrapConfig(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function' && !Array.isArray(value)) {
    return unwrapConfig(value.get())
  }
  if (Array.isArray(value)) return value.map(unwrapConfig)
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, unwrapConfig(child)]))
  return value
}

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
  if (!config.cacheDir) config.cacheDir = join(dshHome(), 'storages', 'dsh-laya-mcp-skill-router')

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
  const urls = urlIssue(config.embeddingsUrl, 'embeddingsUrl', ['embeddingsUrl']) ?? urlIssue(config.layaUrl, 'layaUrl', ['layaUrl'])
  if (urls) return urls
  if (typeof config.embeddingModel !== 'string' || config.embeddingModel === '') {
    return issue('embeddingModel must be a non-empty string', ['embeddingModel'])
  }
  if (typeof config.embeddingsApiKey !== 'string') return issue('embeddingsApiKey must be a string', ['embeddingsApiKey'])
  if (typeof config.layaApiKey !== 'string') return issue('layaApiKey must be a string', ['layaApiKey'])
  if (typeof config.apply !== 'boolean') return issue('apply must be a boolean', ['apply'])

  const optimizer = config.optimizer
  for (const key of ['enabled', 'writeBack', 'rewriteToolDescriptions']) {
    if (typeof optimizer[key] !== 'boolean') return issue(`optimizer.${key} must be a boolean`, ['optimizer', key])
  }
  for (const key of ['apiKey', 'provider', 'model']) {
    if (typeof optimizer[key] !== 'string') return issue(`optimizer.${key} must be a string`, ['optimizer', key])
  }
  const baseUrl = urlIssue(optimizer.baseUrl, 'optimizer.baseUrl', ['optimizer', 'baseUrl'])
  if (baseUrl) return baseUrl
  for (const key of ['concurrency', 'maxTokens']) {
    if (!Number.isInteger(optimizer[key]) || optimizer[key] <= 0) {
      return issue(`optimizer.${key} must be a positive integer`, ['optimizer', key])
    }
  }
  return { value: config }
}

/**
 * Half-finished settings that are allowed (setup and patch edits can set one
 * field at a time) but leave a feature off until completed.
 * @param config - resolved config.
 * @returns warning messages.
 */
export function configWarnings(config) {
  const { baseUrl, provider, model } = config.optimizer
  if (!config.optimizer.enabled) return []
  if (baseUrl && !model) return ['optimizer base URL is set but model is empty; the optimizer waits until a model is set']
  if (!baseUrl && Boolean(provider) !== Boolean(model)) {
    return ['optimizer provider and model must be set together; using the conversation model until both are set']
  }
  return []
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
 * runs the result through `resolveConfig`. Every field but `cacheDir` is
 * volatile, so patch edits apply without a restart.
 * @returns a schemastery object schema.
 */
function buildSchema() {
  const d = DEFAULT_CONFIG
  const o = DEFAULT_OPTIMIZER
  const int = (value, min, text) => z.number().step(1).min(min).default(value).description(text)
  const prob = (value, text) => z.number().min(0).max(1).step(0.01).default(value).description(text)
  const fields = {
    embeddingsUrl: z.string().default(d.embeddingsUrl)
      .description('Ollama server for embeddings, e.g. http://127.0.0.1:11434. Leave empty to use keyword matching only.'),
    embeddingModel: z.string().default(d.embeddingModel).description('Embedding model on that server. Pull it once with `ollama pull <model>`.'),
    embeddingsApiKey: z.string().role('secret').default('').description('API key for the embeddings server, sent as a Bearer token. Leave empty for a local Ollama.'),
    optimizer: z.object({
      enabled: z.boolean().default(o.enabled).description('Rewrite skill and tool descriptions for routing while no conversation is running.'),
      baseUrl: z.string().default(o.baseUrl)
        .description('OpenAI-compatible endpoint for the optimizer, e.g. http://127.0.0.1:11434/v1 for Ollama. Leave empty to use a DeepSeek Harness provider.'),
      apiKey: z.string().role('secret').default('').description('API key for that endpoint, sent as a Bearer token. Leave empty for a local Ollama.'),
      model: z.string().default(o.model).description('Model id. Required with a base URL; with a provider, set both or neither.'),
      provider: z.string().default(o.provider)
        .description('Used when base URL is empty: a provider id from Settings > Models. Leave provider and model empty to use the model your conversations use.'),
      maxTokens: int(o.maxTokens, 1, 'Output token limit per description.'),
      concurrency: int(o.concurrency, 1, 'Descriptions written at a time.'),
      writeBack: z.boolean().default(o.writeBack).description('Also write improved descriptions into SKILL.md files (a backup is kept).'),
      rewriteToolDescriptions: z.boolean().default(o.rewriteToolDescriptions).description('Send optimized descriptions to the model in place of the originals.'),
    }).default({ ...o }).description('Background description optimizer.'),
    selector: z.union(['laya', 'embeddings', 'bm25']).default(d.selector)
      .description('How skills and tool groups are judged. laya uses the sidecar at the Laya URL, or the dsh-laya plugin, and falls back to recall.'),
    layaUrl: z.string().default(d.layaUrl)
      .description('Laya server to use instead of the dsh-laya plugin: laya-mcp (`/ask`), laya-serve (`/v1/systemone`), or a sidecar (`/system-one`), found automatically from the host URL; include the path to pin one. Leave empty to use dsh-laya and its settings, or dsh-laya\'s default endpoint (http://127.0.0.1:8787) when it is not installed.'),
    layaApiKey: z.string().role('secret').default('').description('API key for the Laya server, sent as a Bearer token. Leave empty if it needs none.'),
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
    apply: z.boolean().default(d.apply).description('Off = dry run: log what would be selected but send everything.'),
    logLevel: z.union(['silent', 'warn', 'info', 'debug']).default(d.logLevel).description('Log detail.'),
  }
  return z.object({
    ...Object.fromEntries(Object.entries(fields).map(([key, schema]) => [key, schema.volatile()])),
    cacheDir: z.string().default('').description('Storage folder. Empty uses ~/.dsh/storages/dsh-laya-mcp-skill-router. Changing it restarts the plugin.'),
  })
}

export const Config = z
  ? buildSchema()
  : { '~standard': { version: 1, vendor: 'dsh-laya-mcp-skill-router', validate: validateConfig } }

/**
 * Resolve config without going through Cordis, for tests and the eval script.
 * @param raw - partial config.
 * @returns the merged config.
 * @throws when validation fails.
 */
export function resolveConfig(raw) {
  const result = validateConfig(raw)
  if (result.issues) throw new Error(`dsh-laya-mcp-skill-router config: ${result.issues[0].message}`)
  return result.value
}

export const LOG_LEVELS = { silent: 0, warn: 1, info: 2, debug: 3 }
