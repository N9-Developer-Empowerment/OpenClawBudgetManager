import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  loadChainConfig,
  saveChainConfig,
  getEnabledProviders,
  getProviderById,
  getNextProvider,
  getFirstAvailableProvider,
  getModelForTask,
  resolveFullModelId,
  applyEnvOverrides,
  type ChainConfig,
  type ProviderConfig,
} from "../src/provider-chain.js";

const TEST_DATA_DIR = path.join(import.meta.dirname, "..", "data-test-chain");
const TEST_CONFIG_FILE = path.join(TEST_DATA_DIR, "provider-chain.json");

function createTestConfig(): ChainConfig {
  return {
    providers: [
      {
        id: "anthropic",
        priority: 1,
        maxDailyUsd: 3.0,
        enabled: true,
        models: { default: "claude-sonnet-4", coding: "claude-sonnet-4", vision: "claude-sonnet-4" },
      },
      {
        id: "moonshot",
        priority: 2,
        maxDailyUsd: 2.0,
        enabled: true,
        models: { default: "kimi-k2.5", vision: "kimi-k2.5" },
      },
      {
        id: "deepseek",
        priority: 3,
        maxDailyUsd: 1.0,
        enabled: true,
        models: { default: "deepseek-chat", coding: "deepseek-chat" },
      },
      {
        id: "google",
        priority: 4,
        maxDailyUsd: 1.0,
        enabled: false,
        models: { default: "gemini-2.5-flash", vision: "gemini-2.5-pro" },
      },
      {
        id: "openai",
        priority: 5,
        maxDailyUsd: 1.0,
        enabled: true,
        models: { default: "gpt-4o-mini", coding: "gpt-4o", vision: "gpt-4o" },
      },
      {
        id: "ollama",
        priority: 99,
        maxDailyUsd: 0,
        enabled: true,
        models: { default: "qwen3:8b", coding: "qwen3-coder:30b", vision: "qwen3-vl:8b" },
      },
    ],
  };
}

beforeEach(() => {
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe("Provider Chain", () => {
  describe("loadChainConfig", () => {
    it("should create default config when file does not exist", () => {
      const config = loadChainConfig(TEST_CONFIG_FILE);

      expect(config.providers).toBeDefined();
      expect(config.providers.length).toBeGreaterThan(0);
      expect(fs.existsSync(TEST_CONFIG_FILE)).toBe(true);
    });

    it("should load existing config from file", () => {
      const testConfig = createTestConfig();
      fs.writeFileSync(TEST_CONFIG_FILE, JSON.stringify(testConfig, null, 2));

      const config = loadChainConfig(TEST_CONFIG_FILE);

      expect(config.providers.length).toBe(6);
      expect(config.providers[0].id).toBe("anthropic");
    });
  });

  describe("saveChainConfig", () => {
    it("should save config to file", () => {
      const config = createTestConfig();

      saveChainConfig(TEST_CONFIG_FILE, config);

      const loaded = JSON.parse(fs.readFileSync(TEST_CONFIG_FILE, "utf-8"));
      expect(loaded.providers.length).toBe(6);
    });
  });

  describe("getEnabledProviders", () => {
    it("should return only enabled providers sorted by priority", () => {
      const config = createTestConfig();

      const enabled = getEnabledProviders(config);

      expect(enabled.map((p) => p.id)).toEqual([
        "anthropic",
        "moonshot",
        "deepseek",
        "openai",
        "ollama",
      ]);
      expect(enabled.find((p) => p.id === "google")).toBeUndefined();
    });

    it("should return empty array when no providers are enabled", () => {
      const config = createTestConfig();
      config.providers.forEach((p) => (p.enabled = false));

      const enabled = getEnabledProviders(config);

      expect(enabled).toEqual([]);
    });
  });

  describe("getProviderById", () => {
    it("should return the provider with matching id", () => {
      const config = createTestConfig();

      const provider = getProviderById(config, "deepseek");

      expect(provider?.id).toBe("deepseek");
      expect(provider?.maxDailyUsd).toBe(1.0);
    });

    it("should return null for unknown provider id", () => {
      const config = createTestConfig();

      const provider = getProviderById(config, "unknown");

      expect(provider).toBeNull();
    });
  });

  describe("getNextProvider", () => {
    it("should return the next enabled provider by priority", () => {
      const config = createTestConfig();

      const next = getNextProvider(config, "anthropic", []);

      expect(next?.id).toBe("moonshot");
    });

    it("should skip exhausted providers", () => {
      const config = createTestConfig();

      const next = getNextProvider(config, "anthropic", ["moonshot"]);

      expect(next?.id).toBe("deepseek");
    });

    it("should skip disabled providers", () => {
      const config = createTestConfig();

      const next = getNextProvider(config, "deepseek", []);

      expect(next?.id).toBe("openai");
    });

    it("should return null when all providers are exhausted", () => {
      const config = createTestConfig();

      const next = getNextProvider(
        config,
        "anthropic",
        ["moonshot", "deepseek", "openai", "ollama"],
      );

      expect(next).toBeNull();
    });

    it("should return ollama as final fallback", () => {
      const config = createTestConfig();

      const next = getNextProvider(
        config,
        "openai",
        [],
      );

      expect(next?.id).toBe("ollama");
    });
  });

  describe("getFirstAvailableProvider", () => {
    it("should return the first non-exhausted provider", () => {
      const config = createTestConfig();

      const first = getFirstAvailableProvider(config, ["anthropic"]);

      expect(first?.id).toBe("moonshot");
    });

    it("should return null when all providers are exhausted", () => {
      const config = createTestConfig();
      const allProviders = config.providers.filter((p) => p.enabled).map((p) => p.id);

      const first = getFirstAvailableProvider(config, allProviders);

      expect(first).toBeNull();
    });
  });

  describe("getModelForTask", () => {
    it("should return coding model for coding tasks", () => {
      const provider: ProviderConfig = {
        id: "openai",
        priority: 5,
        maxDailyUsd: 1.0,
        enabled: true,
        models: { default: "gpt-4o-mini", coding: "gpt-4o", vision: "gpt-4o" },
      };

      const model = getModelForTask(provider, "coding");

      expect(model).toBe("gpt-4o");
    });

    it("should return vision model for vision tasks", () => {
      const provider: ProviderConfig = {
        id: "google",
        priority: 4,
        maxDailyUsd: 1.0,
        enabled: true,
        models: { default: "gemini-2.5-flash", vision: "gemini-2.5-pro" },
      };

      const model = getModelForTask(provider, "vision");

      expect(model).toBe("gemini-2.5-pro");
    });

    it("should fall back to default model when task-specific model is not defined", () => {
      const provider: ProviderConfig = {
        id: "moonshot",
        priority: 2,
        maxDailyUsd: 2.0,
        enabled: true,
        models: { default: "kimi-k2.5" },
      };

      const model = getModelForTask(provider, "coding");

      expect(model).toBe("kimi-k2.5");
    });

    it("should return default model for general tasks", () => {
      const provider: ProviderConfig = {
        id: "openai",
        priority: 5,
        maxDailyUsd: 1.0,
        enabled: true,
        models: { default: "gpt-4o-mini", coding: "gpt-4o", vision: "gpt-4o" },
      };

      const model = getModelForTask(provider, "general");

      expect(model).toBe("gpt-4o-mini");
    });
  });

  describe("resolveFullModelId", () => {
    it("should prefix model with provider id", () => {
      const fullId = resolveFullModelId("anthropic", "claude-sonnet-4");

      expect(fullId).toBe("anthropic/claude-sonnet-4");
    });

    it("should not double-prefix if model already has provider", () => {
      const fullId = resolveFullModelId("anthropic", "anthropic/claude-sonnet-4");

      expect(fullId).toBe("anthropic/claude-sonnet-4");
    });
  });

  describe("applyEnvOverrides", () => {
    const ENV_KEYS = [
      "ANTHROPIC_DAILY_BUDGET_USD",
      "MOONSHOT_ENABLED",
      "BYTEDANCE_ARK_DAILY_BUDGET_USD",
      "OPENROUTER_GLM_ENABLED",
    ] as const;
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const key of ENV_KEYS) {
        saved[key] = process.env[key];
        delete process.env[key];
      }
    });

    afterEach(() => {
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = saved[key];
        }
      }
    });

    it("should override maxDailyUsd from environment variable", () => {
      const config = createTestConfig();
      process.env.ANTHROPIC_DAILY_BUDGET_USD = "5.00";

      const updated = applyEnvOverrides(config);

      expect(updated.providers.find((p) => p.id === "anthropic")?.maxDailyUsd).toBe(5.0);
    });

    it("should override enabled status from environment variable", () => {
      const config = createTestConfig();
      process.env.MOONSHOT_ENABLED = "false";

      const updated = applyEnvOverrides(config);

      expect(updated.providers.find((p) => p.id === "moonshot")?.enabled).toBe(false);
    });

    it("should not modify original config", () => {
      const config = createTestConfig();
      process.env.ANTHROPIC_DAILY_BUDGET_USD = "10.00";

      applyEnvOverrides(config);

      expect(config.providers.find((p) => p.id === "anthropic")?.maxDailyUsd).toBe(3.0);
    });

    it("should convert hyphens to underscores for env var names", () => {
      const config: ChainConfig = {
        providers: [
          ...createTestConfig().providers,
          {
            id: "bytedance-ark",
            priority: 0,
            maxDailyUsd: 3.0,
            enabled: true,
            models: { default: "doubao-seed-2.0-pro" },
          },
          {
            id: "openrouter-glm",
            priority: 0,
            maxDailyUsd: 3.0,
            enabled: true,
            models: { default: "glm-5" },
          },
        ],
      };
      process.env.BYTEDANCE_ARK_DAILY_BUDGET_USD = "7.50";
      process.env.OPENROUTER_GLM_ENABLED = "false";

      const updated = applyEnvOverrides(config);

      expect(updated.providers.find((p) => p.id === "bytedance-ark")?.maxDailyUsd).toBe(7.5);
      expect(updated.providers.find((p) => p.id === "openrouter-glm")?.enabled).toBe(false);
    });
  });
});
