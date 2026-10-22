/**
 * dsh-dynamic-router: per-step tool and skill routing for DeepSeek Harness.
 *
 * Each step, recall (local Ollama embeddings plus BM25) and Laya pick the
 * tool groups and skills that fit the request. Unselected optional tools are
 * removed from the request's tool list, the full skill catalog is replaced by
 * a names directory plus a short per-step suggestion list, and confident
 * skills are loaded up front. `request_more` lets the model ask for anything
 * that was left out.
 */

import { Config, LOG_LEVELS, configWarnings, directLayaUrl, resolveConfig, unwrapConfig } from './config.js'
import { sidecarClient } from './laya.js'
import { EmbeddingIndex } from './recall.js'
import { CardStore, Optimizer } from './optimize.js'
import { HINT_CONTEXT, Router } from './router.js'
import { SETUP_CONTEXT, SettingsStore, mergeSettings, setupPrompt } from './settings.js'
import { configureTool, routerTools } from './tools.js'

export const name = 'dynamic-router'
export const inject = ['tools', 'systemPrompt']
export { Config }

const HINT_ORDER = 130

const makeLogger = (ctx, config) => {
  const emit = (at, method, message) => {
    if (LOG_LEVELS[config.logLevel] < LOG_LEVELS[at]) return
    const sink = ctx.logger
    const fn = sink?.[method]
    if (typeof fn === 'function') fn.call(sink, message)
    else if (method === 'warn') console.warn(message)
    else console.log(message)
  }
  return {
    warn: (m) => emit('warn', 'warn', m),
    info: (m) => emit('info', 'info', m),
    debug: (m) => emit('debug', 'debug', m),
  }
}

const optional = (ctx, key) => {
  try {
    return ctx.get(key)
  } catch {
    return undefined
  }
}

const describe = (config, ctx) => {
  const { optimizer } = config
  const optimizerRoute = !optimizer.enabled
    ? 'off'
    : optimizer.baseUrl
      ? `${optimizer.model || '(no model)'} @ ${optimizer.baseUrl}`
      : optimizer.provider && optimizer.model ? `${optimizer.provider}/${optimizer.model}` : 'conversation model'
  const url = directLayaUrl(config, Boolean(optional(ctx, 'laya')))
  const laya = config.selector !== 'laya' ? 'off' : url ? `sidecar @ ${url}` : 'dsh-laya'
  return (
    `selector=${config.selector} · laya=${laya} · ` +
    `embeddings=${config.embeddingsUrl ? `${config.embeddingModel} @ ${config.embeddingsUrl}` : 'off'} · ` +
    `optimizer=${optimizerRoute} · ${config.apply ? 'filtering' : 'dry run (apply: false)'}`
  )
}

/** Cordis plugin entry. */
export function apply(ctx, rawConfig) {
  const config = { ...resolveConfig(unwrapConfig(rawConfig)), setupPending: false }
  const logger = makeLogger(ctx, config)
  const settings = new SettingsStore(config.cacheDir)
  const cards = new CardStore(config.cacheDir)
  const embeddings = new EmbeddingIndex({
    url: config.embeddingsUrl,
    model: config.embeddingModel,
    apiKey: config.embeddingsApiKey,
    cacheDir: config.cacheDir,
    logger,
  })
  const sidecars = new Map()
  const laya = () => {
    const plugin = optional(ctx, 'laya')
    const url = directLayaUrl(config, Boolean(plugin))
    if (!url) return plugin
    const key = `${url}\n${config.layaApiKey}`
    if (!sidecars.has(key)) sidecars.set(key, sidecarClient(url, { apiKey: config.layaApiKey }))
    return sidecars.get(key)
  }
  const services = () => ({
    tools: ctx.tools,
    skills: optional(ctx, 'skills'),
    workingDirectory: optional(ctx, 'workingDirectory'),
    laya: config.selector === 'laya' ? laya() : undefined,
  })
  const router = new Router({ config, logger, cards, embeddings, services })
  const optimizer = new Optimizer({
    config,
    store: cards,
    logger,
    llm: () => optional(ctx, 'llm'),
    loadSource: (job, signal) => router.optimizerSource(job, signal),
    items: () => router.optimizerJobs(),
    onCards: () => router.cardsChanged(),
    fallbackRoute: () => router.lastRoute,
  })

  const reapply = () => {
    let next
    try {
      next = resolveConfig(mergeSettings(unwrapConfig(rawConfig), settings.value))
    } catch (error) {
      logger.warn(`[dynamic-router] ignored a settings change: ${error?.message ?? error}`)
      return false
    }
    const previous = { ...config, optimizer: { ...config.optimizer } }
    Object.assign(config, next, { setupPending: !settings.configured })
    embeddings
      .reconfigure({ url: next.embeddingsUrl, model: next.embeddingModel, apiKey: next.embeddingsApiKey })
      .catch((error) => logger.warn(`[dynamic-router] could not switch embeddings: ${error?.message ?? error}`))
    if (JSON.stringify(next.optimizer) !== JSON.stringify(previous.optimizer)) optimizer.reconfigure()
    router.reconfigure()
    for (const warning of configWarnings(config)) logger.warn(`[dynamic-router] ${warning}`)
    logger.info(`[dynamic-router] settings applied · ${describe(config, ctx)}`)
    return true
  }

  ctx.on('loader/volatile-update', () => reapply())

  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => router.noteClaimed(agent, message, turn))

  ctx.on(
    'system-prompt/assemble',
    async (_assembly, context, next) => router.onAssemble(await next(), context),
    { prepend: true },
  )

  ctx.on(
    'agent/pre-step',
    async ({ agent, signal }, next) => router.onPreStep(agent, await next(), signal),
    { prepend: true },
  )

  ctx.on('session/event', (session, event) => {
    if (event?.type === 'turn/start') optimizer.turnStarted(session?.id ?? session)
    else if (event?.type === 'turn/end') optimizer.turnEnded(session?.id ?? session)
  })

  ctx.effect(() => ctx.tools.guard((exec) => router.guard(exec)))
  for (const definition of routerTools(router)) ctx.effect(() => ctx.tools.register(definition))
  ctx.effect(() =>
    ctx.tools.register(
      configureTool({ settings, base: () => unwrapConfig(rawConfig), reapply, config, laya: () => optional(ctx, 'laya') }),
    ),
  )
  ctx.effect(() =>
    ctx.systemPrompt.context({
      name: HINT_CONTEXT,
      order: HINT_ORDER,
      required: true,
      interpolate: false,
      text: (context) => router.hintFor(context?.agent),
    }),
  )
  ctx.effect(() =>
    ctx.systemPrompt.context({
      name: SETUP_CONTEXT,
      order: HINT_ORDER + 1,
      required: true,
      interpolate: false,
      text: () => (config.setupPending ? setupPrompt({ hasLayaPlugin: Boolean(optional(ctx, 'laya')) }) : ''),
    }),
  )

  ctx.effect(() => {
    let disposed = false
    Promise.all([cards.load(), embeddings.load(), settings.load()])
      .then(() => {
        if (disposed) return
        if (settings.configured) reapply()
        else {
          config.setupPending = true
          router.reconfigure()
          logger.info(`[dynamic-router] no saved settings in ${settings.file}; the model will ask for them in the next conversation`)
        }
        router.cardsChanged()
        optimizer.start()
        logger.info(`[dynamic-router] ready · ${describe(config, ctx)}`)
        for (const warning of configWarnings(config)) logger.warn(`[dynamic-router] ${warning}`)
      })
      .catch((error) => logger.warn(`[dynamic-router] could not load cached state from ${config.cacheDir}: ${error?.message ?? error}`))
    return () => {
      disposed = true
      optimizer.stop()
      embeddings.save.flush()?.catch?.(() => {})
    }
  })
}
