import { getRemainingBudget, loadBudget } from "./budget-store.js";
import {
  loadChainBudget,
  getActiveProvider,
  getExhaustedProviders,
  getProviderStats,
  type ChainBudgetData,
} from "./chain-budget-store.js";
import {
  loadChainConfig,
  applyEnvOverrides,
  getEnabledProviders,
  getProviderById,
  getNextProvider,
  getFirstAvailableProvider,
  getModelForTask,
  resolveFullModelId,
  type ChainConfig,
  type ProviderConfig,
  type TaskType as ChainTaskType,
} from "./provider-chain.js";

export type TaskType = "coding" | "vision" | "general";
export type TaskComplexity = "simple" | "medium" | "complex";

const DEFAULT_LOCAL_MODELS: Record<TaskType, string> = {
  coding: "qwen3-coder:30b",
  vision: "qwen3-vl:8b",
  general: "qwen3:8b",
};

export function getLocalModels(): Record<TaskType, string> {
  const base = process.env.LOCAL_MODEL;
  return {
    general: process.env.LOCAL_MODEL_GENERAL ?? base ?? DEFAULT_LOCAL_MODELS.general,
    coding: process.env.LOCAL_MODEL_CODING ?? base ?? DEFAULT_LOCAL_MODELS.coding,
    vision: process.env.LOCAL_MODEL_VISION ?? base ?? DEFAULT_LOCAL_MODELS.vision,
  };
}

const CODING_KEYWORDS =
  /\b(code|function|bug|implement|refactor|debug|compile|syntax|test|class|method|variable|import|export|return|async|await|promise|api|endpoint|component|module|interface|type|enum|struct|loop|array|object|string|boolean|integer|null|undefined|error|exception|stack\s*trace)\b/i;

const CODE_FILE_EXTENSIONS =
  /\.(ts|js|tsx|jsx|py|go|rs|java|kt|rb|cpp|c|h|cs|swift|sh|yml|yaml|json|toml|sql|html|css|scss)\b/i;

// Complexity detection patterns
const COMPLEX_TASK_KEYWORDS =
  /\b(architect|architecture|design|security|audit|review|analyze\s+thoroughly|think\s+carefully|deep\s+analysis|comprehensive|multi-file|refactor\s+entire|rewrite|migrate|optimize\s+performance|scalability|concurrent|parallel|distributed|critical|production|deployment|infrastructure)\b/i;

const MEDIUM_TASK_KEYWORDS =
  /\b(implement|create|build|add\s+feature|fix\s+bug|update|modify|change|extend|integrate|connect|configure|setup|install|write\s+tests|test\s+coverage|documentation|explain|describe|compare|evaluate)\b/i;

// Heartbeat/ping detection patterns
const HEARTBEAT_PATTERNS = [
  /^\s*(ping|pong|status|health|alive|ok\??|test|echo|heartbeat|check)\s*$/i,
  /^\s*are\s+you\s+(there|alive|ok|working)\s*\??\s*$/i,
  /^\s*hello\s*\??\s*$/i,
  /^\s*hi\s*$/i,
];

export function detectTaskType(prompt: string, messages: unknown[]): TaskType {
  const hasImage = messages.some((msg) => {
    if (typeof msg !== "object" || msg === null) return false;
    const content = (msg as Record<string, unknown>).content;
    if (!Array.isArray(content)) return false;
    return content.some(
      (block) =>
        typeof block === "object" &&
        block !== null &&
        (block as Record<string, unknown>).type === "image",
    );
  });

  if (hasImage) return "vision";

  if (CODING_KEYWORDS.test(prompt) || CODE_FILE_EXTENSIONS.test(prompt)) {
    return "coding";
  }

  return "general";
}

/**
 * Get model recommendation based on task complexity and current model.
 * Returns a recommendation string to inject into context, or null if no recommendation.
 *
 * - Simple task on expensive model (Opus/Sonnet) → recommend Haiku
 * - Complex task on cheap model (Haiku) → recommend Opus
 * - Otherwise → no recommendation
 */
export function getModelRecommendation(
  complexity: TaskComplexity,
  currentModel: string,
): string | null {
  const isHaiku = currentModel.toLowerCase().includes("haiku");
  const isOpus = currentModel.toLowerCase().includes("opus");
  const isSonnet = currentModel.toLowerCase().includes("sonnet");

  // Simple task on expensive model → recommend Haiku
  if (complexity === "simple" && (isOpus || isSonnet)) {
    const currentTier = isOpus ? "Opus ($0.005/$0.025)" : "Sonnet ($0.003/$0.015)";
    return (
      `[MODEL RECOMMENDATION] Simple task detected. ` +
      `For cost efficiency, consider switching to Haiku: /model haiku\n` +
      `Current: ${currentTier} → Recommended: Haiku ($0.0008/$0.004 per 1K tokens)`
    );
  }

  // Complex task on cheap model → recommend Opus
  if (complexity === "complex" && isHaiku) {
    return (
      `[MODEL RECOMMENDATION] Complex task detected requiring deep reasoning. ` +
      `Consider switching to Opus for better results: /model opus\n` +
      `Current: Haiku ($0.0008/$0.004) → Recommended: Opus ($0.005/$0.025 per 1K tokens)`
    );
  }

  return null;
}

/**
 * Detect task complexity to enable smart model routing.
 * - Simple: Short prompts, single-turn Q&A, basic formatting, status checks
 * - Medium: Code changes, multi-step instructions, analysis
 * - Complex: Architecture decisions, security review, multi-file refactors
 */
export function detectTaskComplexity(prompt: string, messages: unknown[]): TaskComplexity {
  const promptLength = prompt.length;
  const messageCount = messages.length;

  // Check for complex task indicators first (keywords take priority)
  if (COMPLEX_TASK_KEYWORDS.test(prompt)) {
    return "complex";
  }

  // Large context or long conversation suggests complexity
  const totalContentLength = messages.reduce<number>((acc, msg) => {
    if (typeof msg !== "object" || msg === null) return acc;
    const content = (msg as Record<string, unknown>).content;
    if (typeof content === "string") return acc + content.length;
    if (Array.isArray(content)) {
      return acc + content.reduce<number>((sum, block) => {
        if (typeof block === "object" && block !== null) {
          const text = (block as Record<string, unknown>).text;
          if (typeof text === "string") return sum + text.length;
        }
        return sum;
      }, 0);
    }
    return acc;
  }, 0);

  // Very large context suggests complex task
  if (totalContentLength > 50000 || messageCount > 10) {
    return "complex";
  }

  // Check for medium task indicators
  if (MEDIUM_TASK_KEYWORDS.test(prompt)) {
    return "medium";
  }

  // Medium-length prompts default to medium complexity
  if (promptLength > 200 || messageCount > 3) {
    return "medium";
  }

  return "simple";
}

/**
 * Detect if a message is a heartbeat/health check.
 * These can be routed to free Ollama models.
 */
export function isHeartbeatMessage(prompt: string, messages: unknown[]): boolean {
  // Must be a very short prompt
  if (prompt.length > 50) {
    return false;
  }

  // Must have no significant conversation history
  if (messages.length > 1) {
    return false;
  }

  // Check against heartbeat patterns
  return HEARTBEAT_PATTERNS.some((pattern) => pattern.test(prompt));
}

export interface BudgetDecision {
  action: "allow" | "prefer_cheaper" | "force_local";
  remaining_usd: number;
  percent_remaining: number;
  forced_model?: string;
  task_type?: TaskType;
}

export function checkBudget(
  budgetFilePath: string,
  dailyBudgetUsd: number,
  prompt?: string,
  messages?: unknown[],
): BudgetDecision {
  loadBudget(budgetFilePath, dailyBudgetUsd);
  const remaining = getRemainingBudget(budgetFilePath);
  const percent = Math.round((remaining / dailyBudgetUsd) * 100);

  if (remaining <= 0) {
    const taskType = detectTaskType(prompt ?? "", messages ?? []);
    return {
      action: "force_local",
      remaining_usd: remaining,
      percent_remaining: percent,
      forced_model: getLocalModels()[taskType],
      task_type: taskType,
    };
  }

  if (percent < 20) {
    return {
      action: "prefer_cheaper",
      remaining_usd: remaining,
      percent_remaining: percent,
    };
  }

  return {
    action: "allow",
    remaining_usd: remaining,
    percent_remaining: percent,
  };
}

// Chain-aware budget decision types
export interface ChainBudgetDecision {
  action: "allow" | "switch_provider" | "all_exhausted";
  currentProvider: string;
  currentModel: string;
  nextProvider?: string;
  nextModel?: string;
  providerRemaining: number;
  providerPercent: number;
  reason: string;
  taskType?: TaskType;
}

export function checkChainBudget(
  chainBudgetPath: string,
  chainConfigPath: string,
  prompt?: string,
  messages?: unknown[],
): ChainBudgetDecision {
  const rawConfig = loadChainConfig(chainConfigPath);
  const config = applyEnvOverrides(rawConfig);
  const budgetData = loadChainBudget(chainBudgetPath, config);

  const activeProviderId = getActiveProvider(budgetData);
  const activeProvider = getProviderById(config, activeProviderId);

  // Determine task type for model selection
  const taskType = detectTaskType(prompt ?? "", messages ?? []);

  // If active provider doesn't exist or is disabled, find first available
  if (!activeProvider || !activeProvider.enabled) {
    const exhausted = getExhaustedProviders(budgetData, config);
    const firstAvailable = getFirstAvailableProvider(config, exhausted);

    if (!firstAvailable) {
      return {
        action: "all_exhausted",
        currentProvider: activeProviderId,
        currentModel: "unknown",
        providerRemaining: 0,
        providerPercent: 0,
        reason: "All providers are exhausted or disabled",
        taskType,
      };
    }

    const model = getModelForTask(firstAvailable, taskType);
    return {
      action: "switch_provider",
      currentProvider: activeProviderId,
      currentModel: "unknown",
      nextProvider: firstAvailable.id,
      nextModel: resolveFullModelId(firstAvailable.id, model),
      providerRemaining: firstAvailable.maxDailyUsd,
      providerPercent: 100,
      reason: `Current provider ${activeProviderId} is disabled or missing`,
      taskType,
    };
  }

  const stats = getProviderStats(budgetData, activeProvider);
  const currentModel = getModelForTask(activeProvider, taskType);

  // Check if current provider is exhausted
  if (stats.exhausted) {
    const exhausted = getExhaustedProviders(budgetData, config);
    const nextProvider = getNextProvider(config, activeProviderId, exhausted);

    if (!nextProvider) {
      return {
        action: "all_exhausted",
        currentProvider: activeProviderId,
        currentModel: resolveFullModelId(activeProviderId, currentModel),
        providerRemaining: 0,
        providerPercent: 0,
        reason: "All providers in the chain are exhausted",
        taskType,
      };
    }

    const nextModel = getModelForTask(nextProvider, taskType);
    return {
      action: "switch_provider",
      currentProvider: activeProviderId,
      currentModel: resolveFullModelId(activeProviderId, currentModel),
      nextProvider: nextProvider.id,
      nextModel: resolveFullModelId(nextProvider.id, nextModel),
      providerRemaining: stats.remaining,
      providerPercent: stats.percent,
      reason: `Provider ${activeProviderId} budget exhausted ($${stats.spent.toFixed(2)}/$${activeProvider.maxDailyUsd.toFixed(2)})`,
      taskType,
    };
  }

  // Provider has budget remaining
  return {
    action: "allow",
    currentProvider: activeProviderId,
    currentModel: resolveFullModelId(activeProviderId, currentModel),
    providerRemaining: stats.remaining,
    providerPercent: stats.percent,
    reason: `Provider ${activeProviderId} has $${stats.remaining.toFixed(2)} remaining (${stats.percent}%)`,
    taskType,
  };
}
