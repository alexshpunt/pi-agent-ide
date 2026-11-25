/** The approved backend operation set. Unknown server methods never become callable automatically. */
export const LINEAR_OPERATIONS = [
  "create_attachment",
  "create_attachment_from_upload",
  "delete_attachment",
  "extract_images",
  "get_attachment",
  "prepare_attachment_upload",
  "list_comments",
  "save_comment",
  "delete_comment",
  "get_document",
  "list_documents",
  "save_document",
  "get_issue",
  "list_issues",
  "save_issue",
  "share_issue",
  "unshare_issue",
  "get_project",
  "list_projects",
  "save_project",
  "get_team",
  "list_teams",
  "get_triage_responsibility",
  "get_user",
  "list_users",
  "get_workspace",
  "list_customers",
  "list_customer_needs",
  "save_customer_need",
  "create_issue_label",
  "get_issue_status",
  "list_issue_labels",
  "list_issue_statuses",
  "list_project_labels",
  "restore_issue_label",
  "restore_project_label",
  "retire_issue_label",
  "retire_project_label",
  "save_issue_label",
  "save_project_label",
  "list_cycles",
  "get_milestone",
  "list_milestones",
  "save_milestone",
  "list_custom_views",
  "get_template",
  "list_templates",
  "get_release",
  "get_release_note",
  "list_release_notes",
  "list_release_pipelines",
  "list_releases",
  "save_release",
  "save_release_note",
  "get_status_updates",
  "save_status_update",
  "delete_status_update",
  "get_notifications",
  "mark_notification",
  "get_agent_skill",
  "list_agent_skills",
  "get_workflow_skill",
  "list_workflow_skills",
  "save_workflow_skill",
  "get_workflow_template",
  "create_workflow_template",
  "update_workflow_template",
  "delete_document",
  "delete_workflow_skill",
  "delete_workflow_template",
  "search_documentation",
  "get_diff",
  "get_diff_threads",
  "list_diffs",
  "save_diff_comment",
  "delete_diff_comment",
  "resolve_diff_thread",
  "submit_diff_review",
  "update_diff",
  "merge_diff",
] as const;

export type LinearOperation = (typeof LINEAR_OPERATIONS)[number];
const allowed = new Set<string>(LINEAR_OPERATIONS);

/** Test a method against the closed catalog before reading input or contacting Linear. */
export function isLinearOperation(name: string): name is LinearOperation {
  return allowed.has(name);
}

/** Reads are classified locally, not from optional or untrusted server annotations. */
export function isReadOnlyOperation(name: LinearOperation): boolean {
  return (
    name.startsWith("get_") ||
    name.startsWith("list_") ||
    name === "search_documentation" ||
    name === "extract_images"
  );
}
