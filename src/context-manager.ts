import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface SessionEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp?: string;
  message?: { role: string; content: unknown };
  customType?: string;
  [key: string]: unknown;
}

export interface TruncationResult {
  truncated: boolean;
  entriesBefore: number;
  entriesAfter: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
}

export interface ContextManagerConfig {
  maxContextTokens: number;
  keepRecentMessages: number;
  sessionsDir: string;
  sessionsIndexPath: string;
  sessionKey: string;
}

const STRUCTURAL_TYPES = new Set([
  "session",
  "model_change",
  "thinking_level_change",
  "custom",
  "compaction",
]);

export function isStructuralEntry(entry: SessionEntry): boolean {
  return STRUCTURAL_TYPES.has(entry.type);
}

export function estimateEntryTokens(entry: SessionEntry): number {
  if (isStructuralEntry(entry)) {
    // Structural entries are small metadata — estimate a flat cost
    return 50;
  }

  const message = entry.message;
  if (!message) return 50;

  const content = message.content;
  let chars = 0;

  if (typeof content === "string") {
    chars = content.length;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && typeof (block as Record<string, unknown>).text === "string") {
        chars += ((block as Record<string, unknown>).text as string).length;
      }
    }
  }

  // ~4 chars per token heuristic
  return Math.max(50, Math.ceil(chars / 4));
}

export function estimateTotalTokens(entries: SessionEntry[]): number {
  let total = 0;
  for (const entry of entries) {
    total += estimateEntryTokens(entry);
  }
  return total;
}

export function parseSessionEntries(filePath: string): SessionEntry[] {
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  const entries: SessionEntry[] = [];

  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as SessionEntry);
    } catch {
      // Skip malformed lines
    }
  }

  return entries;
}

function generateId(): string {
  return crypto.randomUUID();
}

export function truncateSession(
  entries: SessionEntry[],
  config: Pick<ContextManagerConfig, "maxContextTokens" | "keepRecentMessages">,
): SessionEntry[] | null {
  const totalTokens = estimateTotalTokens(entries);
  if (totalTokens <= config.maxContextTokens) {
    return null;
  }

  // Classify entries as structural (S) or content (C)
  const contentIndices: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (!isStructuralEntry(entries[i])) {
      contentIndices.push(i);
    }
  }

  // If we have fewer content messages than keepRecentMessages, no truncation possible
  if (contentIndices.length <= config.keepRecentMessages) {
    return null;
  }

  // Walk backward from end to find the keepRecentMessages most recent content entries
  const keepContentStart = contentIndices.length - config.keepRecentMessages;
  const removedContentIndices = new Set(contentIndices.slice(0, keepContentStart));

  // Build new array: structural entries + recent content entries, in original order
  const kept: SessionEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (!removedContentIndices.has(i)) {
      kept.push(structuredClone(entries[i]));
    }
  }

  // Find the boundary: last structural entry before the first kept content entry
  // Insert a compaction marker there
  const firstKeptContentOriginalIndex = contentIndices[keepContentStart];
  let insertPosition = 0;
  for (let i = 0; i < kept.length; i++) {
    // Find where the first kept content entry ended up in the new array
    if (kept[i].id === entries[firstKeptContentOriginalIndex].id) {
      insertPosition = i;
      break;
    }
  }

  const compactionEntry: SessionEntry = {
    type: "compaction",
    id: generateId(),
    parentId: insertPosition > 0 ? kept[insertPosition - 1].id : null,
    timestamp: new Date().toISOString(),
    message: {
      role: "system",
      content: `[Session compacted: removed ${removedContentIndices.size} older messages to stay within context limit]`,
    },
  };

  kept.splice(insertPosition, 0, compactionEntry);

  // Re-link the parentId chain: each entry[i].parentId = entry[i-1].id
  for (let i = 0; i < kept.length; i++) {
    if (i === 0) {
      kept[i].parentId = null;
    } else {
      kept[i].parentId = kept[i - 1].id;
    }
  }

  return kept;
}

export function writeSessionFile(filePath: string, entries: SessionEntry[]): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = filePath + ".tmp." + process.pid;
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";

  fs.writeFileSync(tmpPath, content, "utf-8");
  fs.renameSync(tmpPath, filePath);
}

export function getActiveSessionPath(config: Pick<ContextManagerConfig, "sessionsIndexPath" | "sessionsDir" | "sessionKey">): string | null {
  try {
    if (!fs.existsSync(config.sessionsIndexPath)) return null;

    const indexContent = JSON.parse(fs.readFileSync(config.sessionsIndexPath, "utf-8")) as Record<string, unknown>;
    const sessionRef = indexContent[config.sessionKey] as Record<string, unknown> | undefined;

    if (!sessionRef) return null;

    // The session reference may contain a file path directly or nested
    const filePath = (sessionRef.file ?? sessionRef.path ?? sessionRef.sessionFile) as string | undefined;
    if (!filePath) return null;

    // Resolve relative to sessions directory
    const resolved = path.isAbsolute(filePath) ? filePath : path.join(config.sessionsDir, filePath);

    if (!fs.existsSync(resolved)) return null;
    return resolved;
  } catch {
    return null;
  }
}

export function truncateActiveSession(config: ContextManagerConfig): TruncationResult {
  const sessionPath = getActiveSessionPath(config);
  if (!sessionPath) {
    return { truncated: false, entriesBefore: 0, entriesAfter: 0, estimatedTokensBefore: 0, estimatedTokensAfter: 0 };
  }

  const entries = parseSessionEntries(sessionPath);
  if (entries.length === 0) {
    return { truncated: false, entriesBefore: 0, entriesAfter: 0, estimatedTokensBefore: 0, estimatedTokensAfter: 0 };
  }

  const estimatedTokensBefore = estimateTotalTokens(entries);
  const truncated = truncateSession(entries, config);

  if (!truncated) {
    return {
      truncated: false,
      entriesBefore: entries.length,
      entriesAfter: entries.length,
      estimatedTokensBefore,
      estimatedTokensAfter: estimatedTokensBefore,
    };
  }

  writeSessionFile(sessionPath, truncated);

  return {
    truncated: true,
    entriesBefore: entries.length,
    entriesAfter: truncated.length,
    estimatedTokensBefore,
    estimatedTokensAfter: estimateTotalTokens(truncated),
  };
}
