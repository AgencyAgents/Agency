import {
  type Budget,
  type LoopEvent,
  loadConfig,
  type ProviderConfig,
  runTurn,
  storagePaths,
  type ToolSpec,
} from "@agency/core";
import type { CallerIdentity, Capabilities } from "@agency/guard";
import { FULL_CAPABILITIES, SandboxBoundary } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import { createHttpClient } from "@agency/net";
import {
  anthropicAdapter,
  createOpenAiCompatibleAdapter,
  googleAdapter,
  type ModelInfo,
  openaiAdapter,
  type ProviderAdapter,
  Scheduler,
  type ThinkingLevel,
  type Usage,
} from "@agency/providers";
import { type DaemonServer, PROTOCOL_VERSION, startDaemonServer, writeInstanceFile } from "@agency/rpc";
import type { Message, StopReason } from "@agency/schema";
import { createBuiltinTools } from "@agency/tools";
import { listProviders } from "./providers-list.ts";

export interface RunTurnParams {
  turnId: string;
  provider: string;
  model: string;
  apiKey: string;
  systemPrompt: string;
  thinkingLevel?: ThinkingLevel;
  session: Message[];
  budget?: Budget;
  maxToolIterations?: number;
}

export interface RunTurnRpcResult {
  messages: Message[];
  stopReason: StopReason;
  usage: Usage;
  budgetExceeded: boolean;
  cancelled: boolean;
}

/**
 * Adapter resolution over the merged provider set: a config-defined provider
 * speaks its declared family's wire format (defaulting to openai-compatible,
 * which makes any OpenAI-shaped gateway work with zero adapter code), a
 * builtin family id falls back to its native adapter, and a catalog provider
 * with a known API base URL gets the openai-compatible adapter pointed there.
 * Unknown ids still throw, but only after every layer had its chance.
 */
export function resolveAdapter(
  providerId: string,
  providers: Record<string, ProviderConfig>,
  catalogBaseUrls: Record<string, string> = {},
): ProviderAdapter {
  const config = providers[providerId];
  if (config) {
    const family = config.family ?? "openai-compatible";
    if (family === "openai-compatible") {
      const baseUrl = config.baseUrl ?? catalogBaseUrls[providerId];
      if (!baseUrl) {
        throw new Error(`provider "${providerId}" needs a baseUrl (no native endpoint for its family)`);
      }
      return createOpenAiCompatibleAdapter(providerId, baseUrl);
    }
    if (family === "openai") return openaiAdapter;
    if (family === "anthropic") return anthropicAdapter;
    return googleAdapter;
  }

  switch (providerId) {
    case "anthropic":
      return anthropicAdapter;
    case "openai":
      return openaiAdapter;
    case "google":
      return googleAdapter;
    default: {
      const catalogBaseUrl = catalogBaseUrls[providerId];
      if (catalogBaseUrl) return createOpenAiCompatibleAdapter(providerId, catalogBaseUrl);
      throw new Error(`unknown provider: ${providerId}`);
    }
  }
}

export interface AgentDaemonOptions {
  workspaceRoot: string;
  instanceFile: string;
  /** How long to stay alive after the last client disconnects before exiting. */
  idleLingerMs?: number;
  /** Defaults to the real built-in adapters; tests substitute fakes here. */
  adapterFor?: (provider: string) => ProviderAdapter;
  http?: HttpClient;
  /** Defaults to the real P4 built-in set (read/write/edit/bash/grep/glob/
   *  fetch/todo); tests substitute a smaller fake set here. */
  tools?: ToolSpec[];
  identity?: CallerIdentity;
  capabilities?: Capabilities;
  /** Overrides the on-disk config; tests inject a minimal layer here. */
  configDir?: string;
  /** Pre-loaded catalog models for providers_list; skips the models.dev fetch. */
  catalog?: readonly ModelInfo[];
  /** Called instead of process.exit so tests can observe an idle shutdown. */
  onIdleShutdown?: () => void;
}

export interface AgentDaemon {
  server: DaemonServer;
  stop(): Promise<void>;
}

/**
 * Wires the RPC transport to the agent loop: this is the actual `agencyd`
 * body, spawned as a separate process by `ensureDaemon`'s caller and shared
 * by every client (TUI, headless, SDK) that attaches to this workspace root.
 */
export async function createAgentDaemon(options: AgentDaemonOptions): Promise<AgentDaemon> {
  const config = loadConfig({ globalDir: options.configDir, env: process.env });
  const providers = config.provider;

  const adapterFor = options.adapterFor ?? ((provider: string) => resolveAdapter(provider, providers));
  const http = options.http ?? createHttpClient();
  const identity = options.identity ?? { type: "user" as const };
  const capabilities = options.capabilities ?? FULL_CAPABILITIES;
  const idleLingerMs = options.idleLingerMs ?? 10 * 60 * 1000;

  const builtins = options.tools
    ? undefined
    : createBuiltinTools({
        deps: { identity, capabilities, sandbox: new SandboxBoundary(options.workspaceRoot) },
        http,
        workspaceRoot: options.workspaceRoot,
        snapshotDir: storagePaths(options.workspaceRoot).snapshotsDir,
      });
  const tools = options.tools ?? builtins?.tools ?? [];

  const scheduler = new Scheduler();
  const activeControllers = new Map<string, AbortController>();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const server = await startDaemonServer({
    handlers: {
      async run_turn(rawParams) {
        const params = rawParams as RunTurnParams;
        const controller = new AbortController();
        activeControllers.set(params.turnId, controller);

        try {
          const result = await runTurn(adapterFor(params.provider), scheduler, http, {
            identity,
            capabilities,
            systemPrompt: params.systemPrompt,
            tools,
            model: params.model,
            apiKey: params.apiKey,
            thinkingLevel: params.thinkingLevel,
            session: params.session,
            budget: params.budget,
            maxToolIterations: params.maxToolIterations,
            signal: controller.signal,
            onEvent: (event: LoopEvent) => server.broadcast(`turn.${params.turnId}`, event),
          });

          const response: RunTurnRpcResult = { ...result, cancelled: controller.signal.aborted };
          return response;
        } finally {
          activeControllers.delete(params.turnId);
        }
      },

      async cancel_turn(rawParams) {
        const { turnId } = rawParams as { turnId: string };
        const controller = activeControllers.get(turnId);
        if (!controller) return { cancelled: false };
        controller.abort();
        return { cancelled: true };
      },

      async providers_list() {
        return listProviders({ config, http, catalog: options.catalog });
      },
    },

    onClientCount(count) {
      if (count > 0) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
        return;
      }
      idleTimer = setTimeout(() => {
        options.onIdleShutdown?.();
      }, idleLingerMs);
    },
  });

  writeInstanceFile(options.instanceFile, {
    port: server.port,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    version: PROTOCOL_VERSION,
  });

  return {
    server,
    async stop() {
      clearTimeout(idleTimer);
      builtins?.processManager.killAll();
      await server.close();
    },
  };
}
