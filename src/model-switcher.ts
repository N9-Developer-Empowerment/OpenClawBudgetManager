import fs from "node:fs";
import path from "node:path";
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

interface OpenClawConfigResult {
  config: Record<string, unknown>;
  hash: string;
}

export function getOpenClawConfig(): OpenClawConfigResult {
  const raw = execSync("openclaw gateway call config.get", {
    encoding: "utf-8",
    timeout: 10_000,
  });
  const parsed = JSON.parse(raw) as { config: Record<string, unknown>; hash: string };
  return { config: parsed.config, hash: parsed.hash };
}

export function patchOpenClawModel(modelId: string, hash: string): void {
  const patch = JSON.stringify({
    patch: { agents: { defaults: { model: { primary: modelId } } } },
    hash,
  });
  execSync(`openclaw gateway call config.patch '${patch}'`, {
    encoding: "utf-8",
    timeout: 10_000,
  });
}

function resolveCurrentModel(config: Record<string, unknown>): string {
  const agents = config.agents as Record<string, unknown> | undefined;
  const defaults = agents?.defaults as Record<string, unknown> | undefined;
  const model = defaults?.model as Record<string, unknown> | string | undefined;
  if (typeof model === "string") return model;
  if (typeof model === "object" && model !== null) {
    return (model.primary as string) ?? "unknown";
  }
  return "unknown";
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

  const { config, hash } = getOpenClawConfig();
  const originalModel = resolveCurrentModel(config);

  const ollamaModelId = `ollama/${target}`;
  patchOpenClawModel(ollamaModelId, hash);

  saveSwitcherState(statePath, {
    mode: "local",
    originalModel,
    switchedAt: new Date().toISOString(),
    switchedModelId: ollamaModelId,
  });

  logger.info(`[model-switcher] Switched from ${originalModel} to ${ollamaModelId}`);
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

  const { hash } = getOpenClawConfig();
  patchOpenClawModel(state.originalModel, hash);
  clearSwitcherState(statePath);

  logger.info(`[model-switcher] Restored cloud model: ${state.originalModel}`);
  return true;
}
