// Prefix offsets use measured row heights; unvisited results keep a conservative estimate.
// Only the viewport and overscan own DOM, even when every retained message matches.
export class SearchWindow<T> {
  private items: readonly T[] = [];
  private heights: number[] = [];
  private offsets: number[] = [0];
  private rows = new Map<number, HTMLElement>();
  private frame: number | undefined;
  private width = 0;
  private active = false;
  private top = document.createElement("div");
  private bottom = document.createElement("div");
  private observer: ResizeObserver;
  private note = document.createElement("p");
  private host: HTMLElement;
  private makeRow: (item: T) => HTMLElement;
  private key: (item: T) => unknown;

  constructor(host: HTMLElement, makeRow: (item: T) => HTMLElement, key: (item: T) => unknown = (item) => item) {
    this.host = host;
    this.makeRow = makeRow;
    this.key = key;
    this.note.className = "history-note search-note";
    this.top.className = this.bottom.className = "search-spacer";
    this.top.ariaHidden = this.bottom.ariaHidden = "true";
    this.observer = new ResizeObserver(() => this.schedule());
    this.observer.observe(host);
    host.addEventListener("scroll", () => this.schedule());
    host.addEventListener("keydown", (event) => {
      if (!this.active) return;
      const row = (event.target as Element).closest<HTMLElement>("[data-search-index]");
      if (!row) return;
      const index = Number(row.dataset.searchIndex);
      const next = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? this.items.length - 1 : undefined;
      if (next === undefined || next < 0 || next >= this.items.length) return;
      event.preventDefault();
      this.host.scrollTop = this.note.offsetHeight + this.offsets[next]!;
      this.draw();
      this.rows.get(next)?.focus({ preventScroll: true });
    });
  }

  set(items: readonly T[], note: string, reset: boolean): void {
    const previousTop = this.host.scrollTop;
    const previousIndex = this.indexAt(Math.max(0, previousTop - this.note.offsetHeight));
    const previousItem = this.items[previousIndex];
    const within = Math.max(0, previousTop - this.note.offsetHeight - this.offsets[previousIndex]!);
    const known = new Map(this.items.map((item, index) => [this.key(item), this.heights[index]!]));
    this.clear();
    this.active = true;
    this.items = items;
    this.heights = items.map((item) => {
      const previous = known.get(this.key(item));
      return reset ? 100 : previous ?? 100;
    });
    this.reindex();
    this.note.textContent = note;
    this.host.classList.add("search-results");
    this.top.style.height = "0px";
    this.bottom.style.height = `${this.offsets[this.items.length]}px`;
    this.host.replaceChildren(this.note, this.top, this.bottom);
    const nextIndex = !reset && previousItem !== undefined ? items.findIndex((item) => this.key(item) === this.key(previousItem)) : -1;
    this.host.scrollTop = reset ? 0 : nextIndex >= 0 ? this.note.offsetHeight + this.offsets[nextIndex]! + within : previousTop;
    this.draw();
  }

  clear(): void {
    this.active = false;
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    for (const row of this.rows.values()) this.observer.unobserve(row);
    this.rows.clear();
    this.items = [];
    this.heights = [];
    this.offsets = [0];
    this.host.replaceChildren();
    this.host.classList.remove("search-results");
  }

  private reindex(): void {
    this.offsets = [0];
    for (const height of this.heights) this.offsets.push(this.offsets.at(-1)! + height);
  }

  private indexAt(offset: number): number {
    let low = 0;
    let high = this.items.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.offsets[mid + 1]! <= offset) low = mid + 1;
      else high = mid;
    }
    return Math.min(low, Math.max(0, this.items.length - 1));
  }

  private schedule(): void {
    if (!this.active || this.frame !== undefined) return;
    this.frame = requestAnimationFrame(() => { this.frame = undefined; this.draw(); });
  }

  private draw(): void {
    if (!this.active) return;
    let top = Math.max(0, this.host.scrollTop - this.note.offsetHeight);
    const anchor = this.indexAt(top);
    const within = top - this.offsets[anchor]!;
    let resized = false;
    if (this.width !== this.host.clientWidth) {
      this.width = this.host.clientWidth;
      this.heights.fill(100);
      this.reindex();
      top = this.offsets[anchor]! + within;
      resized = true;
    }
    const first = Math.max(0, anchor - 5);
    const last = Math.min(this.items.length, this.indexAt(top + this.host.clientHeight) + 6);
    const wanted = new Set<number>();
    for (let index = first; index < last; index++) wanted.add(index);
    for (const [index, row] of this.rows) {
      if (wanted.has(index)) continue;
      this.observer.unobserve(row);
      row.remove();
      this.rows.delete(index);
    }
    for (let index = first; index < last; index++) {
      if (this.rows.has(index)) continue;
      const row = this.makeRow(this.items[index]!);
      row.dataset.searchIndex = String(index);
      row.setAttribute("aria-posinset", String(index + 1));
      row.setAttribute("aria-setsize", String(this.items.length));
      this.rows.set(index, row);
      this.observer.observe(row);
    }
    let cursor: ChildNode = this.bottom;
    for (let index = last - 1; index >= first; index--) {
      const row = this.rows.get(index)!;
      if (row.nextSibling !== cursor) this.host.insertBefore(row, cursor);
      cursor = row;
    }
    let changed = resized;
    for (const [index, row] of this.rows) {
      const height = row.getBoundingClientRect().height;
      if (height > 0 && Math.abs(height - this.heights[index]!) > 0.5) {
        this.heights[index] = height;
        changed = true;
      }
    }
    if (changed) this.reindex();
    this.top.style.height = `${this.offsets[first] ?? 0}px`;
    this.bottom.style.height = `${this.offsets[this.items.length]! - this.offsets[last]!}px`;
    if (changed) {
      this.host.scrollTop = this.note.offsetHeight + this.offsets[anchor]! + within;
      this.schedule();
    }
  }
}
