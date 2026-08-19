import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { TextEditCompletion } from "pi-agent-text-editor/api/edit-completion";

interface LastTextTransaction
{
    readonly before: string;
    readonly afterDigest: string;
}

export class LastTextTransactionStore
{
    readonly #transactions = new Map<string, LastTextTransaction>();

    public observe(completion: TextEditCompletion): void
    {
        const key = sourceKey(completion.resourceSource, completion.cwd);

        if (
            completion.intent !== "edit"
            || !completion.existed
            || completion.before.content === completion.after.content
        )
        {
            this.#transactions.delete(key);
            return;
        }

        this.#transactions.set(key, {
            before: completion.before.content,
            afterDigest: textDigest(completion.after.content),
        });
    }

    public restore(source: string, cwd: string, currentText: string): string
    {
        const key = sourceKey(source, cwd);
        const transaction = this.#transactions.get(key);

        if (transaction === undefined)
        {
            throw new Error(`No last text transaction is available for ${source}.`);
        }

        if (transaction.afterDigest !== textDigest(currentText))
        {
            this.#transactions.delete(key);
            throw new Error(`${source} changed after its last text transaction; refusing to overwrite newer text.`);
        }

        return transaction.before;
    }
}

function sourceKey(source: string, cwd: string): string
{
    if (source.startsWith("file://"))
    {
        return canonicalFile(fileURLToPath(new URL(source)));
    }

    if (/^[a-z][a-z\d+.-]*:/iu.test(source))
    {
        return source;
    }

    return canonicalFile(path.resolve(cwd, source));
}

function canonicalFile(file: string): string
{
    try
    {
        return realpathSync.native(file);
    }
    catch
    {
        return path.normalize(file);
    }
}

function textDigest(text: string): string
{
    return createHash("sha256").update(text).digest("hex");
}
