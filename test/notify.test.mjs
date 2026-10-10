import test from "node:test";
import assert from "node:assert/strict";
import { createNotifier } from "../web/notify.ts";

// Session cleanup must close OS notifications as well as the hidden chat view.
test("ending a session closes every chat notification without changing the notification preference", () => {
  const saved = new Map(["Notification", "document", "localStorage", "window"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const shown = [];
  const opened = [];
  const preferences = new Map([["linejs-notify", "on"]]);
  class FakeNotification {
    static permission = "granted";
    constructor(title, options) {
      this.title = title;
      this.options = options;
      this.closed = false;
      shown.push(this);
    }
    addEventListener(type, listener) { this[type] = listener; }
    close() { this.closed = true; }
  }
  Object.defineProperty(globalThis, "Notification", { configurable: true, value: FakeNotification });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { visibilityState: "hidden" } });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key) => preferences.get(key) ?? null, setItem: (key, value) => preferences.set(key, value) } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { focus() {} } });
  try {
    const notifier = createNotifier({ addEventListener() {} }, (id) => opened.push(id));
    for (const channelId of ["friend", "group"]) {
      notifier.notify({ channelId, channelKind: "user", senderName: "Private sender" }, "Private chat", "Private text");
    }
    assert.equal(shown.length, 2);
    notifier.clearAll();
    assert.ok(shown.every((notification) => notification.closed));
    assert.equal(preferences.get("linejs-notify"), "on");
    assert.deepEqual(opened, []);
    // Cleanup is idempotent; a new login can still receive and clear notifications.
    notifier.clearAll();
    notifier.notify({ channelId: "new-account", channelKind: "user", senderName: "New sender" }, "", "New text");
    assert.equal(shown[2].closed, false);
    notifier.clear("new-account");
    assert.equal(shown[2].closed, true);
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

test("session notification cleanup is available when the browser lacks Notification", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Notification");
  Object.defineProperty(globalThis, "Notification", { configurable: true, value: undefined });
  try {
    const button = {};
    const notifier = createNotifier(button, () => assert.fail("no notification should open a chat"));
    assert.equal(button.hidden, true);
    notifier.clearAll();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "Notification", descriptor);
    else delete globalThis.Notification;
  }
});
