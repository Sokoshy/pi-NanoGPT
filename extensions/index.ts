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

function splitThinkingId(id: string): { base: string; level: keyof NonNullable<ProviderModelConfig["thinkingLevelMap"]>; suffix: string } | undefined {
  const match = id.match(/^(.*):thinking(?::(low|medium|max|xhigh))?$/i);
  if (!match) return undefined;

  const suffix = match[2]?.toLowerCase();
  return {
    base: match[1],
    level: suffix === "low" || suffix === "medium" ? suffix : suffix === "max" || suffix === "xhigh" ? "xhigh" : "high",
    suffix: suffix ? `:thinking:${suffix}` : ":thinking",
  };
}

function toPiModel(
  model: NanoModel,
  thinkingMap?: ProviderModelConfig["thinkingLevelMap"],
  forceReasoning?: boolean,
): ProviderModelConfig {
  const reasoning = forceReasoning ?? Boolean(thinkingMap || model.capabilities?.reasoning);
  return {
    id: model.id,
    name: model.name ?? model.id,
    reasoning,
    ...(thinkingMap ? { thinkingLevelMap: thinkingMap } : {}),
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
      supportsReasoningEffort: Boolean(thinkingMap),
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

  // Collect which base IDs have :thinking variants
  const thinkingBases = new Set<string>();
  for (const m of models) {
    const info = splitThinkingId(m.id);
    if (info) thinkingBases.add(info.base);
  }

  return models.map((model) => {
    const info = splitThinkingId(model.id);
    if (!info) {
      // Non-thinking variant.
      // If this base has :thinking variants, force reasoning=false
      // because NanoGPT controls thinking via model ID, not parameters.
      const hasThinkingVariant = thinkingBases.has(model.id);
      return toPiModel(model, undefined, hasThinkingVariant ? false : undefined);
    }

    // This IS a :thinking variant.
    // Map Pi levels to this variant's fixed level only.
    // e.g. `:thinking:low` → only "low" is active, everything else hidden.
    const piLevel = info.level;
    const thinkingMap: NonNullable<ProviderModelConfig["thinkingLevelMap"]> = {
      off: null,
      minimal: null,
      low: piLevel === "low" ? "low" : null,
      medium: piLevel === "medium" ? "medium" : null,
      high: piLevel === "high" ? "high" : null,
      xhigh: piLevel === "xhigh" ? "max" : null,
    };

    return toPiModel(model, thinkingMap);
  });
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
