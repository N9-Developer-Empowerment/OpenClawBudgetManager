# OpenClaw Budget Manager

An OpenClaw plugin that tracks daily API spend and **actively switches** to local Ollama models when the budget is exhausted. When the budget resets the next day, it restores the original cloud model automatically.

## How it works

### Cost tracking

After each API call (`agent_end` hook), the plugin:

1. Extracts token counts from the response
2. Looks up cost-per-token from a built-in table (or from OpenClaw's model config if a `cost` field is present)
3. Records the calculated cost in `data/budget.json`

The budget resets automatically each day.

### Active model switching

Unlike prompt injection (which OpenClaw does not honour), this plugin **patches OpenClaw's config** to change the active model:

1. **`agent_end` hook fires** — after tracking spend, the plugin checks the remaining budget
2. **Budget exhausted** — the plugin verifies Ollama is running and the target model is available
3. **Config patch** — calls `openclaw gateway call config.patch` to set `agents.defaults.model.primary` to `ollama/<model>`
4. **Gateway restarts** (~2s) — the plugin reloads, reads its state file, sees it already switched, and does nothing (no restart loop)
5. **Next day** — budget resets, plugin load detects state is "local" but budget is healthy, patches config back to the original cloud model

### Budget thresholds

- **> 20% remaining** — no intervention
- **< 20% remaining** — injects a prompt *suggesting* cheaper models (informational only)
- **$0 remaining** — actively switches to a local Ollama model via config patch

### Restart loop prevention

A state file (`data/switcher-state.json`) tracks whether we've switched. On plugin load:

- State = "local" + budget exhausted → do nothing (already switched)
- State = "local" + budget healthy → restore cloud model
- No state / state = "cloud" → normal operation

## Prerequisites

- [OpenClaw](https://openclaw.ai) installed and configured
- [Ollama](https://ollama.com) installed and running (for local fallback models)
- Node.js 18+

### Recommended Ollama models (Qwen 3)

Pull the local models used for budget fallback:

```bash
ollama pull qwen3:8b              # general fallback (~11-12GB RAM)
ollama pull qwen3-coder:30b       # coding tasks (~20-22GB RAM, MoE — only 3.3B active)
ollama pull qwen3-vl:8b           # vision tasks (~12-14GB RAM)
```

Ollama loads one model at a time, so these don't compete for RAM. A MacBook with 36GB RAM can run any of these.

## Smart local model selection

When the budget is exhausted, the plugin inspects the prompt and messages to pick the most appropriate local model:

| Task type | Default model | Trigger |
|---|---|---|
| Coding | `qwen3-coder:30b` | Prompt contains coding keywords (`bug`, `function`, `refactor`, `debug`, etc.) or file extensions (`.ts`, `.py`, `.go`, etc.) |
| Vision | `qwen3-vl:8b` | Any message contains an image content block |
| General | `qwen3:8b` | Everything else |

Priority order: **vision > coding > general** — if an image is present, the vision model is used even when coding keywords also appear.

If the selected model is not available in Ollama, the plugin falls back to the general model. If that is also unavailable, no switch occurs.

### Overriding local models

You can override the default models via environment variables. The resolution order for each task type is:

1. Specific env var (`LOCAL_MODEL_GENERAL`, `LOCAL_MODEL_CODING`, `LOCAL_MODEL_VISION`)
2. `LOCAL_MODEL` (sets one model for all task types)
3. Built-in default

## Setup

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/OpenClawBudgetManager.git
cd OpenClawBudgetManager
npm install
```

### 2. Register the plugin with OpenClaw

Edit `~/.openclaw/openclaw.json` and add a `plugins` section (merge with your existing config):

```json
{
  "plugins": {
    "enabled": true,
    "load": {
      "paths": ["/absolute/path/to/OpenClawBudgetManager"]
    }
  }
}
```

Replace `/absolute/path/to/OpenClawBudgetManager` with the actual path where you cloned the repo.

### 3. Restart the OpenClaw gateway

```bash
openclaw gateway restart
```

Or quit and reopen the OpenClaw menu bar app.

### 4. Verify the plugin loaded

Check the gateway logs for:

```
[budget-manager] Plugin loaded. Daily budget: $5.00
```

## Configuration

Set these environment variables (or add to your shell profile):

| Variable | Default | Description |
|---|---|---|
| `DAILY_BUDGET_USD` | `5.00` | Daily spend limit in USD |
| `BUDGET_DATA_DIR` | `./data` | Directory for runtime data files |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama API base URL |
| `LOCAL_MODEL` | *(none)* | Single Ollama model for all task types |
| `LOCAL_MODEL_GENERAL` | `qwen3:8b` | Ollama model for general tasks |
| `LOCAL_MODEL_CODING` | `qwen3-coder:30b` | Ollama model for coding tasks |
| `LOCAL_MODEL_VISION` | `qwen3-vl:8b` | Ollama model for vision tasks |

## Budget data

Spend is tracked in `data/budget.json` (gitignored):

```json
{
  "date": "2026-01-31",
  "daily_budget_usd": 5.00,
  "spent_today_usd": 1.23,
  "transactions": [
    {
      "model": "claude-sonnet-4-20250514",
      "tokens_in": 1500,
      "tokens_out": 800,
      "cost_usd": 0.0165,
      "timestamp": "2026-01-31T12:00:00.000Z"
    }
  ]
}
```

The file auto-resets when the date changes.

## Built-in cost table

Costs per 1K tokens:

| Model | Input | Output |
|---|---|---|
| claude-opus-4 | $0.015 | $0.075 |
| claude-sonnet-4 | $0.003 | $0.015 |
| claude-3.5-haiku | $0.0008 | $0.004 |
| gpt-4o | $0.0025 | $0.01 |
| gpt-4o-mini | $0.00015 | $0.0006 |
| deepseek-chat | $0.00014 | $0.00028 |
| gemini-2.0-flash | $0.0001 | $0.0004 |
| Ollama (all) | $0 | $0 |

If OpenClaw's model config includes a `cost` field for a model, that takes precedence over these defaults. Models not found in either source default to $0, which will undercount spend.

## Running tests

```bash
npm test
```

## Project structure

```
src/
  index.ts           — plugin entry point, registers hooks, orchestrates switching
  budget-store.ts    — JSON-based daily budget persistence
  usage-tracker.ts   — extracts token usage, calculates cost
  budget-gate.ts     — pre-call budget check + task-aware model selection
  ollama-client.ts   — thin HTTP client for Ollama API
  model-switcher.ts  — state management + config patching for model switching
tests/
  budget-store.test.ts
  usage-tracker.test.ts
  budget-gate.test.ts
  ollama-client.test.ts
  model-switcher.test.ts
data/
  budget.json          — runtime spend state (gitignored)
  switcher-state.json  — model switch state (gitignored)
```

## License

MIT
