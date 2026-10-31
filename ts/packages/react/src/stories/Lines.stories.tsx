import type { Story, StoryDefault } from "@ladle/react";
import type { Compaction, Notice as NoticeItem, TurnResult as TurnResultItem } from "@dire-kiwi/agent-threads-protocol";
import type { ReactNode } from "react";
import { CompactionLine, Notice, TurnResult } from "../components/Lines.js";
import { allItems } from "./fixtures.js";

export default { title: "Lines" } satisfies StoryDefault;

const Column = ({ children }: { children: ReactNode }) => (
  <div className="at-root" style={{ maxWidth: "48rem", display: "flex", flexDirection: "column", gap: 16 }}>
    {children}
  </div>
);

const Label = ({ children }: { children: ReactNode }) => <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 4 }}>{children}</div>;

/** The compactions in the fixtures, and one with its summary (click it). */
export const Compactions: Story = () => {
  const found = allItems.filter((x): x is { fixture: string; item: Compaction } => x.item.type === "compaction");
  const withSummary: Compaction = { id: "c", type: "compaction", trigger: "auto", tokens_before: 182_400, summary: "The user asked for a **rename** across the repo.\n\nDone so far: `src/a.ts` and `src/b.ts`." };
  return (
    <Column>
      {found.map(({ fixture, item }) => (
        <div key={fixture}>
          <Label>{fixture}</Label>
          <CompactionLine item={item} />
        </div>
      ))}
      <Label>automatic, with a summary</Label>
      <CompactionLine item={withSummary} />
    </Column>
  );
};

/** Each way a turn ends in the fixtures: done, interrupted and failed. */
export const TurnResults: Story = () => {
  const seen = new Set<string>();
  const found = allItems.filter((x): x is { fixture: string; item: TurnResultItem } => {
    if (x.item.type !== "turn_result") return false;
    const kind = `${x.fixture.split("/")[0]}:${x.item.interrupted ? "interrupted" : x.item.ok ? "ok" : "error"}`;
    if (seen.has(kind)) return false;
    seen.add(kind);
    return true;
  });
  return (
    <Column>
      {found.map(({ fixture, item }) => (
        <div key={fixture + item.id}>
          <Label>{fixture}</Label>
          <TurnResult item={item} />
        </div>
      ))}
    </Column>
  );
};

/** The notices in the fixtures, and one of each level (the error's detail opens). */
export const Notices: Story = () => {
  const found = allItems.filter((x): x is { fixture: string; item: NoticeItem } => x.item.type === "notice");
  const made: NoticeItem[] = [
    { id: "n1", type: "notice", level: "info", code: "run.reattached", text: "Picked the run up again after a restart" },
    { id: "n2", type: "notice", level: "warning", code: "retry", text: "The API was overloaded; retrying in 4s" },
    { id: "n3", type: "notice", level: "error", code: "stderr", text: "The harness wrote to stderr", detail: "Error: ENOENT: no such file or directory, open '/work/missing.txt'\n    at open (node:fs:573:3)" },
  ];
  return (
    <Column>
      {found.map(({ fixture, item }) => (
        <div key={fixture + item.id}>
          <Label>{fixture}</Label>
          <Notice item={item} />
        </div>
      ))}
      {made.map((item) => (
        <div key={item.id}>
          <Label>{item.level}</Label>
          <Notice item={item} />
        </div>
      ))}
    </Column>
  );
};
