// "Edit with AI": the model sees the selection as compact JSON and replies with
// a small set of operations, which are applied in place so layout and styling
// the user tuned by hand survive (regenerating via Mermaid would lose both).
import {
  convertToExcalidrawElements,
  newElementWith,
  restoreElements,
} from "@excalidraw/excalidraw";
import type {
  ExcalidrawElement,
  ExcalidrawTextElement,
} from "@excalidraw/excalidraw/element/types";

type El = ExcalidrawElement;

export const EDIT_SYSTEM_PROMPT = `You edit an existing Excalidraw diagram.
You receive the user's request and the current elements as JSON:
- shapes: {id, type: rectangle|ellipse|diamond|text|other, x, y, w, h, text?, bg?, stroke?}
- arrows: {id, from?, to?, text?, stroke?}  (from/to are shape ids)
Coordinates are pixels; y grows downward.
Reply with ONLY a JSON object, no code fences, using any of these keys:
{"update": [{"id", "text"?, "bg"?, "stroke"?, "x"?, "y"?, "w"?, "h"?}],
 "delete": ["id"],
 "add": [{"ref", "type": "rectangle|ellipse|diamond|text", "x", "y", "w"?, "h"?, "text", "bg"?, "stroke"?}],
 "connect": [{"from", "to", "text"?}]}
Rules:
- Change only what the request needs. Leave every other element untouched.
- "ref" is your own short name for a new shape; connect.from/to accept existing ids or refs.
- Place new shapes next to the shapes they relate to, aligned with the existing layout, sized like their neighbours (about 180x70 if unsure). Never overlap existing shapes, and keep at least 60px between connected shapes so arrows are visible.
- When inserting between shapes that are too close, move the shapes on one side (update their x/y) to make room.
- To move or resize a shape, update its x/y/w/h; attached arrows follow automatically.
- Arrows can be updated (text, stroke) or deleted by id. To redirect an arrow, delete it and connect again.
- Colors are hex strings. Prefer the Excalidraw palette. Fills: red #ffc9c9, orange #ffd8a8, yellow #ffec99, green #b2f2bb, teal #96f2d7, blue #a5d8ff, violet #d0bfff, pink #eebefa, gray #e9ecef. Strokes: red #e03131, orange #f08c00, green #2f9e44, blue #1971c2, violet #6741d9, black #1e1e1e.
- Keep labels short.`;

const SHAPES = new Set(["rectangle", "ellipse", "diamond"]);
const MAX_ELEMENTS = 400;

const live = (all: readonly El[]) => all.filter((e) => !e.isDeleted);

const boundTextIn = (e: El, els: Map<string, El>) => {
  const ref = e.boundElements?.find((b) => b.type === "text");
  const t = ref && els.get(ref.id);
  return t && t.type === "text" && !t.isDeleted ? t : undefined;
};

// The selection (or the whole scene when nothing is selected) as model input
export function describeScene(all: readonly El[], selected: Readonly<Record<string, true>>) {
  const els = new Map(live(all).map((e) => [e.id, e]));
  let scope = [...els.values()].filter((e) => selected[e.id]);
  if (!scope.length) scope = [...els.values()];
  const r = Math.round;
  const shapes: object[] = [];
  const arrows: object[] = [];
  for (const e of scope) {
    if (e.type === "text" && e.containerId) continue; // folded into its container
    if (e.type === "arrow" || e.type === "line") {
      arrows.push({
        id: e.id,
        from: e.startBinding?.elementId,
        to: e.endBinding?.elementId,
        text: boundTextIn(e, els)?.originalText,
        stroke: e.strokeColor,
      });
      continue;
    }
    shapes.push({
      id: e.id,
      type: SHAPES.has(e.type) || e.type === "text" ? e.type : "other",
      x: r(e.x),
      y: r(e.y),
      w: r(e.width),
      h: r(e.height),
      text: e.type === "text" ? e.originalText : boundTextIn(e, els)?.originalText,
      bg: e.backgroundColor === "transparent" ? undefined : e.backgroundColor,
      stroke: e.strokeColor,
    });
  }
  return {
    scope: new Set(scope.map((e) => e.id)),
    count: shapes.length + arrows.length,
    tooBig: shapes.length + arrows.length > MAX_ELEMENTS,
    json: JSON.stringify({ shapes, arrows }),
  };
}

interface Ops {
  update?: { id: string; text?: string; bg?: string; stroke?: string; x?: number; y?: number; w?: number; h?: number }[];
  delete?: string[];
  add?: { ref: string; type: string; x: number; y: number; w?: number; h?: number; text?: string; bg?: string; stroke?: string }[];
  connect?: { from: string; to: string; text?: string }[];
}

// Tolerates code fences and chatter around the JSON object
export function parseOps(text: string): Ops {
  const s = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const o = JSON.parse(s);
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  return { update: arr(o.update), delete: arr(o.delete), add: arr(o.add), connect: arr(o.connect) };
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const color = (v: unknown) => (typeof v === "string" && /^#[0-9a-f]{3,8}$/i.test(v) ? v : undefined);
const uid = () => "ai" + Math.random().toString(36).slice(2, 12);

// Where the line from e's center toward (tx, ty) leaves e's outline, plus a gap
function border(e: El, tx: number, ty: number, gap = 6): [number, number] {
  const cx = e.x + e.width / 2;
  const cy = e.y + e.height / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  const len = Math.hypot(dx, dy);
  if (!len) return [cx, cy];
  const a = e.width / 2 || 1;
  const b = e.height / 2 || 1;
  const s =
    e.type === "ellipse"
      ? 1 / Math.hypot(dx / a, dy / b)
      : e.type === "diamond"
        ? 1 / (Math.abs(dx) / a + Math.abs(dy) / b)
        : Math.min(a / Math.abs(dx || 1e-9), b / Math.abs(dy || 1e-9));
  const k = s + gap / len;
  return [cx + dx * k, cy + dy * k];
}

function arrowGeometry(from: El, to: El) {
  const [sx, sy] = border(from, to.x + to.width / 2, to.y + to.height / 2);
  const [ex, ey] = border(to, from.x + from.width / 2, from.y + from.height / 2);
  return { x: sx, y: sy, dx: ex - sx, dy: ey - sy };
}

export function applyEdit(all: readonly El[], ops: Ops, scope: Set<string>): { elements: El[]; changed: number } {
  const els = new Map(all.map((e) => [e.id, e]));
  let changed = 0;
  const set = (e: El, patch: object) => {
    const n = newElementWith(e as never, patch as never) as El;
    els.set(e.id, n);
    changed++;
    return n;
  };
  const get = (id: string) => {
    const e = els.get(id);
    return e && !e.isDeleted ? e : undefined;
  };
  const inScope = (id: string) => scope.has(id) && !!get(id);
  const textsToRefresh = new Set<string>(); // text elements whose content changed
  const reflow = new Set<string>(); // shapes moved/resized/relabelled: re-center labels, re-route arrows

  // ---- delete (a shape takes its label and attached arrows with it)
  const del = (id: string) => {
    const e = get(id);
    if (!e) return;
    set(e, { isDeleted: true });
    for (const b of e.boundElements ?? []) del(b.id);
  };
  for (const id of ops.delete ?? []) if (typeof id === "string" && inScope(id)) del(id);

  // ---- update
  const newLabels: [string, string][] = [];
  for (const u of ops.update ?? []) {
    if (!u || typeof u.id !== "string" || !inScope(u.id)) continue;
    let e = get(u.id)!;
    const patch: Record<string, unknown> = {};
    const bg = color(u.bg);
    if (bg) {
      patch.backgroundColor = bg;
      if (e.backgroundColor === "transparent") patch.fillStyle = "solid";
    }
    if (color(u.stroke)) patch.strokeColor = color(u.stroke);
    const isLinear = e.type === "arrow" || e.type === "line";
    if (!isLinear) {
      for (const [k, key] of [["x", "x"], ["y", "y"], ["w", "width"], ["h", "height"]] as const) {
        const v = num(u[k]);
        if (v !== undefined && (key === "x" || key === "y" || v > 4)) patch[key] = v;
      }
    }
    if (Object.keys(patch).length) {
      e = set(e, patch);
      if (["x", "y", "width", "height"].some((k) => k in patch)) reflow.add(e.id);
    }
    if (typeof u.text === "string") {
      const t = e.type === "text" ? e : boundTextIn(e, els);
      if (t) {
        set(t, { text: u.text, originalText: u.text });
        textsToRefresh.add(t.id);
        if (t.containerId) reflow.add(t.containerId);
      } else if (SHAPES.has(e.type) || e.type === "arrow") {
        newLabels.push([e.id, u.text]);
      }
    }
  }

  // ---- add + connect + new labels go through Excalidraw's own converter. Existing
  // endpoints are passed as same-id stand-ins so it computes bindings and labels;
  // the stand-ins themselves are thrown away afterwards.
  const batch: Record<string, unknown>[] = [];
  const standIns = new Map<string, Record<string, unknown>>();
  const standIn = (id: string) => {
    let s = standIns.get(id);
    if (!s) {
      const e = get(id)!;
      s = {
        type: SHAPES.has(e.type) || e.type === "arrow" ? e.type : "rectangle",
        id,
        x: e.x,
        y: e.y,
        width: e.width,
        height: e.height,
        strokeColor: e.strokeColor,
      };
      if (e.type === "arrow") s.points = (e as never as { points: unknown }).points;
      standIns.set(id, s);
      batch.push(s);
    }
    return s;
  };
  for (const [id, text] of newLabels) standIn(id).label = { text };

  // New shapes copy the look of the existing ones (roundness, sloppiness, font)
  const model = [...scope].map(get).find((e) => e && SHAPES.has(e.type));
  const modelText = model && boundTextIn(model, els);
  const look: Record<string, unknown> = model
    ? {
        roundness: model.roundness,
        roughness: model.roughness,
        strokeWidth: model.strokeWidth,
        strokeStyle: model.strokeStyle,
        strokeColor: model.strokeColor,
      }
    : {};
  const font = modelText ? { fontFamily: modelText.fontFamily, fontSize: modelText.fontSize } : {};

  const refs = new Map<string, string>();
  const added = new Map<string, { x: number; y: number; width: number; height: number; type: string }>();
  for (const a of ops.add ?? []) {
    const x = num(a?.x);
    const y = num(a?.y);
    if (!a || x === undefined || y === undefined) continue;
    const id = uid();
    if (typeof a.ref === "string") refs.set(a.ref, id);
    const style: Record<string, unknown> = {};
    if (color(a.stroke)) style.strokeColor = color(a.stroke);
    const text = typeof a.text === "string" ? a.text : "";
    if (a.type === "text") {
      batch.push({ type: "text", id, x, y, text: text || " ", ...font, ...style });
      added.set(id, { x, y, width: 100, height: 25, type: "text" });
      continue;
    }
    if (color(a.bg)) Object.assign(style, { backgroundColor: color(a.bg), fillStyle: "solid" });
    const type = SHAPES.has(a.type) ? a.type : "rectangle";
    const width = Math.max(20, num(a.w) ?? 180);
    const height = Math.max(20, num(a.h) ?? 70);
    batch.push({ type, id, x, y, width, height, ...look, ...style, ...(text ? { label: { text, ...font } } : {}) });
    added.set(id, { x, y, width, height, type });
  }

  const endpoint = (r: unknown) => {
    if (typeof r !== "string") return undefined;
    const id = refs.get(r) ?? r;
    if (added.has(id)) return { id, geo: added.get(id)! as never as El };
    const e = get(id);
    if (!e || e.type === "arrow" || e.type === "line") return undefined;
    standIn(id);
    return { id, geo: e };
  };
  for (const c of ops.connect ?? []) {
    const from = endpoint(c?.from);
    const to = endpoint(c?.to);
    if (!from || !to || from.id === to.id) continue;
    const g = arrowGeometry(from.geo, to.geo);
    batch.push({
      type: "arrow",
      id: uid(),
      x: g.x,
      y: g.y,
      width: g.dx || 0.01,
      height: g.dy || 0.01,
      start: { id: from.id },
      end: { id: to.id },
      ...(typeof c.text === "string" && c.text ? { label: { text: c.text } } : {}),
    });
  }

  if (batch.length) {
    const out = convertToExcalidrawElements(batch as never, { regenerateIds: false }) as El[];
    for (const n of out) {
      const real = standIns.has(n.id) ? get(n.id) : undefined;
      if (real) {
        // keep the real element; just merge in the new arrow/label references
        const known = new Set((real.boundElements ?? []).map((b) => b.id));
        const extra = (n.boundElements ?? []).filter((b) => !known.has(b.id));
        if (extra.length) set(real, { boundElements: [...(real.boundElements ?? []), ...extra] });
        if (extra.some((b) => b.type === "text")) reflow.add(real.id);
      } else {
        els.set(n.id, n);
        changed++;
      }
    }
  }

  // ---- re-measure edited text (wraps to its container)
  if (textsToRefresh.size) {
    const subset = [...textsToRefresh].flatMap((id) => {
      const t = els.get(id) as ExcalidrawTextElement;
      const c = t.containerId ? els.get(t.containerId) : undefined;
      return c ? [t, c] : [t];
    });
    for (const r of restoreElements(subset, null, { refreshDimensions: true })) {
      if (r.type === "text" && textsToRefresh.has(r.id)) {
        set(els.get(r.id)!, { text: r.text, width: r.width, height: r.height });
      }
    }
  }

  // ---- labels follow their containers; containers grow to fit taller labels
  for (const id of reflow) {
    let c = get(id);
    if (!c) continue;
    const t = boundTextIn(c, els);
    if (t && SHAPES.has(c.type)) {
      if (t.height + 16 > c.height) c = set(c, { height: t.height + 16 });
      set(t, { x: c.x + (c.width - t.width) / 2, y: c.y + (c.height - t.height) / 2 });
    }
  }

  // ---- arrows attached to moved/resized shapes are re-routed as straight lines
  const rerouted = new Set<string>();
  for (const id of reflow) {
    const c = get(id);
    for (const b of c?.boundElements ?? []) {
      const a = get(b.id);
      if (!a || a.type !== "arrow" || rerouted.has(a.id) || "elbowed" in a && a.elbowed) continue;
      const from = a.startBinding && get(a.startBinding.elementId);
      const to = a.endBinding && get(a.endBinding.elementId);
      if (!from || !to) continue;
      rerouted.add(a.id);
      const g = arrowGeometry(from, to);
      set(a, {
        x: g.x,
        y: g.y,
        points: [[0, 0], [g.dx, g.dy]],
        width: Math.abs(g.dx),
        height: Math.abs(g.dy),
      });
      const t = boundTextIn(a, els);
      if (t) set(t, { x: g.x + g.dx / 2 - t.width / 2, y: g.y + g.dy / 2 - t.height / 2 });
    }
  }

  return { elements: [...els.values()], changed };
}
