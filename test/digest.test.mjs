import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("daily summary bridge reads, saves and launches only the configured companion", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "linejs-digest-test-"));
  t.after(async () => { delete process.env.LINE_DIGEST_DIR; await rm(folder, { recursive: true, force: true }); });
  const saved = join(folder, "saved.json");
  await writeFile(join(folder, "picker-data.mjs"), `import { writeFile } from 'node:fs/promises'; await writeFile(process.argv[2], JSON.stringify({ profileId: 'owner', profileName: 'Owner', selectedIds: ['chat-1'], chats: [{ id: 'chat-1', kind: 'group', name: 'Test' }] }));`);
  await writeFile(join(folder, "picker-save.mjs"), `import { copyFile } from 'node:fs/promises'; await copyFile(process.argv[2], ${JSON.stringify(saved)});`);
  await writeFile(join(folder, "scheduled-run.ps1"), `Write-Output 'summary finished'\n`);
  process.env.LINE_DIGEST_DIR = folder;
  const { digestAvailable, digestSelection, saveDigestSelection, digestStatus, runDigestNow } = await import(`../dist/http/digest.js?test=${Date.now()}`);
  assert.equal(await digestAvailable(), process.platform === "win32");
  const selection = await digestSelection();
  assert.equal(selection.profileId, "owner");
  assert.deepEqual(selection.selectedIds, ["chat-1"]);
  await assert.rejects(saveDigestSelection({ profileId: "owner", selectedIds: [3] }), /選取資料無效/);
  await saveDigestSelection({ profileId: "owner", selectedIds: ["chat-1"] });
  assert.deepEqual(JSON.parse(await readFile(saved, "utf8")), { profileId: "owner", selectedIds: ["chat-1"] });
  if (process.platform === "win32") {
    assert.equal((await runDigestNow()).running, true);
    for (let n = 0; n < 100 && digestStatus().running; n++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(digestStatus().result, "success", digestStatus().message);
    assert.match(digestStatus().message, /summary finished/);
  }
});
