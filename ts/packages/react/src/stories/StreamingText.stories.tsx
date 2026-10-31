import type { Story, StoryDefault } from "@ladle/react";
import { useEffect, useState } from "react";
import { StreamingText } from "../components/StreamingText.js";
import { fixtures } from "./fixtures.js";

export default { title: "StreamingText" } satisfies StoryDefault;

// The longest reply in the fixtures.
const reply = Object.values(fixtures)
  .flat()
  .flatMap((e) => (e.type === "item.updated" && typeof e.patch.text === "string" ? [e.patch.text] : []))
  .reduce((a, b) => (b.length > a.length ? b : a), "");
const text = `${reply}\n\nIt goes on in a second paragraph, so each delta lays out only the last one.\n\nAnd a third, for good measure.`;

/** Text growing a word at a time, as deltas bring it. */
export const Streaming: Story = () => {
  const [n, setN] = useState(0);
  const words = text.match(/\S+\s*|\s+/g) ?? [];
  useEffect(() => {
    const t = setInterval(() => setN((k) => (k >= words.length ? 0 : k + 1)), 80);
    return () => clearInterval(t);
  }, [words.length]);
  return (
    <div className="at-root" style={{ maxWidth: "40rem" }}>
      <StreamingText text={words.slice(0, n).join("")} />
    </div>
  );
};
