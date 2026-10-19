import test from "node:test";
import assert from "node:assert/strict";
import { CHAT_MESSAGE_LIMIT, TOTAL_MESSAGE_LIMIT, retainedRange } from "../web/retention.ts";
import { SearchWindow } from "../web/searchWindow.ts";

test("retained windows move through more than 500 older messages without dropping the new page or anchor", () => {
  assert.equal(CHAT_MESSAGE_LIMIT, 500);
  assert.equal(TOTAL_MESSAGE_LIMIT, 10000);
  let messages = Array.from({ length: 500 }, (_, index) => index + 1000);
  for (let page = 0; page < 30; page++) {
    const anchor = messages[0];
    const older = Array.from({ length: 50 }, (_, index) => anchor - 50 + index);
    const merged = [...older, ...messages];
    const { start, end } = retainedRange(merged.length, merged.indexOf(anchor), true);
    messages = merged.slice(start, end);
    assert.equal(messages.length, 500);
    assert.equal(messages[0], older[0]);
    assert.ok(messages.includes(anchor));
    assert.ok(messages.every((value, index) => index === 0 || value === messages[index - 1] + 1));
  }
  assert.equal(messages[0], -500);
  assert.deepEqual(retainedRange(501, undefined, false), { start: 1, end: 501 });
  assert.deepEqual(retainedRange(501, 0, false), { start: 0, end: 500 }, "live trimming protects the top-visible message");
  assert.deepEqual(retainedRange(550, 530, true), { start: 31, end: 531 }, "a reader who moved during a fetch is not evicted");
});

// A deterministic DOM geometry fixture tests the production viewport's range/lifecycle behavior.
// Real browser wrapping, focus and layout are covered by the browser smoke, not simulated here.
test("5000 variable-height hits keep complete navigation but only viewport DOM, then release rows", () => {
  const previous = { document: globalThis.document, ResizeObserver: globalThis.ResizeObserver, requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame };
  const frames = new Map();
  const observers = [];
  let serial = 0;
  class Element {
    children = [];
    parent = undefined;
    dataset = {};
    style = {};
    attributes = {};
    listeners = {};
    classList = { add() {}, remove() {} };
    clientWidth = 800;
    clientHeight = 600;
    height = 40;
    top = 0;
    get offsetHeight() { return this.height; }
    get nextSibling() { return this.parent?.children[this.parent.children.indexOf(this) + 1]; }
    get scrollTop() { return this.top; }
    set scrollTop(value) { this.top = Math.max(0, Math.min(value, this.children.reduce((sum, row) => sum + (row.style.height ? parseFloat(row.style.height) : row.height), 0) - this.clientHeight)); }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    setAttribute(key, value) { this.attributes[key] = value; }
    replaceChildren(...nodes) { for (const node of this.children) node.parent = undefined; this.children = []; for (const node of nodes) this.insertBefore(node); }
    insertBefore(node, cursor) { node.remove(); const at = cursor ? this.children.indexOf(cursor) : this.children.length; this.children.splice(at, 0, node); node.parent = this; }
    remove() { if (this.parent) { const at = this.parent.children.indexOf(this); this.parent.children.splice(at, 1); this.parent = undefined; } }
    getBoundingClientRect() { return { height: this.height }; }
    closest() { return this.dataset.searchIndex === undefined ? undefined : this; }
    focus() { this.focused = true; }
  }
  globalThis.document = { createElement: () => new Element() };
  globalThis.ResizeObserver = class {
    rows = new Set();
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(row) { this.rows.add(row); }
    unobserve(row) { this.rows.delete(row); }
  };
  globalThis.requestAnimationFrame = (callback) => { frames.set(++serial, callback); return serial; };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  const flush = () => {
    for (let round = 0; frames.size && round < 30; round++) {
      const batch = [...frames.values()]; frames.clear(); for (const callback of batch) callback();
    }
    assert.equal(frames.size, 0, "measurement converges");
  };
  try {
    const host = new Element();
    const items = Array.from({ length: 5000 }, (_, id) => ({ id }));
    const viewport = new SearchWindow(host, (item) => {
      const row = new Element(); row.height = 60 + item.id % 4 * 50; row.item = item; return row;
    }, (item) => item.id);
    const rows = () => host.children.filter((node) => node.dataset.searchIndex !== undefined);
    viewport.set(items, "5000 則符合", true); flush();
    assert.ok(rows().length < 40);
    assert.equal(rows()[0].attributes["aria-setsize"], "5000");
    assert.equal(rows()[0].item.id, 0);
    host.scrollTop = 250000; host.listeners.scroll(); flush();
    assert.ok(rows().some((row) => row.item.id > 2000 && row.item.id < 3000));
    assert.ok(rows().length < 40);
    host.scrollTop = 1e9; host.listeners.scroll(); flush();
    assert.equal(rows().at(-1).item.id, 4999);
    const tail = rows().at(-1);
    host.listeners.keydown({ target: tail, key: "Home", preventDefault() {} }); flush();
    assert.equal(rows()[0].item.id, 0);
    host.listeners.keydown({ target: rows()[0], key: "End", preventDefault() {} }); flush();
    assert.equal(rows().at(-1).item.id, 4999);
    host.clientWidth = 400; observers[0].callback(); flush();
    assert.ok(rows().length < 40);
    viewport.set(items.slice(100, 200), "100 則符合", true); flush();
    assert.equal(rows()[0].item.id, 100);
    assert.equal(rows()[0].attributes["aria-setsize"], "100");
    viewport.set([], "沒有符合結果", true); flush();
    assert.equal(rows().length, 0);
    viewport.clear(); flush();
    assert.equal(host.children.length, 0);
    assert.equal(observers[0].rows.size, 1, "only the viewport itself remains observed after logout/close");
  } finally {
    Object.assign(globalThis, previous);
  }
});
