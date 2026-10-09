// Reads S3 ListObjectsV2 responses from R2.
import type { StorageObject } from "./model.ts";

const unescapeXml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1];

export type ListPage = { objects: StorageObject[]; prefixes: string[]; next: string | null };

export function parseListPage(xml: string): ListPage {
  const objects: StorageObject[] = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    objects.push({
      key: unescapeXml(tag(m[1], "Key") ?? ""),
      size: Number(tag(m[1], "Size") ?? 0),
      lastModified: tag(m[1], "LastModified") ?? null,
    });
  }
  const prefixes = [...xml.matchAll(/<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g)].map((m) => unescapeXml(tag(m[1], "Prefix") ?? ""));
  const truncated = tag(xml, "IsTruncated") === "true";
  const token = tag(xml, "NextContinuationToken");
  return { objects, prefixes, next: truncated && token ? unescapeXml(token) : null };
}

/** Query string for one ListObjectsV2 page. */
export function listQuery(opts: { prefix?: string; delimiter?: string; token?: string | null }): string {
  const qs = new URLSearchParams({ "list-type": "2", "max-keys": "1000" });
  if (opts.prefix) qs.set("prefix", opts.prefix);
  if (opts.delimiter) qs.set("delimiter", opts.delimiter);
  if (opts.token) qs.set("continuation-token", opts.token);
  return qs.toString();
}
