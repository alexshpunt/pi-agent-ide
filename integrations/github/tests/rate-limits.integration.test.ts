import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionResult,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { currentIde } from "./fixtures/current-ide.ts";
import { githubPackageRoot } from "./fixtures/package-root.ts";

const root = githubPackageRoot;
const fixture = path.join(root, "tests/fixtures/rate-limit-provider.ts");
const source = "github://example/project/issues/12#body";
interface RateFailure {
  details?: {
    failure?: {
      cause?: {
        code?: string;
        effect?: string;
        metadata?: {
          rateLimit?: {
            retryAfterMs?: number;
            resetAt?: number;
            requestsLimit?: number;
            requestsRemaining?: number;
            endpoint?: string;
          };
        };
      };
    };
  };
  structuredContent?: {
    status: string;
    errors: {
      code: string;
      metadata?: {
        rateLimit?: {
          retryAfterMs?: number;
          resetAt?: number;
          requestsLimit?: number;
          requestsRemaining?: number;
          endpoint?: string;
        };
      };
    }[];
  };
}

// Each case crosses a real Pi agent, public provider registration, native tool, SDK, and local HTTP server.
test.each(["standalone", "ide"] as const)(
  "GitHub shows shared cooldown diagnostics in real Pi (%s)",
  async (mode) => {
    await mkdir(path.join(root, ".tmp"), { recursive: true });
    const cwd = await mkdtemp(path.join(root, ".tmp/rate-limit-pi-"));
    try {
      const ide = await currentIde();
      const name = mode === "standalone" ? "github_read" : "read";
      const result = await new PiIntegrationTest({
        testName: "github-rate-limits-" + mode,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        isolateUserResources: true,
        rawMode: false,
        tuiSize: { cols: 120, rows: 70 },
        extensions: mode === "standalone" ? [fixture] : [ide.extension, fixture],
        tools: [name, "rate_fixture_owner"],
        timeoutMs: 60_000,
        conversation: [
          assistantMessage([toolCall({ id: "first", name, arguments: { path: source } })], {
            stopReason: "toolUse",
          }),
          assistantMessage([toolCall({ id: "repeated", name, arguments: { path: source } })], {
            stopReason: "toolUse",
          }),
          assistantMessage(
            [
              toolCall({
                id: "generation",
                name: "rate_fixture_owner",
                arguments: { owner: "limited" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([toolCall({ id: "same-owner", name, arguments: { path: source } })], {
            stopReason: "toolUse",
          }),
          assistantMessage(
            [toolCall({ id: "switch", name: "rate_fixture_owner", arguments: { owner: "other" } })],
            { stopReason: "toolUse" },
          ),
          assistantMessage([toolCall({ id: "other-owner", name, arguments: { path: source } })], {
            stopReason: "toolUse",
          }),
          assistantMessage([text("Done")]),
        ],
      }).run(
        "Read the selected GitHub body; preserve a confirmed cooldown across equivalent credential generations, but keep a different quota owner independent.",
      );
      await ide.record(result.artifacts.directory);
      const http = JSON.parse(await readFile(path.join(cwd, "rate-limit-http.json"), "utf8")) as {
        requests: unknown[];
      };
      await writeFile(
        path.join(result.artifacts.directory, "rate-limit-http.json"),
        JSON.stringify(http, null, 2),
      );
      expect(result.exitCode).toBe(0);
      expect(result.state?.mode).toBe("tui");
      const evidence: { call: string; retryAfterMs: number; resetAt: number }[] = [];
      for (const id of ["first", "repeated", "same-owner"]) {
        expect(getToolExecution(result, id).isError).toBe(true);
        const failure = getToolExecutionResult(result, id) as RateFailure;
        expect(failure.details?.failure?.cause).toMatchObject({
          code: "GH_RATE_LIMITED",
          effect: "not-applied",
        });
        const info = failure.details?.failure?.cause?.metadata?.rateLimit;
        if (info?.retryAfterMs === undefined || info.resetAt === undefined)
          throw new Error("Expected cooldown timing");
        expect(info).toMatchObject({ requestsLimit: 5000, requestsRemaining: 0, endpoint: "core" });
        expect(info.retryAfterMs).toBeGreaterThan(45_000);
        expect(info.retryAfterMs).toBeLessThanOrEqual(60_000);
        expect(info.resetAt).toBeGreaterThan(Date.now());
        const output = getToolResultText(result, id);
        expect(output).toContain(String(Math.ceil(info.retryAfterMs / 1000)));
        expect(output).toContain(new Date(info.resetAt).toISOString());
        evidence.push({ call: id, retryAfterMs: info.retryAfterMs, resetAt: info.resetAt });
      }
      expect(getToolExecution(result, "other-owner").isError).toBe(false);
      expect(getToolResultText(result, "other-owner")).toContain("other-owner-readable-body");
      expect(http.requests).toEqual([
        { method: "GET", route: "/repos/example/project/issues/12", owner: "limited" },
        { method: "GET", route: "/repos/example/project/issues/12", owner: "other" },
      ]);
      const screen = result.tuiRenderedOutput;
      const last = evidence.at(-1);
      if (!last) throw new Error("Expected cooldown evidence");
      expect(screen).toContain(String(Math.ceil(last.retryAfterMs / 1000)));
      expect(screen).toContain(new Date(last.resetAt).toISOString());
      expect(screen).toContain("other-owner-readable-body");
      for (const value of [
        screen,
        ...["first", "repeated", "same-owner"].map((id) =>
          JSON.stringify(getToolExecutionResult(result, id)),
        ),
      ]) {
        expect(value).not.toMatch(/rate-fixture-private-(?:upstream-payload|credential)/u);
      }
      await writeFile(
        path.join(result.artifacts.directory, "rate-limit-evidence.json"),
        JSON.stringify(
          {
            mode,
            provider: "scripted",
            realPi: true,
            nativeTui: true,
            http: http.requests,
            cooldowns: evidence,
            actualCalls: http.requests.length,
            sameOwnerCalls: 1,
            presentation: "Native Pi PTY capture; not a Windows Computer Use screenshot",
          },
          null,
          2,
        ),
      );
      // The requested structured failure contract is checked separately from model text and rendering.
      for (const id of ["first", "repeated", "same-owner"]) {
        const structured = (getToolExecutionResult(result, id) as RateFailure).structuredContent;
        expect(structured?.status).toBe("error");
        expect(structured?.errors).toHaveLength(1);
        expect(structured?.errors[0]).toMatchObject({
          code: "GH_RATE_LIMITED",
          metadata: { rateLimit: { requestsLimit: 5000, requestsRemaining: 0, endpoint: "core" } },
        });
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  90_000,
);
