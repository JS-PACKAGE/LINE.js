import test from "node:test";
import assert from "node:assert/strict";
import { listedNotes, noteFailureReason, noteTarget, noteText } from "../dist/line/notes.js";

const GROUP = `c${"a".repeat(32)}`;
const SQUARE = "s1234567890abc";

test("group (GB) and OpenChat (SN) note notifications name their home and post", () => {
  assert.deepEqual(noteTarget({
    serviceType: "GB", locKey: "BG", text: "  週六 10 點集合\n帶水  ",
    postEndUrl: `https://line.me/R/group/home/posts/post?homeId=${GROUP}&postId=1166554433221100&noteEntryType=post_noti`,
  }), { homeId: GROUP, postId: "1166554433221100", preview: "週六 10 點集合\n帶水" });
  assert.deepEqual(noteTarget({ serviceType: "GB", postEndUrl: `line://group/home/posts/post?homeId=${GROUP}&postId=p1` }), { homeId: GROUP, postId: "p1" });
  assert.deepEqual(noteTarget({ serviceType: "SN", postEndUrl: `line://square/post?squareMid=${SQUARE}&postId=p1&sourceType=TALKROOM_HOME` }), { homeId: SQUARE, postId: "p1" });
  assert.equal(noteTarget({ serviceType: "GB", text: "x".repeat(1500), postEndUrl: `line://group/home/posts/post?homeId=${GROUP}&postId=p1` }).preview.length, 1000);
});

test("albums, shared VOOM posts and anything off-shape are not notes", () => {
  const groupUrl = `https://line.me/R/group/home/posts/post?homeId=${GROUP}&postId=p1`;
  for (const metadata of [
    undefined,
    { serviceType: "AB", postEndUrl: `line://group/home/albums/album?albumId=5302&homeId=${GROUP}` },
    { serviceType: "MH", postEndUrl: "https://line.me/R/home/post?userMid=u1&postId=117" },
    { serviceType: "GB" },
    { serviceType: "gb", postEndUrl: groupUrl },
    { serviceType: "GB", postEndUrl: "not a url" },
    // The service type and the kind of link must agree.
    { serviceType: "SN", postEndUrl: groupUrl },
    { serviceType: "GB", postEndUrl: `line://square/post?squareMid=${SQUARE}&postId=p1` },
    { serviceType: "GB", postEndUrl: `https://line.me.example/R/group/home/posts/post?homeId=${GROUP}&postId=p1` },
    { serviceType: "GB", postEndUrl: `http://line.me/R/group/home/posts/post?homeId=${GROUP}&postId=p1` },
    { serviceType: "GB", postEndUrl: `https://line.me/R/group/home/posts/post?homeId=u${"a".repeat(32)}&postId=p1` },
    { serviceType: "GB", postEndUrl: `https://line.me/R/group/home/posts/post?homeId=${GROUP}&postId=../x` },
    { serviceType: "GB", postEndUrl: `https://line.me/R/group/home/posts/post?homeId=${GROUP}` },
    { serviceType: "SN", postEndUrl: `line://square/post?squareMid=m1234567890abc&postId=p1` },
  ]) {
    assert.equal(noteTarget(metadata), undefined, JSON.stringify(metadata));
  }
});

test("the note API answer counts only when it is the post asked for", () => {
  const post = (postId, contents) => ({ code: 0, message: "success", result: { post: { postInfo: { postId }, contents } } });
  assert.equal(noteText(post("p1", { text: "全文\n第二行" }), "p1"), "全文\n第二行");
  assert.equal(noteText(post("p1", { media: [{ objectId: "o1" }] }), "p1"), "", "a pictures-only note has no text");
  assert.equal(noteText({ code: 0, result: { feed: { post: { postInfo: { postId: "p1" }, contents: { text: "feed" } } } } }, "p1"), "feed");
  assert.equal(noteText({ code: 0, result: { postInfo: { postId: "p1" }, contents: { text: "flat" } } }, "p1"), "flat");
  for (const [response, error] of [
    [undefined, /NOTE_REFUSED/],
    [{ code: 403, message: "not a member", result: null }, /NOTE_REFUSED/],
    [post("p2", { text: "another post" }), /NOTE_INVALID_RESPONSE/],
    [{ code: 0, result: { post: { postInfo: { postId: "p1" } } } }, /NOTE_INVALID_RESPONSE/],
    [post("p1", { text: 42 }), /NOTE_INVALID_TEXT/],
    [post("p1", { text: "x".repeat(20_001) }), /NOTE_INVALID_TEXT/],
  ]) {
    assert.throws(() => noteText(response, "p1"), error);
  }
});

test("a note list yields each post's id, creation time and writer; malformed entries are skipped, other shapes refused", () => {
  const writer = `p${"w".repeat(32)}`;
  assert.deepEqual(listedNotes({ code: 0, result: { posts: [
    { postInfo: { postId: "p1", createdTime: 1_700_000_000_001 }, userInfo: { writerMid: writer, nickname: " 作者 " } },
    { postInfo: { postId: "p2", createdTime: "1700000000002" }, userInfo: { writerMid: "../evil", nickname: "  " } },
    { postInfo: { postId: "p/3", createdTime: 1 } },
    { postInfo: { postId: "p4", createdTime: "soon" } },
    null,
  ] } }), [
    { postId: "p1", createdAt: 1_700_000_000_001, writerId: writer, writerName: "作者" },
    { postId: "p2", createdAt: 1_700_000_000_002 },
  ]);
  assert.deepEqual(listedNotes({ code: 0, result: { feeds: [{ post: { postInfo: { postId: "f1", createdTime: 5 } } }] } }), [{ postId: "f1", createdAt: 5 }]);
  assert.throws(() => listedNotes({ code: 0, result: {} }), /NOTE_INVALID_LIST/);
  assert.throws(() => listedNotes({ code: 10, message: "x" }), /NOTE_REFUSED code=10 message="x"/);
});

test("a failure reason keeps this service's codes and hides anything else LINE or the network said", () => {
  assert.equal(noteFailureReason(new Error('NOTE_REFUSED code=403 message="a\nb"')), 'NOTE_REFUSED code=403 message="a b"');
  assert.equal(noteFailureReason(new TypeError("fetch failed: token=secret")), "LINE_ERROR name=TypeError");
  assert.equal(noteFailureReason("weird"), "LINE_ERROR name=string");
});
