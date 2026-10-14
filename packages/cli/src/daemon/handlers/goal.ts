import {
  askModel,
  GOAL_JUDGE_PROMPT,
  getSessionGoal,
  goalNotMetMessage,
  HookBlock,
  parseGoalVerdict,
  renderTranscript,
} from "@agency/core";
import type { DaemonContext } from "../types.ts";

/** How many of the newest messages the judge reads. */
const JUDGE_MESSAGES = 30;

/** Sets the goal of a session. An empty goal clears it. */
export async function setSessionGoal(ctx: DaemonContext, sessionId: string, goal: string): Promise<void> {
  const store = ctx.todoStore;
  if (!store.list().includes(sessionId)) store.create(sessionId);
  const parentId = store.latestTip(store.load(sessionId)) ?? null;
  await store.append(sessionId, { type: "session_goal", parentId, goal });
}

/** A turn of a session with a goal ends only when the model of that turn judges the goal met. */
export function registerGoalCheck(ctx: DaemonContext): void {
  ctx.eventBus.on("turn.stop", async (payload) => {
    const p = payload as { sessionId?: string; turnId?: string; taskDepth: number };
    if (p.sessionId === undefined || p.turnId === undefined || p.taskDepth > 0) return;
    const store = ctx.todoStore;
    const entries = store.load(p.sessionId);
    const goal = getSessionGoal(entries);
    const meta = ctx.activeTurnMeta.get(p.turnId);
    if (goal === undefined || meta === undefined) return;
    const tip = store.latestTip(entries);
    const messages = tip === undefined ? [] : store.messagesFor(entries, tip);
    const reply = await askModel(
      { adapter: ctx.adapterFor(meta.provider), http: ctx.http, model: meta.model, apiKey: meta.apiKey },
      GOAL_JUDGE_PROMPT,
      `Goal: ${goal}\n\nTranscript, newest last:\n${renderTranscript(messages.slice(-JUDGE_MESSAGES))}`,
    );
    const verdict = reply === undefined ? undefined : parseGoalVerdict(reply);
    // No verdict is not a refusal: a judge that fails must not hold the turn.
    if (verdict === undefined) return;
    if (verdict.met) {
      await setSessionGoal(ctx, p.sessionId, "");
      return;
    }
    throw new HookBlock(goalNotMetMessage(goal, verdict.reason));
  });
}
