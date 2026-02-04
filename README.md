# OpenClaw Budget Manager

<p align="center">
  <img src="asset/logo.png" alt="OpenClaw Budget Manager logo" width="480" />
</p>

An OpenClaw plugin that tracks daily API spend and **actively switches** to fallback providers when budgets are exhausted. Supports two modes:

- **Legacy mode**: Single daily budget with automatic switch to local Ollama models
- **Chain mode**: Multi-provider fallback chain with per-provider budgets

## How it works

### Cost tracking

After each API call (`agent_end` hook), the plugin:

1. Reads model, token counts, and pre-calculated cost from **all** assistant messages in the turn (including intermediate tool-use calls)
2. Sums costs across the entire turn and records a transaction
3. Falls back to a built-in cost-per-token table if messages don't include cost data

The budget resets automatically each day.

### Active model switching

When budgets run out, the plugin **patches `~/.openclaw/openclaw.json`** to change the default model, then restarts the gateway:

1. **`agent_end` hook fires** — after tracking spend, the plugin checks remaining budget
2. **Budget exhausted** — in legacy mode, switches to Ollama; in chain mode, switches to next provider
3. **Config write** — sets `agents.defaults.model.primary` to the new model
4. **Gateway restart** — the plugin runs `openclaw gateway restart` to apply changes
5. **Next day** — budget resets, plugin restores the primary provider

---

## Chain Mode (Multi-Provider Fallback)

Chain mode enables a **provider fallback chain** with individual budgets per provider. When one provider's budget is exhausted, it automatically switches to the next provider in priority order.

### Provider Chain (Default Configuration)

| Priority | Provider | Type | Default Budget | Notes |
|----------|----------|------|----------------|-------|
| 1 | Anthropic | postpaid | $3.00 | Primary, best quality |
| 2 | Moonshot | prepaid | $2.00 | Prepaid, can't overspend |
| 3 | DeepSeek | prepaid | $1.00 | Extremely cheap |
| 4 | Google | postpaid | $1.00 | Gemini models |
| 5 | OpenAI | postpaid | $1.00 | GPT models |
| 6 | Ollama | free | $0 | Final fallback, local |

**Total daily budget: ~$8.00** (configurable per provider)

### Enabling Chain Mode

Create a `.env` file in the plugin directory:

```bash
# In the OpenClawBudgetManager directory
echo "USE_CHAIN_MODE=true" > .env
```

Or copy from the example:

```bash
cp .env.example .env
# Edit .env and set USE_CHAIN_MODE=true
```

The plugin automatically loads environment variables from `.env` on startup. Variables set in the shell environment take precedence over `.env` values.

### Chain Configuration

The provider chain is configured in `data/provider-chain.json`:

```json
{
  "providers": [
    {
      "id": "anthropic",
      "priority": 1,
      "maxDailyUsd": 3.00,
      "enabled": true,
      "models": {
        "default": "claude-sonnet-4-20250514",
        "coding": "claude-sonnet-4-20250514",
        "vision": "claude-sonnet-4-20250514"
      }
    },
    {
      "id": "moonshot",
      "priority": 2,
      "maxDailyUsd": 2.00,
      "enabled": true,
      "models": {
        "default": "kimi-k2.5",
        "vision": "kimi-k2.5"
      }
    }
    // ... more providers
  ]
}
```

### Per-Provider Budget Overrides

Override budgets via environment variables:

```bash
ANTHROPIC_DAILY_BUDGET_USD=5.00
MOONSHOT_DAILY_BUDGET_USD=3.00
DEEPSEEK_DAILY_BUDGET_USD=2.00
```

### Disable Providers Temporarily

```bash
MOONSHOT_ENABLED=false
GOOGLE_ENABLED=false
```

### Registering Providers in OpenClaw

Add all providers to `~/.openclaw/openclaw.json`:

```json
{
  "models": {
    "providers": {
      "moonshot": {
        "baseUrl": "https://api.moonshot.ai/v1",
        "apiKey": "${MOONSHOT_API_KEY}",
        "api": "openai-completions",
        "models": [
          {
            "id": "kimi-k2.5",
            "name": "Kimi K2.5",
            "reasoning": false,
            "input": ["text", "image"],
            "cost": { "input": 0.003, "output": 0.012, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 131072,
            "maxTokens": 8192
          }
        ]
      },
      "deepseek": {
        "baseUrl": "https://api.deepseek.com/v1",
        "apiKey": "${DEEPSEEK_API_KEY}",
        "api": "openai-completions",
        "models": [
          {
            "id": "deepseek-chat",
            "name": "DeepSeek Chat",
            "reasoning": false,
            "input": ["text"],
            "cost": { "input": 0.00028, "output": 0.00042, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 65536,
            "maxTokens": 8192
          }
        ]
      },
      "google": {
        "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai/",
        "apiKey": "${GOOGLE_API_KEY}",
        "api": "openai-completions",
        "models": [
          {
            "id": "gemini-2.5-flash",
            "name": "Gemini 2.5 Flash",
            "reasoning": false,
            "input": ["text", "image"],
            "cost": { "input": 0.000075, "output": 0.0003, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 1048576,
            "maxTokens": 8192
          }
        ]
      },
      "ollama": {
        "baseUrl": "http://127.0.0.1:11434/v1",
        "apiKey": "ollama-local",
        "api": "openai-completions",
        "models": [
          {
            "id": "qwen3:8b",
            "name": "Qwen 3 8B",
            "reasoning": false,
            "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 32768,
            "maxTokens": 32768
          }
        ]
      }
    }
  }
}
```

---

## Legacy Mode (Single Budget)

The original behavior: tracks spend against a single daily budget and switches to local Ollama when exhausted.

### Budget thresholds

- **> 20% remaining** — no intervention
- **< 20% remaining** — injects a prompt suggesting cheaper models (informational only)
- **$0 remaining** — actively switches to a local Ollama model via config write

### Restart loop prevention

A state file (`data/switcher-state.json`) tracks whether we've switched. On plugin load:

- State = "local" + budget exhausted → do nothing (already switched)
- State = "local" + budget healthy → restore cloud model
- No state / state = "cloud" → normal operation

---

## Prerequisites

- [OpenClaw](https://openclaw.ai) installed and configured
- [Ollama](https://ollama.com) installed and running (for local fallback models)
- Node.js 18+

### Recommended Ollama models (Qwen 3)

```bash
ollama pull qwen3:8b              # general fallback (~11-12GB RAM)
ollama pull qwen3-coder:30b       # coding tasks (~20-22GB RAM, MoE — only 3.3B active)
ollama pull qwen3-vl:8b           # vision tasks (~12-14GB RAM)
```

Ollama loads one model at a time, so these don't compete for RAM.

## Smart local model selection

When fallback to Ollama occurs (either mode), the plugin inspects the prompt and messages to pick the most appropriate model:

| Task type | Default model | Trigger |
|---|---|---|
| Coding | `qwen3-coder:30b` | Prompt contains coding keywords or file extensions |
| Vision | `qwen3-vl:8b` | Any message contains an image content block |
| General | `qwen3:8b` | Everything else |

Priority order: **vision > coding > general**.

### Overriding local models

Override via environment variables. Resolution order per task type:

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

### 3. Restart the OpenClaw gateway

```bash
openclaw gateway restart
```

### 4. Verify the plugin loaded

Check the gateway logs:

```bash
tail -f ~/.openclaw/logs/gateway.log
```

You should see:

```
[budget-manager] Plugin loaded (legacy mode). Daily budget: $5.00
```

Or in chain mode:

```
[budget-manager] Plugin loaded (chain mode). Provider chain enabled.
[budget-manager] Active provider: anthropic
```

## Configuration

### Common Variables

| Variable | Default | Description |
|---|---|---|
| `USE_CHAIN_MODE` | `false` | Enable multi-provider chain mode |
| `BUDGET_DATA_DIR` | `./data` | Directory for runtime data files |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama API base URL |
| `OPENCLAW_CONFIG` | `~/.openclaw/openclaw.json` | Path to OpenClaw config file |

### Legacy Mode Variables

| Variable | Default | Description |
|---|---|---|
| `DAILY_BUDGET_USD` | `5.00` | Daily spend limit in USD |
| `LOCAL_MODEL` | *(none)* | Single Ollama model for all task types |
| `LOCAL_MODEL_GENERAL` | `qwen3:8b` | Ollama model for general tasks |
| `LOCAL_MODEL_CODING` | `qwen3-coder:30b` | Ollama model for coding tasks |
| `LOCAL_MODEL_VISION` | `qwen3-vl:8b` | Ollama model for vision tasks |

### Chain Mode Variables

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_DAILY_BUDGET_USD` | `3.00` | Anthropic daily budget |
| `MOONSHOT_DAILY_BUDGET_USD` | `2.00` | Moonshot daily budget |
| `DEEPSEEK_DAILY_BUDGET_USD` | `1.00` | DeepSeek daily budget |
| `GOOGLE_DAILY_BUDGET_USD` | `1.00` | Google daily budget |
| `OPENAI_DAILY_BUDGET_USD` | `1.00` | OpenAI daily budget |
| `{PROVIDER}_ENABLED` | `true` | Enable/disable provider |

## Built-in cost table (fallback)

Used only when OpenClaw doesn't provide pre-calculated cost on the message. Costs per 1K tokens:

| Model | Input | Output |
|---|---|---|
| claude-opus-4 | $0.015 | $0.075 |
| claude-sonnet-4 | $0.003 | $0.015 |
| claude-3.5-haiku | $0.0008 | $0.004 |
| kimi-k2.5 | $0.003 | $0.012 |
| deepseek-chat | $0.00028 | $0.00042 |
| gemini-2.5-flash | $0.000075 | $0.0003 |
| gemini-2.5-pro | $0.00125 | $0.01 |
| gpt-4o | $0.0025 | $0.01 |
| gpt-4o-mini | $0.00015 | $0.0006 |
| Ollama (all) | $0 | $0 |

Both bare (`claude-sonnet-4-20250514`) and provider-prefixed (`anthropic/claude-sonnet-4`) model IDs are recognised.

### Local model detection

Local models are automatically detected as free ($0) based on name patterns, even without the `ollama/` prefix:

- `qwen*` (qwen3:8b, qwen3-coder:30b, etc.)
- `llama*` (llama3:8b, codellama:7b, etc.)
- `mistral*`
- `phi*`
- `gemma*`
- `vicuna*`, `orca*`, `neural-chat*`, `starling*`
- `openchat*`, `zephyr*`, `dolphin*`
- `nous-hermes*`, `yi:*`

This ensures Ollama models are never charged, regardless of how OpenClaw reports the model name.

## Running tests

```bash
npm test
```

## Project structure

```
src/
  index.ts              — plugin entry point, registers hooks, orchestrates switching
  budget-store.ts       — JSON-based daily budget persistence (legacy mode)
  chain-budget-store.ts — per-provider budget tracking (chain mode)
  provider-chain.ts     — provider chain config and selection logic
  usage-tracker.ts      — aggregates token usage and cost from all messages
  budget-gate.ts        — budget check + task-aware model selection
  ollama-client.ts      — thin HTTP client for Ollama API
  model-switcher.ts     — state management + config file patching
tests/
  budget-store.test.ts
  chain-budget-store.test.ts
  provider-chain.test.ts
  usage-tracker.test.ts
  budget-gate.test.ts
  ollama-client.test.ts
  model-switcher.test.ts
data/
  budget.json           — runtime spend state (legacy mode, gitignored)
  chain-budget.json     — per-provider spend state (chain mode, gitignored)
  provider-chain.json   — provider chain configuration
  switcher-state.json   — model switch state (gitignored)
```

## License

MIT
