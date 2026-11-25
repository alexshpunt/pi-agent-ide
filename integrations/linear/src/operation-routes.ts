export interface LinearOperationRoute {
  readonly operation: string;
  readonly kind: string;
  readonly facet?: string;
  readonly identity?: string;
  readonly mode: "read" | "write" | "delete";
  readonly dangerous?: boolean;
  /** False for fixed update-only operations; do not advertise or dispatch creation. */
  readonly allowsCreation?: boolean;
}

const route = (
  operation: string,
  kind: string,
  mode: LinearOperationRoute["mode"],
  identity?: string,
  facet?: string,
  dangerous = false,
): LinearOperationRoute => ({
  operation,
  kind,
  mode,
  ...(identity ? { identity } : {}),
  ...(facet ? { facet } : {}),
  ...(dangerous ? { dangerous } : {}),
});

/** Closed resource routes, not arbitrary MCP dispatch. Fields use the corresponding save schema. */
export const LINEAR_OPERATION_ROUTES: readonly LinearOperationRoute[] = [
  route("get_issue", "issue", "read", "id"),
  route("list_issues", "issues", "read"),
  route("save_issue", "issue", "write", "id"),
  route("share_issue", "issue", "write", "id", "share", true),
  route("unshare_issue", "issue", "write", "id", "unshare", true),
  route("list_customers", "customers", "read"),
  route("list_customer_needs", "customer-requests", "read"),
  route("get_customer_request", "customer-request", "read", "id"),
  route("save_customer_need", "customer-request", "write", "id"),
  route("get_project", "project", "read", "query"),
  route("list_projects", "projects", "read"),
  route("save_project", "project", "write", "id"),
  route("get_document", "document", "read", "id"),
  route("list_documents", "documents", "read"),
  route("save_document", "document", "write", "id"),
  route("delete_document", "document", "delete", "id", undefined, true),
  route("list_comments", "comments", "read"),
  route("save_comment", "comment", "write", "id"),
  route("delete_comment", "comment", "delete", "id", undefined, true),
  route("get_attachment", "attachment", "read", "id"),
  route("prepare_attachment_upload", "attachment", "write", undefined, "prepare-upload"),
  route("create_attachment_from_upload", "attachment", "write", undefined, "from-upload"),
  route("create_attachment", "attachment", "write", undefined, "upload"),
  route("delete_attachment", "attachment", "delete", "id", undefined, true),
  route("extract_images", "attachment", "read", undefined, "images"),
  route("get_team", "team", "read", "query"),
  route("list_teams", "teams", "read"),
  route("get_triage_responsibility", "team", "read", "team", "triage"),
  route("get_user", "user", "read", "query"),
  route("list_users", "users", "read"),
  route("get_workspace", "workspace", "read"),
  route("get_issue_status", "status", "read", "id"),
  route("list_issue_statuses", "statuses", "read"),
  route("list_issue_labels", "labels", "read"),
  route("create_issue_label", "label", "write", undefined, "new"),
  route("save_issue_label", "label", "write", "id"),
  route("retire_issue_label", "label", "write", "id", "retire", true),
  route("restore_issue_label", "label", "write", "id", "restore"),
  route("list_project_labels", "project-labels", "read"),
  route("save_project_label", "project-label", "write", "id"),
  route("retire_project_label", "project-label", "write", "id", "retire", true),
  route("restore_project_label", "project-label", "write", "id", "restore"),
  route("list_cycles", "cycles", "read"),
  route("get_milestone", "milestone", "read", "query"),
  route("list_milestones", "milestones", "read"),
  route("save_milestone", "milestone", "write", "id"),
  route("list_custom_views", "views", "read"),
  route("get_template", "template", "read", "id"),
  route("delete_workflow_template", "template", "delete", "id", undefined, true),
  route("list_templates", "templates", "read"),
  route("get_release", "release", "read", "id"),
  route("list_releases", "releases", "read"),
  route("save_release", "release", "write", "id"),
  route("get_release_note", "release-note", "read", "id"),
  route("list_release_notes", "release-notes", "read"),
  route("save_release_note", "release-note", "write", "id"),
  route("list_release_pipelines", "release-pipelines", "read"),
  route("get_status_updates", "status-updates", "read"),
  route("save_status_update", "status-update", "write", "id"),
  route("delete_status_update", "status-update", "delete", "id", undefined, true),
  route("get_notifications", "notifications", "read"),
  route("mark_notification", "notification", "write", "id", "mark"),
  route("get_agent_skill", "agent-skill", "read", "id"),
  route("list_agent_skills", "agent-skills", "read"),
  route("get_workflow_skill", "workflow-skill", "read", "id"),
  route("list_workflow_skills", "workflow-skills", "read"),
  route("save_workflow_skill", "workflow-skill", "write", "id"),
  route("delete_workflow_skill", "workflow-skill", "delete", "id", undefined, true),
  route("get_workflow_template", "workflow-template", "read", "id"),
  route("delete_workflow_template", "workflow-template", "delete", "id", undefined, true),
  route("create_workflow_template", "workflow-template", "write", "id", "new"),
  {
    ...route("update_workflow_template", "workflow-template", "write", "id"),
    allowsCreation: false,
  },
  route("search_documentation", "documentation", "read"),
  route("get_diff", "diff", "read", "urlOrId"),
  route("list_diffs", "diffs", "read"),
  route("get_diff_threads", "diff", "read", "urlOrId", "threads"),
  route("save_diff_comment", "diff-comment", "write", "commentId"),
  route("delete_diff_comment", "diff-comment", "delete", "commentId", undefined, true),
  route("resolve_diff_thread", "diff-thread", "write", "threadId", "resolve"),
  route("submit_diff_review", "diff", "write", "urlOrId", "review", true),
  route("update_diff", "diff", "write", "urlOrId"),
  route("merge_diff", "diff", "write", "urlOrId", "merge", true),
];

/** Find only the operation owned by one domain/verb; field writes use the domain's default save. */
export function linearOperationRoute(
  kind: string,
  mode: LinearOperationRoute["mode"],
  facet?: string,
): LinearOperationRoute | undefined {
  return LINEAR_OPERATION_ROUTES.find(
    (item) => item.kind === kind && item.mode === mode && item.facet === facet,
  );
}
