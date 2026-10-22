/**
 * Laya precision pass. One `noul` per skill and per group, each with explicit
 * `criteria` text for true and false (Laya is near chance without it), sent in
 * batches through the `ctx.laya` service published by dsh-laya.
 */

import { shortDescription } from './catalog.js'
import { withTimeout } from './store.js'

/** A recall rank only counts toward the floor when it carries real signal. */
export const MIN_COSINE_SIGNAL = 0.45

const SKILL_TRUE =
  'following this skill\'s instructions would improve how the request is handled, ' +
  'including design, style, troubleshooting, or process guidance'
const SKILL_FALSE = 'the skill is unrelated to the request'
const GROUP_TRUE = 'handling the request needs these tools or would clearly benefit from them'
const GROUP_FALSE = 'these tools are unrelated or only loosely related to the request'

const clip = (text, max) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/**
 * Laya state for the turn. Keys are ordered so the current request survives
 * truncation: Laya cuts an oversized state from the END.
 * @param query - `{ current, earlier, lastReply, recentTools }`.
 * @returns the state object.
 */
export function buildState({ current, earlier = [], lastReply = '', recentTools = [] }) {
  const state = { request: clip(current, 2000) }
  if (recentTools.length > 0) state.recent_tools = recentTools.slice(-10).join(', ')
  if (earlier.length > 0) state.earlier_requests = earlier.map((text) => clip(text, 400)).join(' | ')
  if (lastReply) state.last_reply = clip(lastReply, 500)
  return state
}

const falseText = (base, item) => {
  const notFor = item.card?.notFor
  return Array.isArray(notFor) && notFor.length > 0 ? `${base}, for example: ${notFor.slice(0, 4).join('; ')}` : base
}

/**
 * One noul question for an item.
 * @param item - skill or group item.
 * @returns the question body.
 */
export function questionFor(item) {
  if (item.kind === 'skill') {
    return {
      type: 'noul',
      instructions: `Should the assistant load the skill "${item.name}" for this request? Skill: ${shortDescription(item, 300)}`,
      criteria: { true: SKILL_TRUE, false: falseText(SKILL_FALSE, item) },
    }
  }
  return {
    type: 'noul',
    instructions: `Does this request need the tool set "${item.label ?? item.id}"? ${shortDescription(item, 300)}`,
    criteria: { true: GROUP_TRUE, false: falseText(GROUP_FALSE, item) },
  }
}

/**
 * Ask Laya about every item, batched.
 * @param laya - the `ctx.laya` service (`ask(body, { signal })`).
 * @param state - state object from {@link buildState}.
 * @param items - skill and/or group items.
 * @param options - `batchSize`, `timeoutMs`, `signal`.
 * @returns `{ probs, latencyMs, truncated, failed, error }`; `probs` maps item key to P(true).
 */
export async function askAll(laya, state, items, { batchSize = 16, timeoutMs = 5000, signal } = {}) {
  const started = Date.now()
  const probs = new Map()
  if (!laya || typeof laya.ask !== 'function' || items.length === 0) {
    return { probs, latencyMs: 0, truncated: false, failed: !laya, error: laya ? undefined : 'laya service not mounted' }
  }
  let truncated = false
  const deadline = started + timeoutMs
  try {
    for (let offset = 0; offset < items.length; offset += batchSize) {
      const batch = items.slice(offset, offset + batchSize)
      const questions = {}
      batch.forEach((item, index) => {
        questions[`q${offset + index}`] = questionFor(item)
      })
      const remaining = Math.max(1, deadline - Date.now())
      const result = await withTimeout(laya.ask({ state, questions }, signal ? { signal } : undefined), remaining, signal)
      if (result?.truncated) truncated = true
      const answers = result?.answers ?? {}
      batch.forEach((item, index) => {
        const answer = answers[`q${offset + index}`]
        const p = typeof answer?.noul === 'number' ? answer.noul : typeof answer?.p_true === 'number' ? answer.p_true : undefined
        if (p !== undefined) probs.set(keyOf(item), p)
      })
    }
    return { probs, latencyMs: Date.now() - started, truncated, failed: false }
  } catch (error) {
    return { probs, latencyMs: Date.now() - started, truncated, failed: true, error: error?.message ?? String(error) }
  }
}

/**
 * Stable map key for an item across kinds.
 * @param item - skill or group item.
 * @returns `skill:<name>` or `group:<id>`.
 */
export function keyOf(item) {
  return `${item.kind}:${item.id}`
}

const hasSignal = (entry) => entry.bm25 > 0 || (typeof entry.cosine === 'number' && entry.cosine >= MIN_COSINE_SIGNAL)

/**
 * Union merge. An item is kept when Laya says yes at `threshold`, or when it is
 * in the recall top `floor` with real signal. Laya can add items recall missed
 * and cannot remove the recall floor. Without Laya, recall decides alone.
 * @param input - `ranked` (from rankItems), `kind`, `probs`, `threshold`, `floor`, `layaOk`, `fallbackCount`.
 * @returns `[{ id, p, rank, reason }]` ordered by Laya probability, then recall rank.
 */
export function unionMerge({ ranked, kind, probs, threshold, floor, layaOk, fallbackCount = floor }) {
  const out = new Map()
  const floorCount = layaOk ? floor : Math.max(floor, fallbackCount)
  ranked.forEach((entry) => {
    const p = probs?.get(`${kind}:${entry.id}`)
    const inFloor = entry.rank < floorCount && hasSignal(entry)
    const yes = layaOk && typeof p === 'number' && p >= threshold
    if (yes || inFloor) out.set(entry.id, { id: entry.id, p, rank: entry.rank, reason: yes ? (inFloor ? 'both' : 'laya') : 'recall' })
  })
  return [...out.values()].sort((a, b) => (b.p ?? -1) - (a.p ?? -1) || a.rank - b.rank)
}
