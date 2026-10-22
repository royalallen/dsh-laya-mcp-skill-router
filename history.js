/**
 * Reads the routing query and recent tool use from the agent's session log,
 * scanning backwards over a bounded window.
 */

const SCAN_LIMIT = 400

/**
 * Plain text of one message's text blocks.
 * @param message - LLM message.
 * @returns joined text.
 */
export function messageText(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * Whether a message is direct user input (not a catalog, context, or skill injection).
 * @param message - LLM message.
 * @returns true for user-authored input.
 */
export function isUserInput(message) {
  return message?.role === 'user' && message?.source?.kind === 'user'
}

const eventMessage = (event) => event?.data?.message ?? event?.data

/**
 * Recent conversation facts used to build the routing query.
 * @param session - `agent.session` (`seq`, `eventAt`).
 * @param options - `turns`: earlier user requests to include.
 * @returns `{ userTexts, lastReply, recentTools, loadedSkills }`, oldest first for lists.
 */
export function readHistory(session, { turns = 2 } = {}) {
  const userTexts = []
  const recentTools = []
  const loadedSkills = new Set()
  let lastReply = ''
  if (!session || typeof session.eventAt !== 'function' || typeof session.seq !== 'number') {
    return { userTexts, lastReply, recentTools, loadedSkills }
  }
  const stop = Math.max(0, session.seq - SCAN_LIMIT)
  for (let index = session.seq - 1; index >= stop; index -= 1) {
    let event
    try {
      event = session.eventAt(index)
    } catch {
      break
    }
    if (!event) continue
    if (event.type === 'user/message') {
      const message = eventMessage(event)
      if (isUserInput(message) && userTexts.length < turns + 1) {
        const text = messageText(message)
        if (text) userTexts.unshift(text)
      } else if (message?.source?.kind === 'skill-invocation' && message.source.name) {
        loadedSkills.add(message.source.name)
      }
    } else if (event.type === 'assistant/message') {
      const message = eventMessage(event)
      if (!lastReply) lastReply = messageText(message)
      for (const block of message?.content ?? []) {
        if (block?.type !== 'tool-call' || !block.name) continue
        recentTools.unshift(block.name)
        if (block.name === 'skill') {
          try {
            const args = JSON.parse(block.arguments ?? '{}')
            if (typeof args.name === 'string') loadedSkills.add(args.name)
          } catch {
            // malformed arguments; the call failed anyway
          }
        }
      }
    }
  }
  return { userTexts, lastReply, recentTools, loadedSkills }
}

/**
 * Tool names called in the last `turns` turns, newest turn last.
 * @param session - `agent.session`.
 * @param turns - how many turns back to look.
 * @returns set of tool names.
 */
export function toolsCalledInRecentTurns(session, turns) {
  const names = new Set()
  if (!session || typeof session.eventAt !== 'function' || turns <= 0) return names
  let turnStarts = 0
  const stop = Math.max(0, session.seq - SCAN_LIMIT * 2)
  for (let index = session.seq - 1; index >= stop; index -= 1) {
    let event
    try {
      event = session.eventAt(index)
    } catch {
      break
    }
    if (!event) continue
    if (event.type === 'turn/start') {
      turnStarts += 1
      if (turnStarts > turns) break
    } else if (event.type === 'assistant/message') {
      for (const block of eventMessage(event)?.content ?? []) {
        if (block?.type === 'tool-call' && block.name) names.add(block.name)
      }
    }
  }
  return names
}

/**
 * The routing query for this turn. The newest claimed user text wins; when the
 * claim holds none (a tool-result step), the latest user text from history is
 * reused.
 * @param claimedTexts - user texts claimed for this step.
 * @param history - result of {@link readHistory}.
 * @param turns - earlier requests to include.
 * @returns `{ current, earlier, lastReply, recentTools, text }`; `text` is the embedding/BM25 query.
 */
export function buildQuery(claimedTexts, history, turns) {
  const all = [...history.userTexts]
  for (const text of claimedTexts) if (text && all[all.length - 1] !== text) all.push(text)
  const current = all[all.length - 1] ?? ''
  const earlier = all.slice(Math.max(0, all.length - 1 - turns), -1)
  const recentTools = history.recentTools.slice(-10)
  const text = [current, ...earlier.slice(-1), recentTools.length ? `recent tools: ${recentTools.join(' ')}` : '']
    .filter(Boolean)
    .join('\n')
  return { current, earlier, lastReply: history.lastReply, recentTools, text }
}
