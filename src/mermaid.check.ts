// Run: bun src/mermaid.check.ts
import { repairFlowchart } from "./mermaid.ts";

const eq = (a: unknown, b: unknown) => {
  if (a !== b) throw new Error(`expected\n${b}\ngot\n${a}`);
};

// the failing case from the learner-journey image
eq(
  repairFlowchart(
    [
      "flowchart LR",
      "    A[New engineer] --> B[Local_Path]",
      "    E --> F[Skills_Matrix coverage + gaps]",
      "    B -.->|local build guides (optional capstone on the local stack)|",
    ].join("\n")
  ),
  ["flowchart LR", "    A[New engineer] --> B[Local_Path]", "    E --> F[Skills_Matrix coverage + gaps]"].join("\n")
);

eq(repairFlowchart("flowchart TD\n  A -->|uses (cache)| B"), "flowchart TD\n  A -->|uses, cache| B");
eq(repairFlowchart("graph TD\n  A[API (v2)] --> B"), "graph TD\n  A[API, v2] --> B");
eq(repairFlowchart("graph TD\n  D[(Postgres)] --> E([Done])"), "graph TD\n  D[(Postgres)] --> E([Done])");
eq(repairFlowchart("graph TD\n  A -->"), "graph TD");
// non-flowcharts are left alone
eq(repairFlowchart("classDiagram\n  class A {\n    +run(x)\n  }"), "classDiagram\n  class A {\n    +run(x)\n  }");

console.log("mermaid: all checks passed");
