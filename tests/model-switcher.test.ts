import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("../src/ollama-client.js", () => ({
  isOllamaRunning: vi.fn(),
  hasModel: vi.fn(),
}));

import { execSync } from "node:child_process";
import { isOllamaRunning, hasModel } from "../src/ollama-client.js";
import {
  loadSwitcherState,
  saveSwitcherState,
  clearSwitcherState,
  getOpenClawConfig,
  patchOpenClawModel,
  switchToLocalModel,
  restoreCloudModel,
  type SwitcherState,
} from "../src/model-switcher.js";

const TEST_DATA_DIR = path.join(import.meta.dirname, "..", "data-test-switcher");
const TEST_STATE_FILE = path.join(TEST_DATA_DIR, "switcher-state.json");

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

const mockedExecSync = vi.mocked(execSync);
const mockedIsOllamaRunning = vi.mocked(isOllamaRunning);
const mockedHasModel = vi.mocked(hasModel);

beforeEach(() => {
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe("Model Switcher", () => {
  describe("State persistence", () => {
    it("should return null when no state file exists", () => {
      expect(loadSwitcherState(TEST_STATE_FILE)).toBeNull();
    });

    it("should save and load state", () => {
      const state: SwitcherState = {
        mode: "local",
        originalModel: "claude-sonnet-4-20250514",
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
        originalModel: "claude-sonnet-4-20250514",
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

  describe("CLI interaction", () => {
    it("should parse config.get response", () => {
      mockedExecSync.mockReturnValue(
        JSON.stringify({
          config: { agents: { defaults: { model: { primary: "claude-sonnet-4-20250514" } } } },
          hash: "abc123",
        }),
      );

      const result = getOpenClawConfig();

      expect(result.hash).toBe("abc123");
      expect(result.config.agents).toBeDefined();
    });

    it("should call config.patch with model and hash", () => {
      mockedExecSync.mockReturnValue("");

      patchOpenClawModel("ollama/qwen3:8b", "abc123");

      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining("config.patch"),
        expect.objectContaining({ encoding: "utf-8" }),
      );
    });
  });

  describe("switchToLocalModel", () => {
    it("should skip when already switched to local", async () => {
      saveSwitcherState(TEST_STATE_FILE, {
        mode: "local",
        originalModel: "claude-sonnet-4-20250514",
        switchedAt: "2026-01-31T12:00:00.000Z",
        switchedModelId: "ollama/qwen3:8b",
      });

      const result = await switchToLocalModel("general", TEST_STATE_FILE, LOCAL_MODELS, mockLogger);

      expect(result).toBe(false);
      expect(mockedExecSync).not.toHaveBeenCalled();
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
      mockedIsOllamaRunning.mockResolvedValue(true);
      mockedHasModel.mockResolvedValue(true);
      mockedExecSync.mockReturnValueOnce(
        JSON.stringify({
          config: { agents: { defaults: { model: { primary: "claude-sonnet-4-20250514" } } } },
          hash: "abc123",
        }),
      );
      mockedExecSync.mockReturnValueOnce("");

      const result = await switchToLocalModel("coding", TEST_STATE_FILE, LOCAL_MODELS, mockLogger);

      expect(result).toBe(true);
      const state = loadSwitcherState(TEST_STATE_FILE);
      expect(state?.mode).toBe("local");
      expect(state?.switchedModelId).toBe("ollama/qwen3-coder:30b");
      expect(state?.originalModel).toBe("claude-sonnet-4-20250514");
    });

    it("should fall back to general model when target is unavailable", async () => {
      mockedIsOllamaRunning.mockResolvedValue(true);
      mockedHasModel
        .mockResolvedValueOnce(false)  // coding model not available
        .mockResolvedValueOnce(true);  // general model available
      mockedExecSync.mockReturnValueOnce(
        JSON.stringify({
          config: { agents: { defaults: { model: { primary: "claude-sonnet-4-20250514" } } } },
          hash: "abc123",
        }),
      );
      mockedExecSync.mockReturnValueOnce("");

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
      mockedIsOllamaRunning.mockResolvedValue(true);
      mockedHasModel.mockResolvedValue(true);
      mockedExecSync.mockReturnValueOnce(
        JSON.stringify({
          config: { agents: { defaults: { model: { primary: "gpt-4o" } } } },
          hash: "xyz789",
        }),
      );
      mockedExecSync.mockReturnValueOnce("");

      await switchToLocalModel("general", TEST_STATE_FILE, LOCAL_MODELS, mockLogger);

      const state = loadSwitcherState(TEST_STATE_FILE);
      expect(state?.originalModel).toBe("gpt-4o");
    });
  });

  describe("restoreCloudModel", () => {
    it("should restore the original cloud model from state", async () => {
      saveSwitcherState(TEST_STATE_FILE, {
        mode: "local",
        originalModel: "claude-sonnet-4-20250514",
        switchedAt: "2026-01-31T12:00:00.000Z",
        switchedModelId: "ollama/qwen3:8b",
      });

      mockedExecSync.mockReturnValueOnce(
        JSON.stringify({
          config: { agents: { defaults: { model: { primary: "ollama/qwen3:8b" } } } },
          hash: "def456",
        }),
      );
      mockedExecSync.mockReturnValueOnce("");

      const result = await restoreCloudModel(TEST_STATE_FILE, mockLogger);

      expect(result).toBe(true);
      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining("claude-sonnet-4-20250514"),
        expect.any(Object),
      );
    });

    it("should clear state after restoring", async () => {
      saveSwitcherState(TEST_STATE_FILE, {
        mode: "local",
        originalModel: "claude-sonnet-4-20250514",
        switchedAt: "2026-01-31T12:00:00.000Z",
        switchedModelId: "ollama/qwen3:8b",
      });

      mockedExecSync.mockReturnValueOnce(
        JSON.stringify({
          config: { agents: { defaults: { model: { primary: "ollama/qwen3:8b" } } } },
          hash: "def456",
        }),
      );
      mockedExecSync.mockReturnValueOnce("");

      await restoreCloudModel(TEST_STATE_FILE, mockLogger);

      expect(loadSwitcherState(TEST_STATE_FILE)).toBeNull();
    });

    it("should skip when no state file exists", async () => {
      const result = await restoreCloudModel(TEST_STATE_FILE, mockLogger);

      expect(result).toBe(false);
      expect(mockedExecSync).not.toHaveBeenCalled();
    });
  });
});
