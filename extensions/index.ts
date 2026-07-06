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
const MODELS_DEV_URL = "https://models.dev/api.json";

interface ModelsDevModel {
  id?: string;
  name?: string;
  reasoning?: boolean;
  reasoning_options?: Array<{ type?: string; values?: string[] }>;
}

type ThinkingLevelMap = NonNullable<ProviderModelConfig["thinkingLevelMap"]>;

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

async function fetchModelsDev(): Promise<Map<string, ModelsDevModel>> {
  try {
    const res = await fetch(MODELS_DEV_URL);
    if (!res.ok) return new Map();
    const catalog = await res.json() as Record<string, { models?: Record<string, ModelsDevModel> }>;
    const index = new Map<string, ModelsDevModel>();
    // Seulement la section nano-gpt — les autres providers ont leurs propres options.
    for (const [key, model] of Object.entries(catalog["nano-gpt"]?.models ?? {})) {
      for (const id of [key, model.id, key.split("/").pop()]) {
        if (id) index.set(id.toLowerCase(), model);
      }
    }
    return index;
  } catch {
    return new Map();
  }
}

function thinkingMapFromModelsDev(model?: ModelsDevModel): ThinkingLevelMap | undefined {
  const effort = model?.reasoning_options?.find((option) => option.type === "effort");
  if (!effort?.values?.length) return undefined;

  const values = new Set(effort.values);
  return {
    off: values.has("none") ? "none" : null,
    minimal: values.has("minimal") ? "minimal" : null,
    low: values.has("low") ? "low" : null,
    medium: values.has("medium") ? "medium" : null,
    high: values.has("high") ? "high" : null,
    xhigh: values.has("xhigh") ? "xhigh" : values.has("max") ? "max" : null,
  };
}

function toPiModel(model: NanoModel, devModel?: ModelsDevModel): ProviderModelConfig {
  const reasoning = Boolean(model.capabilities?.reasoning);
  // Modèle présent dans models.dev mais sans effort (toggle only) → pas de thinkingLevelMap.
  // Absent de models.dev → fallback 1:1 sécurisé.
  const hasEffort = devModel && devModel.reasoning_options?.some(o => o.type === "effort");
  const tlm = reasoning
    ? hasEffort ? thinkingMapFromModelsDev(devModel)
    : !devModel ? {
        off: "none", minimal: "minimal", low: "low",
        medium: "medium", high: "high", xhigh: "xhigh",
      }
    : undefined
    : undefined;
  return {
    id: model.id,
    name: model.name ?? model.id,
    reasoning,
    ...(tlm ? { thinkingLevelMap: tlm } : {}),
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
      supportsReasoningEffort: reasoning,
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

  // Collect base IDs that have :thinking variants.
  const thinkingBases = new Set<string>();
  for (const m of models) {
    const match = m.id.match(/^(.*):thinking(?:\S*)?$/i);
    if (match) thinkingBases.add(match[1]);
  }

  // Fetch models.dev for per-model reasoning_options.
  const devIndex = await fetchModelsDev();

  return models
    // Skip :thinking variants — Pi sends reasoning_effort instead.
    .filter((m) => !m.id.includes(":thinking"))
    .map((model) => {
      // If NanoGPT lists a :thinking variant for this base, the base model
      // actually supports reasoning via reasoning_effort.
      const supportsReasoning = Boolean(model.capabilities?.reasoning) || thinkingBases.has(model.id);
      return toPiModel(
        { ...model, capabilities: { ...model.capabilities, reasoning: supportsReasoning } },
        devIndex.get(model.id.toLowerCase()),
      );
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
