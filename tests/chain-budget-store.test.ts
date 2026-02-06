import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { ChainConfig } from "../src/provider-chain.js";
import {
  loadChainBudget,
  loadChainBudgetWithStatus,
  saveChainBudget,
  recordProviderTransaction,
  getProviderSpend,
  getProviderRemaining,
  isProviderExhausted,
  markProviderExhausted,
  setActiveProvider,
  getActiveProvider,
  recordSwitch,
  getExhaustedProviders,
  getTotalSpent,
  getLastTransactionTimestamp,
  getProviderStats,
  type ChainBudgetData,
} from "../src/chain-budget-store.js";

const TEST_DATA_DIR = path.join(import.meta.dirname, "..", "data-test-chain-budget");
const TEST_BUDGET_FILE = path.join(TEST_DATA_DIR, "chain-budget.json");

function createTestChainConfig(): ChainConfig {
  return {
    providers: [
      { id: "anthropic", priority: 1, maxDailyUsd: 3.0, enabled: true, models: { default: "claude-sonnet-4" } },
      { id: "moonshot", priority: 2, maxDailyUsd: 2.0, enabled: true, models: { default: "kimi-k2.5" } },
      { id: "deepseek", priority: 3, maxDailyUsd: 1.0, enabled: true, models: { default: "deepseek-chat" } },
      { id: "ollama", priority: 99, maxDailyUsd: 0, enabled: true, models: { default: "qwen3:8b" } },
    ],
  };
}

function createTestBudgetData(): ChainBudgetData {
  return {
    date: new Date().toISOString().split("T")[0],
    providers: {
      anthropic: { spentUsd: 0, exhausted: false },
      moonshot: { spentUsd: 0, exhausted: false },
      deepseek: { spentUsd: 0, exhausted: false },
      ollama: { spentUsd: 0, exhausted: false },
    },
    transactions: [],
    activeProvider: "anthropic",
    switchHistory: [],
  };
}

beforeEach(() => {
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe("Chain Budget Store", () => {
  describe("loadChainBudget", () => {
    it("should create fresh budget when file does not exist", () => {
      const config = createTestChainConfig();

      const budget = loadChainBudget(TEST_BUDGET_FILE, config);

      expect(budget.date).toBe(new Date().toISOString().split("T")[0]);
      expect(budget.providers.anthropic.spentUsd).toBe(0);
      expect(budget.activeProvider).toBe("anthropic");
      expect(fs.existsSync(TEST_BUDGET_FILE)).toBe(true);
    });

    it("should reset all provider spends on date change", () => {
      const config = createTestChainConfig();
      const oldBudget: ChainBudgetData = {
        date: "2020-01-01",
        providers: {
          anthropic: { spentUsd: 2.5, exhausted: true },
          moonshot: { spentUsd: 1.8, exhausted: false },
          deepseek: { spentUsd: 0.5, exhausted: false },
          ollama: { spentUsd: 0, exhausted: false },
        },
        transactions: [{ provider: "anthropic", model: "claude", tokens_in: 1000, tokens_out: 500, cost_usd: 2.5, timestamp: "2020-01-01T10:00:00.000Z" }],
        activeProvider: "deepseek",
        switchHistory: [{ from: "anthropic", to: "moonshot", at: "2020-01-01T11:00:00.000Z", reason: "budget exhausted" }],
      };
      fs.writeFileSync(TEST_BUDGET_FILE, JSON.stringify(oldBudget, null, 2));

      const budget = loadChainBudget(TEST_BUDGET_FILE, config);

      expect(budget.date).toBe(new Date().toISOString().split("T")[0]);
      expect(budget.providers.anthropic.spentUsd).toBe(0);
      expect(budget.providers.anthropic.exhausted).toBe(false);
      expect(budget.transactions).toEqual([]);
      expect(budget.activeProvider).toBe("anthropic");
    });

    it("should preserve data from same day", () => {
      const config = createTestChainConfig();
      const todayBudget = createTestBudgetData();
      todayBudget.providers.anthropic.spentUsd = 1.5;
      todayBudget.transactions.push({
        provider: "anthropic",
        model: "claude-sonnet-4",
        tokens_in: 1000,
        tokens_out: 500,
        cost_usd: 1.5,
        timestamp: new Date().toISOString(),
      });
      fs.writeFileSync(TEST_BUDGET_FILE, JSON.stringify(todayBudget, null, 2));

      const budget = loadChainBudget(TEST_BUDGET_FILE, config);

      expect(budget.providers.anthropic.spentUsd).toBe(1.5);
      expect(budget.transactions.length).toBe(1);
    });

    it("should add missing providers from config", () => {
      const config = createTestChainConfig();
      config.providers.push({ id: "newprovider", priority: 10, maxDailyUsd: 0.5, enabled: true, models: { default: "new-model" } });
      const existingBudget = createTestBudgetData();
      fs.writeFileSync(TEST_BUDGET_FILE, JSON.stringify(existingBudget, null, 2));

      const budget = loadChainBudget(TEST_BUDGET_FILE, config);

      expect(budget.providers.newprovider).toBeDefined();
      expect(budget.providers.newprovider.spentUsd).toBe(0);
    });
  });

  describe("loadChainBudgetWithStatus", () => {
    it("should return wasReset=true when file does not exist", () => {
      const config = createTestChainConfig();

      const { data, wasReset } = loadChainBudgetWithStatus(TEST_BUDGET_FILE, config);

      expect(wasReset).toBe(true);
      expect(data.activeProvider).toBe("anthropic");
    });

    it("should return wasReset=true on date change", () => {
      const config = createTestChainConfig();
      const oldBudget: ChainBudgetData = {
        date: "2020-01-01",
        providers: {
          anthropic: { spentUsd: 2.5, exhausted: true },
          moonshot: { spentUsd: 1.8, exhausted: false },
          deepseek: { spentUsd: 0.5, exhausted: false },
          ollama: { spentUsd: 0, exhausted: false },
        },
        transactions: [],
        activeProvider: "deepseek",
        switchHistory: [],
      };
      fs.writeFileSync(TEST_BUDGET_FILE, JSON.stringify(oldBudget, null, 2));

      const { data, wasReset } = loadChainBudgetWithStatus(TEST_BUDGET_FILE, config);

      expect(wasReset).toBe(true);
      expect(data.activeProvider).toBe("anthropic");
      expect(data.providers.anthropic.spentUsd).toBe(0);
    });

    it("should return wasReset=false when loading same day data", () => {
      const config = createTestChainConfig();
      const todayBudget = createTestBudgetData();
      todayBudget.providers.anthropic.spentUsd = 1.5;
      todayBudget.activeProvider = "moonshot";
      fs.writeFileSync(TEST_BUDGET_FILE, JSON.stringify(todayBudget, null, 2));

      const { data, wasReset } = loadChainBudgetWithStatus(TEST_BUDGET_FILE, config);

      expect(wasReset).toBe(false);
      expect(data.activeProvider).toBe("moonshot");
      expect(data.providers.anthropic.spentUsd).toBe(1.5);
    });
  });

  describe("recordProviderTransaction", () => {
    it("should attribute transaction to correct provider", () => {
      const config = createTestChainConfig();
      loadChainBudget(TEST_BUDGET_FILE, config);

      recordProviderTransaction(TEST_BUDGET_FILE, "anthropic", "claude-sonnet-4", 1000, 500, 0.15);

      const budget = JSON.parse(fs.readFileSync(TEST_BUDGET_FILE, "utf-8")) as ChainBudgetData;
      expect(budget.transactions.length).toBe(1);
      expect(budget.transactions[0].provider).toBe("anthropic");
      expect(budget.transactions[0].model).toBe("claude-sonnet-4");
    });

    it("should update provider spend total", () => {
      const config = createTestChainConfig();
      loadChainBudget(TEST_BUDGET_FILE, config);

      recordProviderTransaction(TEST_BUDGET_FILE, "anthropic", "claude-sonnet-4", 1000, 500, 0.15);
      recordProviderTransaction(TEST_BUDGET_FILE, "anthropic", "claude-sonnet-4", 2000, 1000, 0.25);

      const budget = JSON.parse(fs.readFileSync(TEST_BUDGET_FILE, "utf-8")) as ChainBudgetData;
      expect(budget.providers.anthropic.spentUsd).toBeCloseTo(0.40);
    });

    it("should handle transactions for new providers", () => {
      const config = createTestChainConfig();
      loadChainBudget(TEST_BUDGET_FILE, config);

      recordProviderTransaction(TEST_BUDGET_FILE, "newprovider", "new-model", 500, 200, 0.05);

      const budget = JSON.parse(fs.readFileSync(TEST_BUDGET_FILE, "utf-8")) as ChainBudgetData;
      expect(budget.providers.newprovider.spentUsd).toBe(0.05);
    });
  });

  describe("getProviderRemaining", () => {
    it("should calculate remaining budget for provider", () => {
      const data = createTestBudgetData();
      data.providers.anthropic.spentUsd = 1.5;

      const remaining = getProviderRemaining(data, "anthropic", 3.0);

      expect(remaining).toBe(1.5);
    });

    it("should return 0 for exhausted provider", () => {
      const data = createTestBudgetData();
      data.providers.anthropic.spentUsd = 3.5;

      const remaining = getProviderRemaining(data, "anthropic", 3.0);

      expect(remaining).toBe(0);
    });

    it("should return 0 for unknown provider", () => {
      const data = createTestBudgetData();

      const remaining = getProviderRemaining(data, "unknown", 1.0);

      expect(remaining).toBe(1.0);
    });
  });

  describe("isProviderExhausted", () => {
    it("should return true when spent exceeds budget", () => {
      const data = createTestBudgetData();
      data.providers.anthropic.spentUsd = 3.5;

      expect(isProviderExhausted(data, "anthropic", 3.0)).toBe(true);
    });

    it("should return true when spent equals budget", () => {
      const data = createTestBudgetData();
      data.providers.anthropic.spentUsd = 3.0;

      expect(isProviderExhausted(data, "anthropic", 3.0)).toBe(true);
    });

    it("should return false when budget remains", () => {
      const data = createTestBudgetData();
      data.providers.anthropic.spentUsd = 2.9;

      expect(isProviderExhausted(data, "anthropic", 3.0)).toBe(false);
    });

    it("should return false for ollama with $0 budget (free provider)", () => {
      const data = createTestBudgetData();

      expect(isProviderExhausted(data, "ollama", 0)).toBe(false);
    });
  });

  describe("markProviderExhausted", () => {
    it("should set exhausted flag on provider", () => {
      const config = createTestChainConfig();
      loadChainBudget(TEST_BUDGET_FILE, config);

      markProviderExhausted(TEST_BUDGET_FILE, "anthropic");

      const budget = JSON.parse(fs.readFileSync(TEST_BUDGET_FILE, "utf-8")) as ChainBudgetData;
      expect(budget.providers.anthropic.exhausted).toBe(true);
    });
  });

  describe("setActiveProvider", () => {
    it("should update active provider", () => {
      const config = createTestChainConfig();
      loadChainBudget(TEST_BUDGET_FILE, config);

      setActiveProvider(TEST_BUDGET_FILE, "moonshot");

      const budget = JSON.parse(fs.readFileSync(TEST_BUDGET_FILE, "utf-8")) as ChainBudgetData;
      expect(budget.activeProvider).toBe("moonshot");
    });
  });

  describe("getActiveProvider", () => {
    it("should return current active provider", () => {
      const data = createTestBudgetData();
      data.activeProvider = "deepseek";

      expect(getActiveProvider(data)).toBe("deepseek");
    });
  });

  describe("recordSwitch", () => {
    it("should record switch history", () => {
      const config = createTestChainConfig();
      loadChainBudget(TEST_BUDGET_FILE, config);

      recordSwitch(TEST_BUDGET_FILE, "anthropic", "moonshot", "budget exhausted");

      const budget = JSON.parse(fs.readFileSync(TEST_BUDGET_FILE, "utf-8")) as ChainBudgetData;
      expect(budget.switchHistory.length).toBe(1);
      expect(budget.switchHistory[0].from).toBe("anthropic");
      expect(budget.switchHistory[0].to).toBe("moonshot");
      expect(budget.switchHistory[0].reason).toBe("budget exhausted");
    });

    it("should update active provider when recording switch", () => {
      const config = createTestChainConfig();
      loadChainBudget(TEST_BUDGET_FILE, config);

      recordSwitch(TEST_BUDGET_FILE, "anthropic", "moonshot", "budget exhausted");

      const budget = JSON.parse(fs.readFileSync(TEST_BUDGET_FILE, "utf-8")) as ChainBudgetData;
      expect(budget.activeProvider).toBe("moonshot");
    });
  });

  describe("getExhaustedProviders", () => {
    it("should return list of exhausted providers", () => {
      const config = createTestChainConfig();
      const data = createTestBudgetData();
      data.providers.anthropic.spentUsd = 3.0;
      data.providers.moonshot.spentUsd = 2.0;

      const exhausted = getExhaustedProviders(data, config);

      expect(exhausted).toContain("anthropic");
      expect(exhausted).toContain("moonshot");
      expect(exhausted).not.toContain("deepseek");
    });

    it("should not include ollama as exhausted (free provider)", () => {
      const config = createTestChainConfig();
      const data = createTestBudgetData();
      data.providers.anthropic.spentUsd = 3.0;
      data.providers.moonshot.spentUsd = 2.0;
      data.providers.deepseek.spentUsd = 1.0;

      const exhausted = getExhaustedProviders(data, config);

      expect(exhausted).not.toContain("ollama");
    });
  });

  describe("getTotalSpent", () => {
    it("should return sum of all provider spends", () => {
      const data = createTestBudgetData();
      data.providers.anthropic.spentUsd = 1.5;
      data.providers.moonshot.spentUsd = 0.8;
      data.providers.deepseek.spentUsd = 0.3;

      const total = getTotalSpent(data);

      expect(total).toBeCloseTo(2.6);
    });
  });

  describe("getLastTransactionTimestamp", () => {
    it("should return timestamp of last transaction", () => {
      const data = createTestBudgetData();
      data.transactions = [
        { provider: "anthropic", model: "claude", tokens_in: 100, tokens_out: 50, cost_usd: 0.1, timestamp: "2026-02-03T10:00:00.000Z" },
        { provider: "anthropic", model: "claude", tokens_in: 200, tokens_out: 100, cost_usd: 0.2, timestamp: "2026-02-03T11:00:00.000Z" },
      ];

      const timestamp = getLastTransactionTimestamp(data);

      expect(timestamp).toBe("2026-02-03T11:00:00.000Z");
    });

    it("should return null when no transactions exist", () => {
      const data = createTestBudgetData();

      const timestamp = getLastTransactionTimestamp(data);

      expect(timestamp).toBeNull();
    });
  });

  describe("getProviderStats", () => {
    it("should return complete provider statistics", () => {
      const provider = { id: "anthropic", priority: 1, maxDailyUsd: 3.0, enabled: true, models: { default: "claude" } };
      const data = createTestBudgetData();
      data.providers.anthropic.spentUsd = 1.5;

      const stats = getProviderStats(data, provider);

      expect(stats.spent).toBe(1.5);
      expect(stats.remaining).toBe(1.5);
      expect(stats.percent).toBe(50);
      expect(stats.exhausted).toBe(false);
    });

    it("should return 100% for free provider", () => {
      const provider = { id: "ollama", priority: 99, maxDailyUsd: 0, enabled: true, models: { default: "qwen3:8b" } };
      const data = createTestBudgetData();

      const stats = getProviderStats(data, provider);

      expect(stats.percent).toBe(100);
      expect(stats.exhausted).toBe(false);
    });
  });
});
