import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { loadBudget, recordTransaction } from "../src/budget-store.js";
import {
  checkBudget,
  detectTaskType,
  getLocalModels,
} from "../src/budget-gate.js";

const TEST_DATA_DIR = path.join(import.meta.dirname, "..", "data-test-gate");
const TEST_BUDGET_FILE = path.join(TEST_DATA_DIR, "budget.json");

beforeEach(() => {
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe("Budget Gate", () => {
  describe("detectTaskType", () => {
    it("should return 'coding' when prompt contains coding keywords", () => {
      expect(detectTaskType("fix the bug in my function", [])).toBe("coding");
      expect(detectTaskType("implement a new feature", [])).toBe("coding");
      expect(detectTaskType("refactor this class", [])).toBe("coding");
      expect(detectTaskType("debug the compile error", [])).toBe("coding");
    });

    it("should return 'coding' when prompt mentions file extensions", () => {
      expect(detectTaskType("edit main.ts", [])).toBe("coding");
      expect(detectTaskType("update styles.css", [])).toBe("coding");
      expect(detectTaskType("check server.py for issues", [])).toBe("coding");
      expect(detectTaskType("open config.yml", [])).toBe("coding");
    });

    it("should return 'vision' when messages contain image content blocks", () => {
      const messages = [
        { role: "user", content: [{ type: "image", source: { url: "screenshot.png" } }] },
      ];

      expect(detectTaskType("describe this", messages)).toBe("vision");
    });

    it("should return 'general' for generic text with no coding or vision signals", () => {
      expect(detectTaskType("what is the weather today?", [])).toBe("general");
      expect(detectTaskType("tell me a joke", [])).toBe("general");
      expect(detectTaskType("summarise this document", [])).toBe("general");
    });

    it("should prioritise vision over coding when both signals are present", () => {
      const messages = [
        { role: "user", content: [{ type: "image", source: { url: "code.png" } }] },
      ];

      expect(detectTaskType("debug this function", messages)).toBe("vision");
    });
  });

  describe("getLocalModels", () => {
    const ENV_KEYS = ["LOCAL_MODEL", "LOCAL_MODEL_GENERAL", "LOCAL_MODEL_CODING", "LOCAL_MODEL_VISION"] as const;
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

    it("should return built-in defaults when no env vars are set", () => {
      const models = getLocalModels();

      expect(models.general).toBe("qwen3:8b");
      expect(models.coding).toBe("qwen3-coder:30b");
      expect(models.vision).toBe("qwen3-vl:8b");
    });

    it("should use LOCAL_MODEL for all task types when set", () => {
      process.env.LOCAL_MODEL = "llama3:8b";

      const models = getLocalModels();

      expect(models.general).toBe("llama3:8b");
      expect(models.coding).toBe("llama3:8b");
      expect(models.vision).toBe("llama3:8b");
    });

    it("should let specific env vars override LOCAL_MODEL", () => {
      process.env.LOCAL_MODEL = "llama3:8b";
      process.env.LOCAL_MODEL_CODING = "codellama:7b";

      const models = getLocalModels();

      expect(models.general).toBe("llama3:8b");
      expect(models.coding).toBe("codellama:7b");
      expect(models.vision).toBe("llama3:8b");
    });

    it("should let specific env vars override defaults without LOCAL_MODEL", () => {
      process.env.LOCAL_MODEL_VISION = "llava:13b";

      const models = getLocalModels();

      expect(models.general).toBe("qwen3:8b");
      expect(models.coding).toBe("qwen3-coder:30b");
      expect(models.vision).toBe("llava:13b");
    });
  });

  describe("checkBudget", () => {
    it("should allow any model when budget is healthy (> 20%)", () => {
      loadBudget(TEST_BUDGET_FILE, 5.0);

      const decision = checkBudget(TEST_BUDGET_FILE, 5.0);

      expect(decision.action).toBe("allow");
      expect(decision.remaining_usd).toBe(5.0);
    });

    it("should prefer cheaper models when budget is low (< 20%)", () => {
      loadBudget(TEST_BUDGET_FILE, 5.0);
      recordTransaction(TEST_BUDGET_FILE, "claude-sonnet-4-20250514", 50000, 25000, 4.2);

      const decision = checkBudget(TEST_BUDGET_FILE, 5.0);

      expect(decision.action).toBe("prefer_cheaper");
      expect(decision.remaining_usd).toBeCloseTo(0.8);
    });

    it("should force local model when over budget", () => {
      loadBudget(TEST_BUDGET_FILE, 5.0);
      recordTransaction(TEST_BUDGET_FILE, "claude-sonnet-4-20250514", 100000, 50000, 5.5);

      const decision = checkBudget(TEST_BUDGET_FILE, 5.0);

      expect(decision.action).toBe("force_local");
      expect(decision.forced_model).toBe(getLocalModels().general);
      expect(decision.task_type).toBe("general");
    });

    it("should force coding model when over budget and prompt has coding keywords", () => {
      loadBudget(TEST_BUDGET_FILE, 5.0);
      recordTransaction(TEST_BUDGET_FILE, "claude-sonnet-4-20250514", 100000, 50000, 5.5);

      const decision = checkBudget(TEST_BUDGET_FILE, 5.0, "fix the bug in my code");

      expect(decision.action).toBe("force_local");
      expect(decision.forced_model).toBe("qwen3-coder:30b");
      expect(decision.task_type).toBe("coding");
    });

    it("should force vision model when over budget and messages contain images", () => {
      loadBudget(TEST_BUDGET_FILE, 5.0);
      recordTransaction(TEST_BUDGET_FILE, "claude-sonnet-4-20250514", 100000, 50000, 5.5);

      const messages = [
        { role: "user", content: [{ type: "image", source: { url: "screenshot.png" } }] },
      ];
      const decision = checkBudget(TEST_BUDGET_FILE, 5.0, "describe this", messages);

      expect(decision.action).toBe("force_local");
      expect(decision.forced_model).toBe("qwen3-vl:8b");
      expect(decision.task_type).toBe("vision");
    });

    it("should force local when exactly at budget", () => {
      loadBudget(TEST_BUDGET_FILE, 5.0);
      recordTransaction(TEST_BUDGET_FILE, "claude-sonnet-4-20250514", 100000, 50000, 5.0);

      const decision = checkBudget(TEST_BUDGET_FILE, 5.0);

      expect(decision.action).toBe("force_local");
    });

    it("should include percentage remaining in the decision", () => {
      loadBudget(TEST_BUDGET_FILE, 10.0);
      recordTransaction(TEST_BUDGET_FILE, "gpt-4o", 5000, 2500, 5.0);

      const decision = checkBudget(TEST_BUDGET_FILE, 10.0);

      expect(decision.percent_remaining).toBe(50);
    });
  });
});
