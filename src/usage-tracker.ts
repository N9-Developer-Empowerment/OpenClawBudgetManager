import { loadBudget, recordTransaction, getLastTransactionTimestamp } from "./budget-store.js";

export interface ModelCost {
  input: number;
  output: number;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
}

function extractTokens(usage: Record<string, unknown>): TokenUsage | null {
  const inputTokens =
    typeof usage.input_tokens === "number"
      ? usage.input_tokens
      : typeof usage.prompt_tokens === "number"
        ? usage.prompt_tokens
        : typeof usage.input === "number"
          ? usage.input
          : null;
  const outputTokens =
    typeof usage.output_tokens === "number"
      ? usage.output_tokens
      : typeof usage.completion_tokens === "number"
        ? usage.completion_tokens
        : typeof usage.output === "number"
          ? usage.output
          : null;

  if (inputTokens !== null && outputTokens !== null) {
    return { input_tokens: inputTokens, output_tokens: outputTokens };
  }
  return null;
}

function extractPreCalculatedCost(usage: Record<string, unknown>): number | null {
  const costObj = usage.cost as Record<string, unknown> | undefined;
  if (costObj && typeof costObj.total === "number") {
    return costObj.total;
  }
  return null;
}

export interface AggregatedUsage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost: number;
}

function isFreeMessage(msg: Record<string, unknown>): boolean {
  const provider = msg.provider as string | undefined;
  if (provider === "ollama") return true;
  const model = msg.model as string | undefined;
  if (model && model.startsWith("ollama/")) return true;
  return false;
}

export function aggregateUsageFromMessages(
  messages: unknown[],
  fallbackModelId: string,
  fallbackCost: ModelCost,
  since?: string | null,
): AggregatedUsage | null {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCost = 0;
  let resolvedModel = fallbackModelId;
  let found = false;
  const fallbackIsFree = fallbackModelId.startsWith("ollama/");

  for (const raw of messages) {
    const msg = raw as Record<string, unknown>;
    if (msg?.role !== "assistant" || !msg.usage || typeof msg.usage !== "object") continue;

    // Skip messages we've already counted (or can't verify as new)
    if (since) {
      const rawTs = msg.timestamp;
      if (!rawTs) continue;
      const sinceMs = new Date(since).getTime();
      const msgMs = typeof rawTs === "number" ? rawTs : new Date(String(rawTs)).getTime();
      if (isNaN(msgMs) || msgMs <= sinceMs) continue;
    }

    const usage = msg.usage as Record<string, unknown>;
    const tokens = extractTokens(usage);
    if (!tokens) continue;

    found = true;
    totalInputTokens += tokens.input_tokens;
    totalOutputTokens += tokens.output_tokens;

    // Local/free models: always $0 regardless of pre-calculated cost
    if (isFreeMessage(msg) || fallbackIsFree) {
      // cost += 0
    } else {
      const preCost = extractPreCalculatedCost(usage);
      if (preCost !== null) {
        totalCost += preCost;
      } else {
        totalCost += calculateCost(tokens.input_tokens, tokens.output_tokens, fallbackCost);
      }
    }

    // Use model from the first new assistant message that has one
    if (resolvedModel === fallbackModelId) {
      const provider = msg.provider as string | undefined;
      const model = msg.model as string | undefined;
      if (model) {
        resolvedModel = provider ? `${provider}/${model}` : model;
      }
    }
  }

  if (!found) return null;

  return {
    model: resolvedModel,
    input_tokens: totalInputTokens,
    output_tokens: totalOutputTokens,
    cost: totalCost,
  };
}

export function calculateCost(
  tokensIn: number,
  tokensOut: number,
  cost: ModelCost,
): number {
  return (tokensIn / 1000) * cost.input + (tokensOut / 1000) * cost.output;
}

export function trackUsage(
  budgetFilePath: string,
  modelId: string,
  messages: unknown[],
  cost: ModelCost,
  dailyBudgetUsd: number,
): void {
  loadBudget(budgetFilePath, dailyBudgetUsd);

  const since = getLastTransactionTimestamp(budgetFilePath);
  const aggregated = aggregateUsageFromMessages(messages, modelId, cost, since);
  if (!aggregated) return;

  recordTransaction(
    budgetFilePath,
    aggregated.model,
    aggregated.input_tokens,
    aggregated.output_tokens,
    aggregated.cost,
  );
}
