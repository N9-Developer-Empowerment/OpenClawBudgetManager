import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  loadBudget,
  recordTransaction,
  getRemainingBudget,
  isOverBudget,
  type BudgetData,
} from "../src/budget-store.js";

const TEST_DATA_DIR = path.join(import.meta.dirname, "..", "data-test-store");
const TEST_BUDGET_FILE = path.join(TEST_DATA_DIR, "budget.json");

function writeBudgetFile(data: BudgetData) {
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  fs.writeFileSync(TEST_BUDGET_FILE, JSON.stringify(data, null, 2));
}

function readBudgetFile(): BudgetData {
  return JSON.parse(fs.readFileSync(TEST_BUDGET_FILE, "utf-8"));
}

beforeEach(() => {
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe("Budget Store", () => {
  describe("loadBudget", () => {
    it("should create a new budget file when none exists", () => {
      const budget = loadBudget(TEST_BUDGET_FILE, 5.0);

      expect(budget.daily_budget_usd).toBe(5.0);
      expect(budget.spent_today_usd).toBe(0);
      expect(budget.transactions).toEqual([]);
      expect(budget.date).toBe(new Date().toISOString().split("T")[0]);
    });

    it("should load an existing budget file for the current date", () => {
      const today = new Date().toISOString().split("T")[0];
      writeBudgetFile({
        date: today,
        daily_budget_usd: 5.0,
        spent_today_usd: 2.5,
        transactions: [
          {
            model: "claude-sonnet-4-20250514",
            tokens_in: 1000,
            tokens_out: 500,
            cost_usd: 2.5,
            timestamp: new Date().toISOString(),
          },
        ],
      });

      const budget = loadBudget(TEST_BUDGET_FILE, 5.0);

      expect(budget.spent_today_usd).toBe(2.5);
      expect(budget.transactions).toHaveLength(1);
    });

    it("should reset the budget when the date has changed", () => {
      writeBudgetFile({
        date: "2025-01-01",
        daily_budget_usd: 5.0,
        spent_today_usd: 4.5,
        transactions: [
          {
            model: "claude-sonnet-4-20250514",
            tokens_in: 1000,
            tokens_out: 500,
            cost_usd: 4.5,
            timestamp: "2025-01-01T12:00:00Z",
          },
        ],
      });

      const budget = loadBudget(TEST_BUDGET_FILE, 5.0);

      expect(budget.spent_today_usd).toBe(0);
      expect(budget.transactions).toEqual([]);
      expect(budget.date).toBe(new Date().toISOString().split("T")[0]);
    });
  });

  describe("recordTransaction", () => {
    it("should append a transaction and update the spent total", () => {
      loadBudget(TEST_BUDGET_FILE, 5.0);

      recordTransaction(TEST_BUDGET_FILE, "claude-sonnet-4-20250514", 1000, 500, 0.015);

      const data = readBudgetFile();
      expect(data.transactions).toHaveLength(1);
      expect(data.transactions[0].model).toBe("claude-sonnet-4-20250514");
      expect(data.transactions[0].cost_usd).toBe(0.015);
      expect(data.spent_today_usd).toBe(0.015);
    });

    it("should accumulate multiple transactions", () => {
      loadBudget(TEST_BUDGET_FILE, 5.0);

      recordTransaction(TEST_BUDGET_FILE, "claude-sonnet-4-20250514", 1000, 500, 0.01);
      recordTransaction(TEST_BUDGET_FILE, "gpt-4o", 2000, 1000, 0.05);

      const data = readBudgetFile();
      expect(data.transactions).toHaveLength(2);
      expect(data.spent_today_usd).toBeCloseTo(0.06);
    });
  });

  describe("getRemainingBudget", () => {
    it("should return full budget when nothing is spent", () => {
      loadBudget(TEST_BUDGET_FILE, 5.0);

      expect(getRemainingBudget(TEST_BUDGET_FILE)).toBe(5.0);
    });

    it("should return budget minus spent amount", () => {
      loadBudget(TEST_BUDGET_FILE, 5.0);
      recordTransaction(TEST_BUDGET_FILE, "claude-sonnet-4-20250514", 1000, 500, 2.0);

      expect(getRemainingBudget(TEST_BUDGET_FILE)).toBe(3.0);
    });
  });

  describe("isOverBudget", () => {
    it("should return false when under budget", () => {
      loadBudget(TEST_BUDGET_FILE, 5.0);

      expect(isOverBudget(TEST_BUDGET_FILE)).toBe(false);
    });

    it("should return true when over budget", () => {
      loadBudget(TEST_BUDGET_FILE, 5.0);
      recordTransaction(TEST_BUDGET_FILE, "claude-sonnet-4-20250514", 100000, 50000, 6.0);

      expect(isOverBudget(TEST_BUDGET_FILE)).toBe(true);
    });

    it("should return true when exactly at budget", () => {
      loadBudget(TEST_BUDGET_FILE, 5.0);
      recordTransaction(TEST_BUDGET_FILE, "claude-sonnet-4-20250514", 100000, 50000, 5.0);

      expect(isOverBudget(TEST_BUDGET_FILE)).toBe(true);
    });
  });
});
