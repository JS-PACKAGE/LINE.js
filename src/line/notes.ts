const MAX_PREVIEW = 1000;
/** Longer than LINE lets a note be; anything past it is refused, not cut. */
const MAX_TEXT = 20_000;
const GROUP_HOME = /^c[0-9a-f]{32}$/;
export const SQUARE_HOME = /^s[A-Za-z0-9]{10,64}$/;
const POST_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Where a note lives: the group itself (GB) or the OpenChat community (SN). */
export interface NoteTarget {
  homeId: string;
  postId: string;
  /** LINE's own excerpt from the chat notification; not necessarily the whole post. */
  preview?: string;
}

/**
 * A note (記事本) post notification (content type POSTNOTIFICATION). Captures from other clients show
 * group notes as `serviceType: GB` with `…/group/home/posts/post?homeId=c…&postId=…` and OpenChat notes
 * as `serviceType: SN` with `line://square/post?squareMid=s…&postId=…`. Albums and shared VOOM posts
 * use the same content type with other service types; anything not matching exactly is no note.
 */
export function noteTarget(metadata: Record<string, string> | undefined): NoteTarget | undefined {
  const service = metadata?.serviceType;
  if ((service !== "GB" && service !== "SN") || typeof metadata?.postEndUrl !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(metadata.postEndUrl);
  } catch {
    return undefined;
  }
  const route = url.protocol === "line:" ? `${url.host}${url.pathname}`
    : url.protocol === "https:" && url.host === "line.me" && url.pathname.startsWith("/R/") ? url.pathname.slice(3) : undefined;
  const group = service === "GB";
  if (route !== (group ? "group/home/posts/post" : "square/post")) return undefined;
  const homeId = url.searchParams.get(group ? "homeId" : "squareMid");
  const postId = url.searchParams.get("postId");
  if (!homeId || !(group ? GROUP_HOME : SQUARE_HOME).test(homeId) || !postId || !POST_ID.test(postId)) return undefined;
  const preview = typeof metadata.text === "string" ? metadata.text.trim().slice(0, MAX_PREVIEW) : "";
  return { homeId, postId, ...(preview ? { preview } : {}) };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Throws unless LINE answered `code: 0`; its status code and a short message are kept for the log only. */
function accepted(response: unknown): Record<string, unknown> {
  const root = record(response);
  if (root?.code === 0) return root;
  const detail = root ? ` code=${JSON.stringify(root.code)?.slice(0, 20)} message=${JSON.stringify(String(root.message ?? "").slice(0, 80))}` : "";
  throw new Error(`NOTE_REFUSED${detail}`);
}

/**
 * The text of a note as the note API (`post/get.json`) returns it. The answer is LINE input: it must be
 * the very post asked for, and a note with pictures only has no text (""). Anything else throws.
 */
export function noteText(response: unknown, postId: string): string {
  const result = record(accepted(response).result);
  const post = record(result?.post) ?? record(record(result?.feed)?.post) ?? result;
  const contents = record(post?.contents);
  if (record(post?.postInfo)?.postId !== postId || !contents) throw new Error("NOTE_INVALID_RESPONSE");
  const text = contents.text ?? "";
  if (typeof text !== "string" || text.length > MAX_TEXT) throw new Error("NOTE_INVALID_TEXT");
  return text;
}

/** One post of a note list (`post/list.json`): enough to find the new ones and say who wrote them. */
export interface ListedNote {
  postId: string;
  createdAt: number;
  writerId?: string;
  writerName?: string;
}

const WRITER_ID = /^[A-Za-z0-9_-]{1,66}$/;

/** Posts of a note list; entries without a valid id and creation time are skipped, a list of another shape throws. */
export function listedNotes(response: unknown): ListedNote[] {
  const result = record(accepted(response).result);
  const entries = Array.isArray(result?.posts) ? result.posts
    : Array.isArray(result?.feeds) ? result.feeds.map((feed) => record(feed)?.post) : undefined;
  if (!entries) throw new Error("NOTE_INVALID_LIST");
  return entries.flatMap((entry): ListedNote[] => {
    const post = record(entry);
    const info = record(post?.postInfo);
    const user = record(post?.userInfo);
    const postId = info?.postId;
    const createdAt = Number(info?.createdTime);
    if (typeof postId !== "string" || !POST_ID.test(postId) || !Number.isSafeInteger(createdAt) || createdAt <= 0) return [];
    const writerId = typeof user?.writerMid === "string" && WRITER_ID.test(user.writerMid) ? user.writerMid : undefined;
    const writerName = typeof user?.nickname === "string" && user.nickname.trim() ? user.nickname.trim().slice(0, 100) : undefined;
    return [{ postId, createdAt, ...(writerId ? { writerId } : {}), ...(writerName ? { writerName } : {}) }];
  });
}

/** Why a note could not be read, for the log: this service's own codes as they are, anything else by class name only. */
export function noteFailureReason(error: unknown): string {
  if (error instanceof Error && /^(NOTE_|SESSION_CHANGED|NOT_AUTHENTICATED)/.test(error.message)) return error.message.replace(/[\r\n]/g, " ").slice(0, 200);
  return `LINE_ERROR name=${error instanceof Error ? error.name.slice(0, 40) : typeof error}`;
}
