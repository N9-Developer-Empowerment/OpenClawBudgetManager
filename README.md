# OpenClaw Budget Manager

<p align="center">
  <img src="asset/logo.png" alt="OpenClaw Budget Manager logo" width="480" />
</p>

An OpenClaw plugin that tracks daily API spend and **actively switches** to fallback providers when budgets are exhausted or providers become uncommunicative. Supports two modes:

- **Legacy mode**: Single daily budget with automatic switch to local Ollama models
- **Chain mode**: Multi-provider fallback chain with per-provider budgets and failure-based switching

## How it works

### Cost tracking

After each API call (`agent_end` hook), the plugin:

1. Reads model, token counts, and pre-calculated cost from **all** assistant messages in the turn (including intermediate tool-use calls)
2. Sums costs across the entire turn and records a transaction
3. Falls back to a built-in cost-per-token table if messages don't include cost data

The budget resets automatically each day.

### Active model switching

When budgets run out **or a provider fails repeatedly**, the plugin **patches `~/.openclaw/openclaw.json`** to change the default model, then restarts the gateway:

1. **`agent_end` hook fires** — the plugin first checks for failures, then tracks spend
2. **Failure detected** — if a provider returns errors, empty responses, or rate limits, failures are counted. After 3 consecutive failures (configurable via `FAILURE_THRESHOLD`), the plugin switches to the next provider
3. **Budget exhausted** — in legacy mode, switches to Ollama; in chain mode, switches to next provider
4. **Config write** — sets `agents.defaults.model.primary` to the new model
5. **Gateway restart** — the plugin runs `openclaw gateway restart` to apply changes
6. **Next day** — budget and failure counters reset, plugin restores the first provider

---

## Chain Mode (Multi-Provider Fallback)

Chain mode enables a **provider fallback chain** with individual budgets per provider. When one provider's budget is exhausted, it automatically switches to the next provider in priority order.

### Provider Chain (Default Configuration)

Chinese AI models are tried first; Anthropic is used as a last resort before the free local fallback.

| Priority | Provider ID | Model | API Key | Budget |
|----------|------------|-------|---------|--------|
| 1 | `bytedance-ark` | `bytedance-ark/doubao-seed-2.0-pro` | BYTEDANCE_ARK_API_KEY | $3/day |
| 2 | `openrouter-glm` | `openrouter/z-ai/glm-5` | OPENROUTER_API_KEY | $3/day |
| 3 | `minimax` | `minimax/MiniMax-M2.5` | MINIMAX_API_KEY | $3/day |
| 4 | `moonshot` | `moonshot/kimi-k2.5` | MOONSHOT_API_KEY | $3/day |
| 5 | `openrouter-qwen` | `openrouter/qwen/qwen3.5-plus-02-15` | OPENROUTER_API_KEY | $3/day |
| 6 | `deepseek` | `deepseek/deepseek-chat` | DEEPSEEK_API_KEY | $5/day |
| 7 | `google` | `google/gemini-2.5-flash` | GEMINI_API_KEY | $3/day |
| 8 | `openai` | `openai/gpt-4o-mini` | OPENAI_API_KEY | $3/day |
| 9 | `anthropic` | `anthropic/claude-sonnet-4-20250514` | ANTHROPIC_API_KEY | $5/day |
| 99 | `ollama` | `ollama/qwen3:8b` | (local) | $0 |

**Total daily budget: ~$31.00** (configurable per provider)

**Notes:**
- `openrouter-glm` and `openrouter-qwen` share the same `OPENROUTER_API_KEY` but have separate budget tracking
- ByteDance Ark uses an OpenAI-compatible API at `https://ark.ap-southeast.bytepluses.com/api/v3` (international)
- Switching happens on budget exhaustion **or** after 3 consecutive failures (configurable via `FAILURE_THRESHOLD`)

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
      "id": "bytedance-ark",
      "priority": 1,
      "maxDailyUsd": 3.00,
      "enabled": true,
      "models": {
        "default": "doubao-seed-2.0-pro"
      }
    },
    {
      "id": "openrouter-glm",
      "priority": 2,
      "maxDailyUsd": 3.00,
      "enabled": true,
      "models": {
        "default": "glm-5"
      }
    }
    // ... more providers (see data/provider-chain.json for full list)
  ]
}
```

### Per-Provider Budget Overrides

Override budgets via environment variables. Hyphens in provider IDs become underscores:

```bash
BYTEDANCE_ARK_DAILY_BUDGET_USD=5.00
OPENROUTER_GLM_DAILY_BUDGET_USD=3.00
MINIMAX_DAILY_BUDGET_USD=3.00
MOONSHOT_DAILY_BUDGET_USD=3.00
DEEPSEEK_DAILY_BUDGET_USD=5.00
ANTHROPIC_DAILY_BUDGET_USD=5.00
```

### Disable Providers Temporarily

```bash
BYTEDANCE_ARK_ENABLED=false
MOONSHOT_ENABLED=false
GOOGLE_ENABLED=false
```

### Registering Providers in OpenClaw

Add all providers to `~/.openclaw/openclaw.json`:

```json
{
  "models": {
    "providers": {
      "bytedance-ark": {
        "baseUrl": "https://ark.ap-southeast.bytepluses.com/api/v3",
        "apiKey": "${BYTEDANCE_ARK_API_KEY}",
        "api": "openai-completions",
        "models": [
          {
            "id": "doubao-seed-2.0-pro",
            "name": "Seed 2.0 Pro",
            "reasoning": false,
            "input": ["text"],
            "cost": { "input": 0.004, "output": 0.016, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 131072,
            "maxTokens": 8192
          }
        ]
      },
      "openrouter": {
        "baseUrl": "https://openrouter.ai/api/v1",
        "apiKey": "${OPENROUTER_API_KEY}",
        "api": "openai-completions",
        "models": [
          {
            "id": "z-ai/glm-5",
            "name": "GLM-5",
            "reasoning": false,
            "input": ["text"],
            "cost": { "input": 0.001, "output": 0.001, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 131072,
            "maxTokens": 8192
          },
          {
            "id": "qwen/qwen3.5-plus-02-15",
            "name": "Qwen 3.5 Plus",
            "reasoning": false,
            "input": ["text"],
            "cost": { "input": 0.001, "output": 0.003, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 131072,
            "maxTokens": 8192
          }
        ]
      },
      "minimax": {
        "baseUrl": "https://api.minimaxi.chat/v1",
        "apiKey": "${MINIMAX_API_KEY}",
        "api": "openai-completions",
        "models": [
          {
            "id": "MiniMax-M2.5",
            "name": "MiniMax M2.5",
            "reasoning": false,
            "input": ["text"],
            "cost": { "input": 0.001, "output": 0.005, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 131072,
            "maxTokens": 8192
          }
        ]
      },
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
        "apiKey": "${GEMINI_API_KEY}",
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

---

## Cost Optimization (Chain Mode)

Chain mode automatically applies cost optimizations from the [OpenClaw Token Optimization Guide](https://scaleup.media). The optimizations are **provider-aware**:

- **When on Anthropic**: Applies Sonnet default + Haiku/Sonnet/Opus routing rules
- **When on other providers**: Uses that provider's default model + general optimization rules

### Config Changes

On startup, the plugin patches `~/.openclaw/openclaw.json` with model aliases for all providers (without overriding the active model). When Anthropic is the active provider, it also sets Sonnet as the default.

| Setting | Value | Purpose |
|---------|-------|---------|
| Model aliases | `seed`, `glm`, `minimax`, `kimi`, `qwen35`, `deepseek`, `gemini`, `sonnet`, `haiku`, `opus`, etc. | Easy switching in prompts |

### Prompt Rules Injected

**When on Anthropic:**

- **SESSION INITIALIZATION**: Load only essential context
- **MODEL SELECTION**: Sonnet is the default; automatic `[MODEL RECOMMENDATION]` messages suggest when to switch
- **RATE LIMITS**: 5s between API calls, 10s between searches

**When on other providers:**

- **SESSION INITIALIZATION**: Load only essential context
- **RATE LIMITS**: Same as above
- **BUDGET AWARENESS**: Notes per-provider budget limits and automatic provider switching

### Automatic Model Recommendations

The plugin detects task complexity and recommends the optimal model tier:

| Complexity | Detection Criteria | Recommended Model |
|------------|-------------------|-------------------|
| **Simple** | Short prompts, single-turn Q&A, status checks | Haiku ($0.0008/$0.004) |
| **Medium** | Code changes, multi-step instructions | Sonnet (default) |
| **Complex** | Architecture, security audit, multi-file refactors | Opus ($0.005/$0.025) |

When a mismatch is detected (e.g., simple task on Opus, complex task on Haiku), the plugin injects a recommendation:

```
[MODEL RECOMMENDATION] Simple task detected. For cost efficiency, consider switching to Haiku: /model haiku
Current: Opus ($0.005/$0.025) → Recommended: Haiku ($0.0008/$0.004 per 1K tokens)
```

**To switch models:**
- `/model haiku` - Use Haiku for simple tasks
- `/model sonnet` - Use Sonnet (default) for most work
- `/model opus` - Use Opus for complex reasoning

The `AUTO_MODEL_ROUTING` environment variable controls this behavior:
- `advisory` (default) - Show recommendations, user decides
- `off` - Disable recommendations

### Expected Savings

| Before | After |
|--------|-------|
| Opus for everything | Sonnet by default |
| No model routing | Haiku for simple / Opus for complex tasks |
| $70-90/month | $3-10/month |

### Provider Fallback Flow

```
ByteDance Ark (Seed 2.0 Pro) → budget exhausted or 3 failures
    ↓
OpenRouter GLM (GLM-5) → budget exhausted or 3 failures
    ↓
MiniMax (M2.5) → budget exhausted or 3 failures
    ↓
Moonshot (kimi-k2.5) → budget exhausted or 3 failures
    ↓
OpenRouter Qwen (Qwen 3.5) → budget exhausted or 3 failures
    ↓
DeepSeek (deepseek-chat) → budget exhausted or 3 failures
    ↓
Google (Gemini 2.5 Flash) → budget exhausted or 3 failures
    ↓
OpenAI (GPT-4o-mini) → budget exhausted or 3 failures
    ↓
Anthropic (Sonnet 4) → budget exhausted or 3 failures
    ↓
Ollama (qwen3:8b, free)
```

Each provider uses its own configured default model. The Sonnet/Haiku/Opus routing rules only apply to Anthropic. Failure counters reset daily along with budgets.

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
[budget-manager] Active provider: bytedance-ark
```

## Configuration

### Common Variables

| Variable | Default | Description |
|---|---|---|
| `USE_CHAIN_MODE` | `false` | Enable multi-provider chain mode |
| `AUTO_MODEL_ROUTING` | `advisory` | Model recommendations: `advisory` (show suggestions) or `off` |
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
| `BYTEDANCE_ARK_DAILY_BUDGET_USD` | `3.00` | ByteDance Ark daily budget |
| `OPENROUTER_GLM_DAILY_BUDGET_USD` | `3.00` | OpenRouter GLM daily budget |
| `MINIMAX_DAILY_BUDGET_USD` | `3.00` | MiniMax daily budget |
| `MOONSHOT_DAILY_BUDGET_USD` | `3.00` | Moonshot daily budget |
| `OPENROUTER_QWEN_DAILY_BUDGET_USD` | `3.00` | OpenRouter Qwen daily budget |
| `DEEPSEEK_DAILY_BUDGET_USD` | `5.00` | DeepSeek daily budget |
| `GOOGLE_DAILY_BUDGET_USD` | `3.00` | Google daily budget |
| `OPENAI_DAILY_BUDGET_USD` | `3.00` | OpenAI daily budget |
| `ANTHROPIC_DAILY_BUDGET_USD` | `5.00` | Anthropic daily budget |
| `{PROVIDER}_ENABLED` | `true` | Enable/disable provider (hyphens → underscores) |
| `FAILURE_THRESHOLD` | `3` | Consecutive failures before switching provider |

## Model Aliases

The plugin configures model aliases in OpenClaw so you can easily switch models using `/model <alias>`:

| Alias | Model | Provider | Cost (per 1K tokens) |
|-------|-------|----------|---------------------|
| `seed` | doubao-seed-2.0-pro | ByteDance Ark | $0.004 / $0.016 |
| `seed-lite` | doubao-seed-2.0-lite | ByteDance Ark | $0.0008 / $0.002 |
| `glm` | glm-5 | OpenRouter (Z-AI) | $0.001 / $0.001 |
| `minimax` | MiniMax-M2.5 | MiniMax | $0.001 / $0.005 |
| `kimi` | kimi-k2.5 | Moonshot | $0.003 / $0.012 |
| `qwen35` | qwen3.5-plus-02-15 | OpenRouter (Qwen) | $0.001 / $0.003 |
| `deepseek` | deepseek-chat | DeepSeek | $0.00028 / $0.00042 |
| `gemini` | gemini-2.5-flash | Google | $0.000075 / $0.0003 |
| `gemini-pro` | gemini-2.5-pro | Google | $0.00125 / $0.01 |
| `gpt4` | gpt-4o | OpenAI | $0.0025 / $0.01 |
| `gpt4-mini` | gpt-4o-mini | OpenAI | $0.00015 / $0.0006 |
| `sonnet` | claude-sonnet-4 | Anthropic | $0.003 / $0.015 |
| `haiku` | claude-3.5-haiku | Anthropic | $0.0008 / $0.004 |
| `opus` | claude-opus-4 | Anthropic | $0.005 / $0.025 |
| `opus45` | claude-opus-4-5 | Anthropic | $0.005 / $0.025 |
| `local` | qwen3:8b | Ollama | $0 / $0 |
| `local-coder` | qwen3-coder:30b | Ollama | $0 / $0 |
| `local-vision` | qwen3-vl:8b | Ollama | $0 / $0 |

**Usage:**
- `/model haiku` - Switch to Haiku (for simple tasks)
- `/model sonnet` - Switch to Sonnet (default, balanced)
- `/model opus` - Switch to Opus (for complex tasks)
- `/new haiku` - Start a new session with Haiku

**Note:** Model switching changes the model for all subsequent messages in the session, not just one message.

**Tip:** The plugin's automatic model recommendations will suggest when to switch. Look for `[MODEL RECOMMENDATION]` in responses.

### Adding or Updating Aliases

Aliases are configured in `~/.openclaw/openclaw.json` under `agents.defaults.models`:

```json
{
  "agents": {
    "defaults": {
      "models": {
        "anthropic/claude-sonnet-4-20250514": {
          "alias": "sonnet"
        },
        "anthropic/claude-opus-4-6": {
          "alias": "opus"
        }
      }
    }
  }
}
```

**To add a new alias:**

1. Edit `~/.openclaw/openclaw.json`
2. Add an entry under `agents.defaults.models` with the full model ID as key
3. Set the `alias` property to your preferred shorthand
4. Restart the gateway: `openclaw gateway restart`

**To update for new model versions (e.g., Sonnet 5):**

1. Edit `~/.openclaw/openclaw.json`
2. Change the model ID key to the new version (e.g., `anthropic/claude-sonnet-5`)
3. Keep the same alias (`"alias": "sonnet"`)
4. Update the cost in `src/index.ts` if needed
5. Restart the gateway: `openclaw gateway restart`

---

## Built-in cost table (fallback)

Used only when OpenClaw doesn't provide pre-calculated cost on the message. Costs per 1K tokens:

| Model | Input | Output |
|---|---|---|
| doubao-seed-2.0-pro | $0.004 | $0.016 |
| doubao-seed-2.0-lite | $0.0008 | $0.002 |
| doubao-seed-2.0-mini | $0.0004 | $0.001 |
| glm-5 | $0.001 | $0.001 |
| MiniMax-M2.5 | $0.001 | $0.005 |
| qwen3.5-plus-02-15 | $0.001 | $0.003 |
| kimi-k2.5 | $0.003 | $0.012 |
| deepseek-chat | $0.00028 | $0.00042 |
| gemini-2.5-flash | $0.000075 | $0.0003 |
| gemini-2.5-pro | $0.00125 | $0.01 |
| gpt-4o | $0.0025 | $0.01 |
| gpt-4o-mini | $0.00015 | $0.0006 |
| claude-opus-4.6 | $0.005 | $0.025 |
| claude-opus-4.5 | $0.005 | $0.025 |
| claude-sonnet-4.5 | $0.003 | $0.015 |
| claude-haiku-4.5 | $0.001 | $0.005 |
| claude-3.5-haiku (legacy) | $0.0008 | $0.004 |
| Ollama (all) | $0 | $0 |

Both bare (`doubao-seed-2.0-pro`) and provider-prefixed (`bytedance-ark/doubao-seed-2.0-pro`) model IDs are recognised.

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

Models prefixed with `openrouter/`, `minimax/`, or `bytedance-ark/` are **excluded** from local detection even if they match name patterns (e.g., `openrouter/qwen/qwen3.5-plus` is a cloud model, not local).

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
  failure-tracker.ts    — consecutive failure tracking per provider
  ollama-client.ts      — thin HTTP client for Ollama API
  model-switcher.ts     — state management + config file patching
  context-manager.ts    — session truncation for context window management
tests/
  budget-store.test.ts
  chain-budget-store.test.ts
  provider-chain.test.ts
  usage-tracker.test.ts
  budget-gate.test.ts
  failure-tracker.test.ts
  ollama-client.test.ts
  model-switcher.test.ts
  context-manager.test.ts
data/
  budget.json           — runtime spend state (legacy mode, gitignored)
  chain-budget.json     — per-provider spend state (chain mode, gitignored)
  failure-tracker.json  — failure counts per provider (gitignored, daily reset)
  provider-chain.json   — provider chain configuration
  switcher-state.json   — model switch state (gitignored)
```

## License

MIT
