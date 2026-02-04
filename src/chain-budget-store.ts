import fs from "node:fs";
import path from "node:path";
import type { ChainConfig, ProviderConfig } from "./provider-chain.js";

export interface Transaction {
  provider: string;
  model: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  timestamp: string;
}

export interface ProviderSpend {
  spentUsd: number;
  exhausted: boolean;
}

export interface SwitchRecord {
  from: string;
  to: string;
  at: string;
  reason: string;
}

export interface ChainBudgetData {
  date: string;
  providers: Record<string, ProviderSpend>;
  transactions: Transaction[];
  activeProvider: string;
  switchHistory: SwitchRecord[];
}

function todayString(): string {
  return new Date().toISOString().split("T")[0];
}

function initializeProviderSpends(chainConfig: ChainConfig): Record<string, ProviderSpend> {
  const spends: Record<string, ProviderSpend> = {};
  for (const provider of chainConfig.providers) {
    spends[provider.id] = { spentUsd: 0, exhausted: false };
  }
  return spends;
}

function freshChainBudget(chainConfig: ChainConfig): ChainBudgetData {
  const enabledProviders = chainConfig.providers
    .filter((p) => p.enabled)
    .sort((a, b) => a.priority - b.priority);

  const firstProvider = enabledProviders[0]?.id ?? "anthropic";

  return {
    date: todayString(),
    providers: initializeProviderSpends(chainConfig),
    transactions: [],
    activeProvider: firstProvider,
    switchHistory: [],
  };
}

export function loadChainBudget(filePath: string, chainConfig: ChainConfig): ChainBudgetData {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  if (!fs.existsSync(filePath)) {
    const budget = freshChainBudget(chainConfig);
    fs.writeFileSync(filePath, JSON.stringify(budget, null, 2));
    return budget;
  }

  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as ChainBudgetData;

  if (raw.date !== todayString()) {
    const budget = freshChainBudget(chainConfig);
    fs.writeFileSync(filePath, JSON.stringify(budget, null, 2));
    return budget;
  }

  // Ensure all providers from config exist in spends
  for (const provider of chainConfig.providers) {
    if (!raw.providers[provider.id]) {
      raw.providers[provider.id] = { spentUsd: 0, exhausted: false };
    }
  }

  return raw;
}

export function saveChainBudget(filePath: string, data: ChainBudgetData): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export function recordProviderTransaction(
  filePath: string,
  providerId: string,
  model: string,
  tokensIn: number,
  tokensOut: number,
  costUsd: number,
): void {
  const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as ChainBudgetData;

  data.transactions.push({
    provider: providerId,
    model,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_usd: costUsd,
    timestamp: new Date().toISOString(),
  });

  // Update provider spend
  if (!data.providers[providerId]) {
    data.providers[providerId] = { spentUsd: 0, exhausted: false };
  }
  data.providers[providerId].spentUsd += costUsd;

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export function getProviderSpend(data: ChainBudgetData, providerId: string): number {
  return data.providers[providerId]?.spentUsd ?? 0;
}

export function getProviderRemaining(
  data: ChainBudgetData,
  providerId: string,
  maxUsd: number,
): number {
  const spent = getProviderSpend(data, providerId);
  return Math.max(0, maxUsd - spent);
}

export function isProviderExhausted(
  data: ChainBudgetData,
  providerId: string,
  maxUsd: number,
): boolean {
  // Ollama with $0 budget is never exhausted (free)
  if (maxUsd === 0) {
    return false;
  }
  return getProviderRemaining(data, providerId, maxUsd) <= 0;
}

export function markProviderExhausted(filePath: string, providerId: string): void {
  const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as ChainBudgetData;

  if (!data.providers[providerId]) {
    data.providers[providerId] = { spentUsd: 0, exhausted: false };
  }
  data.providers[providerId].exhausted = true;

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export function setActiveProvider(filePath: string, providerId: string): void {
  const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as ChainBudgetData;
  data.activeProvider = providerId;
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export function getActiveProvider(data: ChainBudgetData): string {
  return data.activeProvider;
}

export function recordSwitch(
  filePath: string,
  from: string,
  to: string,
  reason: string,
): void {
  const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as ChainBudgetData;

  data.switchHistory.push({
    from,
    to,
    at: new Date().toISOString(),
    reason,
  });
  data.activeProvider = to;

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export function getExhaustedProviders(
  data: ChainBudgetData,
  chainConfig: ChainConfig,
): string[] {
  const exhausted: string[] = [];

  for (const provider of chainConfig.providers) {
    if (isProviderExhausted(data, provider.id, provider.maxDailyUsd)) {
      exhausted.push(provider.id);
    }
  }

  return exhausted;
}

export function getTotalSpent(data: ChainBudgetData): number {
  return Object.values(data.providers).reduce((sum, p) => sum + p.spentUsd, 0);
}

export function getLastTransactionTimestamp(data: ChainBudgetData): string | null {
  if (data.transactions.length === 0) return null;
  return data.transactions[data.transactions.length - 1].timestamp;
}

export function getProviderStats(
  data: ChainBudgetData,
  provider: ProviderConfig,
): {
  spent: number;
  remaining: number;
  percent: number;
  exhausted: boolean;
} {
  const spent = getProviderSpend(data, provider.id);
  const remaining = getProviderRemaining(data, provider.id, provider.maxDailyUsd);
  const percent = provider.maxDailyUsd > 0
    ? Math.round((remaining / provider.maxDailyUsd) * 100)
    : 100;
  const exhausted = isProviderExhausted(data, provider.id, provider.maxDailyUsd);

  return { spent, remaining, percent, exhausted };
}
