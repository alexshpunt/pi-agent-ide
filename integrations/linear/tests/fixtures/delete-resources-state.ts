export const deleteIds = {
  document: "89500000-0000-4000-8000-000000000001",
  skill: "89500000-0000-4000-8000-000000000002",
  issueTemplate: "89500000-0000-4000-8000-000000000003",
  documentTemplate: "89500000-0000-4000-8000-000000000004",
  templateAlias: "89500000-0000-4000-8000-000000000005",
  unknown: "89500000-0000-4000-8000-000000000006",
  refused: "89500000-0000-4000-8000-000000000007",
  cancelled: "89500000-0000-4000-8000-000000000008",
  preserved: "89500000-0000-4000-8000-000000000009",
  missing: "89500000-0000-4000-8000-000000000010",
  foreign: "89500000-0000-4000-8000-000000000011",
} as const;
export const deleteOrganization = { id: "89500000-0000-4000-8000-000000000020", urlKey: "example" };
export const deleteTeamId = "89500000-0000-4000-8000-000000000021";
export const deleteProjectId = "89500000-0000-4000-8000-000000000022";
export const deleteSource = (kind: string, id: string, workspace = "example") =>
  `linear://${workspace}/${kind}/${id}`;
export const deleteApproved = [
  ["document", deleteIds.document, "delete_document"],
  ["workflow-skill", deleteIds.skill, "delete_workflow_skill"],
  ["workflow-template", deleteIds.issueTemplate, "delete_workflow_template"],
  ["workflow-template", deleteIds.documentTemplate, "delete_workflow_template"],
  ["template", deleteIds.templateAlias, "delete_workflow_template"],
] as const;
export interface DeleteFixtureState {
  resources: Record<
    string,
    Record<string, unknown> & {
      id: string;
      deleted: boolean;
      trashed: boolean;
      archivedAt: string | null;
    }
  >;
  invokes: { workspace: string; operation: string; input: Record<string, unknown> }[];
  requests: { query: string; variables: Record<string, unknown> }[];
  mutations: { field: string; id: string }[];
}
export function initialDeleteState(): DeleteFixtureState {
  const resources: DeleteFixtureState["resources"] = {};
  for (const [label, id] of Object.entries(deleteIds)) {
    if (label === "missing") continue;
    const skill = label === "skill" || label === "cancelled";
    resources[id] = {
      id,
      title: `DELETE_FIXTURE_${label}`,
      name: `DELETE_FIXTURE_${label}`,
      body: `Preserved fixture body ${label}`,
      content: `Preserved fixture body ${label}`,
      url: `https://linear.app/example/document/delete-fixture-${id.replaceAll("-", "").slice(-12)}`,
      slugId: id.replaceAll("-", "").slice(-12),
      type: label === "issueTemplate" ? "issue" : "document",
      templateData: JSON.stringify({ title: label, descriptionData: { type: "doc", content: [] } }),
      description: null,
      inheritedFrom: null,
      shared: false,
      teamId: skill ? deleteTeamId : null,
      team: null,
      organization: deleteOrganization,
      owner: { organization: deleteOrganization },
      creator: { organization: deleteOrganization },
      project: { id: deleteProjectId, organization: deleteOrganization },
      icon: null,
      color: null,
      sortOrder: 0,
      deleted: false,
      trashed: false,
      archivedAt: null,
    };
  }
  return { resources, invokes: [], requests: [], mutations: [] };
}
