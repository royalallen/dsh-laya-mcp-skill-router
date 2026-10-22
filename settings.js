/**
 * First-run setup. Settings the user gives in conversation are saved to
 * `settings.json` in the router's storage folder and layered over the Cordis
 * config. Until that file exists, the model is told to ask the user for them
 * and save them with `router_configure`.
 */

import { join } from 'node:path'
import { readJson, withTimeout, writeJsonAtomic } from './store.js'
import { DEFAULT_CONFIG, DEFAULT_OPTIMIZER, DSH_LAYA_URL, directLayaUrl, validateConfig } from './config.js'
import { EmbeddingIndex } from './recall.js'
import { chatCompletion } from './optimize.js'
import { sidecarClient } from './laya.js'

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
    `Laya: ${config.selector === 'laya' ? (config.layaUrl ? `the sidecar at ${config.layaUrl}` : `the dsh-laya plugin and its settings, or dsh-laya's default endpoint ${DSH_LAYA_URL} when it is not installed`) : `off (selector ${config.selector})`}`,
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

export const LAYA_INSTALL =
  'install the dsh-laya plugin (Plugins page, or `dsh plugin --profile <profile> add dsh-laya`) and start the Laya sidecar it talks to: ' +
  '`pip install "laya-mcp[mcp]"`, then `laya-mcp serve` (or set dsh-laya `lifecycle: spawn` with `spawnCommand: ["laya-mcp", "serve"]` so it starts automatically)'

/**
 * The setup instruction shown while no settings are saved.
 * @param options - `hasLayaPlugin`: whether dsh-laya is mounted.
 * @returns prompt text.
 */
export function setupPrompt({ hasLayaPlugin = false } = {}) {
  const laya = hasLayaPlugin
    ? '3. Laya (optional): the URL of a Laya server (`laya-mcp serve`) to use instead of the installed dsh-laya plugin. Left blank, the router uses the dsh-laya plugin and its settings.'
    : '3. Laya (optional): the URL of their own Laya server (`laya-mcp serve`), if they run one. ' +
      `Left blank, the router uses the same endpoint dsh-laya uses by default, ${DSH_LAYA_URL}. ` +
      `If they have no Laya server, recommend that they ${LAYA_INSTALL}. Without Laya, routing uses embeddings and keyword matching only.`
  return [
    '## Tool router setup',
    'The dsh-dynamic-router plugin has no saved settings yet. Before starting on the user\'s first request, ask them in one short message for:',
    `1. Embeddings server: an Ollama URL (default ${DEFAULT_CONFIG.embeddingsUrl}) and embedding model (default ${DEFAULT_CONFIG.embeddingModel}), plus an API key only if that server needs one. No URL means keyword matching only.`,
    '2. Description optimizer model: an OpenAI-compatible base URL (for Ollama, http://<host>:11434/v1) with a model name and optional API key; or a DeepSeek Harness provider id and model; or nothing, to use the conversation model; or off.',
    laya,
    `Show the defaults so the user can just reply "defaults". Then call ${SETUP_TOOL} with their answers, or with useDefaults: true if they accept the defaults or want to skip. ` +
      `It tests each connection; tell the user the results and how to fix any failure. Afterwards continue with their request. Do not ask again once ${SETUP_TOOL} succeeds.`,
  ].join('\n')
}

const LAYA_PROBE = {
  state: { request: 'router connection test' },
  questions: {
    q0: {
      type: 'noul',
      instructions: 'Is this request a connection test?',
      criteria: { true: 'the request is a connection test', false: 'the request is real work' },
    },
  },
}

const elapsed = (started) => `${Date.now() - started} ms`
const reason = (error) => (error?.name === 'TimeoutError' ? 'timed out' : error?.message ?? String(error))

/**
 * Check that each configured service answers.
 * @param config - resolved config.
 * @param options - `laya` (the dsh-laya service, if mounted), `fetch`, `timeoutMs`.
 * @returns `{ lines, layaOk }`: one result line per service.
 */
export async function testSettings(config, { laya, fetch: fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const embeddings = async () => {
    if (!config.embeddingsUrl) return 'Embeddings: off, nothing to test.'
    const started = Date.now()
    try {
      const index = new EmbeddingIndex({
        url: config.embeddingsUrl, model: config.embeddingModel, apiKey: config.embeddingsApiKey, fetch: fetchImpl, timeoutMs,
      })
      const [vector] = await index.embed(['router connection test'])
      return `Embeddings: OK, ${config.embeddingModel} at ${config.embeddingsUrl} returned a ${vector.length}-dimension vector in ${elapsed(started)}.`
    } catch (error) {
      return `Embeddings: FAILED (${reason(error)}). Check that Ollama is running at ${config.embeddingsUrl} and run \`ollama pull ${config.embeddingModel}\` there. Until fixed, routing uses keyword matching.`
    }
  }

  const optimizer = async () => {
    const o = config.optimizer
    if (!o.enabled) return 'Optimizer: off, nothing to test.'
    if (!o.baseUrl) {
      return o.provider && o.model
        ? `Optimizer: uses the harness provider ${o.provider}/${o.model}; it is checked on the first background run.`
        : 'Optimizer: uses the conversation model, which this conversation already shows is working.'
    }
    if (!o.model) return 'Optimizer: FAILED, a base URL is set but no model. Ask the user which model to use.'
    const started = Date.now()
    try {
      await chatCompletion({
        baseUrl: o.baseUrl, apiKey: o.apiKey, model: o.model, system: 'Reply with OK.', prompt: 'OK?', maxTokens: 16,
        signal: AbortSignal.timeout(timeoutMs * 4), fetch: fetchImpl,
      })
      return `Optimizer: OK, ${o.model} at ${o.baseUrl} answered in ${elapsed(started)}.`
    } catch (error) {
      return `Optimizer: FAILED (${reason(error)}). Check the base URL (Ollama needs the /v1 suffix), the model name, and the API key.`
    }
  }

  const layaCheck = async () => {
    if (config.selector !== 'laya') return { ok: false, line: `Laya: not used (selector is ${config.selector}).` }
    const url = directLayaUrl(config, Boolean(laya))
    const client = url ? sidecarClient(url, { fetch: fetchImpl, retryMs: 0 }) : laya
    const where = config.layaUrl
      ? `the sidecar at ${url}`
      : url
        ? `dsh-laya's default endpoint ${url} (dsh-laya is not installed)`
        : `the dsh-laya plugin's sidecar${laya.sidecarUrl ? ` at ${laya.sidecarUrl}` : ''}`
    const started = Date.now()
    try {
      const result = await withTimeout(client.ask(LAYA_PROBE, { signal: AbortSignal.timeout(timeoutMs) }), timeoutMs)
      const answer = result?.answers?.q0
      if (typeof (answer?.noul ?? answer?.p_true) !== 'number') throw new Error('it answered, but not with a Laya decision; is this a `laya-mcp serve` sidecar?')
      return { ok: true, line: `Laya: OK, ${where} answered a test question in ${elapsed(started)}.` }
    } catch (error) {
      return { ok: false, line: `Laya: FAILED, ${where} (${reason(error)}).` }
    }
  }

  const [embeddingLine, optimizerLine, layaResult] = await Promise.all([embeddings(), optimizer(), layaCheck()])
  const lines = [embeddingLine, optimizerLine, layaResult.line]
  if (!layaResult.ok && config.selector === 'laya') {
    const fix = config.layaUrl
      ? 'To fix Laya: make sure that URL is a running `laya-mcp serve` sidecar (install it with `pip install "laya-mcp[mcp]"`), ' +
        'or clear the Laya URL to use the dsh-laya plugin instead.'
      : laya
        ? 'To fix Laya: start the sidecar dsh-laya points at (`pip install "laya-mcp[mcp]"`, then `laya-mcp serve`), set dsh-laya ' +
          '`lifecycle: spawn` with `spawnCommand: ["laya-mcp", "serve"]`, or point dsh-laya\'s `sidecarUrl` at a running sidecar.'
        : `To fix Laya: start a sidecar at ${DSH_LAYA_URL} (\`pip install "laya-mcp[mcp]"\`, then \`laya-mcp serve\`), ` +
          `or ${LAYA_INSTALL}, or give the router the URL of a running sidecar.`
    lines.push(`${fix} Until then, routing uses embeddings and keyword matching.`)
  }
  return { lines, layaOk: layaResult.ok }
}

export const SETUP_TOOL_DESCRIPTION =
  'Save the tool router\'s settings: embeddings server, description optimizer model, and Laya sidecar. ' +
  'Settings apply immediately, are kept for future conversations, and each connection is tested. Pass only what the user gave; ' +
  'omitted fields keep their current values. Pass useDefaults: true to accept the defaults without changes, or testOnly: true ' +
  'to re-test the saved settings without changing them.'

export const SETUP_TOOL_PARAMETERS = {
  useDefaults: { type: 'boolean', description: 'Accept current values for everything not passed.' },
  testOnly: { type: 'boolean', description: 'Only test the current settings; save nothing.' },
  embeddingsUrl: { type: 'string', description: `Ollama URL for embeddings, e.g. ${DEFAULT_CONFIG.embeddingsUrl}. Empty string turns embeddings off.` },
  embeddingModel: { type: 'string', description: `Embedding model, e.g. ${DEFAULT_CONFIG.embeddingModel}.` },
  embeddingsApiKey: { type: 'string', description: 'API key for the embeddings server, if it needs one.' },
  optimizerEnabled: { type: 'boolean', description: `Run the background description optimizer (default ${DEFAULT_OPTIMIZER.enabled}).` },
  optimizerBaseUrl: { type: 'string', description: 'OpenAI-compatible endpoint, e.g. http://127.0.0.1:11434/v1. Empty string uses a harness provider or the conversation model.' },
  optimizerApiKey: { type: 'string', description: 'API key for that endpoint, if it needs one.' },
  optimizerModel: { type: 'string', description: 'Model for the optimizer. Required with optimizerBaseUrl or optimizerProvider.' },
  optimizerProvider: { type: 'string', description: 'DeepSeek Harness provider id, used when optimizerBaseUrl is empty.' },
  layaUrl: { type: 'string', description: 'URL of a `laya-mcp serve` sidecar to use instead of the dsh-laya plugin. Empty string uses the dsh-laya plugin and its settings, or dsh-laya\'s default endpoint (http://127.0.0.1:8787) when it is not installed.' },
  selector: { type: 'string', description: 'How skills and tool groups are judged: laya, embeddings, or bm25.' },
}
