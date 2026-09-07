export type ChoiceStatus = "proposed" | "accepted" | "routed-to-lead";

export interface ChoiceEntry {
  id: string;
  topic: string;
  text: string;
  proposedBy: string;
  rationale: string;
  status: ChoiceStatus;
  at: string;
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

// Append-only decision log. Every agent reads it before acting;
// conflicting proposals on one topic route to the lead.
export class ChoiceLog {
  private readonly entries: ChoiceEntry[] = [];
  private seq = 0;

  propose(
    topic: string,
    text: string,
    proposedBy: string,
    rationale = "",
  ): { entry: ChoiceEntry; routed: boolean } {
    if (topic.trim().length === 0) throw new Error("choice topic must be non-empty");
    if (text.trim().length === 0) throw new Error("choice text must be non-empty");
    this.seq += 1;
    const wanted = normalize(text);
    const clash = this.entries.find(
      (e) => normalize(e.topic) === normalize(topic) && normalize(e.text) !== wanted,
    );
    const entry: ChoiceEntry = {
      id: `D-${this.seq}`,
      topic: topic.trim(),
      text: text.trim(),
      proposedBy,
      rationale,
      status: clash ? "routed-to-lead" : "proposed",
      at: new Date().toISOString(),
    };
    this.entries.push(entry);
    return { entry, routed: entry.status === "routed-to-lead" };
  }

  accept(id: string, by: string): { ok: boolean; reason?: string } {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return { ok: false, reason: `unknown choice: ${id}` };
    if (entry.status === "routed-to-lead") {
      if (by !== "lead") return { ok: false, reason: "routed choices settle at the lead only" };
    }
    entry.status = "accepted";
    return { ok: true };
  }

  list(): ChoiceEntry[] {
    return [...this.entries];
  }

  routedToLead(): ChoiceEntry[] {
    return this.entries.filter((e) => e.status === "routed-to-lead");
  }

  // The digest every agent reads before acting: a few lines, not transcripts.
  digest(): string[] {
    return this.entries.map((e) => `${e.id} ${e.text} by @${e.proposedBy} ${e.status}`);
  }
}
