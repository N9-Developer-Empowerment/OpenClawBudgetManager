import { loadBudget, recordTransaction } from "./budget-store.js";

export interface ModelCost {
  input: number;
  output: number;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
}

export function extractUsageFromMessages(messages: unknown[]): TokenUsage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown>;
    if (msg?.role === "assistant" && msg.usage && typeof msg.usage === "object") {
      const usage = msg.usage as Record<string, unknown>;
      const inputTokens =
        typeof usage.input_tokens === "number"
          ? usage.input_tokens
          : typeof usage.prompt_tokens === "number"
            ? usage.prompt_tokens
            : null;
      const outputTokens =
        typeof usage.output_tokens === "number"
          ? usage.output_tokens
          : typeof usage.completion_tokens === "number"
            ? usage.completion_tokens
            : null;

      if (inputTokens !== null && outputTokens !== null) {
        return { input_tokens: inputTokens, output_tokens: outputTokens };
      }
    }
  }
  return null;
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

  const usage = extractUsageFromMessages(messages);
  if (!usage) return;

  const totalCost = calculateCost(usage.input_tokens, usage.output_tokens, cost);
  recordTransaction(budgetFilePath, modelId, usage.input_tokens, usage.output_tokens, totalCost);
}
