// Run: bun src/paths.check.ts
import { relativePath, resolvePath, isDiagramLink } from "./paths.ts";

const eq = (a: unknown, b: unknown) => {
  if (a !== b) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};

eq(relativePath("C:/d/Diagrams/Data", "C:/d/Diagrams/Data/AWS.excalidraw"), "./AWS.excalidraw");
eq(relativePath("C:\\d\\Diagrams\\Data", "C:/d/Diagrams/Agents/Overview.excalidraw"), "../Agents/Overview.excalidraw");
eq(relativePath("c:/d/x", "C:/d/x/y/z.excalidraw"), "./y/z.excalidraw");
eq(relativePath("C:/a", "D:/b/c.excalidraw"), "D:/b/c.excalidraw");
eq(relativePath("/home/u/a/b", "/home/u/c.excalidraw"), "../../c.excalidraw");

eq(resolvePath("C:/d/Diagrams/Data", "../Agents/Overview.excalidraw"), "C:/d/Diagrams/Agents/Overview.excalidraw");
eq(resolvePath("C:\\d\\Data", "./AWS.excalidraw"), "C:/d/Data/AWS.excalidraw");
eq(resolvePath("C:/a", "D:/b/c.excalidraw"), "D:/b/c.excalidraw");
eq(resolvePath("C:/a", "file:///C:/b/My%20Diagram.excalidraw"), "C:/b/My Diagram.excalidraw");
eq(resolvePath("/home/u/a", "../c.excalidraw#frame"), "/home/u/c.excalidraw");
eq(resolvePath("C:/a", "file:///home/u/c.excalidraw"), "/home/u/c.excalidraw");

eq(isDiagramLink("../Agents/Overview.excalidraw"), true);
eq(isDiagramLink("C:/x/y.excalidraw"), true);
eq(isDiagramLink("https://excalidraw.com/x.excalidraw"), false);
eq(isDiagramLink("https://example.com"), false);
eq(isDiagramLink("notes.md"), false);

console.log("paths: all checks passed");
