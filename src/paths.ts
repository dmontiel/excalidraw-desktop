// Path helpers for links between diagrams. Paths are compared with forward
// slashes; Windows drive letters are matched case-insensitively.

const segs = (p: string) => p.replace(/\\/g, "/").split("/");
export const isAbsolutePath = (p: string) => /^([a-zA-Z]:)?[\\/]/.test(p) || /^[a-zA-Z]:$/.test(p);
const sameSeg = (a: string, b: string) => a === b || (/^[a-zA-Z]:$/.test(a) && a.toLowerCase() === b.toLowerCase());

// Collapse "." and ".." segments
function normalize(parts: string[]) {
  const out: string[] = [];
  for (const s of parts) {
    if (s === "." || (s === "" && out.length)) continue;
    if (s === ".." && out.length && out[out.length - 1] !== "..") out.pop();
    else out.push(s);
  }
  return out.join("/");
}

// Link target as stored in an element: relative to fromDir when both share a root
export function relativePath(fromDir: string, target: string) {
  const a = segs(fromDir).filter((s, i) => s || i === 0);
  const b = segs(target);
  if (!sameSeg(a[0], b[0])) return b.join("/"); // different drive: keep absolute
  let i = 0;
  while (i < a.length && i < b.length - 1 && sameSeg(a[i], b[i])) i++;
  const up = a.length - i;
  return [...(up ? Array(up).fill("..") : ["."]), ...b.slice(i)].join("/");
}

// Resolve a stored link against the directory of the file that contains it
export function resolvePath(fromDir: string, link: string) {
  const l = decodeURI(
    link
      .replace(/^file:\/\//i, "") // file:///C:/x -> /C:/x, file:///home/x -> /home/x
      .replace(/^\/([a-zA-Z]:)/, "$1")
      .replace(/[?#].*$/, "")
  );
  return normalize(isAbsolutePath(l) ? segs(l) : [...segs(fromDir), ...segs(l)]);
}

export const isDiagramLink = (link: string) =>
  !/^[a-z][a-z0-9+.-]+:\/\//i.test(link.replace(/^file:\/\//i, "")) &&
  /\.excalidraw$/i.test(link.replace(/[?#].*$/, ""));
