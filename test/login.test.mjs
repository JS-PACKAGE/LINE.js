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
  getProfile() { return { userId: "test-user", displayName: "測試帳號" }; }
}

test("QR and PIN are consumed once; failure requires an explicit new attempt", async () => {
  const provider = new ControlledProvider();
  const login = new LoginController(provider);
  await login.restore();
  const attempt = login.startQR("requesting-tab");
  provider.callbacks.onQRUrl("https://example.invalid/test-only-qr");
  provider.callbacks.onPinCode("123456");
  assert.deepEqual(login.snapshot("requesting-tab").events, [
    { type: "auth:qr", url: "https://example.invalid/test-only-qr" },
    { type: "auth:pin", code: "123456" },
  ]);
  assert.deepEqual(login.snapshot("requesting-tab").events, []);
  await assert.rejects(login.startQR("requesting-tab"), /LOGIN_BUSY/);
  provider.reject(new Error("test login failure"));
  await attempt;
  assert.equal(login.snapshot("requesting-tab").state, "error");
  assert.equal(login.canStartQR(), true);
  assert.deepEqual(login.snapshot("requesting-tab").events, []);
});

test("restored sessions do not generate QR and successful login removes pending secrets", async () => {
  const provider = new ControlledProvider();
  const login = new LoginController(provider);
  await login.restore();
  const attempt = login.startQR("requesting-tab");
  provider.callbacks.onQRUrl("https://example.invalid/test-only-qr");
  provider.finish();
  await attempt;
  assert.deepEqual(login.snapshot("requesting-tab").events, []);
  assert.equal(login.snapshot("requesting-tab").state, "ready");
  assert.equal(login.canStartQR(), false);
  provider.restoreResult = true;
  const restored = new LoginController(provider);
  await restored.restore();
  assert.equal(restored.snapshot("requesting-tab").state, "ready");
  assert.deepEqual(restored.snapshot("requesting-tab").profile, { userId: "test-user", displayName: "測試帳號" });
});

test("another tab cannot consume or replay the requesting tab's QR and PIN", async () => {
  const provider = new ControlledProvider();
  const login = new LoginController(provider);
  await login.restore();
  const attempt = login.startQR("requesting-tab");
  provider.callbacks.onQRUrl("https://example.invalid/test-only-qr");
  provider.callbacks.onPinCode("123456");
  assert.deepEqual(login.snapshot("other-tab").events, []);
  assert.deepEqual(login.snapshot("requesting-tab").events, [
    { type: "auth:qr", url: "https://example.invalid/test-only-qr" },
    { type: "auth:pin", code: "123456" },
  ]);
  assert.deepEqual(login.snapshot("requesting-tab").events, []);
  provider.finish();
  await attempt;
});
