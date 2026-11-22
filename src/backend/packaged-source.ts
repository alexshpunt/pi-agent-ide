import { readFile } from "node:fs/promises";

/** Start reading a worker source shipped with the extension while its module loads.
 * A running Pi keeps the code it loaded. Reading a worker on first use instead could pair it
 * with a newer version on disk once the checkout or package changes, and the two sides would
 * then disagree about their protocol. A failed read surfaces where the promise is awaited.
 */
export function packagedSource(url: URL): Promise<string> {
  const source = readFile(url, "utf8");
  source.catch(() => {});
  return source;
}
