import { GithubConnectionStore } from "#github/connections/store.ts";

const [directory, id] = process.argv.slice(2);
if (!directory || !id) throw new Error("worker input missing");
const store = new GithubConnectionStore(directory);
const previous = await store.withSecret(id, async (secret) => {
  if (secret?.kind !== "device") throw new Error("worker connection missing");
  const generation = Number(secret.refreshToken?.split("-").at(-1));
  await new Promise((resolve) => setTimeout(resolve, 80));
  return {
    secret: { ...secret, accessToken: `access-${generation + 1}`, refreshToken: `rotation-${generation + 1}` },
    value: generation,
  };
});
process.stdout.write(String(previous));
