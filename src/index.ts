import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { trackUsage, trackChainUsage, isLocalModel, type ModelCost } from "./usage-tracker.js";
import { checkBudget, checkChainBudget, getLocalModels, detectTaskComplexity, getModelRecommendation } from "./budget-gate.js";
import {
  loadSwitcherState,
  switchToLocalModel,
  restoreCloudModel,
  switchToProvider,
  restoreFirstProvider,
  applyOptimizedConfig,
  isOptimizationApplied,
  getOptimizationRules,
  restartGateway,
} from "./model-switcher.js";
import { loadChainConfig, applyEnvOverrides } from "./provider-chain.js";
import { loadChainBudgetWithStatus, getActiveProvider } from "./chain-budget-store.js";
import { truncateActiveSession } from "./context-manager.js";

// Load .env file from plugin directory if it exists
const ENV_FILE = path.join(import.meta.dirname, "..", ".env");
if (fs.existsSync(ENV_FILE)) {
  const envContent = fs.readFileSync(ENV_FILE, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    // Only set if not already in environment
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const DAILY_BUDGET_USD = parseFloat(process.env.DAILY_BUDGET_USD ?? "5.00");
const BUDGET_DATA_DIR = process.env.BUDGET_DATA_DIR ?? path.join(import.meta.dirname, "..", "data");
const BUDGET_FILE = path.join(BUDGET_DATA_DIR, "budget.json");
const SWITCHER_STATE_FILE = path.join(BUDGET_DATA_DIR, "switcher-state.json");

// Chain budget paths
const CHAIN_CONFIG_FILE = path.join(BUDGET_DATA_DIR, "provider-chain.json");
const CHAIN_BUDGET_FILE = path.join(BUDGET_DATA_DIR, "chain-budget.json");

// Enable chain mode via environment variable
const USE_CHAIN_MODE = process.env.USE_CHAIN_MODE?.toLowerCase() === "true";

// Disable prompt optimization injection (for troubleshooting)
const DISABLE_PROMPT_OPTIMIZATION = process.env.DISABLE_PROMPT_OPTIMIZATION?.toLowerCase() === "true";

// Context truncation settings
const CONTEXT_TRUNCATION_ENABLED = process.env.CONTEXT_TRUNCATION_ENABLED?.toLowerCase() !== "false";
const CONTEXT_MAX_TOKENS = parseInt(process.env.CONTEXT_MAX_TOKENS ?? "120000", 10);
const CONTEXT_KEEP_RECENT = parseInt(process.env.CONTEXT_KEEP_RECENT ?? "20", 10);

// Model routing settings: "off" | "advisory" (default)
// Advisory mode injects model recommendations based on task complexity
const AUTO_MODEL_ROUTING = process.env.AUTO_MODEL_ROUTING?.toLowerCase() ?? "advisory";
const SESSION_KEY = process.env.SESSION_KEY ?? "agent:main:main";
const OPENCLAW_SESSIONS_DIR = path.join(os.homedir(), ".openclaw", "agents", "main", "sessions");
const OPENCLAW_SESSIONS_INDEX = path.join(os.homedir(), ".openclaw", "agents", "main", "sessions.json");

// Skip prompt injection when context is already near the model's context window limit.
// 150K tokens leaves ~50K for output + safety margin on a 200K context model.
const CONTEXT_INJECTION_THRESHOLD = 150_000;

// Rough token estimate: ~4 chars per token (conservative for English text)
function estimateContextTokens(prompt: string, messages: unknown[]): number {
  let chars = prompt.length;
  for (const msg of messages) {
    if (msg && typeof msg === "object") {
      const content = (msg as Record<string, unknown>).content;
      if (typeof content === "string") {
        chars += content.length;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === "object" && typeof (block as Record<string, unknown>).text === "string") {
            chars += ((block as Record<string, unknown>).text as string).length;
          }
        }
      }
    }
  }
  return Math.ceil(chars / 4);
}

const DEFAULT_COSTS: Record<string, ModelCost> = {
  // Anthropic Claude 4.5/4.6 series (Feb 2026 pricing: per 1K tokens)
  // Opus 4.5/4.6: $5/M input, $25/M output
  "claude-opus-4-6": { input: 0.005, output: 0.025 },
  "anthropic/claude-opus-4-6": { input: 0.005, output: 0.025 },
  "claude-opus-4-5-20251101": { input: 0.005, output: 0.025 },
  "anthropic/claude-opus-4-5-20251101": { input: 0.005, output: 0.025 },
  "anthropic/claude-opus-4-5": { input: 0.005, output: 0.025 },
  "anthropic/claude-opus-4": { input: 0.005, output: 0.025 },
  // Sonnet 4.5: $3/M input, $15/M output
  "claude-sonnet-4-5": { input: 0.003, output: 0.015 },
  "anthropic/claude-sonnet-4-5": { input: 0.003, output: 0.015 },
  "claude-sonnet-4-20250514": { input: 0.003, output: 0.015 },
  "anthropic/claude-sonnet-4-20250514": { input: 0.003, output: 0.015 },
  "anthropic/claude-sonnet-4": { input: 0.003, output: 0.015 },
  // Haiku 4.5: $1/M input, $5/M output
  "claude-haiku-4-5": { input: 0.001, output: 0.005 },
  "anthropic/claude-haiku-4-5": { input: 0.001, output: 0.005 },
  // Haiku 3.5 (legacy): $0.80/M input, $4/M output
  "claude-3-5-haiku-20241022": { input: 0.0008, output: 0.004 },
  "anthropic/claude-3-5-haiku-20241022": { input: 0.0008, output: 0.004 },
  "anthropic/claude-3-5-haiku": { input: 0.0008, output: 0.004 },
  // Legacy Opus 4 (older pricing)
  "claude-opus-4-20250514": { input: 0.005, output: 0.025 },
  "anthropic/claude-opus-4-20250514": { input: 0.005, output: 0.025 },

  // Moonshot
  "kimi-k2.5": { input: 0.003, output: 0.012 },
  "moonshot/kimi-k2.5": { input: 0.003, output: 0.012 },

  // DeepSeek
  "deepseek-chat": { input: 0.00028, output: 0.00042 },
  "deepseek/deepseek-chat": { input: 0.00028, output: 0.00042 },
  "deepseek-reasoner": { input: 0.00055, output: 0.00219 },
  "deepseek/deepseek-reasoner": { input: 0.00055, output: 0.00219 },

  // Google Gemini
  "gemini-2.5-flash": { input: 0.000075, output: 0.0003 },
  "google/gemini-2.5-flash": { input: 0.000075, output: 0.0003 },
  "gemini-2.0-flash": { input: 0.0001, output: 0.0004 },
  "google/gemini-2.0-flash": { input: 0.0001, output: 0.0004 },
  "gemini-2.5-pro": { input: 0.00125, output: 0.01 },
  "google/gemini-2.5-pro": { input: 0.00125, output: 0.01 },
  "gemini-2.5-pro-preview-05-06": { input: 0.00125, output: 0.01 },
  "google/gemini-2.5-pro-preview-05-06": { input: 0.00125, output: 0.01 },

  // OpenAI
  "gpt-4o": { input: 0.0025, output: 0.01 },
  "openai/gpt-4o": { input: 0.0025, output: 0.01 },
  "gpt-4o-mini": { input: 0.00015, output: 0.0006 },
  "openai/gpt-4o-mini": { input: 0.00015, output: 0.0006 },

  // Local (free) — Qwen 3 via Ollama
  "qwen3:8b": { input: 0, output: 0 },
  "ollama/qwen3:8b": { input: 0, output: 0 },
  "qwen3-coder:30b": { input: 0, output: 0 },
  "ollama/qwen3-coder:30b": { input: 0, output: 0 },
  "qwen3-vl:8b": { input: 0, output: 0 },
  "ollama/qwen3-vl:8b": { input: 0, output: 0 },
};

function resolveModelCost(modelId: string): ModelCost {
  // Local models are always free
  if (isLocalModel(modelId)) {
    return { input: 0, output: 0 };
  }
  return DEFAULT_COSTS[modelId] ?? { input: 0, output: 0 };
}

interface OpenClawPluginApi {
  id: string;
  config: Record<string, unknown>;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
  };
  on: (
    hookName: string,
    handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown,
    opts?: { priority?: number },
  ) => void;
}

export default function register(api: OpenClawPluginApi) {
  if (USE_CHAIN_MODE) {
    registerChainMode(api);
  } else {
    registerLegacyMode(api);
  }
}

function registerLegacyMode(api: OpenClawPluginApi) {
  api.logger.info("[budget-manager] Plugin loaded (legacy mode). Daily budget: $" + DAILY_BUDGET_USD);

  // On load: if we previously switched to local but budget has reset, restore cloud model
  const switcherState = loadSwitcherState(SWITCHER_STATE_FILE);
  if (switcherState?.mode === "local") {
    const decision = checkBudget(BUDGET_FILE, DAILY_BUDGET_USD);
    if (decision.remaining_usd > 0) {
      api.logger.info("[budget-manager] Budget reset detected, restoring cloud model");
      restoreCloudModel(SWITCHER_STATE_FILE, api.logger).catch((err) => {
        api.logger.error("[budget-manager] Failed to restore cloud model:", err);
      });
    } else {
      api.logger.info("[budget-manager] Still over budget, staying on local model");
    }
  }

  // Hook: before_agent_start — check budget and provide informational context
  api.on(
    "before_agent_start",
    (_event, _ctx) => {
      const prompt = (_event.prompt as string) ?? "";
      const messages = (_event.messages as unknown[]) ?? [];
      const decision = checkBudget(BUDGET_FILE, DAILY_BUDGET_USD, prompt, messages);

      if (decision.action === "force_local") {
        api.logger.warn(
          `[budget-manager] Over budget! Remaining: $${decision.remaining_usd.toFixed(2)}. ` +
            `Active switching will engage for ${decision.forced_model}`,
        );
        return undefined;
      }

      if (decision.action === "prefer_cheaper") {
        api.logger.info(
          `[budget-manager] Budget low (${decision.percent_remaining}%). ` +
            `Preferring cheaper models.`,
        );
        return {
          prependContext:
            `[BUDGET WARNING] Daily budget is ${decision.percent_remaining}% remaining ` +
            `($${decision.remaining_usd.toFixed(2)}). Prefer cheaper models ` +
            `(DeepSeek, GPT-4o-mini, or local Ollama) over expensive ones.`,
        };
      }

      return undefined;
    },
    { priority: 100 },
  );

  // Hook: agent_end — track usage, then switch to local if over budget
  api.on("agent_end", (event, _ctx) => {
    try {
      const messages = event.messages as unknown[];
      if (!messages?.length) return;

      const modelId = (event.model as string) ?? "unknown";
      const cost = resolveModelCost(modelId);

      trackUsage(BUDGET_FILE, modelId, messages, cost, DAILY_BUDGET_USD);

      const decision = checkBudget(BUDGET_FILE, DAILY_BUDGET_USD);
      api.logger.info(
        `[budget-manager] After tracking: $${decision.remaining_usd.toFixed(2)} remaining ` +
          `(${decision.percent_remaining}%)`,
      );

      // Active model switching: if budget exhausted, switch to local Ollama model
      if (decision.action === "force_local" && decision.task_type) {
        const localModels = getLocalModels();
        switchToLocalModel(decision.task_type, SWITCHER_STATE_FILE, localModels, api.logger)
          .then((switched) => {
            if (switched) {
              api.logger.info("[budget-manager] Config patched, gateway will restart");
            }
          })
          .catch((err) => {
            api.logger.error("[budget-manager] Failed to switch to local model:", err);
          });
      }

      // Context truncation: trim session file when context grows too large
      if (CONTEXT_TRUNCATION_ENABLED) {
        const estimatedTokens = estimateContextTokens("", messages);
        if (estimatedTokens > CONTEXT_MAX_TOKENS) {
          try {
            const result = truncateActiveSession({
              maxContextTokens: CONTEXT_MAX_TOKENS,
              keepRecentMessages: CONTEXT_KEEP_RECENT,
              sessionsDir: OPENCLAW_SESSIONS_DIR,
              sessionsIndexPath: OPENCLAW_SESSIONS_INDEX,
              sessionKey: SESSION_KEY,
            });
            if (result.truncated) {
              api.logger.info(
                `[budget-manager] Session truncated: ${result.entriesBefore} -> ${result.entriesAfter} entries ` +
                  `(~${result.estimatedTokensBefore} -> ~${result.estimatedTokensAfter} tokens)`,
              );
              restartGateway();
            }
          } catch (err) {
            api.logger.error("[budget-manager] Failed to truncate session:", err);
          }
        }
      }
    } catch (err) {
      api.logger.error("[budget-manager] Failed to track usage:", err);
    }
  });
}

function registerChainMode(api: OpenClawPluginApi) {
  api.logger.info("[budget-manager] Plugin loaded (chain mode). Provider chain enabled.");

  // On load: check if date changed and restore first provider if needed
  try {
    const rawConfig = loadChainConfig(CHAIN_CONFIG_FILE);
    const config = applyEnvOverrides(rawConfig);
    const { data: budgetData, wasReset } = loadChainBudgetWithStatus(CHAIN_BUDGET_FILE, config);

    if (wasReset) {
      api.logger.info("[budget-manager] New day detected, restoring first provider");
      restoreFirstProvider(CHAIN_CONFIG_FILE, CHAIN_BUDGET_FILE, api.logger).catch((err) => {
        api.logger.error("[budget-manager] Failed to restore first provider:", err);
      });
    } else {
      const activeProvider = getActiveProvider(budgetData);
      api.logger.info(`[budget-manager] Active provider: ${activeProvider}`);

      // Only apply Anthropic optimization (Sonnet default, model aliases) when on Anthropic
      if (activeProvider === "anthropic" && !isOptimizationApplied()) {
        api.logger.info("[budget-manager] Applying Anthropic optimization (Sonnet default, model aliases)");
        applyOptimizedConfig(api.logger);
      }
    }
  } catch (err) {
    api.logger.error("[budget-manager] Failed to initialize chain mode:", err);
  }

  // Hook: before_agent_start — inject optimization rules and check budget
  api.on(
    "before_agent_start",
    (_event, _ctx) => {
      try {
        const prompt = (_event.prompt as string) ?? "";
        const messages = (_event.messages as unknown[]) ?? [];

        const decision = checkChainBudget(CHAIN_BUDGET_FILE, CHAIN_CONFIG_FILE, prompt, messages);

        if (decision.action === "all_exhausted") {
          api.logger.warn(
            `[budget-manager] All providers exhausted! ${decision.reason}`,
          );
        } else if (decision.action === "switch_provider") {
          api.logger.info(
            `[budget-manager] Provider ${decision.currentProvider} exhausted. ` +
              `Will switch to ${decision.nextProvider} after this request.`,
          );
        } else {
          api.logger.debug(
            `[budget-manager] Using ${decision.currentProvider}: ` +
              `$${decision.providerRemaining.toFixed(2)} remaining (${decision.providerPercent}%)`,
          );
        }

        // Build context to prepend (optimization rules + model recommendation)
        const contextParts: string[] = [];

        // Inject provider-appropriate optimization rules (unless disabled).
        // Skip injection when context is already large to avoid hitting context window limits.
        if (!DISABLE_PROMPT_OPTIMIZATION) {
          const estimatedTokens = estimateContextTokens(prompt, messages);
          if (estimatedTokens > CONTEXT_INJECTION_THRESHOLD) {
            api.logger.warn(
              `[budget-manager] Context too large (~${estimatedTokens} tokens), skipping prompt injection`,
            );
          } else {
            const optimizationRules = getOptimizationRules(decision.currentProvider);
            contextParts.push(optimizationRules);
          }
        }

        // Inject model recommendation based on task complexity (advisory mode)
        if (AUTO_MODEL_ROUTING === "advisory") {
          const currentModel = (_event.model as string) ?? "";
          const complexity = detectTaskComplexity(prompt, messages);
          const recommendation = getModelRecommendation(complexity, currentModel);

          if (recommendation) {
            api.logger.info(
              `[budget-manager] Task complexity: ${complexity}, model: ${currentModel} → suggesting switch`,
            );
            contextParts.push(recommendation);
          }
        }

        if (contextParts.length > 0) {
          return { prependContext: contextParts.join("\n\n") };
        }

        return undefined;
      } catch (err) {
        api.logger.error("[budget-manager] Failed to check chain budget:", err);
        return undefined;
      }
    },
    { priority: 100 },
  );

  // Hook: agent_end — track usage to provider, then switch if exhausted
  api.on("agent_end", (event, _ctx) => {
    try {
      const messages = event.messages as unknown[];
      if (!messages?.length) return;

      const modelId = (event.model as string) ?? "unknown";
      const cost = resolveModelCost(modelId);

      const rawConfig = loadChainConfig(CHAIN_CONFIG_FILE);
      const config = applyEnvOverrides(rawConfig);

      const result = trackChainUsage(CHAIN_BUDGET_FILE, config, modelId, messages, cost);
      if (!result) return;

      api.logger.info(
        `[budget-manager] Model: ${result.aggregated.model} (event.model=${modelId})`
      );
      api.logger.info(
        `[budget-manager] Tracked ${result.providerId}: ` +
          `${result.aggregated.input_tokens} in, ${result.aggregated.output_tokens} out, ` +
          `$${result.aggregated.cost.toFixed(6)}`,
      );

      // Check if we need to switch providers
      const decision = checkChainBudget(CHAIN_BUDGET_FILE, CHAIN_CONFIG_FILE);

      if (decision.action === "switch_provider" && decision.nextProvider && decision.taskType) {
        api.logger.info(
          `[budget-manager] Switching from ${decision.currentProvider} to ${decision.nextProvider}`,
        );

        switchToProvider(
          decision.nextProvider,
          decision.taskType,
          CHAIN_CONFIG_FILE,
          CHAIN_BUDGET_FILE,
          api.logger,
        )
          .then((switched) => {
            if (switched) {
              api.logger.info(
                `[budget-manager] Switched to ${decision.nextProvider}, gateway will restart`,
              );
            }
          })
          .catch((err) => {
            api.logger.error("[budget-manager] Failed to switch provider:", err);
          });
      } else if (decision.action === "all_exhausted") {
        api.logger.warn("[budget-manager] All providers exhausted, no fallback available");
      }

      // Context truncation: trim session file when context grows too large
      if (CONTEXT_TRUNCATION_ENABLED) {
        const estimatedTokens = estimateContextTokens("", messages);
        if (estimatedTokens > CONTEXT_MAX_TOKENS) {
          try {
            const truncResult = truncateActiveSession({
              maxContextTokens: CONTEXT_MAX_TOKENS,
              keepRecentMessages: CONTEXT_KEEP_RECENT,
              sessionsDir: OPENCLAW_SESSIONS_DIR,
              sessionsIndexPath: OPENCLAW_SESSIONS_INDEX,
              sessionKey: SESSION_KEY,
            });
            if (truncResult.truncated) {
              api.logger.info(
                `[budget-manager] Session truncated: ${truncResult.entriesBefore} -> ${truncResult.entriesAfter} entries ` +
                  `(~${truncResult.estimatedTokensBefore} -> ~${truncResult.estimatedTokensAfter} tokens)`,
              );
              restartGateway();
            }
          } catch (err) {
            api.logger.error("[budget-manager] Failed to truncate session:", err);
          }
        }
      }
    } catch (err) {
      api.logger.error("[budget-manager] Failed to track chain usage:", err);
    }
  });
}
