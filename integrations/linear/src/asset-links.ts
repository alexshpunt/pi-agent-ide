// Allow adjacent prose in exported requests, but consume external URLs before their nested assets.
const urlToken =
  /(?<![:/?&=%#@.+-])(?:https:\/\/uploads\.linear\.app\/[^\s<>"'`()[\]]+|https?:\/\/[^\s<>"'`]+)/gu;

/** Keep Markdown snapshots stable by removing only Linear's temporary asset signatures. */
export function stableLinearAssetLinks(content: string): string {
  return content.replace(urlToken, (token: string, offset: number) => {
    if (!token.startsWith("https://uploads.linear.app/")) return token;
    // A bare URL can end with prose punctuation; a delimited link owns its whole target.
    const delimited = content[offset - 1] === "<" || content.slice(offset - 2, offset) === "](";
    const punctuation = delimited ? "" : (/[.,;:!?]+$/u.exec(token)?.[0] ?? "");
    const link = punctuation ? token.slice(0, -punctuation.length) : token;
    const hash = link.indexOf("#");
    const suffix = hash < 0 ? "" : link.slice(hash);
    const base = hash < 0 ? link : link.slice(0, hash);
    const query = base.indexOf("?");
    if (query < 0) return token;
    const parts = base.slice(query + 1).split("&");
    const kept = parts.filter((part) => part.split("=", 1)[0] !== "signature");
    if (kept.length === parts.length) return token;
    return base.slice(0, query) + (kept.length ? `?${kept.join("&")}` : "") + suffix + punctuation;
  });
}
