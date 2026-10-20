import { chmod, lstat, mkdir, readFile, realpath, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Pi refreshes OAuth five minutes early; a bounded attempt must finish before that window. */
export const OAUTH_REFRESH_WINDOW_MS = 5 * 60 * 1000;

/** Public policy contains no tokens and may be retained with verification evidence. */
export interface AuthPolicy {
  /** Credential owner; it can differ from a connector's selected model provider. */
  provider: string;
  modelProvider?: string;
  /** Dedicated Claude-file auth is supported only by the pinned file-reading connector. */
  claudeCredentialFile?: string;
  expiresAt: number | null;
  refreshAllowed: boolean;
}

/** Secret-bearing values stay in process memory or disposable private state, never the manifest. */
export interface StagedAuthentication {
  environment: Record<string, string>;
  policy: AuthPolicy;
  redact(text: string): string;
  containsSecret(text: string): boolean;
  /** Bind only the dedicated auth file, never its settings, sessions or containing home. */
  mount?: { source: string; target: string };
  /** Learn rotated secrets before retaining any child output. */
  refreshSecrets?(): Promise<void>;
  /** Release this attempt's exclusive claim on the dedicated login. */
  release?(): Promise<void>;
}

/** Auth failures deliberately omit JSON parser excerpts and credential values. */
export class AuthenticationUnavailable extends Error {}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function snapshot(
  directory: string | undefined,
  name: string,
  kind: string,
): Promise<Record<string, unknown>> {
  if (!directory)
    throw new AuthenticationUnavailable(
      `An explicit dedicated ${kind} authentication directory is required`,
    );
  try {
    const root = await realpath(directory);
    if (
      [
        os.homedir(),
        path.join(os.homedir(), ".claude"),
        path.join(os.homedir(), ".pi/agent"),
        process.env.PI_CODING_AGENT_DIR,
        process.env.CLAUDE_CONFIG_DIR,
      ]
        .filter(Boolean)
        .includes(root)
    )
      throw new AuthenticationUnavailable(
        "Personal authentication directories cannot be used as dedicated test state",
      );
    const file = path.join(root, name);
    if (!(await lstat(file)).isFile())
      throw new AuthenticationUnavailable(
        `The dedicated ${kind} authentication snapshot must be a regular file`,
      );
    const parsed = object(JSON.parse(await readFile(file, "utf8")));
    if (!parsed)
      throw new AuthenticationUnavailable(
        `The dedicated ${kind} authentication snapshot must be an object`,
      );
    return parsed;
  } catch (error) {
    if (error instanceof AuthenticationUnavailable) throw error;
    throw new AuthenticationUnavailable(
      `The dedicated ${kind} authentication snapshot is unavailable or malformed`,
    );
  }
}

function token(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._~+/=:-]+$/.test(value))
    throw new AuthenticationUnavailable(
      "The authentication snapshot has no usable literal access token",
    );
  return value;
}

/** Reject expired or soon-expiring snapshots before starting Pi or a Claude child. */
export function assertAuthLifetime(
  expiresAt: unknown,
  timeoutMs: number,
  now = Date.now(),
): asserts expiresAt is number {
  if (
    typeof expiresAt !== "number" ||
    !Number.isFinite(expiresAt) ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 1000 ||
    expiresAt <= now + timeoutMs + OAUTH_REFRESH_WINDOW_MS
  )
    throw new AuthenticationUnavailable(
      "Access token expires before the bounded attempt and no-refresh safety window finish",
    );
}

function staged(
  provider: string,
  access: string,
  expiresAt: number | null,
  secrets: Set<string> = new Set([access]),
): StagedAuthentication {
  return {
    environment: {},
    policy: { provider, expiresAt, refreshAllowed: false },
    redact: (text) => {
      for (const secret of [...secrets].sort((a, b) => b.length - a.length))
        text = text.replaceAll(secret, "[REDACTED_AUTH_TOKEN]");
      return text;
    },
    containsSecret: (text) => [...secrets].some((secret) => text.includes(secret)),
  };
}

/** Write only the selected provider and remove refresh material while retaining OAuth classification. */
export async function stagePiAuthentication(
  state: string,
  provider: string,
  directory: string | undefined,
  timeoutMs: number,
  requireOAuth = false,
): Promise<StagedAuthentication> {
  const data = await snapshot(directory, "auth.json", "Pi");
  const credential = object(data[provider]);
  if (!credential)
    throw new AuthenticationUnavailable("The dedicated Pi snapshot lacks the selected provider");
  let result: StagedAuthentication;
  let safeCredential: Record<string, unknown>;
  if (credential.type === "oauth") {
    const access = token(credential.access);
    assertAuthLifetime(credential.expires, timeoutMs);
    // Keep the stored type for isUsingOAuth(), but never provide a refresh token.
    safeCredential = { type: "oauth", access, expires: credential.expires, refresh: "" };
    result = staged(provider, access, credential.expires);
  } else {
    if (requireOAuth || provider === "openai-codex")
      throw new AuthenticationUnavailable(
        "This subscription route requires an expiring OAuth access-token snapshot",
      );
    if (credential.type !== "api_key")
      throw new AuthenticationUnavailable("Unsupported authentication snapshot type");
    const access = token(credential.key);
    if (access.startsWith("sk-ant-oat"))
      throw new AuthenticationUnavailable(
        "OAuth access tokens require their original expiry metadata",
      );
    safeCredential = { type: "api_key", key: access };
    result = staged(provider, access, null);
  }
  const agent = path.join(state, "agent");
  await mkdir(agent, { recursive: true, mode: 0o700 });
  await writeFile(path.join(agent, "auth.json"), JSON.stringify({ [provider]: safeCredential }), {
    mode: 0o600,
  });
  await chmod(path.join(agent, "auth.json"), 0o600);
  await writeFile(path.join(state, "auth-policy.json"), JSON.stringify(result.policy));
  return result;
}

/** Dedicated refresh is an explicit paid-run choice, never a free-check or implicit default. */
export function assertDedicatedAuthInvocation(args: readonly string[], authKind?: string): void {
  if (!args.includes("--dedicated-auth")) return;
  const authIndex = args.indexOf("--auth-dir");
  if (
    !args.includes("--run") ||
    args.includes("--preflight") ||
    authIndex < 0 ||
    !args[authIndex + 1] ||
    args[authIndex + 1]?.startsWith("--") ||
    (authKind !== undefined && authKind !== "pi")
  )
    throw new AuthenticationUnavailable(
      "--dedicated-auth requires --run and an explicit Pi --auth-dir; Claude CLI authentication remains access-only",
    );
}
/**
 * Share only an explicitly selected dedicated login's auth.json with one bounded trial.
 * Pi writes refresh rotations directly to that file; even a timed-out child cannot lose a
 * completed rotation during workspace cleanup. Personal paths and shared/hard-linked files reject.
 */
export async function stageDedicatedPiAuthentication(
  state: string,
  provider: string,
  directory: string | undefined,
): Promise<StagedAuthentication> {
  if (!directory)
    throw new AuthenticationUnavailable(
      "Dedicated refresh requires an explicit private auth directory",
    );
  const root = await realpath(directory);
  if (
    root === os.homedir() ||
    [path.join(os.homedir(), ".pi"), path.join(os.homedir(), ".claude")].some(
      (personal) => root === personal || root.startsWith(personal + path.sep),
    )
  )
    throw new AuthenticationUnavailable(
      "Dedicated refresh cannot use personal authentication paths",
    );
  const source = path.join(root, "auth.json");
  const file = await lstat(source);
  if (
    !file.isFile() ||
    file.nlink !== 1 ||
    file.uid !== process.getuid?.() ||
    (file.mode & 0o077) !== 0
  )
    throw new AuthenticationUnavailable(
      "Dedicated refresh requires an owned private regular auth file with no hard links",
    );
  const lock = path.join(root, ".capability-auth.lock");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    throw new AuthenticationUnavailable(
      "The dedicated login is already in use or cannot be locked",
    );
  }
  try {
    const data = await snapshot(root, "auth.json", "Pi");
    const credential = object(data[provider]);
    if (Object.keys(data).length !== 1 || credential?.type !== "oauth")
      throw new AuthenticationUnavailable(
        "Dedicated refresh requires only the selected provider's OAuth login",
      );
    const access = token(credential.access);
    const refresh = token(credential.refresh);
    if (typeof credential.expires !== "number" || !Number.isFinite(credential.expires))
      throw new AuthenticationUnavailable("Dedicated OAuth login lacks an expiry timestamp");
    const secrets = new Set([access, refresh]);
    const result = staged(provider, access, credential.expires, secrets);
    result.policy.refreshAllowed = true;
    const audit = path.join(state, "auth-secrets.jsonl");
    const agent = path.join(state, "agent");
    await mkdir(agent, { recursive: true, mode: 0o700 });
    await writeFile(path.join(agent, "auth.json"), JSON.stringify(data), { mode: 0o600 });
    await writeFile(audit, "", { mode: 0o600 });
    await writeFile(path.join(state, "auth-policy.json"), JSON.stringify(result.policy));
    result.mount = { source, target: "/state/agent/auth.json" };
    result.refreshSecrets = async () => {
      try {
        const remember = (value: unknown) => {
          const oauth = object(value);
          if (!oauth || oauth.type !== "oauth") throw new Error("Invalid dedicated credential");
          secrets.add(token(oauth.access));
          secrets.add(token(oauth.refresh));
        };
        const retained = object(JSON.parse(await readFile(source, "utf8")));
        remember(retained?.[provider]);
        for (const line of (await readFile(audit, "utf8")).split("\n"))
          if (line) remember(JSON.parse(line));
      } catch {
        throw new AuthenticationUnavailable(
          "Cannot audit rotated credentials; child output must not be retained",
        );
      }
    };
    result.release = () => rmdir(lock);
    return result;
  } catch (error) {
    await rmdir(lock);
    throw error;
  }
}
/**
 * Persist only the pinned file-auth connector's dedicated credential file. Its synchronous
 * writes preserve the bind-mounted inode; atomic-renaming credential stores need a different mode.
 */
export async function stageDedicatedClaudeFileAuthentication(
  state: string,
  provider: string,
  directory: string | undefined,
): Promise<StagedAuthentication> {
  if (provider !== "anthropic" || !directory)
    throw new AuthenticationUnavailable(
      "Claude-file authentication requires an explicit private Claude directory and Anthropic provider",
    );
  if (!(await lstat(directory)).isDirectory())
    throw new AuthenticationUnavailable(
      "Claude-file authentication directory must not be a symlink",
    );
  const root = await realpath(directory);
  if (
    root === os.homedir() ||
    [path.join(os.homedir(), ".pi"), path.join(os.homedir(), ".claude")].some(
      (personal) => root === personal || root.startsWith(personal + path.sep),
    )
  )
    throw new AuthenticationUnavailable("Claude-file authentication cannot use personal paths");
  const dir = await lstat(root);
  const source = path.join(root, ".credentials.json");
  const file = await lstat(source);
  const uid = process.getuid?.();
  if (
    !dir.isDirectory() ||
    dir.uid !== uid ||
    (dir.mode & 0o077) !== 0 ||
    !file.isFile() ||
    file.nlink !== 1 ||
    file.uid !== uid ||
    (file.mode & 0o077) !== 0
  )
    throw new AuthenticationUnavailable(
      "Claude-file authentication requires an owned private directory and regular credential file without links",
    );
  const lock = path.join(root, ".capability-claude-file.lock");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    throw new AuthenticationUnavailable(
      "The dedicated Claude login is already in use or cannot be locked",
    );
  }
  try {
    const data = await snapshot(root, ".credentials.json", "Claude");
    const oauth = object(data.claudeAiOauth);
    if (
      Object.keys(data).some((key) => key !== "claudeAiOauth") ||
      !oauth ||
      typeof oauth.expiresAt !== "number" ||
      !Number.isFinite(oauth.expiresAt)
    )
      throw new AuthenticationUnavailable(
        "Dedicated Claude credential file lacks OAuth expiry metadata",
      );
    const access = token(oauth.accessToken);
    const refresh = token(oauth.refreshToken);
    const secrets = new Set([access, refresh]);
    const result = staged(provider, access, oauth.expiresAt, secrets);
    result.policy.refreshAllowed = true;
    result.policy.claudeCredentialFile = "/state/home/.claude/.credentials.json";
    result.environment.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    const home = path.join(state, "home/.claude");
    const agent = path.join(state, "agent");
    const audit = path.join(state, "auth-secrets.jsonl");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(agent, { recursive: true, mode: 0o700 });
    await writeFile(path.join(home, ".credentials.json"), "{}", { mode: 0o600 });
    await writeFile(path.join(agent, "auth.json"), "{}", { mode: 0o600 });
    await writeFile(audit, "", { mode: 0o600 });
    await writeFile(path.join(state, "auth-policy.json"), JSON.stringify(result.policy));
    result.mount = { source, target: result.policy.claudeCredentialFile };
    result.refreshSecrets = async () => {
      try {
        const remember = (value: unknown, claude = false) => {
          const credential = object(value);
          if (!credential) throw new Error("Invalid credential");
          secrets.add(token(credential[claude ? "accessToken" : "access"]));
          secrets.add(token(credential[claude ? "refreshToken" : "refresh"]));
        };
        const retained = object(JSON.parse(await readFile(source, "utf8")));
        remember(retained?.claudeAiOauth, true);
        const seeded = object(JSON.parse(await readFile(path.join(agent, "auth.json"), "utf8")));
        if (!seeded || Object.keys(seeded).some((key) => key !== provider))
          throw new Error("Unexpected seeded auth provider");
        if (seeded[provider]) remember(seeded[provider]);
        for (const line of (await readFile(audit, "utf8")).split("\n"))
          if (line) remember(JSON.parse(line));
      } catch {
        throw new AuthenticationUnavailable(
          "Cannot audit Claude-file rotations; child output must not be retained",
        );
      }
      if (
        await lstat(path.join(state, "claude-fallback-attempted")).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        )
      )
        throw new AuthenticationUnavailable(
          "The connector attempted blocked Claude CLI fallback inference",
        );
    };
    result.release = () => rmdir(lock);
    return result;
  } catch (error) {
    await rmdir(lock);
    throw error;
  }
}
/** Claude Code gets an access-token-only environment, not a refresh-capable credential file. */
export async function stageClaudeAuthentication(
  state: string,
  provider: string,
  directory: string | undefined,
  timeoutMs: number,
): Promise<StagedAuthentication> {
  const data = await snapshot(directory, ".credentials.json", "Claude");
  const credential = object(data.claudeAiOauth);
  if (!credential)
    throw new AuthenticationUnavailable(
      "The dedicated Claude snapshot lacks Claude OAuth credentials",
    );
  const access = token(credential.accessToken);
  assertAuthLifetime(credential.expiresAt, timeoutMs);
  const result = staged(provider, access, credential.expiresAt);
  result.environment.CLAUDE_CODE_OAUTH_TOKEN = access;
  result.environment.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  await mkdir(path.join(state, "home/.claude"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(state, "agent"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(state, "agent/auth.json"), "{}", { mode: 0o600 });
  await writeFile(path.join(state, "auth-policy.json"), JSON.stringify(result.policy));
  return result;
}
