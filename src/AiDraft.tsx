import { useState, useEffect } from "react";
import Anthropic from "@anthropic-ai/sdk";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { convertToExcalidrawElements, CaptureUpdateAction, loadFromBlob } from "@excalidraw/excalidraw";
import type { BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { stripFences, stripBreaks, repairFlowchart } from "./mermaid";
import { EDIT_SYSTEM_PROMPT, describeScene, parseOps, applyEdit } from "./aiEdit";

type Provider = "gemini" | "anthropic";
type Mode = "create" | "edit" | "image";
interface Img {
  mime: string;
  data: string; // base64, no data: prefix
  url: string; // for the preview thumbnail
}

// Phone photos are huge; both providers downscale past ~1.5k px anyway
async function shrinkImage(dataUrl: string, max = 1568): Promise<Img> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.round(img.naturalWidth * k);
  c.height = Math.round(img.naturalHeight * k);
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff"; // transparent PNGs would turn black as JPEG
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const url = c.toDataURL("image/jpeg", 0.9);
  return { mime: "image/jpeg", data: url.slice(url.indexOf(",") + 1), url };
}

const readAsDataUrl = (f: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });

const DEFAULT_MODEL: Record<Provider, string> = {
  gemini: "gemini-3.5-flash-lite",
  anthropic: "claude-haiku-4-5",
};
const KEY_STORAGE: Record<Provider, string> = {
  gemini: "geminiApiKey",
  anthropic: "anthropicApiKey",
};
const MODEL_STORAGE: Record<Provider, string> = {
  gemini: "geminiModel",
  anthropic: "anthropicModel",
};

// API keys live in the OS keychain (Windows/macOS) via Rust commands. On Linux
// those commands error and we fall back to localStorage. loadKey also migrates
// any pre-existing plaintext localStorage key into the keychain, once.
async function loadKey(provider: Provider): Promise<string> {
  try {
    const v = await invoke<string | null>("secret_load", { provider });
    if (v) return v;
    const legacy = localStorage.getItem(KEY_STORAGE[provider]);
    if (legacy) {
      await invoke("secret_store", { provider, key: legacy });
      localStorage.removeItem(KEY_STORAGE[provider]);
      return legacy;
    }
    return "";
  } catch {
    return localStorage.getItem(KEY_STORAGE[provider]) ?? "";
  }
}

async function saveKey(provider: Provider, key: string): Promise<void> {
  try {
    await invoke("secret_store", { provider, key });
  } catch {
    localStorage.setItem(KEY_STORAGE[provider], key);
  }
}

// LLM writes Mermaid, the existing mermaid-to-excalidraw converter does the rest.
// Only flowchart/sequence/class convert to editable shapes; anything else falls
// back to a flat image, so constrain the model to those three.
const SYSTEM_PROMPT =
  "You convert a plain-language description into a Mermaid diagram definition. " +
  "Reply with ONLY valid Mermaid code: no code fences, no commentary, no explanation. " +
  "You MUST use one of exactly these three diagram types, which are the only supported ones: " +
  "a flowchart (start with `flowchart TD` or `graph TD`), a `sequenceDiagram`, or a `classDiagram`. " +
  "Never use any other type (no mindmap, gantt, pie, erDiagram, stateDiagram, journey, etc.); " +
  "if the description doesn't obviously fit sequence or class, use a flowchart. " +
  "Keep node labels short and on a single line: do not use <br> or other HTML tags. " +
  "Do not wrap labels in double quotes; if a label needs quoting, use single quotes. " +
  "Never put parentheses, brackets or braces inside a label (write 'guides, optional' instead of 'guides (optional)'). " +
  "Every arrow must connect two nodes: never leave an arrow without a target.";

const IMAGE_PROMPT =
  " The user attaches an image: a photo of a whiteboard, a hand-drawn sketch, or a screenshot of a diagram. " +
  "Reproduce that diagram faithfully: the same boxes, labels and connections, with the same overall direction " +
  "(use `flowchart LR` when it reads left to right). Ignore anything that isn't part of the diagram.";

const cleanMermaid = (s: string) => repairFlowchart(stripBreaks(stripFences(s)));

// Excalidraw's own PNG/SVG exports can carry the original drawing; when they
// do, insert it exactly instead of asking a model to guess it from pixels.
type EmbeddedScene = { elements: readonly ExcalidrawElement[]; files: BinaryFiles };
async function embeddedScene(blob: Blob): Promise<EmbeddedScene | null> {
  try {
    const scene = await loadFromBlob(blob, null, null);
    const elements = scene.elements.filter((e) => !e.isDeleted);
    return elements.length ? { elements, files: scene.files ?? {} } : null;
  } catch {
    return null; // plain image
  }
}

// Fresh ids so a pasted copy never collides with elements already on the canvas
function withNewIds(elements: readonly ExcalidrawElement[]): ExcalidrawElement[] {
  const ids = new Map(elements.map((e) => [e.id, Math.random().toString(36).slice(2, 12)]));
  const map = (id: string | null | undefined) => (id ? ids.get(id) ?? id : id);
  return elements.map((e) => {
    const n: Record<string, unknown> = { ...e, id: ids.get(e.id) };
    if ("containerId" in e) n.containerId = map(e.containerId);
    if (e.boundElements) n.boundElements = e.boundElements.map((b) => ({ ...b, id: map(b.id)! }));
    if (e.frameId) n.frameId = map(e.frameId);
    for (const k of ["startBinding", "endBinding"]) {
      const bind = (e as never as Record<string, { elementId: string } | null>)[k];
      if (bind) n[k] = { ...bind, elementId: map(bind.elementId) };
    }
    return n as never as ExcalidrawElement;
  });
}

// Guard against the converter's silent image fallback: only these lead keywords
// produce editable Excalidraw shapes.
const SUPPORTED = /^\s*(flowchart|graph|sequenceDiagram|classDiagram)\b/;
const isSupportedMermaid = (m: string) => SUPPORTED.test(m);

// Keys only ever go to the provider's official endpoint; the app's CSP
// (tauri.conf.json connect-src) blocks requests to any other host.
async function callModel(
  provider: Provider,
  key: string,
  model: string,
  system: string,
  prompt: string,
  image?: Img,
  json = false
): Promise<string> {
  if (provider === "gemini") {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: [
            {
              parts: [
                ...(image ? [{ inline_data: { mime_type: image.mime, data: image.data } }] : []),
                { text: prompt },
              ],
            },
          ],
          ...(json ? { generationConfig: { responseMimeType: "application/json" } } : {}),
        }),
      }
    );
    if (!res.ok) {
      const detail = (await res.json().catch(() => null))?.error?.message ?? "";
      if (res.status === 400 || res.status === 403)
        throw new Error("Invalid API key.");
      if (res.status === 429)
        throw new Error(
          `Quota exhausted for "${model}" (free-tier limits are per-model). ` +
            `Switch to a different model above, or wait for the quota to reset.`
        );
      throw new Error(
        `Gemini API error ${res.status}${detail ? `: ${detail}` : ""}`
      );
    }
    const data = await res.json();
    const parts: Array<{ text?: string }> =
      data.candidates?.[0]?.content?.parts ?? [];
    return parts.map((p) => p.text ?? "").join("");
  }

  try {
    const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
    const response = await client.messages.create({
      model,
      max_tokens: 8192,
      system,
      messages: [
        {
          role: "user",
          content: [
            ...(image
              ? [
                  {
                    type: "image" as const,
                    source: { type: "base64" as const, media_type: "image/jpeg" as const, data: image.data },
                  },
                ]
              : []),
            { type: "text" as const, text: prompt },
          ],
        },
      ],
    });
    return response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError)
      throw new Error("Invalid API key.");
    if (err instanceof Anthropic.RateLimitError)
      throw new Error(
        `Quota or rate limit reached for "${model}". ` +
          `Switch to a different model above, or wait a moment.`
      );
    if (err instanceof Anthropic.APIError)
      throw new Error(`API error ${err.status}: ${err.message}`);
    throw err;
  }
}

export default function AiDraft({
  api,
  onClose,
}: {
  api: ExcalidrawImperativeAPI;
  onClose: () => void;
}) {
  // Always open on Gemini (the free default); key/model are still remembered per provider
  const [provider, setProvider] = useState<Provider>("gemini");
  // Key loads async from the keychain; model stays in localStorage (not secret)
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(
    () =>
      localStorage.getItem(MODEL_STORAGE[provider]) ?? DEFAULT_MODEL[provider]
  );
  const [prompt, setPrompt] = useState("");
  // Open in the mode the selection suggests: an image -> convert it, shapes -> edit them
  const [initial] = useState(() => {
    const st = api.getAppState();
    const sel = api.getSceneElements().filter((e) => st.selectedElementIds[e.id]);
    const img = sel.length === 1 && sel[0].type === "image" ? sel[0] : null;
    return { count: sel.length, img };
  });
  const [mode, setMode] = useState<Mode>(
    initial.img ? "image" : initial.count ? "edit" : "create"
  );
  const [image, setImage] = useState<Img | null>(null);
  const [embedded, setEmbedded] = useState<EmbeddedScene | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the saved key for the current provider (keychain, localStorage on Linux).
  // Guard against a stale async result overwriting a newer provider's key.
  useEffect(() => {
    let active = true;
    loadKey(provider).then((k) => active && setApiKey(k));
    return () => {
      active = false;
    };
  }, [provider]);

  // Seed the image from the selected canvas image
  useEffect(() => {
    const el = initial.img;
    if (!el || el.type !== "image" || !el.fileId) return;
    const url = api.getFiles()[el.fileId]?.dataURL;
    if (!url) return;
    shrinkImage(url).then(setImage).catch(() => {});
    fetch(url)
      .then((r) => r.blob())
      .then(embeddedScene)
      .then(setEmbedded)
      .catch(() => {});
  }, [api, initial]);

  const pickImage = async (f: Blob | null | undefined) => {
    if (!f || !f.type.startsWith("image/")) return;
    try {
      setImage(await shrinkImage(await readAsDataUrl(f)));
      setEmbedded(await embeddedScene(f));
      setMode("image");
      setError(null);
    } catch {
      setError("Could not read that image.");
    }
  };

  // Note: no outside-click or Escape close — only the Cancel button closes,
  // so users don't lose their prompt accidentally.

  // Hand off to Excalidraw's own Mermaid dialog (live preview + parse errors)
  // seeded with the text. The dialog reads this localStorage key on open;
  // EditorLocalStorage stores values JSON-encoded, so match that.
  const openInMermaidEditor = (text: string) => {
    localStorage.setItem("mermaid-to-excalidraw", JSON.stringify(text));
    api.updateScene({
      appState: { openDialog: { name: "ttd", tab: "mermaid" } },
    });
    onClose();
  };

  const switchProvider = (p: Provider) => {
    setProvider(p); // the effect above reloads the key for the new provider
    setModel(localStorage.getItem(MODEL_STORAGE[p]) ?? DEFAULT_MODEL[p]);
  };

  // anchor: top-left corner for the diagram; defaults to the viewport center
  const insertMermaid = async (mermaid: string, anchor?: { x: number; y: number }) => {
    // Lazy import: keeps the multi-MB mermaid bundle out of the startup chunk
    const { parseMermaidToExcalidraw } = await import(
      "@excalidraw/mermaid-to-excalidraw"
    );
    // Match Excalidraw's own dialog: some node/subgraph labels with double
    // quotes make the mermaid parser throw; retry with them swapped to single
    // quotes before giving up.
    let parsed;
    try {
      parsed = await parseMermaidToExcalidraw(mermaid);
    } catch {
      parsed = await parseMermaidToExcalidraw(mermaid.replace(/"/g, "'"));
    }
    const { elements: skeleton, files } = parsed;
    // The converter emits a single `image` element when it can't turn the
    // diagram into shapes (unsupported/partly-broken). Reject that so we never
    // silently paste a flat picture.
    if (skeleton.some((el) => el.type === "image")) {
      throw new Error("image-fallback");
    }
    const elements = convertToExcalidrawElements(skeleton, {
      regenerateIds: true,
    });
    if (!elements.length) throw new Error("Diagram came back empty");

    if (files && Object.keys(files).length) api.addFiles(Object.values(files));
    placeOnCanvas(elements, anchor);
  };

  // Add elements at anchor (their top-left) or centered in the viewport
  const placeOnCanvas = (elements: readonly ExcalidrawElement[], anchor?: { x: number; y: number }) => {
    const st = api.getAppState();
    const minX = Math.min(...elements.map((e) => e.x));
    const minY = Math.min(...elements.map((e) => e.y));
    const maxX = Math.max(...elements.map((e) => e.x + e.width));
    const maxY = Math.max(...elements.map((e) => e.y + e.height));
    const dx = anchor
      ? anchor.x - minX
      : st.width / 2 / st.zoom.value - st.scrollX - (minX + maxX) / 2;
    const dy = anchor
      ? anchor.y - minY
      : st.height / 2 / st.zoom.value - st.scrollY - (minY + maxY) / 2;
    const moved = elements.map((e) => ({ ...e, x: e.x + dx, y: e.y + dy }));

    api.updateScene({
      elements: [...api.getSceneElementsIncludingDeleted(), ...moved],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  };

  // Edit mode: model returns operations applied in place (see aiEdit.ts)
  const runEdit = async (key: string, modelId: string) => {
    const all = api.getSceneElementsIncludingDeleted();
    const scene = describeScene(all, api.getAppState().selectedElementIds);
    if (!scene.count) throw new Error("Nothing to edit: the canvas is empty.");
    if (scene.tooBig)
      throw new Error(`That's ${scene.count} elements; select a smaller part of the diagram to edit.`);
    const ask = `Request: ${prompt}\n\nElements:\n${scene.json}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await callModel(provider, key, modelId, EDIT_SYSTEM_PROMPT, ask, undefined, true);
      let ops;
      try {
        ops = parseOps(reply);
      } catch {
        continue; // malformed JSON: one retry
      }
      const { elements, changed } = applyEdit(all, ops, scene.scope);
      if (!changed) throw new Error("The model didn't change anything. Try being more specific.");
      api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      onClose();
      return;
    }
    throw new Error("The model's reply wasn't valid. Try again or rephrase.");
  };

  const ready =
    !busy &&
    (mode === "image" && embedded
      ? true
      : !!apiKey.trim() && (mode === "image" ? !!image : !!prompt.trim()));

  const generate = async () => {
    const key = apiKey.trim();
    const modelId = model.trim() || DEFAULT_MODEL[provider];
    if (!ready) return;
    await saveKey(provider, key);
    localStorage.setItem(MODEL_STORAGE[provider], modelId);
    setBusy(true);
    setError(null);
    if (mode === "edit") {
      try {
        await runEdit(key, modelId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
      return;
    }
    const fromImage = mode === "image" ? image : null;
    const system = fromImage ? SYSTEM_PROMPT + IMAGE_PROMPT : SYSTEM_PROMPT;
    const basePrompt = fromImage
      ? `Convert the diagram in this image to Mermaid.${prompt.trim() ? ` Notes: ${prompt.trim()}` : ""}`
      : prompt;
    // A diagram made from a canvas image goes right next to that image
    const src = fromImage ? initial.img : null;
    const anchor = src ? { x: src.x + src.width + 80, y: src.y } : undefined;
    if (fromImage && embedded) {
      if (Object.keys(embedded.files).length) api.addFiles(Object.values(embedded.files));
      placeOnCanvas(withNewIds(embedded.elements), anchor);
      setBusy(false);
      onClose();
      return;
    }
    // One retry: malformed/unsupported Mermaid is common, and a second pass
    // with the parse error fed back usually fixes it.
    let lastText = "";
    let lastError = "";
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const hint =
          attempt === 0
            ? basePrompt
            : `${basePrompt}\n\nYour previous answer was not a valid, supported Mermaid ` +
              `flowchart/sequenceDiagram/classDiagram${lastError ? ` (error: ${lastError})` : ""}. ` +
              `Return corrected Mermaid only:\n${lastText}`;
        const text = cleanMermaid(
          await callModel(provider, key, modelId, system, hint, fromImage ?? undefined)
        );
        lastText = text;
        if (!text || !isSupportedMermaid(text)) continue; // retry
        try {
          await insertMermaid(text, anchor);
          onClose();
          return;
        } catch (err) {
          // conversion failed (syntax error or image fallback) — retry once
          lastError = err instanceof Error ? err.message.split("\n")[0] : String(err);
        }
      }
      // Couldn't convert here — hand the text straight to Excalidraw's Mermaid
      // editor (live preview + parse errors) so the user can fix it there.
      if (lastText) {
        openInMermaidEditor(lastText);
      } else {
        setError("The model didn't return a diagram. Try rephrasing.");
      }
    } catch (err) {
      // API/network errors (bad key, quota) — keep the dialog open so the user
      // can switch model or key.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tpl-overlay">
      <div className="ai-modal" onPaste={(e) => pickImage(e.clipboardData.files[0])}>
        <div className="ai-head">
          <div className="ai-head-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3l1.6 3.9L17.5 8.5 13.6 10 12 14l-1.6-4L6.5 8.5l3.9-1.6L12 3z" />
              <path d="M18.5 14l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z" />
            </svg>
          </div>
          <div>
            <div className="ai-title">AI Diagram</div>
            <div className="ai-subtitle">
              {mode === "edit"
                ? "Change the selected shapes (or the whole diagram) in plain words."
                : mode === "image"
                  ? "Turn a whiteboard photo, sketch or screenshot into editable shapes."
                  : "Describe a diagram in plain words and drop editable shapes on the canvas."}
            </div>
          </div>
        </div>

        <div className="ai-seg" role="tablist" aria-label="Provider">
          <button
            role="tab"
            aria-selected={provider === "gemini"}
            className={provider === "gemini" ? "active" : ""}
            onClick={() => switchProvider("gemini")}
          >
            Google Gemini
          </button>
          <button
            role="tab"
            aria-selected={provider === "anthropic"}
            className={provider === "anthropic" ? "active" : ""}
            onClick={() => switchProvider("anthropic")}
          >
            Anthropic Claude
          </button>
        </div>

        <div className="ai-tabs" role="tablist" aria-label="Mode">
          {(
            [
              ["create", "Describe"],
              ["edit", initial.count ? `Edit selection (${initial.count})` : "Edit diagram"],
              ["image", "From image"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              className={mode === m ? "active" : ""}
              onClick={() => {
                setMode(m);
                setError(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === "image" && (
          <div className="ai-image">
            {image ? (
              <img src={image.url} alt="Image to convert" />
            ) : (
              <span className="ai-image-empty">Paste an image (Ctrl+V) or choose a file</span>
            )}
            {embedded && (
              <span className="ai-image-note">
                This image contains the original Excalidraw drawing: it will be inserted exactly, no AI needed.
              </span>
            )}
            <label className="ai-btn ai-cancel ai-image-pick">
              {image ? "Replace..." : "Choose image..."}
              <input
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => pickImage(e.target.files?.[0])}
              />
            </label>
          </div>
        )}

        <label className="ai-label">
          <span className="ai-label-text">
            {mode === "edit"
              ? "What should change?"
              : mode === "image"
                ? "Notes (optional)"
                : "Describe the diagram"}
          </span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={mode === "image" ? 2 : 4}
            placeholder={
              mode === "edit"
                ? "e.g. add a Redis cache between the API and the database, and color the AWS services orange"
                : mode === "image"
                  ? "e.g. the arrows on the right go to the payments service"
                  : "e.g. auth flow: user logs in, backend checks credentials against Postgres, issues a JWT, client stores it and sends it with API calls"
            }
            autoFocus
          />
        </label>

        <div className="ai-row">
          <label className="ai-label">
            <span className="ai-label-text">API key</span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={provider === "gemini" ? "AIza..." : "sk-ant-..."}
              autoComplete="off"
            />
          </label>
          <label className="ai-label ai-model">
            <span className="ai-label-text">Model</span>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={DEFAULT_MODEL[provider]}
              autoComplete="off"
            />
          </label>
        </div>
        <div className="ai-hint">
          {provider === "gemini" ? (
            <>
              Get a free API key from{" "}
              <button
                type="button"
                className="ai-link"
                onClick={() => openUrl("https://aistudio.google.com/api-keys")}
              >
                aistudio.google.com/api-keys
              </button>
              .{" "}
            </>
          ) : null}
          Stored only on this machine; sent only to the provider.
        </div>

        {error && <div className="ai-error">{error}</div>}

        <div className="ai-actions">
          <button className="ai-btn ai-cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            className="ai-btn ai-generate"
            disabled={!ready}
            onClick={generate}
          >
            {busy
              ? mode === "edit"
                ? "Editing…"
                : "Generating…"
              : mode === "edit"
                ? "Apply Changes"
                : "Generate & Insert"}
          </button>
        </div>
      </div>
    </div>
  );
}
