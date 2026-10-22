/**
 * Skill-side rendering and selection: the stable names directory that
 * replaces the full `<available_skills>` text, the per-turn hint, and the
 * merge rules that decide which skills are suggested and auto-loaded.
 */

import { shortDescription } from './catalog.js'

const escapeText = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/**
 * Names-only directory grouped by category. Sorted, so the text is identical
 * for the same skill set and stays cached.
 * @param skills - skill items by name.
 * @param options - `cap` on listed names, `update` when it replaces an earlier catalog.
 * @returns the reminder text.
 */
export function renderDirectory(skills, { cap = 300, update = false } = {}) {
  const byCategory = new Map()
  const names = [...skills.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  let listed = 0
  for (const item of names) {
    if (listed >= cap) break
    const list = byCategory.get(item.category) ?? []
    list.push(item.name)
    byCategory.set(item.category, list)
    listed += 1
  }
  const categories = [...byCategory.keys()].sort()
  const lines = categories.map((category) => `${category}: ${byCategory.get(category).join(', ')}`)
  const hidden = names.length - listed
  if (hidden > 0) lines.push(`(${hidden} more not listed; call request_more with {"skills": "<what you need>"} to search them)`)

  if (names.length === 0) {
    return [
      '<system-reminder>',
      update
        ? 'No skills are currently available through the `skill` tool. Do not use names from earlier skill lists.'
        : 'No skills are installed in this session.',
      'A user may still invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool for it.',
      '</system-reminder>',
    ].join('\n')
  }
  return [
    '<system-reminder>',
    update
      ? 'The installed skills changed. This directory replaces every earlier skill list in this session.'
      : 'A skill is a reusable set of task-specific instructions, loaded with the `skill` tool.',
    'Each step, the runtime context lists "Suggested skills" picked for the current request, with descriptions. Every installed skill is named below by category; if one fits better than the suggestions, call `skill` with its exact name, or call request_more with {"skills": "<what you need>"} to see descriptions.',
    '',
    '<skill_directory>',
    ...lines,
    '</skill_directory>',
    '',
    'If the user names a skill, or the task clearly matches one, load it with the `skill` tool before taking task actions, then follow its full instructions. Do not follow a skill from its name alone.',
    'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
    '</system-reminder>',
  ].join('\n')
}

/**
 * Per-step hint for the runtime context.
 * @param input - `suggested` skill items, `loaded` names already in the conversation, `autoLoaded` names injected this step.
 * @returns the hint text, or `''` when there is nothing to say.
 */
export function renderHint({ suggested, loaded = new Set(), autoLoaded = [] }) {
  const pending = suggested.filter((item) => !loaded.has(item.name) && !autoLoaded.includes(item.name))
  const lines = []
  if (pending.length > 0) {
    lines.push('Suggested skills for this request. Load the ones that apply with the `skill` tool before acting:')
    for (const item of pending) lines.push(`- \`${item.name}\`: ${escapeText(shortDescription(item, 240))}`)
  }
  if (autoLoaded.length > 0) {
    lines.push(`Loaded for this request (instructions are in the conversation; do not call \`skill\` for them again): ${autoLoaded.join(', ')}`)
  }
  return lines.join('\n')
}

/**
 * Final suggested skill list for one step.
 * @param input - `merged` (from unionMerge), `skills` map, `config`, `remembered` names from recent steps,
 *   `extra` names added by request_more this turn.
 * @returns ordered skill names, at most `maxSkills` beyond `alwaysSkills`.
 */
export function chooseSkills({ merged, skills, config, remembered = [], extra = [] }) {
  const out = []
  const push = (name) => {
    if (skills.has(name) && !out.includes(name)) out.push(name)
  }
  for (const name of config.alwaysSkills) push(name)
  const budget = config.alwaysSkills.filter((name) => skills.has(name)).length + config.maxSkills
  for (const name of extra) push(name)
  for (const entry of merged) {
    if (out.length >= budget) break
    push(entry.id)
    for (const companion of config.companions[entry.id] ?? []) if (out.length < budget) push(companion)
  }
  for (const name of remembered) if (out.length < budget) push(name)
  return out
}

/**
 * Skills confident enough to inject without waiting for a `skill` call. Both
 * signals must agree: Laya at or above the threshold and a recall rank in the
 * floor. A skill already in the conversation is skipped.
 * @param input - `merged` entries, `config`, `loaded` names.
 * @returns names to auto-load, best first.
 */
export function chooseAutoLoad({ merged, config, loaded }) {
  if (config.maxAutoLoad === 0) return []
  return merged
    .filter((entry) => entry.reason === 'both' && typeof entry.p === 'number' && entry.p >= config.autoLoadThreshold)
    .filter((entry) => !loaded.has(entry.id))
    .slice(0, config.maxAutoLoad)
    .map((entry) => entry.id)
}

/**
 * The model-facing `<skill_content>` block, matching dsh-skill's renderer so
 * an auto-loaded skill reads exactly like one loaded by the `skill` tool.
 * @param skill - loaded skill (`name`, `provider`, `resourceBase`, `content`).
 * @returns the rendered block.
 */
export function renderSkillContent(skill) {
  const base = skill.resourceBase
  let hint
  if (base?.kind === 'directory') {
    hint = [`Base directory for this skill: ${escapeText(base.path)}`, 'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.']
  } else if (base?.kind === 'url') {
    hint = [`Base URL for this skill: ${escapeText(base.url)}`, 'Resolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.']
  } else if (base?.kind === 'opaque') {
    hint = [`Resources for this skill: ${escapeText(base.description)}`, 'Load referenced resources only as needed.']
  } else {
    hint = [`Resources for this skill are managed by provider "${escapeText(skill.provider ?? '')}".`, 'Load referenced resources only as needed.']
  }
  return [
    `<skill_content name="${escapeText(skill.name).replaceAll('"', '&quot;')}">`,
    '<skill_resources>',
    ...hint,
    '</skill_resources>',
    '',
    '<skill_instructions>',
    skill.content,
    '</skill_instructions>',
    '</skill_content>',
  ].join('\n')
}
