/**
 * Pure functions that turn a selection into the tool list the model sees.
 * Kept separate from the router so they can be tested without a harness.
 */

/**
 * Choose which tools of each selected group go out, within the budgets.
 * @param input - `groupIds` (best first), `groups` map, `toolRank` (tool name to rank, lower is better),
 *   `maxTools`, `maxToolsPerGroup`.
 * @returns tool names, best group first.
 */
export function toolsForGroups({ groupIds, groups, toolRank, maxTools, maxToolsPerGroup }) {
  const out = []
  for (const id of groupIds) {
    const group = groups.get(id)
    if (!group) continue
    const ordered = [...group.tools].sort((a, b) => (toolRank?.get(a) ?? Infinity) - (toolRank?.get(b) ?? Infinity))
    for (const name of ordered.slice(0, maxToolsPerGroup)) {
      if (out.length >= maxTools) return out
      if (!out.includes(name)) out.push(name)
    }
  }
  return out
}

/**
 * Apply stickiness so the tool list does not churn between steps. Additions
 * always apply: a missing tool costs more than a cache miss. Removals apply
 * only when at least `minChange` tools would go, so small swings keep the
 * previous list and its cached prefix.
 * @param input - `previous` (Set or undefined), `desired` (Set), `keep` (Set of names that must stay, e.g. recently called).
 * @param minChange - smallest removal count worth a change.
 * @returns `{ active, changed, added, removed }`.
 */
export function stickySet({ previous, desired, keep = new Set() }, minChange) {
  const next = new Set([...desired, ...keep])
  if (!previous) return { active: next, changed: true, added: [...next], removed: [] }
  const added = [...next].filter((name) => !previous.has(name))
  const removed = [...previous].filter((name) => !next.has(name))
  if (added.length === 0 && removed.length < Math.max(1, minChange)) {
    return { active: previous, changed: false, added: [], removed: [] }
  }
  if (added.length > 0 && removed.length < minChange) {
    const merged = new Set([...previous, ...added])
    return { active: merged, changed: true, added, removed: [] }
  }
  return { active: next, changed: true, added, removed }
}

/**
 * Filter the assembly. Core tools and anything not routable pass untouched;
 * routable tools pass only when active. Order is preserved, so the header
 * stays byte-stable while the active set is unchanged. Sections owned by a
 * group with no active tool are dropped.
 * @param assembly - post-waterfall assembly from `next()`.
 * @param input - `routable` (Set of routable names), `active` (Set), `groups` map.
 * @returns a new assembly, or the same object when nothing is removed.
 */
export function filterAssembly(assembly, { routable, active, groups }) {
  const tools = assembly.tools.filter((tool) => !routable.has(tool.name) || active.has(tool.name))
  const dropSections = new Set()
  for (const group of groups.values()) {
    if (!group.sections?.length) continue
    if (!group.tools.some((name) => active.has(name))) for (const section of group.sections) dropSections.add(section)
  }
  const sections = dropSections.size === 0
    ? assembly.sections
    : assembly.sections.filter((section) => !dropSections.has(section.name))
  if (tools.length === assembly.tools.length && sections === assembly.sections) return assembly
  return { ...assembly, tools, sections }
}

/**
 * Message returned by the guard for a hidden tool.
 * @param name - tool the model tried to call.
 * @param groupId - its group, when known.
 * @returns the denial reason.
 */
export function hiddenToolReason(name, groupId) {
  return (
    `Tool "${name}" is not loaded for this turn. Call request_more with ` +
    `${groupId ? `{"group": "${groupId}"}` : `{"tools": ["${name}"]}`} to load it, then call it again.`
  )
}
