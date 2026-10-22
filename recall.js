/**
 * Recall: BM25 over item text plus local Ollama embeddings, fused by
 * reciprocal rank so a keyword hit and a semantic hit both survive.
 */

import { join } from 'node:path'
import { hashOf, readJson, writeJsonAtomic, debounce, withTimeout } from './store.js'

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'for', 'from', 'how', 'i', 'if', 'in',
  'into', 'is', 'it', 'its', 'me', 'my', 'no', 'not', 'of', 'on', 'or', 'our', 'please', 'so', 'that', 'the',
  'their', 'then', 'there', 'these', 'this', 'to', 'up', 'us', 'use', 'was', 'we', 'what', 'when', 'where',
  'which', 'while', 'who', 'why', 'will', 'with', 'you', 'your', 'can', 'could', 'should', 'would', 'just',
  'some', 'any', 'all', 'about', 'get', 'got', 'have', 'has', 'had', 'want', 'need', 'make', 'let',
])

/**
 * Lowercase word tokens with light suffix stripping. Splits snake_case and
 * camelCase so `list_issues` and `listIssues` match "issues".
 * @param text - input text.
 * @returns tokens.
 */
export function tokenize(text) {
  const spaced = String(text ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
  const out = []
  for (let token of spaced.split(' ')) {
    if (token.length < 2 || STOPWORDS.has(token)) continue
    if (token.length > 4 && token.endsWith('ies')) token = `${token.slice(0, -3)}y`
    else if (token.length > 5 && token.endsWith('ing')) token = token.slice(0, -3)
    else if (token.length > 4 && /(x|z|ch|sh|ss)es$/.test(token)) token = token.slice(0, -2)
    else if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss') && !token.endsWith('us')) token = token.slice(0, -1)
    out.push(token)
  }
  return out
}

/** Okapi BM25 over a fixed document set. */
export class Bm25 {
  /**
   * @param docs - `{ id, text }` documents.
   * @param options - `k1` and `b` parameters.
   */
  constructor(docs, { k1 = 1.2, b = 0.75 } = {}) {
    this.k1 = k1
    this.b = b
    this.docs = docs.map((doc) => {
      const tokens = tokenize(doc.text)
      const tf = new Map()
      for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1)
      return { id: doc.id, tf, length: tokens.length }
    })
    this.avgLength = this.docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, this.docs.length)
    this.df = new Map()
    for (const doc of this.docs) for (const token of doc.tf.keys()) this.df.set(token, (this.df.get(token) ?? 0) + 1)
  }

  /**
   * Score every document against a query.
   * @param query - query text.
   * @returns map of id to score; zero-score documents are omitted.
   */
  score(query) {
    const terms = [...new Set(tokenize(query))]
    const scores = new Map()
    const n = this.docs.length
    for (const term of terms) {
      const df = this.df.get(term)
      if (!df) continue
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
      for (const doc of this.docs) {
        const tf = doc.tf.get(term)
        if (!tf) continue
        const norm = tf * (this.k1 + 1) / (tf + this.k1 * (1 - this.b + this.b * doc.length / (this.avgLength || 1)))
        scores.set(doc.id, (scores.get(doc.id) ?? 0) + idf * norm)
      }
    }
    return scores
  }
}

/**
 * Reciprocal rank fusion.
 * @param rankings - lists of ids, best first. Ids absent from a list get nothing from it.
 * @param k - damping constant.
 * @returns `{ id, score }` sorted best first.
 */
export function reciprocalRankFusion(rankings, k = 60) {
  const scores = new Map()
  for (const ranking of rankings) {
    ranking.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1)))
  }
  return [...scores.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score)
}

/**
 * Cosine similarity of two equal-length vectors.
 * @param a - vector.
 * @param b - vector.
 * @returns similarity in [-1, 1], or 0 for a zero vector.
 */
export function cosine(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb)
}

/**
 * Embeddings from a loopback Ollama with an on-disk cache keyed by the model
 * and a hash of the text, so a restart re-embeds only what changed.
 */
export class EmbeddingIndex {
  /**
   * @param options - `url`, `model`, `cacheDir`, `logger`, optional `fetch`, `batchSize`, `timeoutMs`.
   */
  constructor({ url, model, cacheDir, logger, fetch: fetchImpl = globalThis.fetch, batchSize = 32, timeoutMs = 30000 }) {
    this.url = url
    this.model = model
    this.file = cacheDir ? join(cacheDir, 'embeddings.json') : undefined
    this.logger = logger
    this.fetch = fetchImpl
    this.batchSize = batchSize
    this.timeoutMs = timeoutMs
    this.vectors = new Map()
    this.loaded = false
    this.failures = 0
    this.lastError = undefined
    this.save = debounce(() => this.persist(), 1500)
  }

  get enabled() {
    return Boolean(this.url) && Boolean(this.model)
  }

  /** Whether recent calls are failing; turns skip the query embedding while true. */
  get healthy() {
    return this.enabled && this.failures < 3
  }

  /** Load cached vectors for this model. */
  async load() {
    if (this.loaded || !this.file) {
      this.loaded = true
      return
    }
    const data = await readJson(this.file, {})
    const forModel = data?.[this.model]
    if (forModel && typeof forModel === 'object') {
      for (const [key, vector] of Object.entries(forModel)) if (Array.isArray(vector)) this.vectors.set(key, vector)
    }
    this.loaded = true
  }

  async persist() {
    if (!this.file) return
    const data = await readJson(this.file, {})
    data[this.model] = Object.fromEntries(this.vectors)
    await writeJsonAtomic(this.file, data)
  }

  /**
   * Cache key for a text.
   * @param text - text to embed.
   * @returns cache key.
   */
  keyOf(text) {
    return hashOf(this.model, text)
  }

  /**
   * Vector for a text if it was embedded before.
   * @param text - text.
   * @returns the vector or undefined.
   */
  vectorFor(text) {
    return this.vectors.get(this.keyOf(text))
  }

  async embed(inputs, signal) {
    const response = await withTimeout(
      this.fetch(new URL('/api/embed', this.url).toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: inputs }),
        signal,
      }),
      this.timeoutMs,
      signal,
    )
    if (!response.ok) {
      let detail = ''
      try {
        detail = (await response.json())?.error ?? ''
      } catch {
        // body was not JSON
      }
      throw new Error(`Ollama /api/embed returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
    }
    const body = await response.json()
    if (!Array.isArray(body?.embeddings) || body.embeddings.length !== inputs.length) {
      throw new Error('Ollama /api/embed returned an unexpected body')
    }
    return body.embeddings
  }

  /**
   * Embed every text not yet cached, in batches. Never throws; failures are
   * counted and reported once so routing falls back to BM25.
   * @param texts - texts to make available.
   * @param signal - optional abort signal.
   * @returns number of new vectors.
   */
  async ensure(texts, signal) {
    if (!this.enabled) return 0
    await this.load()
    const missing = [...new Set(texts)].filter((text) => !this.vectors.has(this.keyOf(text)))
    let added = 0
    for (let i = 0; i < missing.length; i += this.batchSize) {
      const batch = missing.slice(i, i + this.batchSize)
      try {
        const vectors = await this.embed(batch, signal)
        batch.forEach((text, index) => this.vectors.set(this.keyOf(text), vectors[index]))
        added += batch.length
        this.failures = 0
      } catch (error) {
        this.noteFailure(error)
        break
      }
    }
    if (added > 0) this.save()
    return added
  }

  /**
   * Embed one query, uncached.
   * @param text - query text.
   * @param signal - optional abort signal.
   * @returns the vector, or undefined when embeddings are unavailable.
   */
  async query(text, signal) {
    if (!this.healthy || !text) return undefined
    await this.load()
    try {
      const [vector] = await this.embed([text], signal)
      this.failures = 0
      return vector
    } catch (error) {
      this.noteFailure(error)
      return undefined
    }
  }

  noteFailure(error) {
    this.failures += 1
    const message = error?.message ?? String(error)
    if (message !== this.lastError) {
      this.lastError = message
      this.logger?.warn?.(
        `[dynamic-router] embeddings unavailable (${message}); routing uses BM25 only. ` +
          `Start Ollama at ${this.url} and run \`ollama pull ${this.model}\`, or set embeddingsUrl: '' to silence this.`,
      )
    }
  }

  /** Allow another attempt after a quiet period. */
  resetHealth() {
    this.failures = 0
  }
}

/**
 * Rank items for a query with BM25 and, when available, embeddings.
 * @param input - `items` (`{ id, text }`), a prebuilt `bm25`, the `query`, optional `queryVector` and `embeddings`.
 * @returns ranked `{ id, score, bm25, cosine, rank }`, best first; every item appears.
 */
export function rankItems({ items, bm25, query, queryVector, embeddings }) {
  const bm25Scores = (bm25 ?? new Bm25(items)).score(query)
  const lexical = [...bm25Scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
  const cosines = new Map()
  let semantic = []
  if (queryVector && embeddings) {
    for (const item of items) {
      const vector = embeddings.vectorFor(item.text)
      if (vector) cosines.set(item.id, cosine(queryVector, vector))
    }
    semantic = [...cosines.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
  }
  const fused = reciprocalRankFusion(semantic.length > 0 ? [lexical, semantic] : [lexical])
  const seen = new Set(fused.map((entry) => entry.id))
  for (const item of items) if (!seen.has(item.id)) fused.push({ id: item.id, score: 0 })
  return fused.map((entry, rank) => ({
    id: entry.id,
    score: entry.score,
    bm25: bm25Scores.get(entry.id) ?? 0,
    cosine: cosines.get(entry.id),
    rank,
  }))
}
