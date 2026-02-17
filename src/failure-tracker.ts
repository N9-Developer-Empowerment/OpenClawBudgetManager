import fs from "node:fs";
import path from "node:path";

export interface FailureRecord {
  consecutiveFailures: number;
  lastFailureAt: string | null;
}

export interface FailureData {
  date: string;
  providers: Record<string, FailureRecord>;
}

function today(): string {
  return new Date().toISOString().split("T")[0];
}

export function loadFailureData(filePath: string): FailureData {
  const currentDate = today();

  if (fs.existsSync(filePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as FailureData;
      if (raw.date === currentDate) {
        return raw;
      }
    } catch {
      // Corrupted file, start fresh
    }
  }

  return { date: currentDate, providers: {} };
}

export function saveFailureData(filePath: string, data: FailureData): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function ensureProvider(data: FailureData, providerId: string): FailureRecord {
  if (!data.providers[providerId]) {
    data.providers[providerId] = { consecutiveFailures: 0, lastFailureAt: null };
  }
  return data.providers[providerId];
}

export function recordSuccess(filePath: string, providerId: string): void {
  const data = loadFailureData(filePath);
  const record = ensureProvider(data, providerId);
  record.consecutiveFailures = 0;
  saveFailureData(filePath, data);
}

export function recordFailure(filePath: string, providerId: string): number {
  const data = loadFailureData(filePath);
  const record = ensureProvider(data, providerId);
  record.consecutiveFailures += 1;
  record.lastFailureAt = new Date().toISOString();
  saveFailureData(filePath, data);
  return record.consecutiveFailures;
}

export function shouldSwitchProvider(
  filePath: string,
  providerId: string,
  threshold = 3,
): boolean {
  const data = loadFailureData(filePath);
  const record = data.providers[providerId];
  if (!record) return false;
  return record.consecutiveFailures >= threshold;
}

const ERROR_PATTERNS = [
  /rate.?limit/i,
  /service.?unavailable/i,
  /timeout/i,
  /too.?many.?requests/i,
  /503/,
  /429/,
  /502/,
  /401/,
  /403/,
  /gateway.?timeout/i,
  /internal.?server.?error/i,
  /connection.?refused/i,
  /ECONNREFUSED/,
  /ETIMEDOUT/,
  /billing.?error/i,
  /insufficient.?(balance|credits|funds)/i,
  /run.?out.?of.?credits/i,
  /quota.?exceeded/i,
  /payment.?required/i,
  /unauthorized/i,
  /invalid.?api.?key/i,
  /authentication.?failed/i,
];

export function detectFailure(
  event: Record<string, unknown>,
  messages: unknown[],
): boolean {
  // Explicit error field in event
  if (event.error) return true;

  // No messages at all
  if (!messages || messages.length === 0) return true;

  // Find assistant messages
  const assistantMessages = messages.filter(
    (m) => (m as Record<string, unknown>)?.role === "assistant",
  );

  // No assistant messages means the provider didn't respond
  if (assistantMessages.length === 0) return true;

  // Check the last assistant message
  const lastAssistant = assistantMessages[assistantMessages.length - 1] as Record<string, unknown>;

  // Empty content
  const content = lastAssistant.content;
  if (content === null || content === undefined || content === "") return true;

  // Check for error patterns in string content
  if (typeof content === "string") {
    for (const pattern of ERROR_PATTERNS) {
      if (pattern.test(content)) return true;
    }
  }

  // Check array content blocks
  if (Array.isArray(content)) {
    if (content.length === 0) return true;
    for (const block of content) {
      const text = (block as Record<string, unknown>)?.text;
      if (typeof text === "string") {
        for (const pattern of ERROR_PATTERNS) {
          if (pattern.test(text)) return true;
        }
      }
    }
  }

  // Missing usage data with very short response suggests a failed request
  const usage = lastAssistant.usage as Record<string, unknown> | undefined;
  if (!usage) {
    const textLength = typeof content === "string" ? content.length : 0;
    if (textLength < 20) return true;
  }

  return false;
}
