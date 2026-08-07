import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";

const PROVIDER = "NanoGPT";
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

/**
 * Structural subset of the `RefreshModelsContext` passed by Pi to
 * `refreshModels` (the full type is not part of the public export surface).
 */
interface RefreshContext {
  /** Effective configured credential — stored key or resolved env var. */
  credential?: { type: string; key?: string };
  /** Persisted catalog snapshot captured before this refresh phase. */
  stored?: { models: readonly ProviderModelConfig[]; checkedAt?: number };
  /** Generation-checked publication of the catalog snapshot. */
  publish(publication: { persist?: unknown; update?: () => void }): Promise<boolean>;
  /** False during offline/cache-only initialization. */
  allowNetwork: boolean;
  /** Bypass the provider freshness check when network access is allowed. */
  force?: boolean;
  signal: AbortSignal;
}

function price(value: number | string | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

async function fetchModelsDev(signal?: AbortSignal): Promise<Map<string, ModelsDevModel>> {
  try {
    const res = await fetch(MODELS_DEV_URL, { signal });
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
    xhigh: values.has("xhigh") ? "xhigh" : null,
    max:   values.has("max")   ? "max"   : null,
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
        medium: "medium", high: "high", xhigh: "xhigh", max: "max",
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

async function fetchNanoModels(apiKey: string | undefined, signal?: AbortSignal): Promise<ProviderModelConfig[]> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(`${BASE_URL}/models?detailed=true&sort=favorites`, { headers, signal });
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
  const devIndex = await fetchModelsDev(signal);

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

/**
 * Dynamic model discovery for Pi 0.84+.
 *
 * Pi calls this during model refresh: first offline (to restore the persisted
 * catalog), then online with the resolved credential. The extension persists
 * the catalog via `context.publish` and returns the list, which Pi publishes
 * synchronously — no manual cache file or re-registration needed.
 */
async function refreshNanoModels(ctx: RefreshContext): Promise<ProviderModelConfig[]> {
  // Offline phase (startup, post-login sync): restore the persisted catalog.
  if (!ctx.allowNetwork) {
    return ctx.stored?.models?.length ? [...ctx.stored.models] : [];
  }

  // Freshness check: keep the persisted list for up to 24h to avoid
  // hammering the NanoGPT API on every startup.
  if (!ctx.force && ctx.stored?.checkedAt && Date.now() - ctx.stored.checkedAt < CACHE_TTL_MS) {
    return ctx.stored.models.length ? [...ctx.stored.models] : [];
  }

  const apiKey = ctx.credential?.type === "api_key" ? ctx.credential.key : undefined;
  const models = await fetchNanoModels(apiKey, ctx.signal);

  // Persist the catalog for offline/cached restores; the returned list is
  // published in-memory by Pi. On failure the previous list is retained.
  await ctx.publish({ persist: { models, checkedAt: Date.now() } });
  return models;
}

export default async function (pi: ExtensionAPI) {
  pi.registerProvider(PROVIDER, {
    name: PROVIDER,
    baseUrl: BASE_URL,
    api: "openai-completions",
    authHeader: true,
    // Config reference only: the key is resolved from the environment or from
    // the credential stored by Pi's built-in `/login NanoGPT`.
    apiKey: "$NANOGPT_API_KEY",
    refreshModels: refreshNanoModels,
  });

  pi.registerCommand("refresh-nanogpt", {
    description: "Refresh NanoGPT models from the API",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      try {
        const result = await ctx.modelRegistry.refresh({
          providers: [PROVIDER],
          force: true,
          signal: AbortSignal.timeout(20_000),
        });
        if (result.aborted) {
          ctx.ui.notify("NanoGPT refresh timed out; using cached models", "warning");
        } else if (result.errors.size > 0) {
          const message = result.errors.get(PROVIDER)?.message ?? "unknown error";
          ctx.ui.notify(`NanoGPT refresh failed: ${message}`, "error");
        } else {
          ctx.ui.notify("NanoGPT models refreshed", "info");
        }
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
  });
}
