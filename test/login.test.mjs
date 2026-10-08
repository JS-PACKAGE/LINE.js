import test from "node:test";
import assert from "node:assert/strict";
import { LoginController } from "../dist/line/login.js";

class ControlledProvider {
  callbacks;
  finish;
  reject;
  restoreResult = false;
  async restoreSession() { return this.restoreResult; }
  loginQR(callbacks) {
    this.callbacks = callbacks;
    return new Promise((resolve, reject) => { this.finish = resolve; this.reject = reject; });
  }
}

test("QR and PIN reach only the starter; state observers never see secrets; failure needs a new attempt", async () => {
  const provider = new ControlledProvider();
  const login = new LoginController(provider);
  const observed = [];
  login.subscribe((state) => observed.push(state));
  await login.restore();
  const received = [];
  const attempt = login.startQR({ onQRUrl: (url) => received.push(["qr", url]), onPinCode: (code) => received.push(["pin", code]) });
  provider.callbacks.onQRUrl("https://example.invalid/test-only-qr");
  provider.callbacks.onPinCode("123456");
  assert.deepEqual(received, [["qr", "https://example.invalid/test-only-qr"], ["pin", "123456"]]);
  await assert.rejects(login.startQR({ onQRUrl() {}, onPinCode() {} }), /LOGIN_BUSY/);
  provider.reject(new Error("test login failure"));
  await attempt;
  assert.equal(login.state, "error");
  assert.equal(login.canStartQR(), true);
  assert.deepEqual(observed, ["idle", "authenticating", "error"]);
  assert.ok(!JSON.stringify(observed).includes("example.invalid"));
});

test("successful QR login and restored sessions both end in ready; restore never asks for a QR", async () => {
  const provider = new ControlledProvider();
  const login = new LoginController(provider);
  await login.restore();
  const attempt = login.startQR({ onQRUrl() {}, onPinCode() {} });
  provider.finish();
  await attempt;
  assert.equal(login.state, "ready");
  assert.equal(login.canStartQR(), false);

  provider.restoreResult = true;
  const restored = new LoginController(provider);
  await restored.restore();
  assert.equal(restored.state, "ready");
});

test("a provider failure during restore surfaces as error instead of an unhandled rejection", async () => {
  const login = new LoginController({ async restoreSession() { throw new Error("test failure"); } });
  await login.restore();
  assert.equal(login.state, "error");
});

test("logout moves ready to idle and allows a fresh QR login; concurrent logouts are refused", async () => {
  const provider = new ControlledProvider();
  let release;
  provider.logout = () => new Promise((resolve) => { release = () => resolve({ remoteRevoked: true }); });
  provider.restoreResult = true;
  const login = new LoginController(provider);
  await login.restore();
  const observed = [];
  login.subscribe((state) => observed.push(state));
  const pending = login.logout();
  assert.equal(login.canLogout(), false);
  await assert.rejects(login.logout(), /LOGOUT_UNAVAILABLE/);
  release();
  assert.deepEqual(await pending, { remoteRevoked: true });
  assert.equal(login.state, "idle");
  assert.equal(login.canStartQR(), true);
  assert.deepEqual(observed, ["idle"]);
});

test("logging out before login is refused and leaves the state untouched", async () => {
  const login = new LoginController(new ControlledProvider());
  await login.restore();
  await assert.rejects(login.logout(), /LOGOUT_UNAVAILABLE/);
  assert.equal(login.state, "idle");
});
