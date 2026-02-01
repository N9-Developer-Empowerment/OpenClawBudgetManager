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
  type SwitcherState,
} from "../src/model-switcher.js";

const mockedExecSync = vi.mocked(execSync);

const TEST_DATA_DIR = path.join(import.meta.dirname, "..", "data-test-switcher");
const TEST_STATE_FILE = path.join(TEST_DATA_DIR, "switcher-state.json");
const TEST_CONFIG_FILE = path.join(TEST_DATA_DIR, "openclaw.json");

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
});
