import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { loadBudget } from "../src/budget-store.js";
import {
  extractUsageFromMessages,
  calculateCost,
  trackUsage,
  type ModelCost,
} from "../src/usage-tracker.js";

const TEST_DATA_DIR = path.join(import.meta.dirname, "..", "data-test-tracker");
const TEST_BUDGET_FILE = path.join(TEST_DATA_DIR, "budget.json");

beforeEach(() => {
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe("Usage Tracker", () => {
  describe("extractUsageFromMessages", () => {
    it("should extract usage from the last assistant message", () => {
      const messages = [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: "hi there",
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      ];

      const usage = extractUsageFromMessages(messages);

      expect(usage).toEqual({ input_tokens: 100, output_tokens: 50 });
    });

    it("should return null when no assistant message has usage", () => {
      const messages = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ];

      expect(extractUsageFromMessages(messages)).toBeNull();
    });

    it("should use the last assistant message when multiple exist", () => {
      const messages = [
        {
          role: "assistant",
          content: "first",
          usage: { input_tokens: 50, output_tokens: 25 },
        },
        { role: "user", content: "more" },
        {
          role: "assistant",
          content: "second",
          usage: { input_tokens: 200, output_tokens: 100 },
        },
      ];

      const usage = extractUsageFromMessages(messages);

      expect(usage).toEqual({ input_tokens: 200, output_tokens: 100 });
    });

    it("should return null for empty messages array", () => {
      expect(extractUsageFromMessages([])).toBeNull();
    });
  });

  describe("calculateCost", () => {
    it("should calculate cost based on per-1K-token pricing", () => {
      const cost: ModelCost = { input: 0.003, output: 0.015 };

      const result = calculateCost(1000, 500, cost);

      expect(result).toBeCloseTo(0.003 + 0.0075);
    });

    it("should return 0 for zero tokens", () => {
      const cost: ModelCost = { input: 0.003, output: 0.015 };

      expect(calculateCost(0, 0, cost)).toBe(0);
    });

    it("should handle Ollama (free) models with zero cost", () => {
      const cost: ModelCost = { input: 0, output: 0 };

      expect(calculateCost(5000, 2000, cost)).toBe(0);
    });
  });

  describe("trackUsage", () => {
    it("should record a transaction from agent_end event data", () => {
      loadBudget(TEST_BUDGET_FILE, 5.0);

      const messages = [
        {
          role: "assistant",
          content: "response",
          usage: { input_tokens: 1000, output_tokens: 500 },
        },
      ];

      const cost: ModelCost = { input: 0.003, output: 0.015 };
      trackUsage(TEST_BUDGET_FILE, "claude-sonnet-4-20250514", messages, cost, 5.0);

      const data = JSON.parse(fs.readFileSync(TEST_BUDGET_FILE, "utf-8"));
      expect(data.transactions).toHaveLength(1);
      expect(data.transactions[0].model).toBe("claude-sonnet-4-20250514");
      expect(data.transactions[0].cost_usd).toBeCloseTo(0.0105);
    });

    it("should skip recording when no usage data is available", () => {
      loadBudget(TEST_BUDGET_FILE, 5.0);

      const messages = [{ role: "assistant", content: "response" }];
      const cost: ModelCost = { input: 0.003, output: 0.015 };
      trackUsage(TEST_BUDGET_FILE, "claude-sonnet-4-20250514", messages, cost, 5.0);

      const data = JSON.parse(fs.readFileSync(TEST_BUDGET_FILE, "utf-8"));
      expect(data.transactions).toHaveLength(0);
    });
  });
});
