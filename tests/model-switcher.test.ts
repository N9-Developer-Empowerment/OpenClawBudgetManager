import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("../src/ollama-client.js", () => ({
  isOllamaRunning: vi.fn(),
  hasModel: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "node:child_process";
import { isOllamaRunning, hasModel } from "../src/ollama-client.js";
import {
  loadSwitcherState,
  saveSwitcherState,
  clearSwitcherState,
  readOpenClawConfig,
  writeOpenClawConfig,
  switchToLocalModel,
  restoreCloudModel,
  switchToProvider,
  restoreFirstProvider,
  applyOptimizedConfig,
  isOptimizationApplied,
  getOptimizationRules,
  ANTHROPIC_OPTIMIZATION_RULES,
  GENERAL_OPTIMIZATION_RULES,
  type SwitcherState,
} from "../src/model-switcher.js";

import { loadChainBudget } from "../src/chain-budget-store.js";
import type { ChainConfig } from "../src/provider-chain.js";

const mockedExecSync = vi.mocked(execSync);

const TEST_DATA_DIR = path.join(import.meta.dirname, "..", "data-test-switcher");
const TEST_STATE_FILE = path.join(TEST_DATA_DIR, "switcher-state.json");
const TEST_CONFIG_FILE = path.join(TEST_DATA_DIR, "openclaw.json");
const TEST_CHAIN_CONFIG_FILE = path.join(TEST_DATA_DIR, "provider-chain.json");
const TEST_CHAIN_BUDGET_FILE = path.join(TEST_DATA_DIR, "chain-budget.json");

function createTestChainConfig(): ChainConfig {
  return {
    providers: [
      { id: "anthropic", priority: 1, maxDailyUsd: 3.0, enabled: true, models: { default: "claude-sonnet-4", coding: "claude-sonnet-4", vision: "claude-sonnet-4" } },
      { id: "moonshot", priority: 2, maxDailyUsd: 2.0, enabled: true, models: { default: "kimi-k2.5", vision: "kimi-k2.5" } },
      { id: "deepseek", priority: 3, maxDailyUsd: 1.0, enabled: true, models: { default: "deepseek-chat", coding: "deepseek-chat" } },
      { id: "ollama", priority: 99, maxDailyUsd: 0, enabled: true, models: { default: "qwen3:8b", coding: "qwen3-coder:30b", vision: "qwen3-vl:8b" } },
    ],
  };
}

const LOCAL_MODELS = {
  general: "qwen3:8b",
  coding: "qwen3-coder:30b",
  vision: "qwen3-vl:8b",
};

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const mockedIsOllamaRunning = vi.mocked(isOllamaRunning);
const mockedHasModel = vi.mocked(hasModel);

function writeTestConfig(primary = "anthropic/claude-opus-4-5") {
  fs.writeFileSync(TEST_CONFIG_FILE, JSON.stringify({
    agents: { defaults: { model: { primary }, models: { [primary]: {} } } },
  }, null, 2));
}

interface TestConfig {
  agents: {
    defaults: {
      model: { primary: string };
      models: Record<string, unknown>;
    };
  };
}

function readTestConfig(): TestConfig {
  return JSON.parse(fs.readFileSync(TEST_CONFIG_FILE, "utf-8"));
}

beforeEach(() => {
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  vi.clearAllMocks();
  vi.stubEnv("OPENCLAW_CONFIG", TEST_CONFIG_FILE);
});

afterEach(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("Model Switcher", () => {
  describe("State persistence", () => {
    it("should return null when no state file exists", () => {
      expect(loadSwitcherState(TEST_STATE_FILE)).toBeNull();
    });

    it("should save and load state", () => {
      const state: SwitcherState = {
        mode: "local",
        originalModel: "anthropic/claude-opus-4-5",
        switchedAt: "2026-01-31T12:00:00.000Z",
        switchedModelId: "ollama/qwen3:8b",
      };

      saveSwitcherState(TEST_STATE_FILE, state);
      const loaded = loadSwitcherState(TEST_STATE_FILE);

      expect(loaded).toEqual(state);
    });

    it("should clear state file", () => {
      const state: SwitcherState = {
        mode: "local",
        originalModel: "anthropic/claude-opus-4-5",
        switchedAt: "2026-01-31T12:00:00.000Z",
        switchedModelId: "ollama/qwen3:8b",
      };

      saveSwitcherState(TEST_STATE_FILE, state);
      clearSwitcherState(TEST_STATE_FILE);

      expect(loadSwitcherState(TEST_STATE_FILE)).toBeNull();
    });

    it("should return null for corrupted state file", () => {
      fs.writeFileSync(TEST_STATE_FILE, "not json");

      expect(loadSwitcherState(TEST_STATE_FILE)).toBeNull();
    });
  });

  describe("Config read/write", () => {
    it("should read and parse the OpenClaw config", () => {
      writeTestConfig();

      const config = readOpenClawConfig(TEST_CONFIG_FILE);

      expect(config.agents?.defaults?.model?.primary).toBe("anthropic/claude-opus-4-5");
    });

    it("should write config back preserving structure", () => {
      writeTestConfig();
      const config = readOpenClawConfig(TEST_CONFIG_FILE);
      writeOpenClawConfig(config, TEST_CONFIG_FILE);

      const reread = readTestConfig();
      expect(reread.agents.defaults.model.primary).toBe("anthropic/claude-opus-4-5");
    });
  });

  describe("switchToLocalModel", () => {
    it("should skip when already switched to local", async () => {
      saveSwitcherState(TEST_STATE_FILE, {
        mode: "local",
        originalModel: "anthropic/claude-opus-4-5",
        switchedAt: "2026-01-31T12:00:00.000Z",
        switchedModelId: "ollama/qwen3:8b",
      });

      const result = await switchToLocalModel("general", TEST_STATE_FILE, LOCAL_MODELS, mockLogger);

      expect(result).toBe(false);
    });

    it("should skip when Ollama is not running", async () => {
      mockedIsOllamaRunning.mockResolvedValue(false);

      const result = await switchToLocalModel("general", TEST_STATE_FILE, LOCAL_MODELS, mockLogger);

      expect(result).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("not running"),
      );
    });

    it("should switch to the correct model for the task type", async () => {
      writeTestConfig();
      mockedIsOllamaRunning.mockResolvedValue(true);
      mockedHasModel.mockResolvedValue(true);

      const result = await switchToLocalModel("coding", TEST_STATE_FILE, LOCAL_MODELS, mockLogger);

      expect(result).toBe(true);

      const state = loadSwitcherState(TEST_STATE_FILE);
      expect(state?.mode).toBe("local");
      expect(state?.switchedModelId).toBe("ollama/qwen3-coder:30b");
      expect(state?.originalModel).toBe("anthropic/claude-opus-4-5");

      const config = readTestConfig();
      expect(config.agents.defaults.model.primary).toBe("ollama/qwen3-coder:30b");
      expect(config.agents.defaults.models).toHaveProperty("ollama/qwen3-coder:30b");
      expect(mockedExecSync).toHaveBeenCalledWith(
        "openclaw gateway restart",
        expect.objectContaining({ timeout: 15_000 }),
      );
    });

    it("should fall back to general model when target is unavailable", async () => {
      writeTestConfig();
      mockedIsOllamaRunning.mockResolvedValue(true);
      mockedHasModel
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      const result = await switchToLocalModel("coding", TEST_STATE_FILE, LOCAL_MODELS, mockLogger);

      expect(result).toBe(true);
      const state = loadSwitcherState(TEST_STATE_FILE);
      expect(state?.switchedModelId).toBe("ollama/qwen3:8b");
    });

    it("should abort when both target and general models are unavailable", async () => {
      mockedIsOllamaRunning.mockResolvedValue(true);
      mockedHasModel.mockResolvedValue(false);

      const result = await switchToLocalModel("coding", TEST_STATE_FILE, LOCAL_MODELS, mockLogger);

      expect(result).toBe(false);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("also unavailable"),
      );
    });

    it("should save state with the original cloud model", async () => {
      writeTestConfig("gpt-4o");
      mockedIsOllamaRunning.mockResolvedValue(true);
      mockedHasModel.mockResolvedValue(true);

      await switchToLocalModel("general", TEST_STATE_FILE, LOCAL_MODELS, mockLogger);

      const state = loadSwitcherState(TEST_STATE_FILE);
      expect(state?.originalModel).toBe("gpt-4o");
    });
  });

  describe("restoreCloudModel", () => {
    it("should restore the original cloud model from state", async () => {
      writeTestConfig("ollama/qwen3:8b");
      saveSwitcherState(TEST_STATE_FILE, {
        mode: "local",
        originalModel: "anthropic/claude-opus-4-5",
        switchedAt: "2026-01-31T12:00:00.000Z",
        switchedModelId: "ollama/qwen3:8b",
      });

      const result = await restoreCloudModel(TEST_STATE_FILE, mockLogger);

      expect(result).toBe(true);

      const config = readTestConfig();
      expect(config.agents.defaults.model.primary).toBe("anthropic/claude-opus-4-5");
      expect(config.agents.defaults.models).toHaveProperty("anthropic/claude-opus-4-5");
      expect(mockedExecSync).toHaveBeenCalledWith(
        "openclaw gateway restart",
        expect.objectContaining({ timeout: 15_000 }),
      );
    });

    it("should clear state after restoring", async () => {
      writeTestConfig("ollama/qwen3:8b");
      saveSwitcherState(TEST_STATE_FILE, {
        mode: "local",
        originalModel: "anthropic/claude-opus-4-5",
        switchedAt: "2026-01-31T12:00:00.000Z",
        switchedModelId: "ollama/qwen3:8b",
      });

      await restoreCloudModel(TEST_STATE_FILE, mockLogger);

      expect(loadSwitcherState(TEST_STATE_FILE)).toBeNull();
    });

    it("should skip when no state file exists", async () => {
      const result = await restoreCloudModel(TEST_STATE_FILE, mockLogger);

      expect(result).toBe(false);
    });
  });

  describe("switchToProvider", () => {
    beforeEach(() => {
      const chainConfig = createTestChainConfig();
      fs.writeFileSync(TEST_CHAIN_CONFIG_FILE, JSON.stringify(chainConfig, null, 2));
      loadChainBudget(TEST_CHAIN_BUDGET_FILE, chainConfig);
    });

    it("should switch to specified provider", async () => {
      writeTestConfig("anthropic/claude-sonnet-4");

      const result = await switchToProvider(
        "moonshot",
        "general",
        TEST_CHAIN_CONFIG_FILE,
        TEST_CHAIN_BUDGET_FILE,
        mockLogger,
      );

      expect(result).toBe(true);
      const config = readTestConfig();
      expect(config.agents.defaults.model.primary).toBe("moonshot/kimi-k2.5");
      expect(mockedExecSync).toHaveBeenCalledWith(
        "openclaw gateway restart",
        expect.objectContaining({ timeout: 15_000 }),
      );
    });

    it("should use correct model for task type", async () => {
      writeTestConfig("anthropic/claude-sonnet-4");

      await switchToProvider(
        "deepseek",
        "coding",
        TEST_CHAIN_CONFIG_FILE,
        TEST_CHAIN_BUDGET_FILE,
        mockLogger,
      );

      const config = readTestConfig();
      expect(config.agents.defaults.model.primary).toBe("deepseek/deepseek-chat");
    });

    it("should fail for unknown provider", async () => {
      writeTestConfig();

      const result = await switchToProvider(
        "unknown",
        "general",
        TEST_CHAIN_CONFIG_FILE,
        TEST_CHAIN_BUDGET_FILE,
        mockLogger,
      );

      expect(result).toBe(false);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("not found"),
      );
    });

    it("should fail for disabled provider", async () => {
      const config = createTestChainConfig();
      config.providers[1].enabled = false;
      fs.writeFileSync(TEST_CHAIN_CONFIG_FILE, JSON.stringify(config, null, 2));

      const result = await switchToProvider(
        "moonshot",
        "general",
        TEST_CHAIN_CONFIG_FILE,
        TEST_CHAIN_BUDGET_FILE,
        mockLogger,
      );

      expect(result).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("disabled"),
      );
    });

    it("should check Ollama availability when switching to ollama", async () => {
      writeTestConfig();
      mockedIsOllamaRunning.mockResolvedValue(false);

      const result = await switchToProvider(
        "ollama",
        "general",
        TEST_CHAIN_CONFIG_FILE,
        TEST_CHAIN_BUDGET_FILE,
        mockLogger,
      );

      expect(result).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("not running"),
      );
    });

    it("should record switch in chain budget", async () => {
      writeTestConfig("anthropic/claude-sonnet-4");

      await switchToProvider(
        "moonshot",
        "general",
        TEST_CHAIN_CONFIG_FILE,
        TEST_CHAIN_BUDGET_FILE,
        mockLogger,
      );

      const budgetData = JSON.parse(fs.readFileSync(TEST_CHAIN_BUDGET_FILE, "utf-8"));
      expect(budgetData.activeProvider).toBe("moonshot");
      expect(budgetData.switchHistory.length).toBeGreaterThan(0);
    });
  });

  describe("restoreFirstProvider", () => {
    beforeEach(() => {
      const chainConfig = createTestChainConfig();
      fs.writeFileSync(TEST_CHAIN_CONFIG_FILE, JSON.stringify(chainConfig, null, 2));
    });

    it("should restore to first provider in chain", async () => {
      writeTestConfig("deepseek/deepseek-chat");
      const config = createTestChainConfig();
      const budgetData = {
        date: new Date().toISOString().split("T")[0],
        providers: {
          anthropic: { spentUsd: 0, exhausted: false },
          moonshot: { spentUsd: 0, exhausted: false },
          deepseek: { spentUsd: 0, exhausted: false },
          ollama: { spentUsd: 0, exhausted: false },
        },
        transactions: [],
        activeProvider: "deepseek",
        switchHistory: [],
      };
      fs.writeFileSync(TEST_CHAIN_BUDGET_FILE, JSON.stringify(budgetData, null, 2));

      const result = await restoreFirstProvider(
        TEST_CHAIN_CONFIG_FILE,
        TEST_CHAIN_BUDGET_FILE,
        mockLogger,
      );

      expect(result).toBe(true);
      const openclawConfig = readTestConfig();
      expect(openclawConfig.agents.defaults.model.primary).toBe("anthropic/claude-sonnet-4");
    });

    it("should skip if already on first provider", async () => {
      writeTestConfig("anthropic/claude-sonnet-4");
      const config = createTestChainConfig();
      loadChainBudget(TEST_CHAIN_BUDGET_FILE, config);

      const result = await restoreFirstProvider(
        TEST_CHAIN_CONFIG_FILE,
        TEST_CHAIN_BUDGET_FILE,
        mockLogger,
      );

      expect(result).toBe(false);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("Already on first provider"),
      );
    });

    it("should update chain budget active provider", async () => {
      writeTestConfig("deepseek/deepseek-chat");
      const budgetData = {
        date: new Date().toISOString().split("T")[0],
        providers: {
          anthropic: { spentUsd: 0, exhausted: false },
          moonshot: { spentUsd: 0, exhausted: false },
          deepseek: { spentUsd: 0, exhausted: false },
          ollama: { spentUsd: 0, exhausted: false },
        },
        transactions: [],
        activeProvider: "deepseek",
        switchHistory: [],
      };
      fs.writeFileSync(TEST_CHAIN_BUDGET_FILE, JSON.stringify(budgetData, null, 2));

      await restoreFirstProvider(
        TEST_CHAIN_CONFIG_FILE,
        TEST_CHAIN_BUDGET_FILE,
        mockLogger,
      );

      const newBudgetData = JSON.parse(fs.readFileSync(TEST_CHAIN_BUDGET_FILE, "utf-8"));
      expect(newBudgetData.activeProvider).toBe("anthropic");
    });
  });

  describe("applyOptimizedConfig", () => {
    it("should set Sonnet as default model", () => {
      writeTestConfig("anthropic/claude-3-5-haiku-20241022");

      const result = applyOptimizedConfig(mockLogger);

      expect(result).toBe(true);
      const config = readTestConfig();
      expect(config.agents.defaults.model.primary).toBe("anthropic/claude-sonnet-4-20250514");
    });

    it("should add model aliases for sonnet, haiku, and opus", () => {
      writeTestConfig("anthropic/claude-sonnet-4-20250514");

      applyOptimizedConfig(mockLogger);

      const config = readTestConfig();
      expect(config.agents.defaults.models["anthropic/claude-sonnet-4-20250514"]).toEqual({ alias: "sonnet" });
      expect(config.agents.defaults.models["anthropic/claude-3-5-haiku-20241022"]).toEqual({ alias: "haiku" });
      expect(config.agents.defaults.models["anthropic/claude-opus-4-20250514"]).toEqual({ alias: "opus" });
    });

    it("should accept custom default model", () => {
      writeTestConfig("anthropic/claude-sonnet-4-20250514");

      applyOptimizedConfig(mockLogger, {
        defaultModel: "anthropic/claude-sonnet-4-20250514",
      });

      const config = readTestConfig();
      expect(config.agents.defaults.model.primary).toBe("anthropic/claude-sonnet-4-20250514");
    });
  });

  describe("isOptimizationApplied", () => {
    it("should return true when model aliases are configured", () => {
      writeTestConfig("anthropic/claude-sonnet-4-20250514");
      // Apply optimization to set up aliases
      applyOptimizedConfig(mockLogger);

      expect(isOptimizationApplied()).toBe(true);
    });

    it("should return false when aliases are not set up", () => {
      writeTestConfig("anthropic/claude-sonnet-4-20250514");

      expect(isOptimizationApplied()).toBe(false);
    });
  });

  describe("getOptimizationRules", () => {
    it("should return Anthropic rules when provider is anthropic", () => {
      const rules = getOptimizationRules("anthropic");

      expect(rules).toBe(ANTHROPIC_OPTIMIZATION_RULES);
      expect(rules).toContain("MODEL SELECTION (Anthropic)");
      expect(rules).toContain("Default: Sonnet");
      expect(rules).toContain("[MODEL RECOMMENDATION]");
    });

    it("should return general rules for non-Anthropic providers", () => {
      expect(getOptimizationRules("moonshot")).toBe(GENERAL_OPTIMIZATION_RULES);
      expect(getOptimizationRules("deepseek")).toBe(GENERAL_OPTIMIZATION_RULES);
      expect(getOptimizationRules("openai")).toBe(GENERAL_OPTIMIZATION_RULES);
      expect(getOptimizationRules("ollama")).toBe(GENERAL_OPTIMIZATION_RULES);
    });

    it("should return general rules for unknown providers", () => {
      expect(getOptimizationRules("unknown")).toBe(GENERAL_OPTIMIZATION_RULES);
    });
  });

  describe("ANTHROPIC_OPTIMIZATION_RULES", () => {
    it("should contain session initialization rules", () => {
      expect(ANTHROPIC_OPTIMIZATION_RULES).toContain("SESSION INITIALIZATION RULE");
      expect(ANTHROPIC_OPTIMIZATION_RULES).toContain("Load ONLY essential context");
    });

    it("should contain model selection with automatic recommendations", () => {
      expect(ANTHROPIC_OPTIMIZATION_RULES).toContain("MODEL SELECTION (Anthropic)");
      expect(ANTHROPIC_OPTIMIZATION_RULES).toContain("Default: Sonnet");
      expect(ANTHROPIC_OPTIMIZATION_RULES).toContain("[MODEL RECOMMENDATION]");
      expect(ANTHROPIC_OPTIMIZATION_RULES).toContain("/model haiku");
      expect(ANTHROPIC_OPTIMIZATION_RULES).toContain("/model opus");
    });

    it("should contain rate limits", () => {
      expect(ANTHROPIC_OPTIMIZATION_RULES).toContain("RATE LIMITS");
      expect(ANTHROPIC_OPTIMIZATION_RULES).toContain("5 seconds minimum");
    });
  });

  describe("GENERAL_OPTIMIZATION_RULES", () => {
    it("should contain session initialization rules", () => {
      expect(GENERAL_OPTIMIZATION_RULES).toContain("SESSION INITIALIZATION RULE");
    });

    it("should NOT contain Haiku/Sonnet model selection rules", () => {
      expect(GENERAL_OPTIMIZATION_RULES).not.toContain("use Haiku");
      expect(GENERAL_OPTIMIZATION_RULES).not.toContain("Switch to Sonnet");
    });

    it("should mention fallback provider status", () => {
      expect(GENERAL_OPTIMIZATION_RULES).toContain("Anthropic budget was exhausted");
      expect(GENERAL_OPTIMIZATION_RULES).toContain("fallback provider");
    });

    it("should contain rate limits", () => {
      expect(GENERAL_OPTIMIZATION_RULES).toContain("RATE LIMITS");
      expect(GENERAL_OPTIMIZATION_RULES).toContain("5 seconds minimum");
    });
  });
});
