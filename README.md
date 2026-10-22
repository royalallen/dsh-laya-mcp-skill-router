# dsh-dynamic-router

Per-step tool and skill routing for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Each step, the router picks the MCP/plugin tools and Agent Skills that fit the request and sends only those to the model. Every tool schema and every skill description would otherwise ride along on every request, so this keeps the prompt small for a remote Ollama endpoint.

```powershell
dsh plugin --profile desktop add github:royalallen/dsh-dynamic-router
```

## How it works

1. **Recall.** Local Ollama embeddings (`nomic-embed-text` on `http://127.0.0.1:11434`) plus BM25 rank tool groups, tools and skills against the current request, the previous request and recently used tools. The two rankings are fused by reciprocal rank. With no embeddings the router uses BM25 alone.
2. **Laya.** When the `dsh-laya` plugin is mounted, one batched yes/no question per skill (all of them) and per top tool group goes to the local Laya sidecar. Every question carries explicit true/false criteria.
3. **Union merge.** An item is kept when Laya says yes, or when it is in the recall top N with real signal. Laya can add what recall missed. It cannot drop the recall floor, so a skill you need is not lost to one bad probability.
4. **Tools.** Core tools (`bash`, `pwsh`, `read`, `write`, `edit`, `glob`, `grep`, `skill`, `request_more`) always go out. Routable tools are grouped (config groups, then `mcp__<server>__*`, then optimizer groups, then shared name prefix), and only selected groups go out, within `maxTools` and `maxToolsPerGroup`. Tools called in the last `stickyTurns` turns stay. Small removals are skipped so the cached prompt prefix survives. A call to a hidden tool is denied with a message telling the model how to load it.
5. **Skills.** The harness's full `<available_skills>` catalog is replaced with a names-only directory grouped by category. That directory is stable and cache-friendly. Each step's runtime context gets a short "Suggested skills" list with descriptions. Skills where Laya (≥ `autoLoadThreshold`) and recall agree are loaded up front, at most `maxAutoLoad` per turn.
6. **Escalation.** `request_more` loads a group or named tools for the next step, or searches skills by description. It is capped at `maxEscalations` per turn. Its description lists the tool groups.
7. **Optimizer.** While no turn is running, a background job asks a model (through the harness's own providers) to write a routing card for each skill, group and lone tool: description, example triggers, "not for" examples, category. Cards that are not grounded in the source text are rejected. Cards are stored in `~/.dsh/storages/dsh-dynamic-router/cards.json` and used only for routing. `SKILL.md` files are untouched unless `optimizer.writeBack: true`. Choose the model in the plugin's settings in DeepSeek Harness (`optimizer.provider` and `optimizer.model`, using a provider id from the harness's model settings). Left empty, it uses the model your conversations use.

Inspection tools: `router_preview` (what would be selected for a request), `router_stats` (tokens saved, Laya latency, misses), `router_cards` (optimizer cards).

## Requirements

- DeepSeek Harness with Node 22.19+ or 24+.
- Optional, recommended: Ollama on loopback with `ollama pull nomic-embed-text`.
- Optional, recommended: `dsh-laya` enabled with its sidecar running.
- Optional: a provider configured in the harness for the optimizer, if it should use a different model than your conversations.

Everything degrades gracefully. Without Laya the router uses recall with a wider floor. Without embeddings it uses BM25. Without the optimizer provider, cards are not written and the source descriptions are used.

## Configuration

Every setting appears in the plugin's settings in DeepSeek Harness after you add it. You can also override them in your profile `cordis.patch.yml` with an entry targeting `id: dynamic-router`. Defaults are in [`config.js`](config.js); the most useful settings:

| Key | Default | What it does |
| --- | --- | --- |
| `selector` | `laya` | `laya`, `embeddings`, or `bm25` |
| `maxTools` / `maxToolsPerGroup` | 12 / 5 | Routable tool budget per request |
| `maxSkills` | 8 | Suggested skills per step (plus `alwaysSkills`) |
| `keepTop` / `skillKeepTop` | 2 / 3 | Recall floor for groups / skills |
| `groupKeep` / `skillKeep` | 0.5 / 0.35 | Laya probability to keep a group / skill |
| `autoLoadThreshold` / `maxAutoLoad` | 0.85 / 2 | Up-front skill loading |
| `alwaysSkills`, `companions`, `skillCategories` | | Pin skills, load pairs together, name categories |
| `groups` | `[]` | `{ id, tools: ['glob_*'], sections?, description? }` |
| `stickyTurns` / `minChange` | 3 / 2 | Cache stability |
| `optimizer.provider` / `optimizer.model` | empty | Model for the description optimizer; empty uses the conversation model |
| `apply` | `true` | `false` = dry run: log the selection, send everything |

## Development

```powershell
npm test          # unit tests, no harness needed
npm run eval      # skill recall against your live catalog and Laya (see eval/)
```

## Troubleshooting

- **"embeddings unavailable"**: start Ollama on `127.0.0.1:11434` and run `ollama pull nomic-embed-text`. To use BM25 only and silence the warning, set `embeddingsUrl: ''`.
- **"laya service is not mounted"**: install and enable `dsh-laya` and start its sidecar (`laya-mcp serve`), or set `selector: embeddings`.
- **The model says a tool is missing**: run `router_preview` with the request to see why. Add the tool to `alwaysInclude`, or lower `groupKeep`.
- **A skill was not suggested**: `router_stats` lists skills the model loaded without a suggestion. Add the skill to `alwaysSkills` or `companions`, or let the optimizer write a card for it.
- **Optimizer calls fail**: pick a provider and model in the plugin settings that work in a normal conversation. To stop the job, turn `optimizer.enabled` off.

## License

MIT
