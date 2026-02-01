import fs from "node:fs";
import path from "node:path";

export interface Transaction {
  model: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  timestamp: string;
}

export interface BudgetData {
  date: string;
  daily_budget_usd: number;
  spent_today_usd: number;
  transactions: Transaction[];
}

function todayString(): string {
  return new Date().toISOString().split("T")[0];
}

function freshBudget(dailyBudgetUsd: number): BudgetData {
  return {
    date: todayString(),
    daily_budget_usd: dailyBudgetUsd,
    spent_today_usd: 0,
    transactions: [],
  };
}

export function loadBudget(filePath: string, dailyBudgetUsd: number): BudgetData {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  if (!fs.existsSync(filePath)) {
    const budget = freshBudget(dailyBudgetUsd);
    fs.writeFileSync(filePath, JSON.stringify(budget, null, 2));
    return budget;
  }

  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as BudgetData;

  if (raw.date !== todayString()) {
    const budget = freshBudget(dailyBudgetUsd);
    fs.writeFileSync(filePath, JSON.stringify(budget, null, 2));
    return budget;
  }

  return raw;
}

export function recordTransaction(
  filePath: string,
  model: string,
  tokensIn: number,
  tokensOut: number,
  costUsd: number,
): void {
  const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as BudgetData;

  data.transactions.push({
    model,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_usd: costUsd,
    timestamp: new Date().toISOString(),
  });

  data.spent_today_usd = data.transactions.reduce((sum, t) => sum + t.cost_usd, 0);

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export function getRemainingBudget(filePath: string): number {
  const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as BudgetData;
  return data.daily_budget_usd - data.spent_today_usd;
}

export function getLastTransactionTimestamp(filePath: string): string | null {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as BudgetData;
    if (data.transactions.length === 0) return null;
    return data.transactions[data.transactions.length - 1].timestamp;
  } catch {
    return null;
  }
}

