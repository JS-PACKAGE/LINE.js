export const MAX_STICKERS_PER_PACKAGE = 200;

export interface OwnedProduct {
  packageId: number;
  name: string;
  /** Fallback sticker ids from LINE's own product summary (first id + count ranges). */
  rangeStickerIds: number[];
}

export interface PackageMeta {
  name?: string;
  stickerIds: number[];
  animated: boolean;
}

function positiveInt(value: unknown): number | undefined {
  const number = typeof value === "bigint" ? Number(value) : typeof value === "string" && /^\d{1,12}$/.test(value) ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * getOwnedProductSummaries answers with untyped thrift. Observed shape: field 1 is the list of
 * products; each has 1 = package id, 11 = name and 93.1.1 = [{ 1: first sticker id, 2: count }].
 */
export function parseOwnedProducts(result: unknown): OwnedProduct[] {
  const list = asRecord(result)?.["1"];
  if (!Array.isArray(list)) return [];
  const products: OwnedProduct[] = [];
  const seen = new Set<number>();
  for (const entry of list) {
    const product = asRecord(entry);
    const packageId = positiveInt(product?.["1"]);
    if (!product || !packageId || seen.has(packageId)) continue;
    seen.add(packageId);
    const ranges = asRecord(asRecord(product["93"])?.["1"])?.["1"];
    const rangeStickerIds: number[] = [];
    for (const range of Array.isArray(ranges) ? ranges : []) {
      const first = positiveInt(asRecord(range)?.["1"]);
      const count = positiveInt(asRecord(range)?.["2"]);
      if (!first || !count) continue;
      for (let offset = 0; offset < count && rangeStickerIds.length < MAX_STICKERS_PER_PACKAGE; offset += 1) rangeStickerIds.push(first + offset);
    }
    products.push({ packageId, name: typeof product["11"] === "string" ? product["11"] : "", rangeStickerIds });
  }
  return products;
}

const TITLE_LOCALES = ["zh_TW", "zh-Hant", "zh_HK", "zh-TW", "en", "ja"];

/** The CDN's productInfo.meta: { title: { locale: text }, stickers: [{ id }], hasAnimation, ... }. */
export function parsePackageMeta(meta: unknown): PackageMeta | undefined {
  const info = asRecord(meta);
  if (!info || !Array.isArray(info.stickers)) return undefined;
  const stickerIds: number[] = [];
  for (const sticker of info.stickers) {
    const id = positiveInt(asRecord(sticker)?.id);
    if (id && stickerIds.length < MAX_STICKERS_PER_PACKAGE) stickerIds.push(id);
  }
  if (stickerIds.length === 0) return undefined;
  const titles = asRecord(info.title);
  const name = TITLE_LOCALES.map((locale) => titles?.[locale]).find((title) => typeof title === "string" && title.length > 0)
    ?? Object.values(titles ?? {}).find((title) => typeof title === "string" && title.length > 0);
  return { ...(typeof name === "string" ? { name } : {}), stickerIds, animated: info.hasAnimation === true };
}
