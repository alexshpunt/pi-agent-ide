import { required } from "./fixtures/check.ts";
import { encode } from "@toon-format/toon-v4";
import { expect, test, vi } from "vitest";
import { createAxiPageReader } from "#linear/pages.ts";
import { createLinearResolver } from "#linear/read.ts";

const base = "https://linear.app/example/team/ENG";
const team = { id: "team-id", key: "ENG", name: "Engineering", visibility: "public" };
const issue = {
  id: "ENG-12",
  title: "A task",
  url: "https://linear.app/example/issue/ENG-12/a-task",
  teamId: team.id,
  status: "Done",
};
const project = {
  id: "project-id",
  uuid: "71000000-0000-4000-8000-000000000002",
  name: "Example project",
  url: "https://linear.app/example/project/example-ab12cd34ef56",
  description: "Full description\nLast line",
  status: { name: "In Progress" },
  resources: [
    {
      type: "document",
      id: "71000000-0000-4000-8000-000000000006",
      title: "Spec",
      url: "https://linear.app/example/document/spec-1234abcd5678",
    },
  ],
  resourceCount: 1,
};
function backend(overrides: Partial<Record<string, string>> = {}) {
  return vi.fn(async (_cwd: string, args: readonly string[]) => {
    const key = args.slice(0, 2).join(" ");
    if (overrides[key] !== undefined) return overrides[key];
    if (key === "teams view") return encode({ team });
    if (key === "projects view") return encode({ project });
    if (key === "issues list")
      return args.includes("--cursor")
        ? encode({ count: 1, issues: [issue] })
        : encode({ count: "1 returned (more available)", cursor: "next/page", issues: [issue] });
    if (key === "projects list")
      return encode({ count: 1, projects: [{ ...project, teams: JSON.stringify([team]) }] });
    throw new Error("Unexpected command");
  });
}

test("team overview validates its workspace and exposes navigation, not fabricated pinned resources", async () => {
  const run = backend();
  const text = await createAxiPageReader(run)(`${base}/overview`, "/workspace");
  expect(text).toContain("Engineering");
  expect(text).toContain(`${base}/all`);
  expect(text).toContain(`${base}/projects/all`);
  expect(text).toContain("Pinned resources are not exposed");
  expect(run.mock.calls[1]?.[1]).toContain("--all-projects");
  await expect(
    createAxiPageReader(run)(base.replace("example", "other") + "/overview", "/workspace"),
  ).rejects.toThrow("LINEAR_IDENTITY_MISMATCH");
});

test("issue list uses bounded team scope and a readable opaque continuation URL", async () => {
  const run = backend();
  const reader = createAxiPageReader(run);
  const text = await reader(`${base}/all`, "/workspace");
  expect(text).toContain("ENG-12");
  expect(text).toContain(`${base}/all?cursor=next%2Fpage`);
  expect(text).toContain("more available");
  await reader(`${base}/all?cursor=next%2Fpage`, "/workspace");
  expect(run.mock.calls.at(-1)?.[1]).toEqual([
    "issues",
    "list",
    "--team",
    "ENG",
    "--all-projects",
    "--limit",
    "50",
    "--fields",
    "id,title,url,teamId,status",
    "--cursor",
    "next/page",
  ]);
});

test("project list and card expose full descriptions and lazy resource links", async () => {
  const run = backend();
  const reader = createAxiPageReader(run);
  expect(await reader(`${base}/projects/all`, "/workspace")).toContain(project.url);
  const card = await reader(project.url + "/overview", "/workspace");
  expect(card).toContain(project.description);
  expect(card).toContain(required(project.resources[0]).url);
  expect(card).not.toContain("Full document content");
  expect(run.mock.calls.at(-1)?.[1]).toEqual(["projects", "view", "ab12cd34ef56", "--full"]);
  await expect(
    reader(project.url.replace("example/project", "other/project"), "/workspace"),
  ).rejects.toThrow("LINEAR_IDENTITY_MISMATCH");
});

test("refuses wrong team rows, truncated tables, and ambiguous empty team identity", async () => {
  for (const issues of [
    [{ ...issue, teamId: "other-team" }],
    [{ ...issue, url: issue.url.replace("example", "other") }],
  ]) {
    await expect(
      createAxiPageReader(backend({ "issues list": encode({ issues }) }))(
        `${base}/all`,
        "/workspace",
      ),
    ).rejects.toThrow("LINEAR_IDENTITY_MISMATCH");
  }
  await expect(
    createAxiPageReader(backend({ "issues list": "issues[1]{id,title,url,teamId,status}:\n" }))(
      `${base}/all`,
      "/workspace",
    ),
  ).rejects.toThrow("LINEAR_INVALID_RESPONSE");
  await expect(
    createAxiPageReader(
      backend({ "issues list": encode({ issues: [] }), "projects list": encode({ projects: [] }) }),
    )(`${base}/overview`, "/workspace"),
  ).rejects.toThrow("LINEAR_WORKSPACE_UNVERIFIED");
  await expect(
    createAxiPageReader(
      backend({
        "projects list": encode({
          projects: [{ ...project, teams: JSON.stringify([{ id: "other-team" }]) }],
        }),
      }),
    )(`${base}/projects/all`, "/workspace"),
  ).rejects.toThrow("LINEAR_IDENTITY_MISMATCH");
});

test("empty lists are explicit after checking workspace through another team resource", async () => {
  const text = await createAxiPageReader(backend({ "issues list": encode({ issues: [] }) }))(
    `${base}/all`,
    "/workspace",
  );
  expect(text).toContain("Items on this page: 0");
  expect(text).toContain("End of list");
});

test("ignores human CLI help but still rejects a missing continuation cursor", async () => {
  const data = encode({
    count: "1 returned (more available)",
    cursor: "next/page",
    issues: [issue],
  });
  const text = await createAxiPageReader(
    backend({ "issues list": data + "\nhelp[2]:\n  Run a command\n  Run another command" }),
  )(`${base}/all`, "/workspace");
  expect(text).toContain("?cursor=next%2Fpage");
  await expect(
    createAxiPageReader(
      backend({ "issues list": encode({ count: "1 returned (more available)", issues: [issue] }) }),
    )(`${base}/all`, "/workspace"),
  ).rejects.toThrow("LINEAR_INVALID_RESPONSE");
});
test.each([null, ""])(
  "native project pages accept an empty description (%s) and omitted zero resources",
  async (description) => {
    const { resources: _resources, ...empty } = project;
    const run = backend({
      "projects view": encode({ project: { ...empty, description, resourceCount: 0 } }),
    });
    const reader = createAxiPageReader(run);
    for (const source of [project.url, project.url + "/overview"]) {
      const card = await reader(source, "/workspace");
      expect(card).toContain("# Example project");
      expect(card).toContain(`URL: ${project.url}`);
      expect(card).toContain("## Resources (0)");
      expect(card).not.toContain("Resources are not exposed");
      expect(card).not.toContain("null");
    }
  },
);

test("missing resources with a positive count remain invalid, while backend failures stay distinct", async () => {
  const { resources: _resources, ...missing } = project;
  await expect(
    createAxiPageReader(backend({ "projects view": encode({ project: missing }) }))(
      project.url,
      "/workspace",
    ),
  ).rejects.toThrow("LINEAR_INVALID_RESPONSE");
  const run = vi.fn().mockRejectedValue(new Error("LINEAR_PERMISSION_DENIED"));
  await expect(createAxiPageReader(run)(project.url, "/workspace")).rejects.toThrow(
    "LINEAR_PERMISSION_DENIED",
  );
});
test("project cards refuse wrong identities, incomplete resources, and unsafe resource URLs", async () => {
  for (const changed of [
    { ...project, url: project.url.replace("ab12cd34ef56", "111111111111") },
    { ...project, resourceCount: 2 },
    { ...project, resources: [{ title: "Unsafe", url: "javascript:alert(1)" }] },
  ]) {
    await expect(
      createAxiPageReader(backend({ "projects view": encode({ project: changed }) }))(
        project.url,
        "/workspace",
      ),
    ).rejects.toThrow(/LINEAR_(IDENTITY_MISMATCH|INVALID_RESPONSE)/);
  }
});

test("refuses a repeated continuation cursor instead of sending the agent in a loop", async () => {
  await expect(
    createAxiPageReader(backend({ "issues list": encode({ cursor: "same", issues: [issue] }) }))(
      `${base}/all?cursor=same`,
      "/workspace",
    ),
  ).rejects.toThrow("LINEAR_INVALID_RESPONSE");
});
test("page resolution is lazy, read-only, and forwards operation cancellation", async () => {
  const readPage = vi.fn().mockResolvedValue("Team page");
  const resolved = await createLinearResolver(vi.fn(), undefined, readPage).tryResolve(
    `${base}/overview`,
    { cwd: "/workspace" },
  );
  expect(readPage).not.toHaveBeenCalled();
  if (resolved.kind !== "resolved" || !resolved.resource.read) throw new Error("Missing page");
  expect(resolved.resource.write).toBeUndefined();
  const signal = new AbortController().signal;
  expect(await resolved.resource.read({ signal })).toEqual([{ type: "text", text: "Team page" }]);
  expect(readPage).toHaveBeenCalledTimes(1);
  expect(readPage).toHaveBeenCalledWith(
    `${base}/overview`,
    "/workspace",
    signal,
    expect.any(Function),
  );
});
