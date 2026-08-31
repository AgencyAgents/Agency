import { type Budget, type LoopEvent, runTurn, type ToolSpec } from "@agency/core";
import type { CallerIdentity, Capabilities } from "@agency/guard";
import { FULL_CAPABILITIES } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import { createHttpClient } from "@agency/net";
import {
  anthropicAdapter,
  googleAdapter,
  openaiAdapter,
  type ProviderAdapter,
  Scheduler,
  type ThinkingLevel,
  type Usage,
} from "@agency/providers";
import { type DaemonServer, PROTOCOL_VERSION, startDaemonServer, writeInstanceFile } from "@agency/rpc";
import type { Message, StopReason } from "@agency/schema";

const BUILTIN_ADAPTERS: Record<string, ProviderAdapter> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  google: googleAdapter,
};

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

export interface AgentDaemonOptions {
  workspaceRoot: string;
  instanceFile: string;
  /** How long to stay alive after the last client disconnects before exiting. */
  idleLingerMs?: number;
  /** Defaults to the real built-in adapters; tests substitute fakes here. */
  adapterFor?: (provider: string) => ProviderAdapter;
  http?: HttpClient;
  tools?: ToolSpec[];
  identity?: CallerIdentity;
  capabilities?: Capabilities;
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
  const adapterFor =
    options.adapterFor ??
    ((provider) => {
      const adapter = BUILTIN_ADAPTERS[provider];
      if (!adapter) throw new Error(`unknown provider: ${provider}`);
      return adapter;
    });
  const http = options.http ?? createHttpClient();
  const tools = options.tools ?? [];
  const identity = options.identity ?? { type: "user" as const };
  const capabilities = options.capabilities ?? FULL_CAPABILITIES;
  const idleLingerMs = options.idleLingerMs ?? 10 * 60 * 1000;

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
      await server.close();
    },
  };
}
