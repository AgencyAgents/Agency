import type { SessionEntry } from "./entry.ts";

/** The condition that a session must meet before a turn can end: the newest goal entry. An empty one is a cleared goal. */
export function getSessionGoal(entries: SessionEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === "session_goal" && typeof entry.goal === "string") return entry.goal || undefined;
  }
  return undefined;
}

export const GOAL_JUDGE_PROMPT =
  "You check whether an agent has met a goal. You get the goal and the newest part of the agent's transcript.\n" +
  "Reply with one line and nothing else:\n" +
  "MET\n" +
  "when the transcript shows that the goal is met, or\n" +
  "NOT MET: <what is still missing, in one sentence>\n" +
  "when it does not.\n" +
  "Judge from evidence in the transcript, such as tool results and command output. " +
  "A statement by the agent with no evidence is not enough.";

/** Undefined when the reply is not a verdict: the caller must not act on it. */
export function parseGoalVerdict(reply: string): { met: boolean; reason: string } | undefined {
  const match = /^\W*(not\s+met|met)\b[\s:.-]*(.*)/is.exec(reply.trim());
  if (!match) return undefined;
  return { met: match[1]?.toLowerCase() === "met", reason: (match[2] ?? "").trim() };
}

/** The message that the model gets when its turn ends with the goal not met. */
export function goalNotMetMessage(goal: string, reason: string): string {
  return `The goal of this session is not met yet${reason ? `: ${reason}` : "."}\nGoal: ${goal}\nContinue the work. Do not stop before the goal is met.`;
}
