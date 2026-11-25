import { Type, type TObject, type TSchema } from "typebox";
import type { GithubAddress } from "./address.ts";

const text = Type.String({ maxLength: 65536 });
const title = Type.String({ minLength: 1, maxLength: 256 });
const names = Type.Array(Type.String({ minLength: 1 }), { maxItems: 100 });
const object = (properties: Record<string, TSchema>) =>
  Type.Object(properties, { additionalProperties: false });
const optional = (schema: TSchema) => Type.Optional(schema);
const body = object({ body: text });
const issueFields = object({
  title: optional(title),
  body: optional(text),
  state: optional(Type.Union([Type.Literal("open"), Type.Literal("closed")])),
  state_reason: optional(
    Type.Union([Type.Literal("completed"), Type.Literal("not_planned"), Type.Null()]),
  ),
  labels: optional(names),
  assignees: optional(names),
  milestone: optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
});
const pullFields = object({
  title: optional(title),
  body: optional(text),
  state: optional(Type.Union([Type.Literal("open"), Type.Literal("closed")])),
  base: optional(title),
  maintainer_can_modify: optional(Type.Boolean()),
});
const releaseFields = object({
  tag_name: optional(title),
  target_commitish: optional(title),
  name: optional(title),
  body: optional(text),
  draft: optional(Type.Boolean()),
  prerelease: optional(Type.Boolean()),
  make_latest: optional(
    Type.Union([Type.Literal("true"), Type.Literal("false"), Type.Literal("legacy")]),
  ),
});

/** One closed, API-backed entity definition. Cards themselves never become writable. */
export interface GithubEntityRoute {
  readonly kind: string;
  readonly path: string;
  readonly schema: TObject;
  readonly body?: boolean;
  readonly updateMethod?: "PATCH" | "PUT";
}

/** Recognize only resource shapes whose identity is explicit in the repository-qualified URI. */
export function entityRoute(address: GithubAddress): GithubEntityRoute | undefined {
  const path = address.parts.join("/");
  if (!path) return { kind: "repository", path: "", schema: object({}) };
  if (/^issues\/\d+$/.test(path))
    return { kind: "issue", path, schema: issueFields, body: true, updateMethod: "PATCH" };
  if (/^pulls\/\d+$/.test(path))
    return { kind: "pull request", path, schema: pullFields, body: true, updateMethod: "PATCH" };
  if (/^issues\/comments\/\d+$/.test(path))
    return { kind: "comment", path, schema: body, body: true, updateMethod: "PATCH" };
  if (/^pulls\/comments\/\d+$/.test(path))
    return { kind: "review comment", path, schema: body, body: true, updateMethod: "PATCH" };
  if (/^pulls\/\d+\/reviews\/\d+$/.test(path))
    return { kind: "review", path, schema: body, body: true, updateMethod: "PUT" };
  if (/^releases\/\d+$/.test(path))
    return { kind: "release", path, schema: releaseFields, body: true, updateMethod: "PATCH" };
  if (/^labels\/[^/]+$/.test(path) && !path.endsWith("/new"))
    return {
      kind: "label",
      path,
      schema: object({
        name: optional(title),
        color: optional(Type.String({ pattern: "^[0-9a-fA-F]{6}$" })),
        description: optional(Type.Union([text, Type.Null()])),
      }),
      updateMethod: "PATCH",
    };
  if (/^milestones\/\d+$/.test(path))
    return {
      kind: "milestone",
      path,
      schema: object({
        title: optional(title),
        description: optional(text),
        state: optional(Type.Union([Type.Literal("open"), Type.Literal("closed")])),
        due_on: optional(Type.Union([Type.String(), Type.Null()])),
      }),
      updateMethod: "PATCH",
    };
  return undefined;
}

/** A typed creation or action, never an arbitrary HTTP dispatcher. */
export interface GithubActionRoute {
  readonly kind: string;
  readonly path: string;
  readonly method: "POST" | "PUT";
  readonly schema: TSchema;
  readonly dangerous?: boolean;
}

/** Keep non-text operations on existing Write, with a readable schema at their action address. */
export function actionRoute(address: GithubAddress): GithubActionRoute | undefined {
  const path = address.parts.join("/");
  if (path === "issues/new")
    return {
      kind: "issue",
      path: "issues",
      method: "POST",
      schema: object({
        title,
        body: optional(text),
        labels: optional(names),
        assignees: optional(names),
        milestone: optional(Type.Integer({ minimum: 1 })),
      }),
    };
  if (path === "pulls/new")
    return {
      kind: "pull request",
      path: "pulls",
      method: "POST",
      schema: object({
        title,
        head: title,
        base: title,
        body: optional(text),
        draft: optional(Type.Boolean()),
        maintainer_can_modify: optional(Type.Boolean()),
      }),
    };
  if (/^issues\/\d+\/comments\/new$/.test(path))
    return { kind: "comment", path: path.slice(0, -4), method: "POST", schema: body };
  if (/^pulls\/\d+\/comments\/new$/.test(path))
    return {
      kind: "review comment",
      path: path.slice(0, -4),
      method: "POST",
      schema: object({
        body: text,
        commit_id: title,
        path: title,
        line: optional(Type.Integer({ minimum: 1 })),
        side: optional(Type.Union([Type.Literal("LEFT"), Type.Literal("RIGHT")])),
        start_line: optional(Type.Integer({ minimum: 1 })),
        start_side: optional(Type.Union([Type.Literal("LEFT"), Type.Literal("RIGHT")])),
        subject_type: optional(Type.Union([Type.Literal("line"), Type.Literal("file")])),
      }),
    };
  if (/^pulls\/\d+\/comments\/\d+\/replies\/new$/.test(path))
    return { kind: "review reply", path: path.slice(0, -4), method: "POST", schema: body };
  if (/^pulls\/\d+\/reviews\/new$/.test(path))
    return {
      kind: "review",
      path: path.slice(0, -4),
      method: "POST",
      schema: object({
        body: optional(text),
        commit_id: optional(title),
        event: optional(
          Type.Union([
            Type.Literal("APPROVE"),
            Type.Literal("REQUEST_CHANGES"),
            Type.Literal("COMMENT"),
          ]),
        ),
        comments: optional(
          Type.Array(
            object({
              path: title,
              body: text,
              line: optional(Type.Integer({ minimum: 1 })),
              side: optional(Type.Union([Type.Literal("LEFT"), Type.Literal("RIGHT")])),
            }),
          ),
        ),
      }),
    };
  if (/^pulls\/\d+\/reviews\/\d+\/submit$/.test(path))
    return {
      kind: "review submission",
      path: path.slice(0, -7) + "/events",
      method: "POST",
      dangerous: true,
      schema: object({
        body: optional(text),
        event: Type.Union([
          Type.Literal("APPROVE"),
          Type.Literal("REQUEST_CHANGES"),
          Type.Literal("COMMENT"),
        ]),
      }),
    };
  if (/^pulls\/\d+\/merge$/.test(path))
    return {
      kind: "merge",
      path,
      method: "PUT",
      dangerous: true,
      schema: object({
        sha: title,
        merge_method: Type.Union([
          Type.Literal("merge"),
          Type.Literal("squash"),
          Type.Literal("rebase"),
        ]),
        commit_title: optional(title),
        commit_message: optional(text),
      }),
    };
  if (path === "releases/new")
    return {
      kind: "release",
      path: "releases",
      method: "POST",
      schema: object({
        tag_name: title,
        target_commitish: optional(title),
        name: optional(title),
        body: optional(text),
        draft: Type.Boolean(),
        prerelease: optional(Type.Boolean()),
      }),
    };
  if (path === "labels/new")
    return {
      kind: "label",
      path: "labels",
      method: "POST",
      schema: object({
        name: title,
        color: Type.String({ pattern: "^[0-9a-fA-F]{6}$" }),
        description: optional(text),
      }),
    };
  if (path === "milestones/new")
    return {
      kind: "milestone",
      path: "milestones",
      method: "POST",
      schema: object({
        title,
        description: optional(text),
        state: optional(Type.Union([Type.Literal("open"), Type.Literal("closed")])),
        due_on: optional(Type.String()),
      }),
    };
  return undefined;
}

/** Collections are bounded pages, not recursive expansions of their linked bodies. */
export function collectionRoute(address: GithubAddress): string | undefined {
  const path = address.parts.join("/");
  if (["issues", "pulls", "releases", "labels", "milestones"].includes(path)) return path;
  if (/^issues\/\d+\/comments$/.test(path)) return path;
  if (/^pulls\/\d+\/(comments|reviews|files|commits)$/.test(path)) return path;
  if (/^releases\/\d+\/assets$/.test(path)) return path;
  return undefined;
}
