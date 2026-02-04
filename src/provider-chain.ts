import fs from "node:fs";
import path from "node:path";

export interface ProviderConfig {
  id: string;
  priority: number;
  maxDailyUsd: number;
  enabled: boolean;
  models: {
    default: string;
    coding?: string;
    vision?: string;
  };
}

export interface ChainConfig {
  providers: ProviderConfig[];
}

export type TaskType = "general" | "coding" | "vision";

export function loadChainConfig(configPath: string): ChainConfig {
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });

  if (!fs.existsSync(configPath)) {
    const defaultConfig = getDefaultChainConfig();
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
    return defaultConfig;
  }

  return JSON.parse(fs.readFileSync(configPath, "utf-8")) as ChainConfig;
}

export function saveChainConfig(configPath: string, config: ChainConfig): void {
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

export function getEnabledProviders(config: ChainConfig): ProviderConfig[] {
  return config.providers
    .filter((p) => p.enabled)
    .sort((a, b) => a.priority - b.priority);
}

export function getProviderById(config: ChainConfig, providerId: string): ProviderConfig | null {
  return config.providers.find((p) => p.id === providerId) ?? null;
}

export function getNextProvider(
  config: ChainConfig,
  currentProviderId: string,
  exhaustedProviders: string[],
): ProviderConfig | null {
  const enabled = getEnabledProviders(config);
  const exhaustedSet = new Set(exhaustedProviders);

  const currentProvider = enabled.find((p) => p.id === currentProviderId);
  const currentPriority = currentProvider?.priority ?? 0;

  for (const provider of enabled) {
    if (provider.priority > currentPriority && !exhaustedSet.has(provider.id)) {
      return provider;
    }
  }

  return null;
}

export function getFirstAvailableProvider(
  config: ChainConfig,
  exhaustedProviders: string[],
): ProviderConfig | null {
  const enabled = getEnabledProviders(config);
  const exhaustedSet = new Set(exhaustedProviders);

  for (const provider of enabled) {
    if (!exhaustedSet.has(provider.id)) {
      return provider;
    }
  }

  return null;
}

export function getModelForTask(
  provider: ProviderConfig,
  taskType: TaskType,
): string {
  switch (taskType) {
    case "coding":
      return provider.models.coding ?? provider.models.default;
    case "vision":
      return provider.models.vision ?? provider.models.default;
    default:
      return provider.models.default;
  }
}

export function resolveFullModelId(providerId: string, modelId: string): string {
  if (modelId.includes("/")) {
    return modelId;
  }
  return `${providerId}/${modelId}`;
}

export function applyEnvOverrides(config: ChainConfig): ChainConfig {
  const updated = structuredClone(config);

  for (const provider of updated.providers) {
    const envKey = `${provider.id.toUpperCase()}_DAILY_BUDGET_USD`;
    const envValue = process.env[envKey];
    if (envValue !== undefined) {
      const parsed = parseFloat(envValue);
      if (!isNaN(parsed)) {
        provider.maxDailyUsd = parsed;
      }
    }

    const enabledKey = `${provider.id.toUpperCase()}_ENABLED`;
    const enabledValue = process.env[enabledKey];
    if (enabledValue !== undefined) {
      provider.enabled = enabledValue.toLowerCase() === "true";
    }
  }

  return updated;
}

function getDefaultChainConfig(): ChainConfig {
  return {
    providers: [
      {
        id: "anthropic",
        priority: 1,
        maxDailyUsd: 3.0,
        enabled: true,
        models: {
          default: "claude-sonnet-4-20250514",
          coding: "claude-sonnet-4-20250514",
          vision: "claude-sonnet-4-20250514",
        },
      },
      {
        id: "moonshot",
        priority: 2,
        maxDailyUsd: 2.0,
        enabled: true,
        models: {
          default: "kimi-k2.5",
          vision: "kimi-k2.5",
        },
      },
      {
        id: "deepseek",
        priority: 3,
        maxDailyUsd: 1.0,
        enabled: true,
        models: {
          default: "deepseek-chat",
          coding: "deepseek-chat",
        },
      },
      {
        id: "google",
        priority: 4,
        maxDailyUsd: 1.0,
        enabled: true,
        models: {
          default: "gemini-2.5-flash",
          vision: "gemini-2.5-pro",
        },
      },
      {
        id: "openai",
        priority: 5,
        maxDailyUsd: 1.0,
        enabled: true,
        models: {
          default: "gpt-4o-mini",
          coding: "gpt-4o",
          vision: "gpt-4o",
        },
      },
      {
        id: "ollama",
        priority: 99,
        maxDailyUsd: 0,
        enabled: true,
        models: {
          default: "qwen3:8b",
          coding: "qwen3-coder:30b",
          vision: "qwen3-vl:8b",
        },
      },
    ],
  };
}
