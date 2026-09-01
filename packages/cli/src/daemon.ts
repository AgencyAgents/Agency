import { join } from "node:path";
import {
  type Budget,
  createRotatingFileSink,
  dataDir,
  Logger,
  type LoopEvent,
  loadConfig,
  type ProviderConfig,
  runTurn,
  storagePaths,
  type ToolSpec,
  withTrace,
} from "@agency/core";
import type { CallerIdentity, Capabilities } from "@agency/guard";
import { FULL_CAPABILITIES, Redactor, SandboxBoundary } from "@agency/guard";
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
import { AgencyError, ErrorCode, type Message, type StopReason } from "@agency/schema";
import { createFileTelemetrySink, Telemetry } from "@agency/telemetry";
import { createBuiltinTools } from "@agency/tools";
import { listProviders } from "./providers-list.ts";

function createRotatingSink(logsDir: string): (line: string) => void {
  const sink = createRotatingFileSink({ dir: logsDir });
  return (line) => sink.write(line);
}

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
  /** Set when the turn failed with CONTEXT_OVERFLOW: the daemon produced no
   *  assistant messages, so the caller (which owns the SessionStore) can
   *  compact the session and retry the turn. */
  needsCompaction?: boolean;
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
  /** When set, structured logs persist here (rotated JSONL); the real daemon
   *  passes logDir(). Tests omit it and get a console sink. */
  logsDir?: string;
  /** Overrides where telemetry events land; defaults to dataDir()/telemetry. */
  telemetryDir?: string;
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

  // R11 wiring: every key that resolves anywhere in this process is registered
  // here, and the logger scrubs every line through the same redactor.
  const redactor = new Redactor();
  for (const providerConfig of Object.values(providers)) {
    if (providerConfig.apiKey) redactor.registerSecret(providerConfig.apiKey);
  }
  for (const [envKey, value] of Object.entries(process.env)) {
    if (envKey.startsWith("AGENCY_") && envKey.endsWith("_API_KEY") && value) {
      redactor.registerSecret(value);
    }
  }

  const sink = options.logsDir ? createRotatingSink(options.logsDir) : (line: string) => console.log(line);
  const logger = new Logger({ level: config.logLevel, sink, redactor });
  const telemetry = new Telemetry({
    enabled: config.telemetryEnabled,
    crashReports: { enabled: config.crashReportsEnabled },
    redactor,
    sink: createFileTelemetrySink(join(options.telemetryDir ?? dataDir(), "telemetry", "events.jsonl")),
  });

  const adapterFor = options.adapterFor ?? ((provider: string) => resolveAdapter(provider, providers));
  const http = options.http ?? createHttpClient();
  const identity = options.identity ?? { type: "user" as const };
  const capabilities = options.capabilities ?? FULL_CAPABILITIES;
  const idleLingerMs = options.idleLingerMs ?? 10 * 60 * 1000;

  logger.info("daemon started", { workspaceRoot: options.workspaceRoot, protocolVersion: PROTOCOL_VERSION });

  const builtins = options.tools
    ? undefined
    : await createBuiltinTools({
        deps: { identity, capabilities, sandbox: new SandboxBoundary(options.workspaceRoot) },
        http,
        workspaceRoot: options.workspaceRoot,
        snapshotDir: storagePaths(options.workspaceRoot).snapshotsDir,
        mcpServers: config.mcpServers,
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

        // R10 wiring: the whole turn — provider requests and tool calls —
        // correlates under one trace ID in the logs.
        return withTrace(async () => {
          try {
            redactor.registerSecret(params.apiKey);
            logger.info("turn started", {
              turnId: params.turnId,
              provider: params.provider,
              model: params.model,
            });
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

            logger.info("turn finished", {
              turnId: params.turnId,
              stopReason: result.stopReason,
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              cachedInputTokens: result.usage.cachedInputTokens ?? null,
            });
            telemetry.record("turn_complete", {
              provider: params.provider,
              stopReason: result.stopReason,
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              cachedInputTokens: result.usage.cachedInputTokens ?? null,
            });

            const response: RunTurnRpcResult = { ...result, cancelled: controller.signal.aborted };
            return response;
          } catch (error) {
            if (error instanceof AgencyError && error.code === ErrorCode.CONTEXT_OVERFLOW) {
              // The loop throws before pushing any assistant message, so the
              // input session is the full message list. Report the overflow as
              // a result instead of an RPC error: the caller owns the
              // SessionStore and is the one who can compact and retry.
              logger.warn("context overflow — client should compact and retry", {
                turnId: params.turnId,
                provider: params.provider,
                model: params.model,
              });
              const response: RunTurnRpcResult = {
                messages: params.session,
                stopReason: "error",
                usage: { inputTokens: 0, outputTokens: 0 },
                budgetExceeded: false,
                cancelled: controller.signal.aborted,
                needsCompaction: true,
              };
              return response;
            }
            logger.error("turn failed", {
              turnId: params.turnId,
              error: error instanceof Error ? error.message : String(error),
            });
            telemetry.recordCrash("run_turn", error);
            throw error;
          } finally {
            activeControllers.delete(params.turnId);
          }
        });
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
      await builtins?.dispose();
      await server.close();
    },
  };
}
