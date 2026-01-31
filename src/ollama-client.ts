const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const TIMEOUT_MS = 3000;

function getBaseUrl(): string {
  return (process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL).replace(/\/+$/, "");
}

export async function isOllamaRunning(): Promise<boolean> {
  try {
    const response = await fetch(getBaseUrl(), {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

interface OllamaTagsResponse {
  models?: Array<{ name?: string }>;
}

export async function listModels(): Promise<string[]> {
  try {
    const response = await fetch(`${getBaseUrl()}/api/tags`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return [];
    const data = (await response.json()) as OllamaTagsResponse;
    return (data.models ?? [])
      .map((m) => m.name)
      .filter((n): n is string => typeof n === "string");
  } catch {
    return [];
  }
}

export async function hasModel(name: string): Promise<boolean> {
  try {
    const response = await fetch(`${getBaseUrl()}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}
