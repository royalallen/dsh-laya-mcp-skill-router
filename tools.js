/**
 * Model-facing tools: `request_more` (escalation), the inspection tools
 * `router_preview`, `router_stats`, `router_cards`, and `router_configure`
 * for first-run setup.
 */

import {
  SETUP_TOOL,
  SETUP_TOOL_DESCRIPTION,
  SETUP_TOOL_PARAMETERS,
  checkSettings,
  describeSettings,
  settingsFromArgs,
  testSettings,
} from './settings.js'

let hostDefineTool
try {
  ;({ defineTool: hostDefineTool } = await import('@deepseek-ai/dsh-tools'))
} catch {
  hostDefineTool = undefined
}

const specToJsonSchema = (spec) => {
  const properties = {}
  const required = []
  for (const [key, field] of Object.entries(spec ?? {})) {
    const { required: isRequired, ...rest } = field
    properties[key] = rest.type === 'json' ? { ...rest, type: undefined } : rest
    if (properties[key].type === undefined) delete properties[key].type
    if (isRequired) required.push(key)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false }
}

/**
 * `defineTool` from the host when it resolves, otherwise a minimal stand-in
 * so the module loads under `node --test` outside the harness.
 * @param options - DSH tool options.
 * @returns a registry-ready definition.
 */
export function defineTool(options) {
  if (hostDefineTool) return hostDefineTool(options)
  return {
    name: options.name,
    description: options.description,
    parameters: specToJsonSchema(options.parameters),
    output: options.output,
    execute: options.execute,
    ...(options.isConcurrencySafe ? { isConcurrencySafe: options.isConcurrencySafe } : {}),
    ...(options.presentCall ? { presentCall: options.presentCall } : {}),
  }
}

const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      text: { type: 'string', required: true },
      data: { type: 'json' },
    },
    additionalProperties: false,
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
  presentationMeta: (_args, value) => ({ summary: String(value.text).split('\n')[0].slice(0, 120) }),
}

export const REQUEST_MORE_BASE =
  'Load tools or find skills the router did not include for this request. Tools from optional ' +
  'groups (MCP servers and plugins) are loaded per request; when you need one that is not in your ' +
  'tool list, call this with the group id or exact tool names, then call the tool on your next step. ' +
  'To find a skill that is not in the suggested list, pass "skills" with a short description of the task.'

/**
 * `request_more` description with the current group index appended.
 * @param index - `[{ id, label, count, blurb }]`, best known first.
 * @returns the description text.
 */
export function requestMoreDescription(index) {
  if (!index?.length) return REQUEST_MORE_BASE
  const lines = index.map((entry) => `- ${entry.id} (${entry.count} tool${entry.count === 1 ? '' : 's'}): ${entry.blurb}`)
  return `${REQUEST_MORE_BASE}\n\nTool groups:\n${lines.join('\n')}`
}

/**
 * Build the four tool definitions against a router instance.
 * @param router - the Router.
 * @returns tool definitions.
 */
export function routerTools(router) {
  const requestMore = defineTool({
    name: 'request_more',
    description: REQUEST_MORE_BASE,
    parameters: {
      group: { type: 'string', description: 'A tool group id from the list in this description.' },
      tools: { type: 'array', items: { type: 'string' }, description: 'Exact tool names to load.' },
      skills: { type: 'string', description: 'Describe the task to search installed skills by description.' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return router.requestMore(exec.agent, args, exec.signal)
    },
    presentCall(args) {
      const what = args.group ?? (args.tools?.length ? args.tools.join(', ') : args.skills ?? '')
      return { card: 'generic', title: `Request more: ${what}`.slice(0, 80), kind: 'read', rawInput: what }
    },
  })

  const preview = defineTool({
    name: 'router_preview',
    description:
      'Show what the tool and skill router would select for a request: groups, tools and skills with ' +
      'Laya probabilities, recall ranks and the reason each was kept. Read-only; changes nothing.',
    parameters: {
      request: { type: 'string', required: true, description: 'The request text to route.' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return router.preview(exec.agent, args.request, exec.signal)
    },
  })

  const stats = defineTool({
    name: 'router_stats',
    description:
      'Report the router\'s recent turns: tokens of tool schemas and skill catalog saved, Laya latency ' +
      'and failures, embedding status, escalations, and skills the model loaded that were not suggested.',
    parameters: {},
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute() {
      return router.stats()
    },
  })

  const cards = defineTool({
    name: 'router_cards',
    description:
      'List the routing description cards the background optimizer wrote, or show one. Cards live in ' +
      'the router\'s storage overlay and are used for routing only; source files are not changed.',
    parameters: {
      key: { type: 'string', description: 'Card key such as "skill:impeccable" or "group:mcp:github". Omit to list.' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args) {
      return router.cardsReport(args.key)
    },
  })

  return [requestMore, preview, stats, cards]
}

/**
 * `router_configure`: save settings the user gave in conversation.
 * @param options - `settings` (SettingsStore), `base()` returning the plain Cordis config,
 *   `reapply()` applying saved settings, the live `config`, and `laya()` returning the dsh-laya service.
 * @returns the tool definition.
 */
export function configureTool({ settings, base, reapply, config, laya }) {
  const report = async (headline) => {
    const { lines } = await testSettings(config, { laya: laya?.() })
    return { text: `${headline}\n${describeSettings(config)}\n\nConnection tests:\n${lines.join('\n')}` }
  }
  return defineTool({
    name: SETUP_TOOL,
    description: SETUP_TOOL_DESCRIPTION,
    parameters: SETUP_TOOL_PARAMETERS,
    output: TEXT_OUTPUT,
    async execute(args) {
      if (args?.testOnly === true) return report('Current router settings (nothing changed).')
      const given = Object.keys(args ?? {}).filter((key) => key !== 'useDefaults' && args[key] !== undefined)
      if (given.length === 0 && args?.useDefaults !== true) {
        return { text: 'Nothing to save. Pass the settings the user gave, useDefaults: true to accept the defaults, or testOnly: true to test.' }
      }
      const candidate = settingsFromArgs(args ?? {}, settings.value)
      const checked = checkSettings(base(), candidate)
      if (checked.error) return { text: `Not saved: ${checked.error}. Ask the user for a corrected value.` }
      try {
        await settings.save(candidate)
      } catch (error) {
        return { text: `Not saved: could not write ${settings.file} (${error?.message ?? error}).` }
      }
      reapply()
      return report(`Router settings saved to ${settings.file} and applied.`)
    },
    presentCall() {
      return { card: 'generic', title: 'Configure tool router', kind: 'edit', rawInput: '' }
    },
  })
}
