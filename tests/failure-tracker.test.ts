import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  loadFailureData,
  saveFailureData,
  recordSuccess,
  recordFailure,
  shouldSwitchProvider,
  detectFailure,
  type FailureData,
} from "../src/failure-tracker.js";

const TEST_DATA_DIR = path.join(import.meta.dirname, "..", "data-test-failure");
const TEST_FAILURE_FILE = path.join(TEST_DATA_DIR, "failure-tracker.json");

beforeEach(() => {
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe("Failure Tracker", () => {
  describe("loadFailureData / saveFailureData", () => {
    it("should return empty data when no file exists", () => {
      const data = loadFailureData(TEST_FAILURE_FILE);

      expect(data.date).toBe(new Date().toISOString().split("T")[0]);
      expect(data.providers).toEqual({});
    });

    it("should load existing data for the current day", () => {
      const today = new Date().toISOString().split("T")[0];
      const existing: FailureData = {
        date: today,
        providers: {
          "bytedance-ark": { consecutiveFailures: 2, lastFailureAt: "2026-02-17T10:00:00Z" },
        },
      };
      fs.writeFileSync(TEST_FAILURE_FILE, JSON.stringify(existing));

      const data = loadFailureData(TEST_FAILURE_FILE);

      expect(data.providers["bytedance-ark"].consecutiveFailures).toBe(2);
    });

    it("should reset data when the date has changed", () => {
      const yesterday: FailureData = {
        date: "2025-01-01",
        providers: {
          "bytedance-ark": { consecutiveFailures: 5, lastFailureAt: "2025-01-01T23:00:00Z" },
        },
      };
      fs.writeFileSync(TEST_FAILURE_FILE, JSON.stringify(yesterday));

      const data = loadFailureData(TEST_FAILURE_FILE);

      expect(data.providers).toEqual({});
    });

    it("should handle corrupted file gracefully", () => {
      fs.writeFileSync(TEST_FAILURE_FILE, "not json");

      const data = loadFailureData(TEST_FAILURE_FILE);

      expect(data.providers).toEqual({});
    });

    it("should save and reload data", () => {
      const data: FailureData = {
        date: new Date().toISOString().split("T")[0],
        providers: {
          deepseek: { consecutiveFailures: 1, lastFailureAt: new Date().toISOString() },
        },
      };

      saveFailureData(TEST_FAILURE_FILE, data);
      const loaded = loadFailureData(TEST_FAILURE_FILE);

      expect(loaded.providers.deepseek.consecutiveFailures).toBe(1);
    });
  });

  describe("recordSuccess", () => {
    it("should reset consecutive failures to zero", () => {
      // Set up some failures first
      recordFailure(TEST_FAILURE_FILE, "moonshot");
      recordFailure(TEST_FAILURE_FILE, "moonshot");

      recordSuccess(TEST_FAILURE_FILE, "moonshot");

      const data = loadFailureData(TEST_FAILURE_FILE);
      expect(data.providers.moonshot.consecutiveFailures).toBe(0);
    });

    it("should create provider record if it does not exist", () => {
      recordSuccess(TEST_FAILURE_FILE, "google");

      const data = loadFailureData(TEST_FAILURE_FILE);
      expect(data.providers.google.consecutiveFailures).toBe(0);
    });
  });

  describe("recordFailure", () => {
    it("should increment consecutive failures and return the new count", () => {
      const count1 = recordFailure(TEST_FAILURE_FILE, "deepseek");
      const count2 = recordFailure(TEST_FAILURE_FILE, "deepseek");
      const count3 = recordFailure(TEST_FAILURE_FILE, "deepseek");

      expect(count1).toBe(1);
      expect(count2).toBe(2);
      expect(count3).toBe(3);
    });

    it("should set lastFailureAt timestamp", () => {
      recordFailure(TEST_FAILURE_FILE, "openai");

      const data = loadFailureData(TEST_FAILURE_FILE);
      expect(data.providers.openai.lastFailureAt).toBeTruthy();
    });

    it("should track failures independently per provider", () => {
      recordFailure(TEST_FAILURE_FILE, "moonshot");
      recordFailure(TEST_FAILURE_FILE, "moonshot");
      recordFailure(TEST_FAILURE_FILE, "deepseek");

      const data = loadFailureData(TEST_FAILURE_FILE);
      expect(data.providers.moonshot.consecutiveFailures).toBe(2);
      expect(data.providers.deepseek.consecutiveFailures).toBe(1);
    });
  });

  describe("shouldSwitchProvider", () => {
    it("should return false when failures are below threshold", () => {
      recordFailure(TEST_FAILURE_FILE, "google");
      recordFailure(TEST_FAILURE_FILE, "google");

      expect(shouldSwitchProvider(TEST_FAILURE_FILE, "google", 3)).toBe(false);
    });

    it("should return true when failures reach the threshold", () => {
      recordFailure(TEST_FAILURE_FILE, "google");
      recordFailure(TEST_FAILURE_FILE, "google");
      recordFailure(TEST_FAILURE_FILE, "google");

      expect(shouldSwitchProvider(TEST_FAILURE_FILE, "google", 3)).toBe(true);
    });

    it("should return true when failures exceed the threshold", () => {
      for (let i = 0; i < 5; i++) {
        recordFailure(TEST_FAILURE_FILE, "openai");
      }

      expect(shouldSwitchProvider(TEST_FAILURE_FILE, "openai", 3)).toBe(true);
    });

    it("should return false for unknown provider", () => {
      expect(shouldSwitchProvider(TEST_FAILURE_FILE, "unknown", 3)).toBe(false);
    });

    it("should use custom threshold", () => {
      recordFailure(TEST_FAILURE_FILE, "minimax");

      expect(shouldSwitchProvider(TEST_FAILURE_FILE, "minimax", 1)).toBe(true);
      expect(shouldSwitchProvider(TEST_FAILURE_FILE, "minimax", 2)).toBe(false);
    });
  });

  describe("detectFailure", () => {
    it("should detect explicit error field in event", () => {
      const event = { error: "connection refused" };
      const messages = [{ role: "assistant", content: "ok", usage: { input: 10, output: 10 } }];

      expect(detectFailure(event, messages)).toBe(true);
    });

    it("should detect empty messages array", () => {
      expect(detectFailure({}, [])).toBe(true);
    });

    it("should detect null/undefined messages", () => {
      expect(detectFailure({}, null as unknown as unknown[])).toBe(true);
    });

    it("should detect no assistant messages", () => {
      const messages = [{ role: "user", content: "hello" }];

      expect(detectFailure({}, messages)).toBe(true);
    });

    it("should detect empty assistant content", () => {
      const messages = [
        { role: "assistant", content: "", usage: { input: 10, output: 0 } },
      ];

      expect(detectFailure({}, messages)).toBe(true);
    });

    it("should detect null assistant content", () => {
      const messages = [
        { role: "assistant", content: null, usage: { input: 10, output: 0 } },
      ];

      expect(detectFailure({}, messages)).toBe(true);
    });

    it("should detect rate limit error in content", () => {
      const messages = [
        { role: "assistant", content: "Error: rate limit exceeded", usage: { input: 10, output: 5 } },
      ];

      expect(detectFailure({}, messages)).toBe(true);
    });

    it("should detect service unavailable error in content", () => {
      const messages = [
        { role: "assistant", content: "503 Service Unavailable", usage: { input: 10, output: 5 } },
      ];

      expect(detectFailure({}, messages)).toBe(true);
    });

    it("should detect timeout error in content", () => {
      const messages = [
        { role: "assistant", content: "Request timeout", usage: { input: 10, output: 5 } },
      ];

      expect(detectFailure({}, messages)).toBe(true);
    });

    it("should detect 429 error in content", () => {
      const messages = [
        { role: "assistant", content: "HTTP 429 Too Many Requests", usage: { input: 10, output: 5 } },
      ];

      expect(detectFailure({}, messages)).toBe(true);
    });

    it("should detect billing error in content", () => {
      const messages = [
        { role: "assistant", content: "API provider returned a billing error", usage: { input: 10, output: 5 } },
      ];

      expect(detectFailure({}, messages)).toBe(true);
    });

    it("should detect insufficient credits in content", () => {
      const messages = [
        { role: "assistant", content: "Your API key has run out of credits or has an insufficient balance", usage: { input: 10, output: 5 } },
      ];

      expect(detectFailure({}, messages)).toBe(true);
    });

    it("should detect quota exceeded in content", () => {
      const messages = [
        { role: "assistant", content: "Error: quota exceeded for this API key", usage: { input: 10, output: 5 } },
      ];

      expect(detectFailure({}, messages)).toBe(true);
    });

    it("should detect invalid API key in content", () => {
      const messages = [
        { role: "assistant", content: "Error: invalid api key provided", usage: { input: 10, output: 5 } },
      ];

      expect(detectFailure({}, messages)).toBe(true);
    });

    it("should detect error patterns in array content blocks", () => {
      const messages = [
        {
          role: "assistant",
          content: [{ type: "text", text: "Error: ETIMEDOUT connecting to API" }],
          usage: { input: 10, output: 5 },
        },
      ];

      expect(detectFailure({}, messages)).toBe(true);
    });

    it("should detect empty array content", () => {
      const messages = [
        { role: "assistant", content: [], usage: { input: 10, output: 0 } },
      ];

      expect(detectFailure({}, messages)).toBe(true);
    });

    it("should detect missing usage with very short response", () => {
      const messages = [
        { role: "assistant", content: "err" },
      ];

      expect(detectFailure({}, messages)).toBe(true);
    });

    it("should NOT flag a successful response", () => {
      const messages = [
        {
          role: "assistant",
          content: "Here is the answer to your question about JavaScript closures...",
          usage: { input_tokens: 500, output_tokens: 200 },
        },
      ];

      expect(detectFailure({}, messages)).toBe(false);
    });

    it("should NOT flag a response with usage data even without error patterns", () => {
      const messages = [
        {
          role: "user",
          content: "hello",
        },
        {
          role: "assistant",
          content: "Hello! How can I help you today?",
          usage: { input_tokens: 50, output_tokens: 20 },
        },
      ];

      expect(detectFailure({}, messages)).toBe(false);
    });

    it("should check only the last assistant message for failures", () => {
      const messages = [
        {
          role: "assistant",
          content: "rate limit exceeded",
          usage: { input: 10, output: 5 },
        },
        {
          role: "assistant",
          content: "This is a normal response that is long enough to not trigger the short response heuristic.",
          usage: { input_tokens: 200, output_tokens: 100 },
        },
      ];

      expect(detectFailure({}, messages)).toBe(false);
    });
  });
});
