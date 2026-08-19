import { readdir } from "node:fs/promises";
import path from "node:path";

export async function collectFiles(directory: string): Promise<string[]>
{
    const files: string[] = [];
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries)
    {
        const entryPath = path.join(directory, entry.name);

        if (entry.isDirectory())
        {
            files.push(...await collectFiles(entryPath));
        }
        else if (entry.isFile() || entry.isSymbolicLink())
        {
            files.push(entryPath);
        }
    }

    return files;
}
