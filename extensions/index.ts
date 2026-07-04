import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";

const PROVIDER = "NanoGPT";
const CACHE_PATH = join(homedir(), ".pi", "nanogpt-models.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const BASE_URL = "https://nano-gpt.com/api/v1";

interface NanoModel {
  id: string;
  name?: string;
  context_length?: number | null;
  max_output_tokens?: number | null;
  capabilities?: {
    vision?: boolean;
    reasoning?: boolean;
  };
  pricing?: {
    prompt?: number | string;
    completion?: number | string;
  };
}

interface ModelCache {
  fetchedAt: number;
  models: ProviderModelConfig[];
}

async function readCache(): Promise<ModelCache | undefined> {
  try {
    const cache = JSON.parse(await readFile(CACHE_PATH, "utf8")) as ModelCache;
    return typeof cache.fetchedAt === "number" && Array.isArray(cache.models)
      ? cache
      : undefined;
  } catch {
    return undefined;
  }
}

async function writeCache(models: ProviderModelConfig[]): Promise<void> {
  await mkdir(dirname(CACHE_PATH), { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify({ fetchedAt: Date.now(), models }, null, 2));
}

function price(value: number | string | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function thinkingLevelMap(id: string): ProviderModelConfig["thinkingLevelMap"] | undefined {
  const match = id.match(/:thinking(?::(low|medium|max|xhigh))?$/i);
  if (!match) return undefined;

  const level = (match[1]?.toLowerCase() ?? "high") === "max" ? "xhigh" : match[1]?.toLowerCase() ?? "high";
  return {
    off: null,
    minimal: null,
    low: level === "low" ? "low" : null,
    medium: level === "medium" ? "medium" : null,
    high: level === "high" ? "high" : null,
    xhigh: level === "xhigh" ? "max" : null,
  };
}

function toPiModel(model: NanoModel, thinkingBases: Set<string>): ProviderModelConfig {
  const map = thinkingLevelMap(model.id);
  const reasoning = Boolean(map || (model.capabilities?.reasoning && !thinkingBases.has(model.id)));
  return {
    id: model.id,
    name: model.name ?? model.id,
    reasoning,
    ...(map ? { thinkingLevelMap: map } : {}),
    input: model.capabilities?.vision ? ["text", "image"] : ["text"],
    cost: {
      input: price(model.pricing?.prompt),
      output: price(model.pricing?.completion),
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: model.context_length ?? 128000,
    maxTokens: model.max_output_tokens ?? 4096,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
    },
  };
}

async function fetchNanoModels(apiKey?: string): Promise<ProviderModelConfig[]> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(`${BASE_URL}/models?detailed=true&sort=favorites`, { headers });
  if (!res.ok) throw new Error(`NanoGPT models request failed: ${res.status}`);

  const body = (await res.json()) as { data?: NanoModel[] };
  const models = (body.data ?? []).filter((m) => m.id);
  const thinkingBases = new Set(
    models
      .map((m) => m.id.match(/^(.*):thinking(?::(?:low|medium|max|xhigh))?$/i)?.[1])
      .filter((id): id is string => Boolean(id)),
  );

  return models.map((model) => toPiModel(model, thinkingBases));
}

function providerConfig(models: ProviderModelConfig[]) {
  return {
    name: PROVIDER,
    baseUrl: BASE_URL,
    api: "openai-completions" as const,
    authHeader: true,
    apiKey: "$NANOGPT_API_KEY",
    models,
  };
}

async function registerModels(
  pi: ExtensionAPI,
  apiKey?: string,
  notify?: (message: string, type: string) => void,
): Promise<void> {
  const models = await fetchNanoModels(apiKey);
  if (!models.length) throw new Error("No NanoGPT models returned");

  pi.registerProvider(PROVIDER, providerConfig(models));
  await writeCache(models);
  notify?.(`NanoGPT: ${models.length} models loaded`, "info");
}

async function loginNanoGPT(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
  const apiKey = await ctx.ui.input("Enter your NanoGPT API key:", "sk-...");
  if (!apiKey?.trim()) return;

  try {
    ctx.modelRegistry.authStorage.set(PROVIDER, {
      type: "api_key" as const,
      key: apiKey.trim(),
    });
    await registerModels(pi, apiKey.trim(), ctx.ui.notify);
  } catch (err) {
    ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
  }
}

export default async function (pi: ExtensionAPI) {
  const cache = await readCache();
  pi.registerProvider(PROVIDER, providerConfig(cache?.models ?? []));

  const shouldRefresh = !cache || Date.now() - cache.fetchedAt > CACHE_TTL_MS;
  if (shouldRefresh) {
    try {
      await registerModels(pi, process.env.NANOGPT_API_KEY);
    } catch {
      // ponytail: network/API failures keep the last cached model list.
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    const cache = await readCache();
    if (cache && Date.now() - cache.fetchedAt <= CACHE_TTL_MS) return;

    const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
    try {
      await registerModels(pi, apiKey);
    } catch {
      // ponytail: startup should not fail just because model discovery did.
    }
  });

  pi.registerCommand("login-nanogpt", {
    description: "Enter your NanoGPT API key and load models",
    handler: async (_args: string, ctx) => loginNanoGPT(pi, ctx),
  });

  pi.registerCommand("refresh-nanogpt", {
    description: "Refresh NanoGPT models from the API",
    handler: async (_args: string, ctx) => {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
      try {
        await registerModels(pi, apiKey, ctx.ui.notify);
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
  });
}
