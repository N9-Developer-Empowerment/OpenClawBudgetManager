import path from "node:path";
import { trackUsage, type ModelCost } from "./usage-tracker.js";
import { checkBudget, getLocalModels } from "./budget-gate.js";
import { loadSwitcherState, switchToLocalModel, restoreCloudModel } from "./model-switcher.js";

const DAILY_BUDGET_USD = parseFloat(process.env.DAILY_BUDGET_USD ?? "5.00");
const BUDGET_DATA_DIR = process.env.BUDGET_DATA_DIR ?? path.join(import.meta.dirname, "..", "data");
const BUDGET_FILE = path.join(BUDGET_DATA_DIR, "budget.json");
const SWITCHER_STATE_FILE = path.join(BUDGET_DATA_DIR, "switcher-state.json");

const DEFAULT_COSTS: Record<string, ModelCost> = {
  // Anthropic
  "claude-sonnet-4-20250514": { input: 0.003, output: 0.015 },
  "claude-opus-4-20250514": { input: 0.015, output: 0.075 },
  "claude-3-5-haiku-20241022": { input: 0.0008, output: 0.004 },
  // OpenAI
  "gpt-4o": { input: 0.0025, output: 0.01 },
  "gpt-4o-mini": { input: 0.00015, output: 0.0006 },
  // DeepSeek
  "deepseek-chat": { input: 0.00014, output: 0.00028 },
  "deepseek-reasoner": { input: 0.00055, output: 0.00219 },
  // Gemini
  "gemini-2.0-flash": { input: 0.0001, output: 0.0004 },
  "gemini-2.5-pro-preview-05-06": { input: 0.00125, output: 0.01 },
  // Local (free) — Qwen 3 via Ollama
  "ollama/qwen3:8b": { input: 0, output: 0 },
  "ollama/qwen3-coder:30b": { input: 0, output: 0 },
  "ollama/qwen3-vl:8b": { input: 0, output: 0 },
};

function resolveModelCost(
  modelId: string,
  configCost?: { input?: number; output?: number },
): ModelCost {
  if (configCost && typeof configCost.input === "number" && typeof configCost.output === "number") {
    return { input: configCost.input, output: configCost.output };
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
  api.logger.info("[budget-manager] Plugin loaded. Daily budget: $" + DAILY_BUDGET_USD);

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

      // Try to determine model from config
      const config = api.config as Record<string, unknown>;
      const agents = config.agents as Record<string, unknown> | undefined;
      const defaults = agents?.defaults as Record<string, unknown> | undefined;
      const modelId = (defaults?.model as string) ?? "unknown";

      // Resolve cost from config or defaults
      const models = config.models as Record<string, unknown> | undefined;
      const providers = models?.providers as Record<string, Record<string, unknown>> | undefined;
      let configCost: { input?: number; output?: number } | undefined;

      if (providers) {
        for (const provider of Object.values(providers)) {
          const modelDefs = provider.models as Array<Record<string, unknown>> | undefined;
          const match = modelDefs?.find((m) => m.id === modelId);
          if (match?.cost) {
            configCost = match.cost as { input?: number; output?: number };
            break;
          }
        }
      }

      const cost = resolveModelCost(modelId, configCost);
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
    } catch (err) {
      api.logger.error("[budget-manager] Failed to track usage:", err);
    }
  });
}
