import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { isOllamaRunning, hasModel } from "./ollama-client.js";
import type { TaskType } from "./budget-gate.js";

export interface SwitcherState {
  mode: "cloud" | "local";
  originalModel: string;
  switchedAt: string;
  switchedModelId: string;
}

interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

const OPENCLAW_CONFIG_PATH = path.join(os.homedir(), ".openclaw", "openclaw.json");

export function loadSwitcherState(statePath: string): SwitcherState | null {
  try {
    if (!fs.existsSync(statePath)) return null;
    return JSON.parse(fs.readFileSync(statePath, "utf-8")) as SwitcherState;
  } catch {
    return null;
  }
}

export function saveSwitcherState(statePath: string, state: SwitcherState): void {
  const dir = path.dirname(statePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export function clearSwitcherState(statePath: string): void {
  try {
    if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
  } catch {
    // ignore
  }
}

export function getConfigPath(): string {
  return process.env.OPENCLAW_CONFIG ?? OPENCLAW_CONFIG_PATH;
}

interface OpenClawConfig {
  agents?: {
    defaults?: {
      model?: { primary?: string; [key: string]: unknown };
      models?: Record<string, unknown>;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export function readOpenClawConfig(configPath?: string): OpenClawConfig {
  const p = configPath ?? getConfigPath();
  return JSON.parse(fs.readFileSync(p, "utf-8")) as OpenClawConfig;
}

export function writeOpenClawConfig(config: OpenClawConfig, configPath?: string): void {
  const p = configPath ?? getConfigPath();
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + "\n");
}

export function restartGateway(): void {
  execSync("openclaw gateway restart", {
    encoding: "utf-8",
    timeout: 15_000,
    stdio: "ignore",
  });
}

function resolveCurrentModel(config: OpenClawConfig): string {
  return config.agents?.defaults?.model?.primary ?? "unknown";
}

function setActiveModel(config: OpenClawConfig, modelId: string): OpenClawConfig {
  const updated = structuredClone(config);
  if (!updated.agents) updated.agents = {};
  if (!updated.agents.defaults) updated.agents.defaults = {};
  if (!updated.agents.defaults.model) updated.agents.defaults.model = {};
  updated.agents.defaults.model.primary = modelId;
  if (!updated.agents.defaults.models) updated.agents.defaults.models = {};
  if (!updated.agents.defaults.models[modelId]) {
    updated.agents.defaults.models[modelId] = {};
  }
  return updated;
}

export async function switchToLocalModel(
  taskType: TaskType,
  statePath: string,
  localModels: Record<TaskType, string>,
  logger: Logger,
): Promise<boolean> {
  const existing = loadSwitcherState(statePath);
  if (existing?.mode === "local") {
    logger.info("[model-switcher] Already switched to local, skipping");
    return false;
  }

  const ollamaUp = await isOllamaRunning();
  if (!ollamaUp) {
    logger.warn("[model-switcher] Ollama is not running, cannot switch");
    return false;
  }

  let target = localModels[taskType];
  const targetAvailable = await hasModel(target);
  if (!targetAvailable) {
    logger.warn(`[model-switcher] Model ${target} not available, falling back to general`);
    target = localModels.general;
    const generalAvailable = await hasModel(target);
    if (!generalAvailable) {
      logger.error(`[model-switcher] General model ${target} also unavailable, aborting`);
      return false;
    }
  }

  const config = readOpenClawConfig();
  const originalModel = resolveCurrentModel(config);
  const ollamaModelId = `ollama/${target}`;

  const updated = setActiveModel(config, ollamaModelId);
  writeOpenClawConfig(updated);

  saveSwitcherState(statePath, {
    mode: "local",
    originalModel,
    switchedAt: new Date().toISOString(),
    switchedModelId: ollamaModelId,
  });

  logger.info(`[model-switcher] Switched from ${originalModel} to ${ollamaModelId}, restarting gateway`);
  restartGateway();
  return true;
}

export async function restoreCloudModel(
  statePath: string,
  logger: Logger,
): Promise<boolean> {
  const state = loadSwitcherState(statePath);
  if (!state || state.mode !== "local") {
    logger.info("[model-switcher] No local state to restore from");
    return false;
  }

  const config = readOpenClawConfig();
  const updated = setActiveModel(config, state.originalModel);
  writeOpenClawConfig(updated);
  clearSwitcherState(statePath);

  logger.info(`[model-switcher] Restored cloud model: ${state.originalModel}, restarting gateway`);
  restartGateway();
  return true;
}
