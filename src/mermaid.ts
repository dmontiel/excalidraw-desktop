// Text clean-up for model-written Mermaid, applied before parsing. Models
// regularly emit syntax the parser rejects; fixing the common cases here is
// cheaper than a second round-trip to the model.

export const stripFences = (s: string) =>
  s.replace(/^\s*```(?:mermaid)?\s*/i, "").replace(/```\s*$/, "").trim();

// In-label line breaks (<br>, literal \n / \r) render as literal text. Real
// newlines separate statements, so they stay.
export const stripBreaks = (s: string) =>
  s.replace(/<br\s*\/?>/gi, " ").replace(/\\[nr]/g, " ");

// "guides (optional, local)" -> "guides, optional, local": parentheses inside a
// label are shape syntax to the flowchart parser
const cleanLabel = (t: string) =>
  t
    .replace(/\s*\(\s*/g, ", ")
    .replace(/\s*\)\s*/g, " ")
    .replace(/^[,\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();

const EDGE = /(-->|-\.->|==>|---|-\.-|===|--[ox]|<-->)/;

// Flowchart-only repairs (sequence/class diagrams use () and [] legitimately)
export function repairFlowchart(src: string) {
  if (!/^\s*(flowchart|graph)\b/.test(src)) return src;
  return src
    .split("\n")
    .filter((line) => {
      // drop edges that never reach a target node: "B -.->|label|" or "B -->"
      const t = line.trim();
      return !(EDGE.test(t) && new RegExp(`${EDGE.source}\\s*(\\|[^|]*\\|)?\\s*$`).test(t));
    })
    .map((line) =>
      line
        // edge labels: -->|text|
        .replace(/\|([^|\n]*)\|/g, (_, t) => `|${cleanLabel(t)}|`)
        // node labels: id[text], keeping shape brackets like [(db)] and ([pill])
        .replace(/\[(\(?)([^\]\n]*?)(\)?)\]/g, (_, open, t, close) =>
          open && close ? `[(${cleanLabel(t)})]` : `[${cleanLabel(open + t + close)}]`
        )
    )
    .join("\n");
}
