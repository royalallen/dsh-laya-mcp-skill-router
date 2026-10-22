/**
 * First-run setup. Settings the user gives in conversation are saved to
 * `settings.json` in the router's storage folder and layered over the Cordis
 * config. Until that file exists, the model is told to ask the user for them
 * and save them with `router_configure`.
 */

import { join } from 'node:path'
import { readJson, writeJsonAtomic } from './store.js'
import { DEFAULT_CONFIG, DEFAULT_OPTIMIZER, validateConfig } from './config.js'

export const SETUP_TOOL = 'router_configure'
export const SETUP_CONTEXT = 'dynamic-router-setup'

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Layer saved settings over the Cordis config.
 * @param base - plain Cordis config.
 * @param saved - saved settings, possibly undefined.
 * @returns merged raw config.
 */
export function mergeSettings(base, saved) {
  if (!isPlainObject(saved)) return base
  const { optimizer, configuredAt: _configuredAt, ...rest } = saved
  return {
    ...base,
    ...rest,
    optimizer: { ...(isPlainObject(base?.optimizer) ? base.optimizer : {}), ...(isPlainObject(optimizer) ? optimizer : {}) },
  }
}

/** `settings.json` in the router's storage folder. */
export class SettingsStore {
  /**
   * @param cacheDir - storage directory.
   */
  constructor(cacheDir) {
    this.file = join(cacheDir, 'settings.json')
    this.value = undefined
  }

  /** Whether the user has completed setup. */
  get configured() {
    return this.value !== undefined
  }

  async load() {
    const data = await readJson(this.file, undefined)
    this.value = isPlainObject(data) ? data : undefined
    return this.value
  }

  async save(value) {
    await writeJsonAtomic(this.file, value)
    this.value = value
  }
}

const OPTIMIZER_ARGS = {
  optimizerEnabled: 'enabled',
  optimizerBaseUrl: 'baseUrl',
  optimizerApiKey: 'apiKey',
  optimizerModel: 'model',
  optimizerProvider: 'provider',
}
const TOP_ARGS = ['embeddingsUrl', 'embeddingModel', 'embeddingsApiKey', 'layaUrl', 'selector']

/**
 * Turn `router_configure` arguments into saved settings, keeping earlier
 * saved values the call does not mention.
 * @param args - tool arguments.
 * @param previous - previously saved settings.
 * @returns settings to save.
 */
export function settingsFromArgs(args, previous) {
  const next = isPlainObject(previous) ? { ...previous, optimizer: { ...(previous.optimizer ?? {}) } } : { optimizer: {} }
  for (const key of TOP_ARGS) if (args[key] !== undefined) next[key] = typeof args[key] === 'string' ? args[key].trim() : args[key]
  for (const [arg, key] of Object.entries(OPTIMIZER_ARGS)) {
    if (args[arg] !== undefined) next.optimizer[key] = typeof args[arg] === 'string' ? args[arg].trim() : args[arg]
  }
  next.configuredAt = new Date().toISOString()
  return next
}

const mask = (value) => (value ? 'set' : 'not set')

/**
 * One-paragraph summary of the effective settings, with keys masked.
 * @param config - resolved config.
 * @returns text.
 */
export function describeSettings(config) {
  const o = config.optimizer
  const optimizer = !o.enabled
    ? 'off'
    : o.baseUrl
      ? `${o.model || '(no model yet)'} at ${o.baseUrl} (API key ${mask(o.apiKey)})`
      : o.provider && o.model ? `${o.provider}/${o.model}` : 'the conversation model'
  return [
    `Embeddings: ${config.embeddingsUrl ? `${config.embeddingModel} at ${config.embeddingsUrl} (API key ${mask(config.embeddingsApiKey)})` : 'off (keyword matching only)'}`,
    `Optimizer: ${optimizer}`,
    `Laya: ${config.selector === 'laya' ? (config.layaUrl ? `dsh-laya if installed, else the sidecar at ${config.layaUrl}` : 'dsh-laya only') : `off (selector ${config.selector})`}`,
  ].join('\n')
}

/**
 * Validate the merged result before saving.
 * @param base - plain Cordis config.
 * @param settings - candidate settings.
 * @returns `{ config }` or `{ error }`.
 */
export function checkSettings(base, settings) {
  const result = validateConfig(mergeSettings(base, settings))
  return result.issues ? { error: result.issues[0].message } : { config: result.value }
}

export const SETUP_PROMPT = [
  '## Tool router setup',
  'The dsh-dynamic-router plugin has no saved settings yet. Before starting on the user\'s first request, ask them in one short message for:',
  `1. Embeddings server: an Ollama URL (default ${DEFAULT_CONFIG.embeddingsUrl}) and embedding model (default ${DEFAULT_CONFIG.embeddingModel}), plus an API key only if that server needs one. No URL means keyword matching only.`,
  '2. Description optimizer model: an OpenAI-compatible base URL (for Ollama, http://<host>:11434/v1) with a model name and optional API key; or a DeepSeek Harness provider id and model; or nothing, to use the conversation model; or off.',
  `3. Laya sidecar URL (default ${DEFAULT_CONFIG.layaUrl}), used when the dsh-laya plugin is not installed. Empty skips Laya.`,
  `Show the defaults so the user can just reply "defaults". Then call ${SETUP_TOOL} with their answers, or with useDefaults: true if they accept the defaults or want to skip. Afterwards continue with their request. Do not ask again once ${SETUP_TOOL} succeeds.`,
].join('\n')

export const SETUP_TOOL_DESCRIPTION =
  'Save the tool router\'s settings: embeddings server, description optimizer model, and Laya sidecar. ' +
  'Settings apply immediately and are kept for future conversations. Pass only what the user gave; ' +
  'omitted fields keep their current values. Pass useDefaults: true to accept the defaults without changes.'

export const SETUP_TOOL_PARAMETERS = {
  useDefaults: { type: 'boolean', description: 'Accept current values for everything not passed.' },
  embeddingsUrl: { type: 'string', description: `Ollama URL for embeddings, e.g. ${DEFAULT_CONFIG.embeddingsUrl}. Empty string turns embeddings off.` },
  embeddingModel: { type: 'string', description: `Embedding model, e.g. ${DEFAULT_CONFIG.embeddingModel}.` },
  embeddingsApiKey: { type: 'string', description: 'API key for the embeddings server, if it needs one.' },
  optimizerEnabled: { type: 'boolean', description: `Run the background description optimizer (default ${DEFAULT_OPTIMIZER.enabled}).` },
  optimizerBaseUrl: { type: 'string', description: 'OpenAI-compatible endpoint, e.g. http://127.0.0.1:11434/v1. Empty string uses a harness provider or the conversation model.' },
  optimizerApiKey: { type: 'string', description: 'API key for that endpoint, if it needs one.' },
  optimizerModel: { type: 'string', description: 'Model for the optimizer. Required with optimizerBaseUrl or optimizerProvider.' },
  optimizerProvider: { type: 'string', description: 'DeepSeek Harness provider id, used when optimizerBaseUrl is empty.' },
  layaUrl: { type: 'string', description: `Laya sidecar URL, e.g. ${DEFAULT_CONFIG.layaUrl}. Empty string uses dsh-laya only.` },
  selector: { type: 'string', description: 'How skills and tool groups are judged: laya, embeddings, or bm25.' },
}
