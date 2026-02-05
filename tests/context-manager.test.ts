import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  isStructuralEntry,
  parseSessionEntries,
  estimateEntryTokens,
  estimateTotalTokens,
  truncateSession,
  getActiveSessionPath,
  writeSessionFile,
  truncateActiveSession,
  type SessionEntry,
  type ContextManagerConfig,
} from "../src/context-manager.js";

const TEST_DIR = path.join(import.meta.dirname, "..", "data-test-context");
const TEST_SESSIONS_DIR = path.join(TEST_DIR, "sessions");
const TEST_SESSIONS_INDEX = path.join(TEST_DIR, "sessions.json");

function makeEntry(overrides: Partial<SessionEntry> & { type: string; id: string }): SessionEntry {
  return {
    parentId: null,
    ...overrides,
  };
}

function makeContentEntry(id: string, role: string, content: string, parentId: string | null = null): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: { role, content },
  };
}

function makeStructuralEntry(type: string, id: string, parentId: string | null = null): SessionEntry {
  return {
    type,
    id,
    parentId,
    timestamp: new Date().toISOString(),
  };
}

function writeJsonl(filePath: string, entries: SessionEntry[]): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  fs.writeFileSync(filePath, content, "utf-8");
}

function writeSessionsIndex(sessionKey: string, sessionFile: string): void {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const index = { [sessionKey]: { file: sessionFile } };
  fs.writeFileSync(TEST_SESSIONS_INDEX, JSON.stringify(index, null, 2));
}

beforeEach(() => {
  fs.mkdirSync(TEST_SESSIONS_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("Context Manager", () => {
  describe("isStructuralEntry", () => {
    it("should classify session entries as structural", () => {
      expect(isStructuralEntry(makeEntry({ type: "session", id: "1" }))).toBe(true);
    });

    it("should classify model_change entries as structural", () => {
      expect(isStructuralEntry(makeEntry({ type: "model_change", id: "2" }))).toBe(true);
    });

    it("should classify thinking_level_change entries as structural", () => {
      expect(isStructuralEntry(makeEntry({ type: "thinking_level_change", id: "3" }))).toBe(true);
    });

    it("should classify custom entries as structural", () => {
      expect(isStructuralEntry(makeEntry({ type: "custom", id: "4", customType: "model-snapshot" }))).toBe(true);
    });

    it("should classify compaction entries as structural", () => {
      expect(isStructuralEntry(makeEntry({ type: "compaction", id: "5" }))).toBe(true);
    });

    it("should classify message entries as content", () => {
      expect(isStructuralEntry(makeContentEntry("6", "user", "hello"))).toBe(false);
    });

    it("should classify assistant message entries as content", () => {
      expect(isStructuralEntry(makeContentEntry("7", "assistant", "hi there"))).toBe(false);
    });
  });

  describe("parseSessionEntries", () => {
    it("should parse JSONL into entry objects", () => {
      const entries = [
        makeStructuralEntry("session", "s1"),
        makeContentEntry("m1", "user", "hello", "s1"),
      ];
      const filePath = path.join(TEST_SESSIONS_DIR, "test.jsonl");
      writeJsonl(filePath, entries);

      const parsed = parseSessionEntries(filePath);

      expect(parsed).toHaveLength(2);
      expect(parsed[0].type).toBe("session");
      expect(parsed[1].type).toBe("message");
      expect(parsed[1].message?.content).toBe("hello");
    });

    it("should return empty array for non-existent files", () => {
      const parsed = parseSessionEntries("/nonexistent/file.jsonl");
      expect(parsed).toEqual([]);
    });

    it("should return empty array for empty files", () => {
      const filePath = path.join(TEST_SESSIONS_DIR, "empty.jsonl");
      fs.writeFileSync(filePath, "", "utf-8");

      const parsed = parseSessionEntries(filePath);
      expect(parsed).toEqual([]);
    });

    it("should skip malformed JSON lines", () => {
      const filePath = path.join(TEST_SESSIONS_DIR, "malformed.jsonl");
      const validEntry = JSON.stringify(makeStructuralEntry("session", "s1"));
      fs.writeFileSync(filePath, `${validEntry}\n{bad json\n`, "utf-8");

      const parsed = parseSessionEntries(filePath);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].type).toBe("session");
    });
  });

  describe("estimateEntryTokens", () => {
    it("should estimate tokens for string content", () => {
      // 400 chars / 4 = 100 tokens
      const entry = makeContentEntry("m1", "user", "a".repeat(400));
      expect(estimateEntryTokens(entry)).toBe(100);
    });

    it("should estimate tokens for array content", () => {
      const entry: SessionEntry = {
        type: "message",
        id: "m1",
        parentId: null,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "b".repeat(800) }],
        },
      };
      expect(estimateEntryTokens(entry)).toBe(200);
    });

    it("should return minimum 50 for structural entries", () => {
      const entry = makeStructuralEntry("session", "s1");
      expect(estimateEntryTokens(entry)).toBe(50);
    });

    it("should return minimum 50 for entries with no message", () => {
      const entry = makeEntry({ type: "message", id: "m1" });
      expect(estimateEntryTokens(entry)).toBe(50);
    });

    it("should return minimum 50 for very short content", () => {
      const entry = makeContentEntry("m1", "user", "hi");
      expect(estimateEntryTokens(entry)).toBe(50);
    });
  });

  describe("estimateTotalTokens", () => {
    it("should sum token estimates for all entries", () => {
      const entries = [
        makeStructuralEntry("session", "s1"),
        makeContentEntry("m1", "user", "a".repeat(400), "s1"),
      ];
      // 50 (structural) + 100 (400/4) = 150
      expect(estimateTotalTokens(entries)).toBe(150);
    });
  });

  describe("truncateSession", () => {
    it("should return null when total tokens are below threshold", () => {
      const entries = [
        makeStructuralEntry("session", "s1"),
        makeContentEntry("m1", "user", "hello", "s1"),
      ];

      const result = truncateSession(entries, { maxContextTokens: 100000, keepRecentMessages: 5 });
      expect(result).toBeNull();
    });

    it("should remove oldest content entries when over threshold", () => {
      const entries: SessionEntry[] = [
        makeStructuralEntry("session", "s1"),
      ];
      // Create 30 content entries with large content to exceed threshold
      let lastId = "s1";
      for (let i = 0; i < 30; i++) {
        const id = `m${i}`;
        entries.push(makeContentEntry(id, i % 2 === 0 ? "user" : "assistant", "x".repeat(2000), lastId));
        lastId = id;
      }

      const result = truncateSession(entries, { maxContextTokens: 1000, keepRecentMessages: 5 });

      expect(result).not.toBeNull();
      // Should keep structural + 5 recent content + 1 compaction marker
      const contentEntries = result!.filter((e) => e.type === "message");
      expect(contentEntries).toHaveLength(5);
    });

    it("should preserve all structural entries", () => {
      const entries: SessionEntry[] = [
        makeStructuralEntry("session", "s1"),
        makeStructuralEntry("model_change", "mc1", "s1"),
      ];
      let lastId = "mc1";
      for (let i = 0; i < 30; i++) {
        const id = `m${i}`;
        entries.push(makeContentEntry(id, "user", "x".repeat(2000), lastId));
        lastId = id;
      }
      // Add another structural in the middle
      entries.splice(15, 0, { ...makeStructuralEntry("custom", "c1", entries[14].id), customType: "cache-ttl" });

      const result = truncateSession(entries, { maxContextTokens: 1000, keepRecentMessages: 5 });

      expect(result).not.toBeNull();
      const structuralEntries = result!.filter((e) => isStructuralEntry(e));
      // session + model_change + custom + compaction marker = 4
      expect(structuralEntries.length).toBeGreaterThanOrEqual(4);
      expect(structuralEntries.some((e) => e.type === "session")).toBe(true);
      expect(structuralEntries.some((e) => e.type === "model_change")).toBe(true);
      expect(structuralEntries.some((e) => e.type === "custom")).toBe(true);
      expect(structuralEntries.some((e) => e.type === "compaction")).toBe(true);
    });

    it("should keep at least keepRecentMessages content entries", () => {
      const entries: SessionEntry[] = [makeStructuralEntry("session", "s1")];
      let lastId = "s1";
      for (let i = 0; i < 10; i++) {
        const id = `m${i}`;
        entries.push(makeContentEntry(id, "user", "x".repeat(2000), lastId));
        lastId = id;
      }

      const result = truncateSession(entries, { maxContextTokens: 1000, keepRecentMessages: 8 });

      expect(result).not.toBeNull();
      const contentEntries = result!.filter((e) => e.type === "message");
      expect(contentEntries).toHaveLength(8);
    });

    it("should return null when fewer messages than keepRecentMessages", () => {
      const entries: SessionEntry[] = [
        makeStructuralEntry("session", "s1"),
        makeContentEntry("m1", "user", "x".repeat(20000), "s1"),
        makeContentEntry("m2", "assistant", "x".repeat(20000), "m1"),
      ];

      const result = truncateSession(entries, { maxContextTokens: 100, keepRecentMessages: 5 });
      expect(result).toBeNull();
    });

    it("should re-link parentId chain correctly", () => {
      const entries: SessionEntry[] = [
        makeStructuralEntry("session", "s1"),
      ];
      let lastId = "s1";
      for (let i = 0; i < 20; i++) {
        const id = `m${i}`;
        entries.push(makeContentEntry(id, "user", "x".repeat(2000), lastId));
        lastId = id;
      }

      const result = truncateSession(entries, { maxContextTokens: 1000, keepRecentMessages: 5 });

      expect(result).not.toBeNull();
      // First entry should have null parentId
      expect(result![0].parentId).toBeNull();

      // Each subsequent entry should point to the previous entry's id
      for (let i = 1; i < result!.length; i++) {
        expect(result![i].parentId).toBe(result![i - 1].id);
      }
    });

    it("should insert a compaction entry at the truncation boundary", () => {
      const entries: SessionEntry[] = [
        makeStructuralEntry("session", "s1"),
      ];
      let lastId = "s1";
      for (let i = 0; i < 20; i++) {
        const id = `m${i}`;
        entries.push(makeContentEntry(id, "user", "x".repeat(2000), lastId));
        lastId = id;
      }

      const result = truncateSession(entries, { maxContextTokens: 1000, keepRecentMessages: 5 });

      expect(result).not.toBeNull();
      const compactionEntries = result!.filter((e) => e.type === "compaction");
      expect(compactionEntries).toHaveLength(1);
      expect(compactionEntries[0].message?.role).toBe("system");
      expect(typeof compactionEntries[0].message?.content).toBe("string");
      expect((compactionEntries[0].message?.content as string)).toContain("compacted");
    });
  });

  describe("getActiveSessionPath", () => {
    it("should resolve session path from sessions.json", () => {
      const sessionFile = "test-session.jsonl";
      const sessionPath = path.join(TEST_SESSIONS_DIR, sessionFile);
      writeJsonl(sessionPath, [makeStructuralEntry("session", "s1")]);
      writeSessionsIndex("agent:main:main", sessionFile);

      const result = getActiveSessionPath({
        sessionsIndexPath: TEST_SESSIONS_INDEX,
        sessionsDir: TEST_SESSIONS_DIR,
        sessionKey: "agent:main:main",
      });

      expect(result).toBe(sessionPath);
    });

    it("should return null when sessions.json does not exist", () => {
      const result = getActiveSessionPath({
        sessionsIndexPath: "/nonexistent/sessions.json",
        sessionsDir: TEST_SESSIONS_DIR,
        sessionKey: "agent:main:main",
      });

      expect(result).toBeNull();
    });

    it("should return null when session key is not found", () => {
      writeSessionsIndex("other:key", "other.jsonl");

      const result = getActiveSessionPath({
        sessionsIndexPath: TEST_SESSIONS_INDEX,
        sessionsDir: TEST_SESSIONS_DIR,
        sessionKey: "agent:main:main",
      });

      expect(result).toBeNull();
    });

    it("should return null when referenced session file does not exist", () => {
      writeSessionsIndex("agent:main:main", "nonexistent.jsonl");

      const result = getActiveSessionPath({
        sessionsIndexPath: TEST_SESSIONS_INDEX,
        sessionsDir: TEST_SESSIONS_DIR,
        sessionKey: "agent:main:main",
      });

      expect(result).toBeNull();
    });
  });

  describe("writeSessionFile", () => {
    it("should write valid JSONL", () => {
      const entries = [
        makeStructuralEntry("session", "s1"),
        makeContentEntry("m1", "user", "hello", "s1"),
      ];
      const filePath = path.join(TEST_SESSIONS_DIR, "output.jsonl");

      writeSessionFile(filePath, entries);

      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).type).toBe("session");
      expect(JSON.parse(lines[1]).type).toBe("message");
    });

    it("should round-trip with parseSessionEntries", () => {
      const entries = [
        makeStructuralEntry("session", "s1"),
        makeContentEntry("m1", "user", "hello world", "s1"),
        makeContentEntry("m2", "assistant", "hi there", "m1"),
      ];
      const filePath = path.join(TEST_SESSIONS_DIR, "roundtrip.jsonl");

      writeSessionFile(filePath, entries);
      const parsed = parseSessionEntries(filePath);

      expect(parsed).toHaveLength(3);
      expect(parsed[0].id).toBe("s1");
      expect(parsed[1].message?.content).toBe("hello world");
      expect(parsed[2].message?.content).toBe("hi there");
    });
  });

  describe("truncateActiveSession", () => {
    function makeConfig(overrides: Partial<ContextManagerConfig> = {}): ContextManagerConfig {
      return {
        maxContextTokens: 1000,
        keepRecentMessages: 5,
        sessionsDir: TEST_SESSIONS_DIR,
        sessionsIndexPath: TEST_SESSIONS_INDEX,
        sessionKey: "agent:main:main",
        ...overrides,
      };
    }

    it("should truncate an oversized session", () => {
      const sessionFile = "large-session.jsonl";
      const sessionPath = path.join(TEST_SESSIONS_DIR, sessionFile);
      const entries: SessionEntry[] = [makeStructuralEntry("session", "s1")];
      let lastId = "s1";
      for (let i = 0; i < 30; i++) {
        const id = `m${i}`;
        entries.push(makeContentEntry(id, i % 2 === 0 ? "user" : "assistant", "x".repeat(2000), lastId));
        lastId = id;
      }
      writeJsonl(sessionPath, entries);
      writeSessionsIndex("agent:main:main", sessionFile);

      const result = truncateActiveSession(makeConfig());

      expect(result.truncated).toBe(true);
      expect(result.entriesBefore).toBe(31);
      expect(result.entriesAfter).toBeLessThan(31);
      expect(result.estimatedTokensAfter).toBeLessThan(result.estimatedTokensBefore);

      // Verify the file was actually written
      const reloaded = parseSessionEntries(sessionPath);
      expect(reloaded).toHaveLength(result.entriesAfter);

      // Verify parentId chain
      expect(reloaded[0].parentId).toBeNull();
      for (let i = 1; i < reloaded.length; i++) {
        expect(reloaded[i].parentId).toBe(reloaded[i - 1].id);
      }
    });

    it("should skip truncation when session is below limit", () => {
      const sessionFile = "small-session.jsonl";
      const sessionPath = path.join(TEST_SESSIONS_DIR, sessionFile);
      const entries: SessionEntry[] = [
        makeStructuralEntry("session", "s1"),
        makeContentEntry("m1", "user", "hello", "s1"),
      ];
      writeJsonl(sessionPath, entries);
      writeSessionsIndex("agent:main:main", sessionFile);

      const result = truncateActiveSession(makeConfig({ maxContextTokens: 100000 }));

      expect(result.truncated).toBe(false);
      expect(result.entriesBefore).toBe(2);
      expect(result.entriesAfter).toBe(2);
    });

    it("should return not-truncated when session file is missing", () => {
      writeSessionsIndex("agent:main:main", "nonexistent.jsonl");

      const result = truncateActiveSession(makeConfig());

      expect(result.truncated).toBe(false);
      expect(result.entriesBefore).toBe(0);
    });

    it("should return not-truncated when sessions index is missing", () => {
      const result = truncateActiveSession(makeConfig({
        sessionsIndexPath: "/nonexistent/sessions.json",
      }));

      expect(result.truncated).toBe(false);
    });
  });
});
