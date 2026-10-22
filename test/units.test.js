import { test } from 'node:test'
import assert from 'node:assert/strict'
import { configWarnings, validateConfig, resolveConfig, unwrapConfig } from '../config.js'
import { Bm25, EmbeddingIndex, rankItems, reciprocalRankFusion, tokenize } from '../recall.js'
import { askAll, buildState, questionFor, sidecarClient, unionMerge } from '../laya.js'
import { stickySet, filterAssembly, toolsForGroups } from '../filter.js'
import { buildToolCatalog, partitionTools } from '../catalog.js'
import { chooseAutoLoad, chooseSkills, renderDirectory, renderHint } from '../skills.js'
import { Optimizer, chatCompletion, extractJson, validateCard } from '../optimize.js'
import { fakeLaya, tool } from './helpers.js'

test('config: defaults merge and bad values are rejected', () => {
  const config = resolveConfig({ maxTools: 7, optimizer: { maxTokens: 900 } })
  assert.equal(config.maxTools, 7)
  assert.equal(config.optimizer.maxTokens, 900)
  assert.equal(config.optimizer.provider, '')
  assert.ok(validateConfig({ selector: 'nope' }).issues)
  assert.ok(validateConfig({ skillKeep: 2 }).issues)
  assert.ok(validateConfig({ groups: [{ id: 'g' }] }).issues)
  assert.ok(validateConfig({ embeddingsUrl: 'ftp://x' }).issues)
  assert.ok(validateConfig({ layaUrl: 'not a url' }).issues)
  assert.ok(validateConfig({ optimizer: { baseUrl: 'ftp://x' } }).issues)
})

test('config: half-finished optimizer settings warn instead of failing', () => {
  assert.equal(configWarnings(resolveConfig({ optimizer: { provider: 'p' } })).length, 1)
  assert.equal(configWarnings(resolveConfig({ optimizer: { baseUrl: 'http://h:11434/v1' } })).length, 1)
  assert.deepEqual(configWarnings(resolveConfig({ optimizer: { baseUrl: 'http://h:11434/v1', model: 'm' } })), [])
})

test('config: volatile references are unwrapped', () => {
  const ref = (value) => ({ get: () => value })
  const plain = unwrapConfig({ maxTools: ref(5), optimizer: ref({ model: 'm' }), coreTools: ['a'], cacheDir: '' })
  assert.deepEqual(plain, { maxTools: 5, optimizer: { model: 'm' }, coreTools: ['a'], cacheDir: '' })
})

test('optimizer: base URL routes to an OpenAI-compatible endpoint with the API key', async () => {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'hi' } }] }) }
  }
  const text = await chatCompletion({ baseUrl: 'http://h:11434/v1/', apiKey: 'k', model: 'm', system: 's', prompt: 'p', maxTokens: 9, fetch })
  assert.equal(text, 'hi')
  assert.equal(calls[0].url, 'http://h:11434/v1/chat/completions')
  assert.equal(calls[0].init.headers.authorization, 'Bearer k')
  assert.equal(JSON.parse(calls[0].init.body).model, 'm')

  const optimizer = new Optimizer({ config: resolveConfig({ optimizer: { baseUrl: 'http://h/v1', model: 'm' } }), store: { map: new Map() } })
  assert.equal(optimizer.route().baseUrl, 'http://h/v1')
  const waiting = new Optimizer({ config: resolveConfig({ optimizer: { baseUrl: 'http://h/v1' } }), store: { map: new Map() } })
  assert.equal(waiting.route(), undefined)
})

test('laya sidecar client posts to /ask and backs off after a refused connection', async () => {
  let now = 0
  let calls = 0
  const ok = sidecarClient('http://127.0.0.1:8787', {
    fetch: async (url, init) => {
      calls += 1
      assert.equal(url, 'http://127.0.0.1:8787/ask')
      assert.deepEqual(JSON.parse(init.body), { state: {}, questions: {} })
      return { ok: true, status: 200, json: async () => ({ answers: { q0: { noul: 0.9 } } }) }
    },
  })
  assert.equal((await ok.ask({ state: {}, questions: {} })).answers.q0.noul, 0.9)

  calls = 0
  const down = sidecarClient('http://127.0.0.1:8787', {
    now: () => now,
    retryMs: 1000,
    fetch: async () => {
      calls += 1
      throw new Error('ECONNREFUSED')
    },
  })
  await assert.rejects(down.ask({}), /laya-mcp serve/)
  await assert.rejects(down.ask({}), /laya-mcp serve/)
  assert.equal(calls, 1)
  now = 1001
  await assert.rejects(down.ask({}))
  assert.equal(calls, 2)
})

test('embeddings reconfigure switches model and clears failures', async () => {
  const index = new EmbeddingIndex({ url: 'http://a', model: 'm1', logger: {} })
  index.vectors.set('x', [1])
  index.failures = 5
  assert.equal(await index.reconfigure({ url: 'http://a', model: 'm1' }), false)
  assert.equal(await index.reconfigure({ url: 'http://b', model: 'm2', apiKey: 'k' }), true)
  assert.equal(index.vectors.size, 0)
  assert.equal(index.failures, 0)
  assert.equal(index.apiKey, 'k')
})

test('tokenize splits snake and camel case and strips plurals', () => {
  assert.deepEqual(tokenize('list_issues listPullRequests'), ['list', 'issue', 'list', 'pull', 'request'])
})

test('bm25 ranks keyword matches first', () => {
  const bm25 = new Bm25([
    { id: 'gh', text: 'github issues pull requests repositories' },
    { id: 'pg', text: 'postgres database sql query' },
  ])
  const scores = bm25.score('open a pull request')
  assert.ok(scores.get('gh') > 0)
  assert.equal(scores.get('pg'), undefined)
})

test('rrf keeps hits from either list', () => {
  const fused = reciprocalRankFusion([['a', 'b'], ['c', 'a']])
  assert.equal(fused[0].id, 'a')
  assert.deepEqual(new Set(fused.map((f) => f.id)), new Set(['a', 'b', 'c']))
})

test('laya questions carry true/false criteria and notFor boundaries', () => {
  const q = questionFor({ kind: 'skill', id: 'ux', name: 'ux', description: 'UI design', card: { description: 'Design UIs', notFor: ['backend bugs'] } })
  assert.equal(q.type, 'noul')
  assert.ok(q.criteria.true.length > 10)
  assert.match(q.criteria.false, /backend bugs/)
})

test('laya state keeps the request first so truncation cuts the tail', () => {
  const state = buildState({ current: 'now', earlier: ['before'], lastReply: 'reply', recentTools: ['bash'] })
  assert.equal(Object.keys(state)[0], 'request')
})

test('union merge: laya can add, cannot remove the recall floor', () => {
  const ranked = [
    { id: 'a', rank: 0, bm25: 2 },
    { id: 'b', rank: 1, bm25: 1 },
    { id: 'c', rank: 2, bm25: 0 },
  ]
  const probs = new Map([['skill:a', 0.01], ['skill:b', 0.02], ['skill:c', 0.9]])
  const merged = unionMerge({ ranked, kind: 'skill', probs, threshold: 0.35, floor: 2, layaOk: true })
  assert.deepEqual(merged.map((m) => m.id).sort(), ['a', 'b', 'c'])
  assert.equal(merged[0].id, 'c')
  assert.equal(merged.find((m) => m.id === 'a').reason, 'recall')
})

test('union merge: a floor rank without signal is not kept', () => {
  const ranked = [{ id: 'a', rank: 0, bm25: 0 }]
  assert.equal(unionMerge({ ranked, kind: 'skill', probs: new Map(), threshold: 0.5, floor: 3, layaOk: true }).length, 0)
})

test('laya timeout falls back to recall with a wider floor', async () => {
  const laya = fakeLaya(() => 0.9, { delayMs: 200 })
  const result = await askAll(laya, { request: 'x' }, [{ kind: 'skill', id: 's', name: 's', description: 'd' }], { timeoutMs: 20 })
  assert.equal(result.failed, true)
  const ranked = [0, 1, 2, 3, 4].map((i) => ({ id: `s${i}`, rank: i, bm25: 1 }))
  const merged = unionMerge({ ranked, kind: 'skill', probs: result.probs, threshold: 0.35, floor: 2, layaOk: false, fallbackCount: 4 })
  assert.equal(merged.length, 4)
})

test('laya questions are batched', async () => {
  const laya = fakeLaya(() => 0.5)
  const items = Array.from({ length: 5 }, (_, i) => ({ kind: 'skill', id: `s${i}`, name: `s${i}`, description: 'd' }))
  const result = await askAll(laya, { request: 'x' }, items, { batchSize: 2 })
  assert.equal(laya.calls.length, 3)
  assert.equal(result.probs.size, 5)
})

test('sticky set: small removals keep the previous list, additions always apply', () => {
  const previous = new Set(['a', 'b', 'c'])
  assert.equal(stickySet({ previous, desired: new Set(['a', 'b']) }, 2).changed, false)
  const grown = stickySet({ previous, desired: new Set(['a', 'b', 'c', 'd']) }, 2)
  assert.deepEqual([...grown.active].sort(), ['a', 'b', 'c', 'd'])
  const shrunk = stickySet({ previous, desired: new Set(['x']) }, 2)
  assert.deepEqual([...shrunk.active], ['x'])
  const kept = stickySet({ previous: undefined, desired: new Set(['a']), keep: new Set(['z']) }, 2)
  assert.deepEqual([...kept.active].sort(), ['a', 'z'])
})

test('filter keeps core and order, drops unselected group sections', () => {
  const tools = [tool('bash'), tool('mcp__gh__issues'), tool('mcp__pg__query'), tool('read')]
  const sections = [{ name: 'mcp:gh', text: 'GitHub' }, { name: 'mcp:pg', text: 'Postgres' }, { name: 'other', text: 'x' }]
  const config = resolveConfig({ embeddingsUrl: '', cacheDir: '.' })
  const { routable } = partitionTools(tools, config)
  const { groups } = buildToolCatalog(routable, sections, config, new Map())
  const out = filterAssembly({ tools, sections, contexts: [], variables: {} }, {
    routable: new Set(routable.map((t) => t.name)),
    active: new Set(['mcp__gh__issues']),
    groups,
  })
  assert.deepEqual(out.tools.map((t) => t.name), ['bash', 'mcp__gh__issues', 'read'])
  assert.deepEqual(out.sections.map((s) => s.name), ['mcp:gh', 'other'])
})

test('grouping: config, mcp server, prefix, single', () => {
  const config = resolveConfig({ embeddingsUrl: '', cacheDir: '.', groups: [{ id: 'remote', tools: ['ssh_*'] }] })
  const routable = [tool('ssh_exec'), tool('ssh_copy'), tool('mcp__gh__a'), tool('mcp__gh__b'), tool('jira_get'), tool('jira_put'), tool('weather')]
  const { groupOf } = buildToolCatalog(routable, [], config, new Map())
  assert.equal(groupOf.get('ssh_exec'), 'remote')
  assert.equal(groupOf.get('mcp__gh__a'), 'mcp:gh')
  assert.equal(groupOf.get('jira_put'), 'prefix:jira')
  assert.equal(groupOf.get('weather'), 'tool:weather')
})

test('tools for groups respects per-group and total budgets', () => {
  const groups = new Map([
    ['g1', { tools: ['a', 'b', 'c'] }],
    ['g2', { tools: ['d', 'e'] }],
  ])
  const toolRank = new Map([['c', 0], ['a', 1], ['b', 2], ['e', 3], ['d', 4]])
  assert.deepEqual(toolsForGroups({ groupIds: ['g1', 'g2'], groups, toolRank, maxTools: 3, maxToolsPerGroup: 2 }), ['c', 'a', 'e'])
})

test('directory is sorted, grouped and stable', () => {
  const skills = new Map([
    ['b-skill', { name: 'b-skill', category: 'design' }],
    ['a-skill', { name: 'a-skill', category: 'design' }],
    ['fix-it', { name: 'fix-it', category: 'troubleshooting' }],
  ])
  const text = renderDirectory(skills)
  assert.match(text, /design: a-skill, b-skill/)
  assert.match(text, /troubleshooting: fix-it/)
  assert.equal(text, renderDirectory(new Map([...skills].reverse())))
  assert.match(renderDirectory(skills, { cap: 1 }), /2 more not listed/)
})

test('hint lists pending suggestions and notes auto-loaded skills', () => {
  const hint = renderHint({
    suggested: [{ kind: 'skill', name: 'ux', description: 'UI design' }, { kind: 'skill', name: 'net', description: 'network fixes' }],
    loaded: new Set(),
    autoLoaded: ['net'],
  })
  assert.match(hint, /`ux`/)
  assert.doesNotMatch(hint, /`net`:/)
  assert.match(hint, /Loaded for this request.*net/)
  assert.equal(renderHint({ suggested: [] }), '')
})

test('skill choice: always, companions, budget', () => {
  const config = resolveConfig({ embeddingsUrl: '', cacheDir: '.', maxSkills: 3, alwaysSkills: ['base'], companions: { ux: ['a11y'] } })
  const skills = new Map(['base', 'ux', 'a11y', 'x', 'y'].map((n) => [n, { name: n }]))
  const merged = [{ id: 'ux' }, { id: 'x' }, { id: 'y' }]
  assert.deepEqual(chooseSkills({ merged, skills, config }), ['base', 'ux', 'a11y', 'x'])
})

test('auto-load needs both signals and the threshold, skips loaded skills', () => {
  const config = resolveConfig({ embeddingsUrl: '', cacheDir: '.', maxAutoLoad: 2, autoLoadThreshold: 0.85 })
  const merged = [
    { id: 'a', p: 0.95, reason: 'both' },
    { id: 'b', p: 0.95, reason: 'laya' },
    { id: 'c', p: 0.7, reason: 'both' },
    { id: 'd', p: 0.9, reason: 'both' },
    { id: 'e', p: 0.99, reason: 'both' },
  ]
  assert.deepEqual(chooseAutoLoad({ merged, config, loaded: new Set(['d']) }), ['a', 'e'])
})

test('optimizer cards: JSON extraction and grounding', () => {
  const raw = extractJson('<think>hmm</think>```json\n{"description":"Design and polish web interfaces and layouts","triggers":["make this page look better","fix the layout"],"notFor":["fix a SQL bug"],"category":"Design"}\n```')
  const ok = validateCard(raw, 'This skill helps design, polish and critique web interfaces, layouts and styling.', 'skill')
  assert.ok(ok.card)
  assert.equal(ok.card.category, 'design')
  const bad = validateCard({ description: 'Quantum blockchain spaceship telemetry orchestration', triggers: ['a', 'b'] }, 'resize images', 'skill')
  assert.match(bad.error, /not grounded/)
})

test('rankItems returns every item', () => {
  const items = [{ id: 'a', text: 'alpha' }, { id: 'b', text: 'beta' }]
  const ranked = rankItems({ items, query: 'beta' })
  assert.equal(ranked.length, 2)
  assert.equal(ranked[0].id, 'b')
})
