import test from "node:test";
import assert from "node:assert/strict";
import { JevClient } from "../dist/jev/client.js";

function fakeFetch(respond) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return respond();
  };
  return { calls, fetchImpl };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("only the message text goes to TypeSafe, with the token as the bearer header and no redirects", async () => {
  const { calls, fetchImpl } = fakeFetch(() => json({
    model: "jev-1.13.0",
    answers: {
      scam: { type: "noul", noul: 0.93 },
      tactic: { type: "choice", choice: "investment", probabilities: { investment: 0.9, other: 0.1 }, confidence: 0.85 },
    },
    usage: { input_tokens: 300, output_tokens: 20 },
  }));
  const client = new JevClient({ token: "ts_secret", model: "jev-1.13.0", fetchImpl });
  assert.deepEqual(await client.analyzeScam("加入飆股群，保證獲利"), { probability: 0.93, tactic: { kind: "investment", confidence: 0.85 } });
  const [{ url, init, body }] = calls;
  assert.equal(url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer ts_secret");
  assert.equal(init.redirect, "error");
  assert.equal(body.model, "jev-1.13.0");
  assert.equal(body.state, "加入飆股群，保證獲利");
  assert.equal(body.questions.scam.type, "noul");
  assert.equal(body.questions.tactic.type, "choice");
});

test("no readable probability means no result (fail-closed); an unknown tactic is just left out", async () => {
  for (const answers of [undefined, {}, { scam: { noul: 1.2 } }, { scam: { noul: "0.9" } }, { tactic: { choice: "investment", confidence: 1 } }]) {
    const client = new JevClient({ token: "t", model: "m", fetchImpl: async () => json({ answers }) });
    await assert.rejects(client.analyzeScam("x"), /shape/, JSON.stringify(answers));
  }
  const client = new JevClient({ token: "t", model: "m", fetchImpl: async () => json({ answers: { scam: { noul: 0.1 }, tactic: { choice: "made_up", confidence: 0.9 } } }) });
  assert.deepEqual(await client.analyzeScam("x"), { probability: 0.1 });
});

test("an HTTP failure reports the status only, never the response body or the token", async () => {
  let consumed = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) { consumed++; controller.enqueue(Buffer.from('{"error":"invalid key ts_secret"}')); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const client = new JevClient({ token: "ts_secret", model: "m", fetchImpl: async () => new Response(body, { status: 401 }) });
  await assert.rejects(client.analyzeScam("x"), (error) => error.message === "status 401");
  assert.equal(consumed, 0);
  assert.equal(cancelled, true);
  const failedBody = new ReadableStream({ start(controller) { controller.error(new Error("invalid key ts_secret")); } });
  const failed = new JevClient({ token: "ts_secret", model: "m", fetchImpl: async () => new Response(failedBody, { status: 401 }) });
  await assert.rejects(failed.analyzeScam("x"), (error) => error.message === "status 401");
  const huge = new JevClient({ token: "t", model: "m", fetchImpl: async () => new Response("x".repeat(70 * 1024)) });
  await assert.rejects(huge.analyzeScam("x"), /size/);
});
