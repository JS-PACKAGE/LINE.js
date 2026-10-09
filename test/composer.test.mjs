import test from "node:test";
import assert from "node:assert/strict";

// The composer is browser code: it reaches for DOM nodes and XHR at call time. These shims stand in
// for them so the send queue can be driven headlessly. The web build bundles the module away, so the
// test imports the TypeScript source directly (Node ≥ 22 strips types).
function makeElement(id) {
  const listeners = new Map();
  return {
    id,
    value: "",
    textContent: "",
    hidden: false,
    disabled: false,
    files: null,
    scrollHeight: 0,
    style: { setProperty() {} },
    dataset: {},
    classList: { add() {}, remove() {}, contains: () => false },
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    fire(type) {
      return listeners.get(type)?.({ preventDefault() {}, stopPropagation() {}, clipboardData: { files: [], getData: () => "" } });
    },
    appendChild() {},
    append() {},
    replaceChildren() {},
    removeAttribute() {},
    setAttribute() {},
    focus() {},
    click() {},
    setSelectionRange() {},
    getContext: () => ({ clearRect() {} }),
    load() {},
    pause() {},
  };
}

const SELECTORS = [
  "#draft", "#send", "#attach", "#file", "#sticker-toggle", "#sticker-panel", "#sticker-tabs", "#sticker-grid",
  "#sticker-state", "#sticker-package", "#sticker-id", "#sticker-preview", "#sticker-send", "#attachment",
  "#attachment-info", "#attachment-send", "#attachment-cancel", "#attachment img", "#attachment video",
  "#reply-bar", "#reply-preview", "#reply-cancel", "#composer-note", "#composer",
];

function withShims(run) {
  const nodes = new Map(SELECTORS.map((id) => [id, makeElement(id)]));
  const globals = {
    document: { querySelector: (s) => nodes.get(s) ?? makeElement(s), createElement: () => makeElement("created"), createTextNode: (text) => ({ textContent: text }) },
    window: { addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
  };
  class FakeXHR {
    constructor() {
      this.upload = { addEventListener() {} };
      this.status = 200;
      this.responseText = "{}";
      this.listeners = new Map();
    }
    open() {}
    setRequestHeader() {}
    addEventListener(type, fn) {
      this.listeners.set(type, fn);
    }
    send(file) {
      // Responds like POST /media/upload: one media id per file, in order.
      setTimeout(() => {
        this.responseText = JSON.stringify({ mediaId: `up-${file.name}` });
        this.listeners.get("load")?.();
      }, 1);
    }
  }
  globals.XMLHttpRequest = FakeXHR;
  const saved = new Map();
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  return run(nodes).finally(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
}

const file = (name) => ({ name, size: 1024, type: "image/png" });

test("a selection of several files is sent one at a time, then the draft text follows", async () => {
  await withShims(async (nodes) => {
    const { createComposer } = await import("../web/composer.ts");
    const sent = [];
    const composer = createComposer((frame) => {
      sent.push(frame);
      return true;
    });
    composer.setConnected(true);
    composer.setChannel("c1");

    nodes.get("#file").files = [file("a.png"), file("b.png"), file("c.png")];
    nodes.get("#file").fire("change");
    assert.equal(nodes.get("#attachment-info").textContent, "a.png（1 KB · 第 1/3 個）");

    nodes.get("#draft").value = "三張之後的文字";
    nodes.get("#draft").fire("input");
    nodes.get("#attachment-send").fire("click");

    // The hub acks each send; the composer then picks up the next file, and the text last.
    const seenIndexes = [];
    for (let turn = 0; turn < 20; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const info = nodes.get("#attachment-info").textContent;
      const at = /第 (\d+)\/(\d+) 個/.exec(info);
      if (at) seenIndexes.push(Number(at[1]));
      const outstanding = sent.filter((frame) => !frame.__acked);
      for (const frame of outstanding) {
        frame.__acked = true;
        composer.handleSent(frame.requestId);
      }
      if (sent.length >= 4 && outstanding.length === 0) break;
    }

    assert.deepEqual(
      sent.filter((frame) => frame.type === "message:send").map((frame) => (frame.text ? `text:${frame.text}` : `media:${frame.mediaId}`)),
      ["media:up-a.png", "media:up-b.png", "media:up-c.png", "text:三張之後的文字"],
    );
    assert.ok(seenIndexes.includes(2), `the counter advanced through the selection (saw ${seenIndexes.join(",")})`);
    assert.ok(seenIndexes.includes(3), `the counter reached the last file (saw ${seenIndexes.join(",")})`);
    assert.equal(nodes.get("#draft").value, "");
  });
});

test("the draft text is sent only after the selection, and only when it has one", async () => {
  await withShims(async (nodes) => {
    const { createComposer } = await import("../web/composer.ts");
    const sent = [];
    const composer = createComposer((frame) => {
      sent.push(frame);
      return true;
    });
    composer.setConnected(true);
    composer.setChannel("c1");

    nodes.get("#file").files = [file("a.png"), file("b.png")];
    nodes.get("#file").fire("change");
    // No draft text: the selection is sent alone, with no trailing message.
    nodes.get("#attachment-send").fire("click");
    for (let turn = 0; turn < 20; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const outstanding = sent.filter((frame) => !frame.__acked);
      for (const frame of outstanding) {
        frame.__acked = true;
        composer.handleSent(frame.requestId);
      }
      if (sent.length >= 2 && outstanding.length === 0) break;
    }
    assert.deepEqual(sent.filter((frame) => frame.type === "message:send").map((frame) => frame.mediaId), ["up-a.png", "up-b.png"]);
  });
});
