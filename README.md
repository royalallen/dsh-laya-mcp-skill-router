# dsh-dynamic-router

Per-step tool and skill routing for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Each step, the router picks the MCP/plugin tools and Agent Skills that fit the request and sends only those to the model. Every tool schema and every skill description would otherwise ride along on every request, so this keeps the prompt small for a remote Ollama endpoint.

```powershell
dsh plugin --profile desktop add github:royalallen/dsh-dynamic-router
```

## How it works

1. **Recall.** Local Ollama embeddings (`nomic-embed-text` on `http://127.0.0.1:11434`) plus BM25 rank tool groups, tools and skills against the current request, the previous request and recently used tools. The two rankings are fused by reciprocal rank. With no embeddings the router uses BM25 alone.
2. **Laya.** One batched yes/no question per skill (all of them) and per top tool group goes to a Laya sidecar: the one at `layaUrl` when you give one, otherwise the one the `dsh-laya` plugin is configured for, or `http://127.0.0.1:8787` (dsh-laya's default) when `dsh-laya` is not installed. Every question carries explicit true/false criteria.
3. **Union merge.** An item is kept when Laya says yes, or when it is in the recall top N with real signal. Laya can add what recall missed. It cannot drop the recall floor, so a skill you need is not lost to one bad probability.
4. **Tools.** Core tools (`bash`, `pwsh`, `read`, `write`, `edit`, `glob`, `grep`, `skill`, `request_more`) always go out. Routable tools are grouped (config groups, then `mcp__<server>__*`, then optimizer groups, then shared name prefix), and only selected groups go out, within `maxTools` and `maxToolsPerGroup`. Tools called in the last `stickyTurns` turns stay. Small removals are skipped so the cached prompt prefix survives. A call to a hidden tool is denied with a message telling the model how to load it.
5. **Skills.** The harness's full `<available_skills>` catalog is replaced with a names-only directory grouped by category. That directory is stable and cache-friendly. Each step's runtime context gets a short "Suggested skills" list with descriptions. Skills where Laya (≥ `autoLoadThreshold`) and recall agree are loaded up front, at most `maxAutoLoad` per turn.
6. **Escalation.** `request_more` loads a group or named tools for the next step, or searches skills by description. It is capped at `maxEscalations` per turn. Its description lists the tool groups.
7. **Optimizer.** While no turn is running, a background job asks a model to write a routing card for each skill, group and lone tool: description, example triggers, "not for" examples, category. Cards that are not grounded in the source text are rejected. Cards are stored in `~/.dsh/storages/dsh-dynamic-router/cards.json` and used only for routing. `SKILL.md` files are untouched unless `optimizer.writeBack: true`. The model is chosen during first-run setup: an OpenAI-compatible base URL, API key and model (Ollama serves one at `http://<host>:11434/v1`), or a provider id from the harness's model settings, or nothing, which uses the model your conversations use.

Settings tool: `router_configure`. Inspection tools: `router_preview` (what would be selected for a request), `router_stats` (tokens saved, Laya latency, misses), `router_cards` (optimizer cards).

## Requirements

- DeepSeek Harness with Node 22.19+ or 24+.
- Optional, recommended: an Ollama server with `ollama pull nomic-embed-text`.
- Optional, recommended: the Laya sidecar (`laya-mcp serve`), reached through `dsh-laya` or directly at `layaUrl`. The router does not install or start it; Laya is a separate local model.
- Optional: an endpoint or harness provider for the optimizer, if it should use a different model than your conversations.

Everything degrades gracefully. Without Laya the router uses recall with a wider floor. Without embeddings it uses BM25. Without an optimizer model, cards are not written and the source descriptions are used.

## Configuration

**First run.** Until settings are saved, the model asks you at the start of a conversation for the embeddings server, the optimizer model (endpoint, model and API key), and the Laya sidecar URL, then saves your answers with the `router_configure` tool. Reply "defaults" to keep the defaults. Settings apply immediately and are kept in `~/.dsh/storages/dsh-dynamic-router/settings.json`, including any API keys, in plain text. To change them later, ask the model to reconfigure the tool router. To be asked again, delete that file.

Saved settings override the Cordis config. Everything else can be set in your profile `cordis.patch.yml` with an entry targeting `id: dynamic-router`; edits there apply without a restart, except `cacheDir`. Defaults are in [`config.js`](config.js); the most useful settings:

| Key | Default | What it does |
| --- | --- | --- |
| `embeddingsUrl` / `embeddingModel` / `embeddingsApiKey` | `http://127.0.0.1:11434` / `nomic-embed-text` / empty | Ollama server for recall embeddings |
| `optimizer.baseUrl` / `optimizer.apiKey` / `optimizer.model` | empty | OpenAI-compatible endpoint for the optimizer |
| `optimizer.provider` | empty | Harness provider id, used when `baseUrl` is empty; empty provider and model use the conversation model |
| `layaUrl` | empty | `laya-mcp serve` sidecar to use instead of `dsh-laya`; empty uses `dsh-laya` and its settings, or `http://127.0.0.1:8787` (dsh-laya's default) when it is not installed |
| `selector` | `laya` | `laya`, `embeddings`, or `bm25` |
| `maxTools` / `maxToolsPerGroup` | 12 / 5 | Routable tool budget per request |
| `maxSkills` | 8 | Suggested skills per step (plus `alwaysSkills`) |
| `keepTop` / `skillKeepTop` | 2 / 3 | Recall floor for groups / skills |
| `groupKeep` / `skillKeep` | 0.5 / 0.35 | Laya probability to keep a group / skill |
| `autoLoadThreshold` / `maxAutoLoad` | 0.85 / 2 | Up-front skill loading |
| `alwaysSkills`, `companions`, `skillCategories` | | Pin skills, load pairs together, name categories |
| `groups` | `[]` | `{ id, tools: ['glob_*'], sections?, description? }` |
| `stickyTurns` / `minChange` | 3 / 2 | Cache stability |
| `apply` | `true` | `false` = dry run: log the selection, send everything |

## Development

```powershell
npm test          # unit tests, no harness needed
npm run eval      # skill recall against your live catalog and Laya (see eval/)
```

## Troubleshooting

- **The model never asked for settings**: it only asks while `settings.json` is missing. Delete it to start setup again, or ask the model to call `router_configure`.
- **"embeddings unavailable"**: start Ollama at the embeddings URL and run `ollama pull nomic-embed-text`. To use BM25 only and silence the warning, clear the embeddings URL.
- **Laya test fails, or "neither a Laya URL nor the dsh-laya plugin is available"**: install `dsh-laya` and run its sidecar (`pip install "laya-mcp[mcp]"`, then `laya-mcp serve`, or set dsh-laya `lifecycle: spawn`), or give the router the URL of a running `laya-mcp serve`. A server that answers `/health` but not `/ask` is not a Laya sidecar. To stop using Laya, set `selector: embeddings`. After a refused connection the router retries the sidecar once a minute.
- **The model says a tool is missing**: run `router_preview` with the request to see why. Add the tool to `alwaysInclude`, or lower `groupKeep`.
- **A skill was not suggested**: `router_stats` lists skills the model loaded without a suggestion. Add the skill to `alwaysSkills` or `companions`, or let the optimizer write a card for it.
- **Optimizer calls fail**: ask the model to reconfigure the tool router with a working base URL (it must include `/v1` for Ollama), API key and model, or a harness provider and model that work in a normal conversation. To stop the job, have it turn the optimizer off.

## License

MIT
