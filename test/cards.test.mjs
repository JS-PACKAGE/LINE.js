import test from "node:test";
import assert from "node:assert/strict";
import { contentTypeName, messageCard } from "../dist/line/cards.js";

test("LINE's numeric content types read as their names; names and unknown numbers pass through", () => {
  assert.equal(contentTypeName("15"), "LOCATION");
  assert.equal(contentTypeName("0"), "NONE");
  assert.equal(contentTypeName("22"), "FLEX");
  assert.equal(contentTypeName("STICKER"), "STICKER");
  assert.equal(contentTypeName("99"), "99");
});

test("a location keeps its place name, address and coordinates", () => {
  assert.deepEqual(messageCard("LOCATION", undefined, { title: " 台北車站 ", address: "台北市中正區", latitude: 25.0478, longitude: 121.517, phone: "x" }), {
    kind: "location", title: "台北車站", address: "台北市中正區", latitude: 25.0478, longitude: 121.517,
  });
  assert.deepEqual(messageCard("LOCATION", undefined, { latitude: -33.9, longitude: 151.2 }), { kind: "location", latitude: -33.9, longitude: 151.2 });
});

test("a card that cannot be read stays a placeholder rather than a guess", () => {
  for (const location of [undefined, null, "25,121", { latitude: 91, longitude: 0 }, { latitude: "25", longitude: 121 }, { latitude: Number.NaN, longitude: 1 }]) {
    assert.equal(messageCard("LOCATION", undefined, location), undefined);
  }
  assert.equal(messageCard("CONTACT", { displayName: "   " }, undefined), undefined);
  assert.equal(messageCard("FILE", {}, undefined), undefined);
  assert.equal(messageCard("FLEX", { FLEX_JSON: "{}" }, undefined), undefined);
  assert.equal(messageCard("CALL", { GC_EVT_TYPE: "S" }, undefined), undefined, "call metadata is not documented by linejs");
});

test("contacts, files and rich cards show what LINE itself puts in the metadata", () => {
  assert.deepEqual(messageCard("CONTACT", { mid: "u1", displayName: "王小明" }, undefined), { kind: "contact", name: "王小明" });
  assert.deepEqual(messageCard("FILE", { FILE_NAME: "報告.pdf", FILE_SIZE: "20480" }, undefined), { kind: "file", name: "報告.pdf", size: 20480 });
  assert.deepEqual(messageCard("FILE", { FILE_NAME: "a.zip", FILE_SIZE: "-1" }, undefined), { kind: "file", name: "a.zip" });
  assert.deepEqual(messageCard("FLEX", { ALT_TEXT: "x".repeat(500) }, undefined), { kind: "flex", altText: "x".repeat(400) });
});
