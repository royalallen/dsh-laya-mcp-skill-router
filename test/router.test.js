import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { assemblyOf, fakeAgent, fakeLaya, makeRouter, skill, tool, userMsg } from './helpers.js'
import { HINT_CONTEXT } from '../router.js'

const TOOLS = [
  tool('bash'), tool('read'), tool('skill'), tool('request_more', 'base'),
  tool('mcp__github__list_issues', 'List GitHub issues in a repository'),
  tool('mcp__github__create_pull_request', 'Open a pull request on GitHub'),
  tool('mcp__postgres__query', 'Run a SQL query against the Postgres database'),
  tool('mcp__figma__get_file', 'Read a Figma design file and its frames'),
  tool('router_preview'), tool('router_stats'), tool('router_cards'),
]
const SECTIONS = [{ name: 'mcp:github', text: 'GitHub server' }, { name: 'mcp:postgres', text: 'Postgres server' }, { name: 'mcp:figma', text: 'Figma server' }]
const SKILLS = [
  skill('ui-design', 'Design and polish user interfaces, layouts, typography and color'),
  skill('wifi-troubleshooting', 'Diagnose Wi-Fi and network connectivity problems on Windows'),
  skill('sql-tuning', 'Tune slow SQL queries and database indexes'),
]

const turn = (router, agent, text, turnNo = 1) => {
  router.noteClaimed(agent, userMsg(text), turnNo)
}

const assembled = () => ({ ...assemblyOf(TOOLS, SECTIONS), contexts: [{ name: HINT_CONTEXT, text: '' }] })

test('recall-only routing keeps core tools and the matching group', async () => {
  const { router } = makeRouter({ config: { selector: 'bm25' }, skills: SKILLS })
  const agent = fakeAgent()
  turn(router, agent, 'list the open github issues in my repository')
  const out = await router.onAssemble(assembled(), { agent })
  const names = out.tools.map((t) => t.name)
  for (const core of ['bash', 'read', 'skill', 'request_more']) assert.ok(names.includes(core))
  assert.ok(names.includes('mcp__github__list_issues'))
  assert.ok(!names.includes('mcp__postgres__query'))
  assert.ok(out.sections.some((s) => s.name === 'mcp:github'))
  assert.ok(!out.sections.some((s) => s.name === 'mcp:postgres'))
  assert.match(out.tools.find((t) => t.name === 'request_more').description, /mcp:postgres/)
})

test('laya adds a group recall missed and suggests a design skill', async () => {
  const laya = fakeLaya((question) => (/figma|ui-design/.test(question.instructions) ? 0.92 : 0.05))
  const { router } = makeRouter({ laya, skills: SKILLS })
  const agent = fakeAgent()
  turn(router, agent, 'make the landing page feel more premium')
  const out = await router.onAssemble(assembled(), { agent })
  assert.ok(out.tools.some((t) => t.name === 'mcp__figma__get_file'))
  const hint = out.contexts.find((c) => c.name === HINT_CONTEXT).text
  assert.match(hint, /ui-design/)
  assert.equal(laya.calls.length, 1)
})

test('selection is cached within a turn and re-ranked on a new request', async () => {
  const laya = fakeLaya(() => 0.1)
  const { router } = makeRouter({ laya, skills: SKILLS })
  const agent = fakeAgent()
  turn(router, agent, 'query the postgres database')
  await router.onAssemble(assembled(), { agent })
  agent.session.user('query the postgres database')
  await router.onAssemble(assembled(), { agent })
  assert.equal(laya.calls.length, 1)
  turn(router, agent, 'now fix my wifi', 2)
  await router.onAssemble(assembled(), { agent })
  assert.equal(laya.calls.length, 2)
})

test('laya failure falls back to recall without throwing', async () => {
  const laya = fakeLaya(() => 1, { fail: true })
  const { router } = makeRouter({ laya, skills: SKILLS })
  const agent = fakeAgent()
  turn(router, agent, 'run a sql query against postgres')
  const out = await router.onAssemble(assembled(), { agent })
  assert.ok(out.tools.some((t) => t.name === 'mcp__postgres__query'))
  assert.equal(router.turnStats.at(-1).layaFailed, true)
})

test('guard denies hidden tools with a request_more hint and logs the miss', async () => {
  const { router, config } = makeRouter({ config: { selector: 'bm25' }, skills: SKILLS })
  const agent = fakeAgent()
  turn(router, agent, 'list github issues')
  await router.onAssemble(assembled(), { agent })
  const reason = router.guard({ name: 'mcp__postgres__query', agent, arguments: {} })
  assert.match(reason, /request_more/)
  assert.match(reason, /mcp:postgres/)
  assert.equal(router.guard({ name: 'bash', agent, arguments: {} }), undefined)
  assert.equal(router.guard({ name: 'mcp__github__list_issues', agent, arguments: {} }), undefined)
  assert.equal(router.guard({ name: 'mcp__postgres__query', agent, arguments: {}, parent: 'x' }), undefined)
  router.guard({ name: 'skill', agent, arguments: { name: 'sql-tuning' } })
  assert.deepEqual(router.misses.map((m) => m.type), ['tool', 'skill'])
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(existsSync(join(config.cacheDir, 'misses.jsonl')))
})

test('request_more pins tools for the next step and is capped per turn', async () => {
  const { router } = makeRouter({ config: { selector: 'bm25', maxEscalations: 2 }, skills: SKILLS })
  const agent = fakeAgent()
  turn(router, agent, 'list github issues')
  await router.onAssemble(assembled(), { agent })
  const first = await router.requestMore(agent, { group: 'mcp:postgres' })
  assert.match(first.text, /Loaded 1 tool/)
  assert.equal(router.guard({ name: 'mcp__postgres__query', agent, arguments: {} }), undefined)
  const out = await router.onAssemble(assembled(), { agent })
  assert.ok(out.tools.some((t) => t.name === 'mcp__postgres__query'))
  await router.requestMore(agent, { skills: 'wifi keeps dropping' })
  const third = await router.requestMore(agent, { tools: ['mcp__figma__get_file'] })
  assert.match(third.text, /already used 2 times/)
  turn(router, agent, 'next question', 2)
  const fresh = await router.requestMore(agent, { tools: ['mcp__figma__get_file'] })
  assert.match(fresh.text, /Loaded 1 tool/)
})

test('request_more skill search suggests matches and adds them to the hint', async () => {
  const { router } = makeRouter({ config: { selector: 'bm25' }, skills: SKILLS })
  const agent = fakeAgent()
  turn(router, agent, 'hello')
  await router.onAssemble(assembled(), { agent })
  const result = await router.requestMore(agent, { skills: 'diagnose network connectivity on windows' })
  assert.match(result.text, /wifi-troubleshooting/)
  const out = await router.onAssemble(assembled(), { agent })
  assert.match(out.contexts.find((c) => c.name === HINT_CONTEXT).text, /wifi-troubleshooting/)
})

test('pre-step swaps the full catalog for the directory and auto-loads confident skills once', async () => {
  const laya = fakeLaya((question) => (/wifi-troubleshooting/.test(question.instructions) ? 0.97 : 0.02))
  const { router } = makeRouter({ laya, skills: SKILLS })
  const agent = fakeAgent()
  turn(router, agent, 'my wifi network keeps disconnecting on windows')
  await router.onAssemble(assembled(), { agent })
  const catalog = {
    id: 'cat', role: 'user',
    content: [{ type: 'text', text: '<available_skills>\n' + SKILLS.map((s) => `- \`${s.name}\`: ${s.description}`).join('\n') + '\n</available_skills>' }],
    source: { kind: 'skill-catalog', form: 'catalog', entries: SKILLS.map((s) => ({ name: s.name, description: s.description })) },
  }
  const decision = await router.onPreStep(agent, { kind: 'enter', messages: [userMsg('x'), catalog] }, undefined)
  const directory = decision.messages[1]
  assert.deepEqual(directory.source, catalog.source)
  assert.match(directory.content[0].text, /<skill_directory>/)
  assert.doesNotMatch(directory.content[0].text, /Diagnose Wi-Fi/)
  const loaded = decision.messages.filter((m) => m.source.kind === 'skill-invocation')
  assert.deepEqual(loaded.map((m) => m.source.name), ['wifi-troubleshooting'])
  assert.match(loaded[0].content[0].text, /<skill_content name="wifi-troubleshooting">/)

  await router.onAssemble(assembled(), { agent })
  const again = await router.onPreStep(agent, { kind: 'enter', messages: [] }, undefined)
  assert.equal(again.messages.length, 0)
})

test('stickiness keeps a recently called tool across turns', async () => {
  const { router } = makeRouter({ config: { selector: 'bm25' }, skills: SKILLS })
  const agent = fakeAgent()
  turn(router, agent, 'run a sql query on postgres')
  await router.onAssemble(assembled(), { agent })
  agent.session.push('turn/start', { turn: 1 })
  agent.session.user('run a sql query on postgres')
  agent.session.assistant('', [{ name: 'mcp__postgres__query' }])
  agent.session.push('turn/start', { turn: 2 })
  turn(router, agent, 'list github issues', 2)
  const out = await router.onAssemble(assembled(), { agent })
  assert.ok(out.tools.some((t) => t.name === 'mcp__postgres__query'))
  assert.ok(out.tools.some((t) => t.name === 'mcp__github__list_issues'))
})

test('dry run returns the assembly untouched and blanks the hint', async () => {
  const { router } = makeRouter({ config: { selector: 'bm25', apply: false }, skills: SKILLS })
  const agent = fakeAgent()
  turn(router, agent, 'list github issues')
  const input = assembled()
  const out = await router.onAssemble(input, { agent })
  assert.equal(out, input)
  assert.equal(router.hintFor(agent), '')
  assert.equal(router.guard({ name: 'mcp__postgres__query', agent, arguments: {} }), undefined)
})

test('router_preview and router_stats report without changing state', async () => {
  const { router } = makeRouter({ config: { selector: 'bm25' }, skills: SKILLS })
  const agent = fakeAgent()
  turn(router, agent, 'list github issues')
  await router.onAssemble(assembled(), { agent })
  const preview = await router.preview(agent, 'tune my slow sql query')
  assert.match(preview.text, /sql-tuning/)
  assert.match(router.stats().text, /Tool schema tokens/)
})

test('README exists for the repo', () => {
  assert.ok(readFileSync(new URL('../README.md', import.meta.url), 'utf8').includes('dsh-dynamic-router'))
})
