#!/usr/bin/env node
/**
 * Skill-recall eval against the live skill folders, local embeddings and the
 * Laya sidecar. For each case in cases.json it reports whether every expected
 * skill lands in the suggested list, under three selectors: BM25 only,
 * BM25 + embeddings, and the full Laya union.
 *
 *   npm run eval
 *   node eval/run.js --cases my-cases.json --skills-dir D:\skills --laya http://127.0.0.1:8787
 *
 * Cases whose expected skills are not installed are skipped and listed, so
 * the file can hold cases for skills you have not added yet.
 */

import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from '../config.js'
import { buildSkillCatalog, indexText } from '../catalog.js'
import { Bm25, EmbeddingIndex, rankItems } from '../recall.js'
import { askAll, buildState, unionMerge } from '../laya.js'
import { chooseAutoLoad, chooseSkills } from '../skills.js'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const flags = (name) => args.flatMap((value, i) => (args[i - 1] === `--${name}` ? [value] : []))

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const profile = flag('profile', 'desktop')
const roots = [
  ...flags('skills-dir'),
  join(dshHome, 'skills'),
  join(dshHome, 'profiles', profile, 'skills'),
  join(dshHome, 'profiles', profile, 'node_modules'),
  join(homedir(), '.agents', 'skills'),
]

async function findSkillFiles(root, depth = 0, out = []) {
  if (depth > 6) return out
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isFile() && entry.name === 'SKILL.md') out.push(path)
    else if (entry.isDirectory() && entry.name !== '.git' && !(entry.name === 'node_modules' && depth > 0)) {
      await findSkillFiles(path, depth + 1, out)
    }
  }
  return out
}

/** Minimal frontmatter reader: top-level scalars, quoted strings and folded blocks. */
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!match) return {}
  const out = {}
  const lines = match[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i])
    if (!m) continue
    let value = m[2].trim()
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const block = []
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim())
      value = block.join(value.startsWith('>') ? ' ' : '\n')
    } else if (/^["'].*["']$/.test(value)) {
      value = value.slice(1, -1)
    }
    out[m[1]] = value
  }
  return out
}

async function loadSkills() {
  const seen = new Map()
  for (const root of roots) {
    for (const file of await findSkillFiles(root)) {
      const text = await readFile(file, 'utf8').catch(() => '')
      const front = parseFrontmatter(text)
      const name = front.name || dirname(file).split(/[\\/]/).pop()
      if (!name || seen.has(name) || !front.description) continue
      seen.set(name, {
        name,
        description: front.description,
        whenToUse: front.when_to_use ?? front['when-to-use'] ?? '',
        provider: 'eval',
        resourceBase: { kind: 'directory', path: dirname(file) },
        invocation: { modelInvocable: front['disable-model-invocation'] !== 'true', userInvocable: true },
        metadata: front.category ? { category: front.category } : undefined,
        headings: text.split(/\r?\n/).filter((l) => /^#{1,3}\s/.test(l)).map((l) => l.replace(/^#+\s+/, '')).slice(0, 30),
      })
    }
  }
  return [...seen.values()]
}

const layaClient = (url) => ({
  async ask(body, options) {
    const response = await fetch(new URL('/ask', url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: options?.signal,
    })
    if (!response.ok) throw new Error(`Laya /ask returned HTTP ${response.status}`)
    return response.json()
  },
})

async function main() {
  const config = resolveConfig({ logLevel: 'silent' })
  const casesFile = resolve(flag('cases', join(here, 'cases.json')))
  const cases = JSON.parse(await readFile(casesFile, 'utf8'))
  const summaries = await loadSkills()
  if (summaries.length === 0) {
    console.log(`No skills found under:\n  ${roots.join('\n  ')}\nPass --skills-dir <folder> to point at your skills.`)
    process.exitCode = 1
    return
  }
  const headings = new Map(summaries.map((s) => [s.name, { hash: undefined, headings: s.headings }]))
  const skills = buildSkillCatalog(summaries, config, new Map(), headings)
  for (const s of summaries) skills.get(s.name) && (skills.get(s.name).headings = s.headings)
  const docs = [...skills.values()].map((item) => ({ id: item.id, text: indexText(item) }))
  const bm25 = new Bm25(docs)

  const embeddings = new EmbeddingIndex({ url: flag('embeddings', config.embeddingsUrl), model: flag('model', config.embeddingModel), cacheDir: config.cacheDir })
  await embeddings.ensure(docs.map((d) => d.text))
  const embeddingsOk = embeddings.healthy && docs.every((d) => embeddings.vectorFor(d.text))
  const layaUrl = flag('laya', 'http://127.0.0.1:8787')
  const laya = layaClient(layaUrl)

  const runnable = cases.filter((c) => c.expect.every((name) => skills.has(name)))
  const skipped = cases.filter((c) => !runnable.includes(c))
  console.log(`${skills.size} skills · ${runnable.length} runnable cases · ${skipped.length} skipped · embeddings ${embeddingsOk ? 'on' : 'off'} · laya ${layaUrl}\n`)

  const modes = { bm25: { hits: 0, size: 0 }, embeddings: { hits: 0, size: 0 }, laya: { hits: 0, size: 0, ms: 0, failures: 0, autoLoadHits: 0 } }
  for (const c of runnable) {
    const query = { current: c.request, earlier: [], lastReply: '', recentTools: [], text: c.request }
    const vector = embeddingsOk ? await embeddings.query(c.request) : undefined
    const lexical = rankItems({ items: docs, bm25, query: c.request })
    const fused = rankItems({ items: docs, bm25, query: c.request, queryVector: vector, embeddings })
    const pick = (ranked, probs, layaOk) => {
      const merged = unionMerge({ ranked, kind: 'skill', probs, threshold: config.skillKeep, floor: config.skillKeepTop, layaOk, fallbackCount: Math.max(config.skillKeepTop, 5) })
      return { merged, names: chooseSkills({ merged, skills, config }) }
    }
    const a = pick(lexical, new Map(), false)
    const b = pick(fused, new Map(), false)
    const result = await askAll(laya, buildState(query), [...skills.values()], { batchSize: config.layaBatchSize, timeoutMs: 20000 })
    const d = pick(fused, result.probs, !result.failed)
    const hit = (names) => c.expect.every((name) => names.includes(name))
    modes.bm25.hits += hit(a.names); modes.bm25.size += a.names.length
    modes.embeddings.hits += hit(b.names); modes.embeddings.size += b.names.length
    modes.laya.hits += hit(d.names); modes.laya.size += d.names.length; modes.laya.ms += result.latencyMs
    if (result.failed) modes.laya.failures += 1
    const auto = chooseAutoLoad({ merged: d.merged, config, loaded: new Set() })
    if (c.expect.some((name) => auto.includes(name))) modes.laya.autoLoadHits += 1
    const mark = (ok) => (ok ? 'ok ' : 'MISS')
    console.log(`${mark(hit(d.names))} ${c.request}`)
    console.log(`     expect ${c.expect.join(', ')} · laya ${d.names.join(', ') || '-'}${result.failed ? ` (laya failed: ${result.error})` : ''}${auto.length ? ` · auto-load ${auto.join(', ')}` : ''}`)
  }
  const n = runnable.length || 1
  console.log('\nRecall (all expected skills suggested) and average suggestions per request:')
  for (const [mode, m] of Object.entries(modes)) {
    console.log(`  ${mode.padEnd(10)} ${((m.hits / n) * 100).toFixed(0).padStart(3)}%  avg ${(m.size / n).toFixed(1)} skills${mode === 'laya' ? `  · ${Math.round(m.ms / n)} ms/request · ${m.failures} failures · auto-load hit ${m.autoLoadHits}` : ''}`)
  }
  if (modes.laya.failures === runnable.length && runnable.length > 0) {
    console.log(`\nEvery Laya call failed. Start the sidecar (laya-mcp serve) or pass --laya <url>.`)
  }
  if (!embeddingsOk) console.log(`\nEmbeddings were off. Start Ollama and run \`ollama pull ${config.embeddingModel}\`, or pass --embeddings <url>.`)
  if (skipped.length) console.log(`\nSkipped (skill not installed): ${skipped.map((c) => c.expect.join('+')).join(', ')}`)
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
