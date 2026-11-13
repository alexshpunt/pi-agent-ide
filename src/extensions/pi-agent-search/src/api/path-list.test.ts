import { describe, expect, test } from "vitest";
import { NULL_FIELD } from "./null-fields.ts";
import {
  describePathArgument,
  isResultReference,
  pathMachine,
  plainPathList,
  uniquePaths,
} from "./path-list.ts";

const uuid = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("plainPathList", () => {
  test("returns a list of plain local and SSH paths", () => {
    expect(plainPathList(["src/code-view", "src/api"])).toEqual(["src/code-view", "src/api"]);
    expect(plainPathList(["ssh://vps/srv/a", "C:/src"])).toEqual(["ssh://vps/srv/a", "C:/src"]);
  });

  test("leaves a list of results to the result scope", () => {
    expect(plainPathList([`RESULT#${uuid}`, uuid, "SEARCH#ABCD:1:match"])).toBeUndefined();
    expect(plainPathList([{ status: "success" }])).toBeUndefined();
    expect(plainPathList([])).toBeUndefined();
  });

  test("rejects a list that mixes paths and results", () => {
    expect(() => plainPathList(["src/api", uuid])).toThrow(
      "either file and directory paths or Read/Search/edit results",
    );
  });

  test("rejects other sources and empty paths", () => {
    expect(() => plainPathList(["src", "docs:search"])).toThrow("Search docs:search in a separate");
    expect(() => plainPathList(["src", "https://example.com"])).toThrow("separate call");
    expect(() => plainPathList(["src", " "])).toThrow("must not be empty");
  });
});

test("isResultReference tells issued results from paths", () => {
  expect(isResultReference(`RESULT#${uuid}`)).toBe(true);
  expect(isResultReference(`<system-result note=""><uuid>${uuid}</uuid></system-result>`)).toBe(
    true,
  );
  expect(isResultReference({})).toBe(true);
  expect(isResultReference("src/RESULT.ts")).toBe(false);
});

test("uniquePaths drops a path listed again in another spelling", () => {
  expect(
    uniquePaths(["src/api", "./src/api", "src/api/", "/work/src/api", "src"], "/work"),
  ).toEqual(["src/api", "src"]);
  expect(uniquePaths(["ssh://vps/a/", "ssh://vps/a", "b"], "ssh://vps/a")).toEqual([
    "ssh://vps/a/",
    "b",
  ]);
});

test("pathMachine names the machine of a path", () => {
  expect(pathMachine("src", "/work")).toBe("local");
  expect(pathMachine("ssh://vps/srv/a", "/work")).toBe("ssh://vps");
  expect(pathMachine("src", "ssh://vps/srv")).toBe("ssh://vps");
});

test("describePathArgument shows listed paths and hides results", () => {
  expect(describePathArgument("src")).toBe("src");
  expect(describePathArgument(["src/a", "src/b"])).toBe("src/a, src/b");
  expect(describePathArgument([uuid])).toBe("result scope");
  expect(describePathArgument(NULL_FIELD)).toBe("null");
});
