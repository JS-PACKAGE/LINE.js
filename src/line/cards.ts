import type { MessageCard } from "../model/dto.js";

/** LINE's ContentType numbers (linejs-types `ContentType`), so the browser only ever sees one spelling. */
const CONTENT_TYPE_NAMES = [
  "NONE", "IMAGE", "VIDEO", "AUDIO", "HTML", "PDF", "CALL", "STICKER", "PRESENCE", "GIFT", "GROUPBOARD", "APPLINK",
  "LINK", "CONTACT", "FILE", "LOCATION", "POSTNOTIFICATION", "RICH", "CHATEVENT", "MUSIC", "PAYMENT", "EXTIMAGE", "FLEX",
] as const;

export function contentTypeName(contentType: string): string {
  return /^\d{1,2}$/.test(contentType) ? (CONTENT_TYPE_NAMES[Number(contentType)] ?? contentType) : contentType;
}

const MAX_FIELD = 200;
const MAX_ALT_TEXT = 400;

function field(value: unknown, max = MAX_FIELD): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function coordinate(value: unknown, limit: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit ? value : undefined;
}

/**
 * The shown-as-text part of a location, contact, file or flex message, from the fields linejs types and
 * reads (`Message.location`; `displayName`, `FILE_NAME`/`FILE_SIZE`, `ALT_TEXT` metadata). Anything
 * missing or malformed yields no card, and the message stays a type placeholder.
 */
export function messageCard(contentType: string, metadata: Record<string, string> | undefined, location: unknown): MessageCard | undefined {
  switch (contentType) {
    case "LOCATION": {
      const place = location && typeof location === "object" ? (location as Record<string, unknown>) : undefined;
      const latitude = coordinate(place?.latitude, 90);
      const longitude = coordinate(place?.longitude, 180);
      if (latitude === undefined || longitude === undefined) return undefined;
      const title = field(place?.title);
      const address = field(place?.address);
      return { kind: "location", latitude, longitude, ...(title ? { title } : {}), ...(address ? { address } : {}) };
    }
    case "CONTACT": {
      const name = field(metadata?.displayName);
      return name ? { kind: "contact", name } : undefined;
    }
    case "FILE": {
      const name = field(metadata?.FILE_NAME);
      if (!name) return undefined;
      const size = Number(metadata?.FILE_SIZE);
      return { kind: "file", name, ...(Number.isSafeInteger(size) && size >= 0 ? { size } : {}) };
    }
    case "FLEX": {
      const altText = field(metadata?.ALT_TEXT, MAX_ALT_TEXT);
      return altText ? { kind: "flex", altText } : undefined;
    }
    default:
      return undefined;
  }
}
