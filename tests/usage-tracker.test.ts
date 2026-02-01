import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { loadBudget, recordTransaction, getLastTransactionTimestamp } from "../src/budget-store.js";
import {
  aggregateUsageFromMessages,
  calculateCost,
  trackUsage,
  type ModelCost,
} from "../src/usage-tracker.js";

const TEST_DATA_DIR = path.join(import.meta.dirname, "..", "data-test-tracker");
const TEST_BUDGET_FILE = path.join(TEST_DATA_DIR, "budget.json");
const FREE: ModelCost = { input: 0, output: 0 };

beforeEach(() => {
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe("Usage Tracker", () => {
  describe("aggregateUsageFromMessages", () => {
    it("should extract usage from a single assistant message", () => {
      const messages = [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: "hi",
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      ];

      const result = aggregateUsageFromMessages(messages, "unknown", FREE);

      expect(result).not.toBeNull();
      expect(result!.input_tokens).toBe(100);
      expect(result!.output_tokens).toBe(50);
    });

    it("should sum usage across multiple assistant messages in a tool-use turn", () => {
      const messages = [
        { role: "user", content: "search for X" },
        {
          role: "assistant",
          content: "calling tool",
          model: "claude-opus-4-5",
          provider: "anthropic",
          usage: { input: 500, output: 100, cost: { total: 0.05 } },
        },
        { role: "tool", content: "tool result" },
        {
          role: "assistant",
          content: "here is the answer",
          model: "claude-opus-4-5",
          provider: "anthropic",
          usage: { input: 800, output: 200, cost: { total: 0.08 } },
        },
      ];

      const result = aggregateUsageFromMessages(messages, "unknown", FREE);

      expect(result).not.toBeNull();
      expect(result!.input_tokens).toBe(1300);
      expect(result!.output_tokens).toBe(300);
      expect(result!.cost).toBeCloseTo(0.13);
      expect(result!.model).toBe("anthropic/claude-opus-4-5");
    });

    it("should extract OpenClaw-format usage (input/output without _tokens suffix)", () => {
      const messages = [
        {
          role: "assistant",
          content: "response",
          usage: { input: 8, output: 68, cacheRead: 22022, totalTokens: 22098 },
        },
      ];

      const result = aggregateUsageFromMessages(messages, "unknown", FREE);

      expect(result).not.toBeNull();
      expect(result!.input_tokens).toBe(8);
      expect(result!.output_tokens).toBe(68);
    });

    it("should use pre-calculated cost when available", () => {
      const messages = [
        {
          role: "assistant",
          content: "response",
          usage: { input: 8, output: 68, cost: { total: 0.013976 } },
        },
      ];

      const result = aggregateUsageFromMessages(messages, "unknown", FREE);

      expect(result!.cost).toBe(0.013976);
    });

    it("should fall back to token-based cost calculation when no pre-calculated cost", () => {
      const cost: ModelCost = { input: 0.003, output: 0.015 };
      const messages = [
        {
          role: "assistant",
          content: "response",
          usage: { input_tokens: 1000, output_tokens: 500 },
        },
      ];

      const result = aggregateUsageFromMessages(messages, "unknown", cost);

      expect(result!.cost).toBeCloseTo(0.0105);
    });

    it("should resolve model from assistant message", () => {
      const messages = [
        {
          role: "assistant",
          content: "hi",
          model: "claude-opus-4-5",
          provider: "anthropic",
          usage: { input: 100, output: 50, cost: { total: 0.01 } },
        },
      ];

      const result = aggregateUsageFromMessages(messages, "unknown", FREE);

      expect(result!.model).toBe("anthropic/claude-opus-4-5");
    });

    it("should use fallback model when message has no model field", () => {
      const messages = [
        {
          role: "assistant",
          content: "hi",
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      ];

      const result = aggregateUsageFromMessages(messages, "gpt-4o", FREE);

      expect(result!.model).toBe("gpt-4o");
    });

    it("should return null when no assistant message has usage", () => {
      const messages = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ];

      expect(aggregateUsageFromMessages(messages, "unknown", FREE)).toBeNull();
    });

    it("should return null for empty messages array", () => {
      expect(aggregateUsageFromMessages([], "unknown", FREE)).toBeNull();
    });

    it("should skip messages with timestamps at or before the since cutoff", () => {
      const messages = [
        {
          role: "assistant",
          content: "old response",
          model: "claude-opus-4-5",
          provider: "anthropic",
          timestamp: "2026-02-01T10:00:00.000Z",
          usage: { input: 500, output: 100, cost: { total: 0.05 } },
        },
        {
          role: "assistant",
          content: "new response",
          model: "qwen3:8b",
          provider: "ollama",
          timestamp: "2026-02-01T11:00:00.000Z",
          usage: { input: 200, output: 50, cost: { total: 0 } },
        },
      ];

      const result = aggregateUsageFromMessages(messages, "unknown", FREE, "2026-02-01T10:00:00.000Z");

      expect(result).not.toBeNull();
      expect(result!.input_tokens).toBe(200);
      expect(result!.output_tokens).toBe(50);
      expect(result!.cost).toBe(0);
      expect(result!.model).toBe("ollama/qwen3:8b");
    });

    it("should count all messages when since is null", () => {
      const messages = [
        {
          role: "assistant",
          content: "first",
          timestamp: "2026-02-01T10:00:00.000Z",
          usage: { input: 100, output: 50, cost: { total: 0.01 } },
        },
        {
          role: "assistant",
          content: "second",
          timestamp: "2026-02-01T11:00:00.000Z",
          usage: { input: 200, output: 100, cost: { total: 0.02 } },
        },
      ];

      const result = aggregateUsageFromMessages(messages, "unknown", FREE, null);

      expect(result!.input_tokens).toBe(300);
      expect(result!.cost).toBeCloseTo(0.03);
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
      expect(calculateCost(5000, 2000, FREE)).toBe(0);
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

    it("should sum costs from multiple assistant messages in a tool-use turn", () => {
      loadBudget(TEST_BUDGET_FILE, 5.0);

      const messages = [
        { role: "user", content: "do something" },
        {
          role: "assistant",
          content: "calling tool",
          model: "claude-opus-4-5",
          provider: "anthropic",
          usage: { input: 500, output: 100, cost: { total: 0.05 } },
        },
        { role: "tool", content: "result" },
        {
          role: "assistant",
          content: "done",
          model: "claude-opus-4-5",
          provider: "anthropic",
          usage: { input: 800, output: 200, cost: { total: 0.08 } },
        },
      ];

      trackUsage(TEST_BUDGET_FILE, "unknown", messages, FREE, 5.0);

      const data = JSON.parse(fs.readFileSync(TEST_BUDGET_FILE, "utf-8"));
      expect(data.transactions).toHaveLength(1);
      expect(data.transactions[0].model).toBe("anthropic/claude-opus-4-5");
      expect(data.transactions[0].tokens_in).toBe(1300);
      expect(data.transactions[0].tokens_out).toBe(300);
      expect(data.transactions[0].cost_usd).toBeCloseTo(0.13);
    });

    it("should skip recording when no usage data is available", () => {
      loadBudget(TEST_BUDGET_FILE, 5.0);

      const messages = [{ role: "assistant", content: "response" }];
      const cost: ModelCost = { input: 0.003, output: 0.015 };
      trackUsage(TEST_BUDGET_FILE, "claude-sonnet-4-20250514", messages, cost, 5.0);

      const data = JSON.parse(fs.readFileSync(TEST_BUDGET_FILE, "utf-8"));
      expect(data.transactions).toHaveLength(0);
    });

    it("should not re-count messages from previous turns", () => {
      // Use fake timers so transaction timestamps align with message timestamps
      vi.useFakeTimers();
      try {
        const today = new Date().toISOString().split("T")[0];
        const t1 = `${today}T10:00:00.000Z`;
        const t1Record = `${today}T10:00:01.000Z`;
        const t2 = `${today}T11:00:00.000Z`;

        vi.setSystemTime(new Date(t1Record));
        loadBudget(TEST_BUDGET_FILE, 5.0);

        // First turn: cloud model
        const turn1Messages = [
          {
            role: "assistant",
            content: "cloud response",
            model: "claude-opus-4-5",
            provider: "anthropic",
            timestamp: t1,
            usage: { input: 500, output: 200, cost: { total: 1.50 } },
          },
        ];
        trackUsage(TEST_BUDGET_FILE, "unknown", turn1Messages, FREE, 5.0);

        // Second turn: same conversation history + new local message
        const turn2Messages = [
          ...turn1Messages,
          {
            role: "assistant",
            content: "local response",
            model: "qwen3:8b",
            provider: "ollama",
            timestamp: t2,
            usage: { input: 200, output: 50, cost: { total: 0 } },
          },
        ];
        vi.setSystemTime(new Date(`${today}T11:00:01.000Z`));
        trackUsage(TEST_BUDGET_FILE, "unknown", turn2Messages, FREE, 5.0);

        const data = JSON.parse(fs.readFileSync(TEST_BUDGET_FILE, "utf-8"));
        expect(data.transactions).toHaveLength(2);
        expect(data.transactions[0].cost_usd).toBe(1.50);
        expect(data.transactions[1].cost_usd).toBe(0);
        expect(data.transactions[1].model).toBe("ollama/qwen3:8b");
        expect(data.spent_today_usd).toBe(1.50);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
