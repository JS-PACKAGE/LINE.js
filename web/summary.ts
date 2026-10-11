interface Chat { id: string; kind: string; name: string }
interface Selection { profileId: string; profileName: string; selectedIds: string[]; chats: Chat[] }
interface Status { running: boolean; startedAt?: string; finishedAt?: string; result?: "success" | "error"; message?: string }

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/summary/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    credentials: "same-origin",
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || `摘要工具回應 ${response.status}`);
  return data as T;
}

export function setupSummary(): void {
  const toggle = byId<HTMLButtonElement>("summary-toggle");
  void api<{ enabled: boolean }>("availability").then((result) => { toggle.hidden = !result.enabled; }).catch(() => {});
  const dialog = byId<HTMLDialogElement>("summary-dialog");
  const list = byId<HTMLDivElement>("summary-list");
  const search = byId<HTMLInputElement>("summary-search");
  const account = byId<HTMLParagraphElement>("summary-account");
  const count = byId<HTMLParagraphElement>("summary-count");
  const statusText = byId<HTMLParagraphElement>("summary-status");
  const save = byId<HTMLButtonElement>("summary-save");
  const run = byId<HTMLButtonElement>("summary-run");
  let data: Selection | undefined;
  let selected = new Set<string>();
  let busy = false;
  let poll: ReturnType<typeof setInterval> | undefined;

  function render(): void {
    list.replaceChildren();
    if (!data) return;
    const query = search.value.trim().toLocaleLowerCase();
    for (const chat of data.chats.filter((item) => item.name.toLocaleLowerCase().includes(query))) {
      const label = document.createElement("label");
      label.className = "summary-chat";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selected.has(chat.id);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selected.add(chat.id);
        else selected.delete(chat.id);
        count.textContent = `已選 ${selected.size} / ${data?.chats.length ?? 0} 個聊天室`;
      });
      const name = document.createElement("span");
      name.textContent = chat.name;
      const kind = document.createElement("small");
      kind.textContent = `${chat.kind} · …${chat.id.slice(-6)}`;
      label.append(checkbox, name, kind);
      list.append(label);
    }
    count.textContent = `已選 ${selected.size} / ${data.chats.length} 個聊天室`;
  }

  function showStatus(state: Status): void {
    if (state.running) statusText.textContent = state.message || "摘要正在執行…";
    else if (state.finishedAt) statusText.textContent = `${state.result === "success" ? "完成" : "失敗"}：${state.message || ""}`;
    else statusText.textContent = "目前沒有手動任務；自動排程由摘要工具管理。";
    run.disabled = busy || state.running || !data || selected.size === 0;
    save.disabled = busy || state.running || !data;
    if (!state.running && poll) { clearInterval(poll); poll = undefined; }
    if (state.running && !poll) poll = setInterval(() => { void refreshStatus(); }, 3000);
  }

  async function refreshStatus(): Promise<void> {
    try { showStatus(await api<Status>("status")); }
    catch (error) { statusText.textContent = String(error); }
  }

  async function load(): Promise<void> {
    data = undefined;
    list.replaceChildren();
    statusText.textContent = "正在載入聊天室…";
    save.disabled = run.disabled = true;
    try {
      data = await api<Selection>("selection");
      selected = new Set(data.selectedIds);
      account.textContent = `登入帳號：${data.profileName}`;
      render();
      await refreshStatus();
    } catch (error) { statusText.textContent = `載入失敗：${error instanceof Error ? error.message : String(error)}`; }
  }

  async function saveSelection(): Promise<void> {
    if (!data) return;
    await api("selection", { profileId: data.profileId, selectedIds: [...selected] });
    statusText.textContent = `已儲存 ${selected.size} 個聊天室。`;
  }

  toggle.addEventListener("click", () => { dialog.showModal(); void load(); });
  byId<HTMLButtonElement>("summary-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => { if (poll) clearInterval(poll); poll = undefined; });
  search.addEventListener("input", render);
  save.addEventListener("click", async () => {
    if (busy) return;
    busy = true; save.disabled = run.disabled = true;
    let message = "";
    try { await saveSelection(); message = `已儲存 ${selected.size} 個聊天室。`; }
    catch (error) { message = `儲存失敗：${error instanceof Error ? error.message : String(error)}`; }
    finally { busy = false; await refreshStatus(); if (message) statusText.textContent = message; }
  });
  run.addEventListener("click", async () => {
    if (busy || selected.size === 0) return;
    busy = true; save.disabled = run.disabled = true;
    let errorMessage = "";
    try {
      await saveSelection();
      showStatus(await api<Status>("run", {}));
    } catch (error) { errorMessage = `執行失敗：${error instanceof Error ? error.message : String(error)}`; }
    finally { busy = false; await refreshStatus(); if (errorMessage) statusText.textContent = errorMessage; }
  });
}
