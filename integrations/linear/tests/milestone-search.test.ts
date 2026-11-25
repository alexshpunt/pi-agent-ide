import { required } from "./fixtures/check.ts";
import { expect, test } from "vitest";
import { encode } from "@toon-format/toon-v4";
import { createAxiObjectSearcher, parseSearchAddress } from "#linear/object-search.ts";
const projectId = "10000000-0000-4000-8000-000000000001";
const milestoneId = "20000000-0000-4000-8000-000000000002";
const projectUrl = "https://linear.app/example/project/release-abcdef123456";
const base = { kind: "issues", workspace: "example", term: "release", limit: 2 };
for (const project of [`linear://example/project/${projectId}`, projectUrl]) {
  test.each([
    milestoneId,
    "0.8.2 - Release",
    `linear://example/resource/milestones/${milestoneId}?parent=${projectId}`,
  ])(
    `milestone %s stays pinned through empty and final project pages (${project})`,
    async (reference) => {
      const scope = new URL(project);
      scope.searchParams.set("milestone", reference);
      const calls: string[][] = [];
      const search = createAxiObjectSearcher(async (_cwd, args) => {
        calls.push([...args]);
        if (args[0] === "resources" && args[1] === "scope")
          return encode({ project: { id: projectId, url: projectUrl } });
        expect(args[args.indexOf("--project-id") + 1]).toBe(projectId);
        expect(args[args.indexOf("--milestone") + 1]).toBe(
          reference.startsWith("linear:")
            ? milestoneId
            : calls.length === 2
              ? reference
              : milestoneId,
        );
        return encode({
          search: {
            kind: "issues",
            workspace: "example",
            term: "release",
            milestoneId,
            items: [],
            hasMore: calls.length < 6,
            ...(calls.length < 6 ? { cursor: `page-${calls.length}` } : {}),
            totalCount: 0,
            postFiltered: true,
          },
        });
      });
      let path = scope.href;
      for (let index = 0; index < 3; index++) {
        const page = await search({ ...base, scope: path }, ".");
        expect(page.items).toEqual([]);
        expect(page.complete).toBe(index === 2);
        if (index < 2) {
          path = required(page.next);
          expect(
            new URL(required(parseSearchAddress(path)).scope).searchParams.get("milestone"),
          ).toBe(milestoneId);
        } else expect(page.next).toBeUndefined();
      }
    },
  );
}
test.each([
  `linear://example?milestone=${milestoneId}`,
  `linear://example/project/${projectId}?milestone=`,
  `linear://example/project/${projectId}?milestone=a&milestone=b`,
  `linear://example/project/${projectId}?milestone=a&unknown=b`,
  `linear://example/project/${projectId}?milestone=${encodeURIComponent(`linear://other/resource/milestones/${milestoneId}?parent=${projectId}`)}`,
  `linear://example/project/${projectId}?milestone=${encodeURIComponent(`linear://example/resource/milestones/${milestoneId}?parent=${milestoneId}`)}`,
])("invalid milestone scope %s never searches issues", async (scope) => {
  const commands: string[][] = [];
  const search = createAxiObjectSearcher(async (_cwd, args) => {
    commands.push([...args]);
    if (args[0] === "resources" && args[1] === "scope")
      return encode({ project: { id: projectId, url: projectUrl } });
    throw Error("Unexpected issue search");
  });
  await expect(search({ ...base, scope }, ".")).rejects.toThrow(
    /LINEAR_(?:INVALID_SEARCH_SCOPE|IDENTITY_MISMATCH)/u,
  );
  expect(commands.filter(([command]) => command === "search")).toEqual([]);
});
test("milestone selection refuses a missing or mismatched backend identity", async () => {
  for (const id of [undefined, "invalid", projectId]) {
    const search = createAxiObjectSearcher(async (_cwd, args) =>
      args[0] === "resources" && args[1] === "scope"
        ? encode({ project: { id: projectId, url: projectUrl } })
        : encode({
            search: {
              ...base,
              milestoneId: id,
              items: [],
              hasMore: false,
              totalCount: 0,
              postFiltered: true,
            },
          }),
    );
    await expect(
      search(
        { ...base, scope: `linear://example/project/${projectId}?milestone=${milestoneId}` },
        ".",
      ),
    ).rejects.toThrow("LINEAR_IDENTITY_MISMATCH");
  }
});
