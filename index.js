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

import { Config, LOG_LEVELS, resolveConfig } from './config.js'
import { EmbeddingIndex } from './recall.js'
import { CardStore, Optimizer } from './optimize.js'
import { HINT_CONTEXT, Router } from './router.js'
import { routerTools } from './tools.js'

export const name = 'dynamic-router'
export const inject = ['tools', 'systemPrompt']
export { Config }

const HINT_ORDER = 130

const makeLogger = (ctx, level) => {
  const emit = (at, method, message) => {
    if (LOG_LEVELS[level] < LOG_LEVELS[at]) return
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

/** Cordis plugin entry. */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const logger = makeLogger(ctx, config.logLevel)
  const cards = new CardStore(config.cacheDir)
  const embeddings = new EmbeddingIndex({
    url: config.embeddingsUrl,
    model: config.embeddingModel,
    cacheDir: config.cacheDir,
    logger,
  })
  const services = () => ({
    tools: ctx.tools,
    skills: optional(ctx, 'skills'),
    workingDirectory: optional(ctx, 'workingDirectory'),
    laya: config.selector === 'laya' ? optional(ctx, 'laya') : undefined,
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
    ctx.systemPrompt.context({
      name: HINT_CONTEXT,
      order: HINT_ORDER,
      required: true,
      interpolate: false,
      text: (context) => router.hintFor(context?.agent),
    }),
  )

  ctx.effect(() => {
    let disposed = false
    Promise.all([cards.load(), embeddings.load()])
      .then(() => {
        if (disposed) return
        router.cardsChanged()
        optimizer.start()
        logger.info(
          `[dynamic-router] ready · selector=${config.selector} · embeddings=${config.embeddingsUrl ? `${config.embeddingModel} @ ${config.embeddingsUrl}` : 'off'} · ` +
            `optimizer=${config.optimizer.enabled ? (config.optimizer.provider ? `${config.optimizer.provider}/${config.optimizer.model}` : 'conversation model') : 'off'} · ` +
            `${config.apply ? 'filtering' : 'dry run (apply: false)'}`,
        )
        if (config.selector === 'laya' && !optional(ctx, 'laya')) {
          logger.warn(
            '[dynamic-router] selector is "laya" but the laya service is not mounted yet. Routing uses recall only ' +
              'until dsh-laya loads. Install and enable dsh-laya, or set selector: embeddings to silence this.',
          )
        }
      })
      .catch((error) => logger.warn(`[dynamic-router] could not load cached state from ${config.cacheDir}: ${error?.message ?? error}`))
    return () => {
      disposed = true
      optimizer.stop()
      embeddings.save.flush()?.catch?.(() => {})
    }
  })
}
