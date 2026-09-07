import { estimateTokens } from "@agency/providers";
import { appendTeamProtocol, resolveFamilyPrompt } from "../prompt/compose.ts";

export type LayerId = "L0" | "L1" | "L2" | "L3" | "L4" | "L5" | "L6" | "L7";

// Per-layer token ceilings, asserted in CI so prompt detail
// stays measurable instead of drifting upward unnoticed.
export const LAYER_BUDGETS: Record<LayerId, number> = {
  L0: 800,
  L1: 1200,
  L2: 900,
  L3: 1500,
  L4: 1200,
  L5: 2500,
  L6: 1200,
  L7: 800,
};

// The playbook is the shared L2 block: one text, byte-identical
// for every agent on the team, hence cached once and read often.
export const PLAYBOOK = [
  "Playbook: claim one item before acting; accept, decline with reason,",
  "counter with a narrower scope, or escalate with a question.",
  "Delegate only when you lack the skill or tool, when parallel work is",
  "in flight, or when the specialist costs clearly less; else do it inline.",
  "Propose choices to the log and read it before acting; clashes settle",
  "at the lead. Report files touched, verification, choices, and open",
  "questions. Stay inside your item scope. Never merge another tree.",
].join("\n");

export interface TeamPromptInput {
  goal: string;
  roster: string;
  ownersSummary: string;
  workspaceTexts: string[];
  family: string;
  role: string;
  builtInRolePrompt: string;
  agentBody?: string;
  replaceRole?: boolean;
  toolDescriptions: string[];
  itemContract?: string;
  decisions: string[];
  claimedItems: string[];
  inbox: string[];
  digest: string[];
  environment?: string;
}

export interface TeamPrompt {
  text: string;
  prefix: string;
  tail: string;
  layers: Record<LayerId, string>;
  over: LayerId[];
  segments: Array<{ stability: "shared" | "agent" | "dynamic"; text: string }>;
}

// Agent-file bodies extend the built-in role prompt by default;
// a frontmatter replace flag swaps it out fully instead.
export function resolveRolePrompt(builtIn: string, body: string | undefined, replace: boolean): string {
  if (body === undefined || body.trim().length === 0) return builtIn;
  if (replace) return body;
  return `${builtIn}\n\n${body}`;
}

export function checkLayerBudgets(layers: Record<LayerId, string>): LayerId[] {
  const over: LayerId[] = [];
  for (const [layer, text] of Object.entries(layers) as Array<[LayerId, string]>) {
    if (estimateTokens(text) > LAYER_BUDGETS[layer]) over.push(layer);
  }
  return over;
}

// Detail lives in the prefix, brevity in the tail: L0 to L6 are
// stable per agent turn, L7 carries inbox, digest, and env only.
export function buildTeamPrompt(input: TeamPromptInput): TeamPrompt {
  const rolePrompt = resolveRolePrompt(input.builtInRolePrompt, input.agentBody, input.replaceRole ?? false);
  const layers: Record<LayerId, string> = {
    L0: "Agency team agent. Follow the playbook, stay in scope, report lean.",
    L1: [`Goal: ${input.goal}`, `Roster: ${input.roster}`, `Owners: ${input.ownersSummary}`].join("\n"),
    L2: PLAYBOOK,
    L3: input.workspaceTexts.join("\n\n"),
    L4: [resolveFamilyPrompt(input.family, input.role), rolePrompt, appendTeamProtocol(input.role)]
      .filter((part) => part.length > 0)
      .join("\n\n"),
    L5: input.toolDescriptions.join("\n"),
    L6: [
      ...(input.itemContract === undefined ? [] : [`Item: ${input.itemContract}`]),
      ...(input.decisions.length > 0 ? [`Choices:\n${input.decisions.join("\n")}`] : []),
      ...(input.claimedItems.length > 0 ? [`Claimed:\n${input.claimedItems.join("\n")}`] : []),
    ].join("\n\n"),
    L7: [...input.inbox, ...input.digest, ...(input.environment ? [input.environment] : [])].join("\n"),
  };
  const prefix = (["L0", "L1", "L2", "L3", "L4", "L5", "L6"] as LayerId[])
    .map((layer) => layers[layer])
    .filter((text) => text.length > 0)
    .join("\n\n");
  const tail = layers.L7;
  const text = tail.length > 0 ? `${prefix}\n\n${tail}` : prefix;
  const segments = [
    { stability: "shared" as const, text: [layers.L0, layers.L1, layers.L2].join("\n\n") },
    { stability: "shared" as const, text: layers.L3 },
    { stability: "agent" as const, text: [layers.L4, layers.L5].join("\n\n") },
    { stability: "dynamic" as const, text: [layers.L6, layers.L7].join("\n\n") },
  ];
  return { text, prefix, tail, layers, over: checkLayerBudgets(layers), segments };
}

// Flags 5-word phrases shared between prompt text and tool
// descriptions so policy and mechanics never repeat each other.
export function auditPromptToolOverlap(promptText: string, tools: readonly string[]): string[] {
  const phrases = (text: string): Set<string> => {
    const words = text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 0);
    const out = new Set<string>();
    for (let i = 0; i + 5 <= words.length; i++) out.add(words.slice(i, i + 5).join(" "));
    return out;
  };
  const promptPhrases = phrases(promptText);
  const hits = new Set<string>();
  for (const tool of tools) {
    for (const phrase of phrases(tool)) {
      if (promptPhrases.has(phrase)) hits.add(phrase);
    }
  }
  return [...hits].sort();
}
