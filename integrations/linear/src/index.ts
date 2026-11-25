import { loadLinearGuides } from "./guidance.ts";
import { createStandaloneResources } from "./standalone-resources.ts";
import { registerStandaloneTools } from "./standalone-tools.ts";
import { connectAgentDocumentation } from "pi-agent-ide/api/documentation";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  connectReadPlugin,
  READ_API_VERSION,
  READ_PROTOCOL,
  type ReadPluginApi,
} from "pi-agent-ide/api/read";
import { connectSearchPlugin, SEARCH_PROTOCOL, SEARCH_API_VERSION } from "pi-agent-ide/api/search";
import { createLinearResolver } from "./read.ts";
import { readAxiDocument, readAxiIssue } from "./axi.ts";
import { registerLinearAuthCommand } from "./auth-ui.ts";
import { readAxiPage } from "./pages.ts";
import { createAuthenticatedLinearSearch } from "./auth-search.ts";
import { createLinearAuthBoundary } from "./auth-boundary.ts";
import { readAuthEpoch } from "./auth-process.ts";
import { createSessionConnectionSelection } from "./auth-session.ts";
import { searchAxiObjects } from "./object-search.ts";
import { createAuxiliaryReader, textFromRead } from "./resource-read.ts";
import { createLinearEnvironmentProvider } from "./environment.ts";
import {
  connectTextEditorPlugin,
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
} from "pi-agent-ide/api/text-editor";
import { connectResultTargets } from "pi-agent-ide/api/resource";
import { createLinearTextBackend } from "./text-backend.ts";
import { createLinearTextResolver } from "./text-resource.ts";
import { createLinearBodySelectionHandler } from "./text-selection.ts";
import { linearBodyProvenance } from "./text-provenance.ts";
import { createLinearTextCreationHandler, connectLinearCreationReceipts } from "./text-create.ts";
import { createLinearApi, createLinearApiReadSelection, parseLinearApiAddress } from "./api.ts";
import { createLinearApiExecutor } from "./api-backend.ts";
import { connectLinearApiReceipts, registerLinearApiRenderer } from "./api-receipts.ts";
import { createLinearUploadTool } from "./upload.ts";
import { createLinearAssetResolver } from "./asset-read.ts";
import { createLinearOperationBackend } from "./operation-backend.ts";
import { createCustomerRequestBackend } from "./customer-requests.ts";
import {
  connectLinearOperationReceipts,
  connectLinearPermissionGate,
  createLinearOperationHandlers,
} from "./operation-actions.ts";
import { createLinearArtifactBackend } from "./artifact-backend.ts";
import {
  connectLinearArtifactReceipts,
  createLinearArtifactHandlers,
  createLinearArtifactResolver,
} from "./artifact-actions.ts";
import { createLinearCollectionResolver } from "./collection-read.ts";
import { createAxiCollectionReader, parseLinearCollectionAddress } from "./collections.ts";
import { parseLinearFieldAddress } from "./fields.ts";
import { connectLinearDomainReadRecovery, createLinearDomainResolver } from "./domain-read.ts";
import { createLinearCommentResolver } from "./comment-resource.ts";
import { registerLinearFailureRenderers } from "./text-failure-renderer.ts";
import { registerLinearJsonViews } from "./json-read.ts";
import { connectLinearReadErrorGuidance } from "./read-error-guidance.ts";
import { connectLinearSearchErrorGuidance } from "./search-error-guidance.ts";

/** Extend shared resource tools; AXI owns authorization and remote transport. */
export default async function linearExtension(pi: ExtensionAPI): Promise<void> {
  const guides = await loadLinearGuides();
  connectAgentDocumentation(pi, guides);
  let standaloneMode = false;
  const editorConnections = new Set<string>();
  let searchConnected = false;
  const requirePermit = connectLinearPermissionGate(pi, () => standaloneMode);
  const targets = connectResultTargets(pi);
  let invalidateProvider = () => {};
  const selection = createSessionConnectionSelection((type, data) => pi.appendEntry(type, data));
  const auth = createLinearAuthBoundary({
    readEpoch: (cwd, signal) => readAuthEpoch(cwd, signal, selection.get()),
    targets,
    onChange: () => invalidateProvider(),
  });
  pi.on("session_start", async (_event, context) => {
    try {
      await selection.restore(context);
    } catch {
      context.ui.notify(
        "Linear connection selection could not be restored. Use /linear switch to select a saved connection explicitly.",
        "warning",
      );
    }
    auth.clear();
  });
  const textBackend = createLinearTextBackend();
  const textResolver = auth.resolver(createLinearTextResolver(textBackend));
  const operations = createCustomerRequestBackend(createLinearOperationBackend());
  const handlers = createLinearOperationHandlers(operations, requirePermit);
  const apiRequests = createLinearApi(createLinearApiExecutor());
  const apiResolver = auth.resolver(apiRequests.resolver);
  const fieldResolver = auth.resolver(handlers.fields.resolver);
  const artifactBackend = createLinearArtifactBackend(operations);
  const artifacts = createLinearArtifactHandlers(artifactBackend);
  const artifactResolver = auth.resolver(createLinearArtifactResolver(artifactBackend));
  const collections = auth.resolver(createLinearCollectionResolver());
  const domains = auth.resolver(createLinearDomainResolver(operations));
  const comments = auth.resolver(createLinearCommentResolver(operations));
  const collectionReader = createAxiCollectionReader();
  connectLinearOperationReceipts(pi);
  connectLinearApiReceipts(pi);
  connectLinearReadErrorGuidance(pi);
  connectLinearSearchErrorGuidance(pi);
  connectLinearDomainReadRecovery(pi);
  connectLinearArtifactReceipts(pi);
  connectLinearCreationReceipts(pi);
  const upload = createLinearUploadTool();
  pi.registerTool({
    ...upload,
    execute: (...args: Parameters<typeof upload.execute>) =>
      auth.run(args[4].cwd, args[2], () => upload.execute(...args)),
  });
  let readApi: ReadPluginApi | undefined;
  const sharedText = textFromRead(() => readApi);
  const readText: typeof sharedText = (source, cwd, signal) =>
    parseLinearCollectionAddress(source)
      ? collectionReader(source, cwd, signal)
      : readApi
        ? sharedText(source, cwd, signal)
        : standalone.readText(source, cwd, signal);
  const linearResolver = auth.resolver(
    createLinearResolver(
      readAxiIssue,
      readAxiDocument,
      readAxiPage,
      createAuxiliaryReader(readText),
    ),
  );
  const standalone = createStandaloneResources({
    resolvers: [
      apiResolver,
      comments,
      fieldResolver,
      artifactResolver,
      collections,
      domains,
      auth.resolver(createLinearAssetResolver()),
      textResolver,
      linearResolver,
    ],
    write: [
      apiRequests.write,
      createLinearTextCreationHandler(textBackend.create),
      artifacts.write,
      handlers.write,
    ].map(auth.semantic),
    ownsWriteAction: apiRequests.ownsAction,
    insert: [artifacts.insert, handlers.insert].map(auth.semantic),
    fileOperations: [artifacts.fileOperations, handlers.fileOperations].map(auth.fileOperations),
    guides,
    run: (context, execute) => auth.run(context.cwd, context.signal, execute),
  });
  invalidateProvider = () => {
    requirePermit.clear();
    apiRequests.clear();
  };
  registerLinearAuthCommand(pi, () => auth.clear(), selection);
  let registered = false;
  pi.on("session_start", () => {
    auth.clear();
    if (registered || (readApi && searchConnected && editorConnections.size === 4)) return;
    standaloneMode = true;
    registered = true;
    registerStandaloneTools(pi, standalone);
  });
  pi.on("session_tree", () => auth.clear());
  pi.on("session_shutdown", () => auth.clear());
  return Promise.all([
    connectTextEditorPlugin(pi, {
      protocol: TEXT_EDITOR_PROTOCOL,
      apiVersion: TEXT_EDITOR_API_VERSION,
      id: "linear-text",
      setup(api) {
        editorConnections.add("text");
        api.addResolver({ resolver: textResolver, priority: -100 });
        // Wait until IDE's shared renderer exists, even when Linear loads first.
        let failureRenderersInstalled = false;
        pi.on("agent_start", () => {
          if (failureRenderersInstalled) return;
          registerLinearFailureRenderers(api);
          failureRenderersInstalled = true;
        });
        api
          .tool("write")
          .addSemanticHandler(auth.semantic(createLinearTextCreationHandler(textBackend.create)));
        api.describe(
          "Linear uses ordinary editors for body text, typed fields, creation and artifact actions. Read docs:linear, then the relevant domain guide or returned #actions/#schema link. Read again after saving; never replay unknown remote effects.",
        );
      },
    }),
    connectTextEditorPlugin(pi, {
      protocol: TEXT_EDITOR_PROTOCOL,
      apiVersion: TEXT_EDITOR_API_VERSION,
      id: "linear-operations",
      setup(api) {
        editorConnections.add("operations");
        api.addResolver({ resolver: fieldResolver, priority: -200 });
        api.addResolver({ resolver: comments, priority: -230 });
        api.addResolver({ resolver: domains, priority: -180 });
        api.addFileOperationResolver(auth.fileOperations(handlers.fileOperations));
        api.tool("write").addSemanticHandler(auth.semantic(handlers.write));
        api.tool("insert").addSemanticHandler(auth.semantic(handlers.insert));
      },
    }),
    connectTextEditorPlugin(pi, {
      protocol: TEXT_EDITOR_PROTOCOL,
      apiVersion: TEXT_EDITOR_API_VERSION,
      id: "linear-api",
      setup(api) {
        editorConnections.add("api");
        api.addResolver({ resolver: apiResolver, priority: -250 });
        api.tool("write").addSemanticHandler(auth.semantic(apiRequests.write));
        let rendererInstalled = false;
        pi.on("agent_start", () => {
          if (rendererInstalled) return;
          registerLinearApiRenderer(api);
          rendererInstalled = true;
        });
      },
    }),
    connectTextEditorPlugin(pi, {
      protocol: TEXT_EDITOR_PROTOCOL,
      apiVersion: TEXT_EDITOR_API_VERSION,
      id: "linear-artifacts",
      setup(api) {
        editorConnections.add("artifacts");
        api.addResolver({ resolver: artifactResolver, priority: -210 });
        api.addFileOperationResolver(auth.fileOperations(artifacts.fileOperations));
        api.tool("write").addSemanticHandler(auth.semantic(artifacts.write));
        api.tool("insert").addSemanticHandler(auth.semantic(artifacts.insert));
      },
    }),
    ...[
      { resolver: textResolver, priority: -150 },
      {
        resolver: fieldResolver,
        priority: -220,
        owns(source: string) {
          const address = parseLinearFieldAddress(source);
          return (
            !!address?.facet &&
            !["actions", "schema", "comments", "subtasks", "attachments", "file"].includes(
              address.facet,
            )
          );
        },
      },
      { resolver: comments, priority: -230, owns: (source: string) => source.endsWith("#body") },
      {
        resolver: apiResolver,
        priority: -250,
        owns: (source: string) => parseLinearApiAddress(source)?.kind === "result",
      },
    ].map(({ resolver, priority, owns }) =>
      connectReadPlugin(pi, {
        protocol: READ_PROTOCOL,
        apiVersion: READ_API_VERSION,
        id: resolver.id,
        setup(api) {
          api.addResolver({ resolver, priority });
          api.addHandler({
            stage: "read",
            when: { resolvedBy: resolver.id, contentKind: "text" },
            handler: linearBodyProvenance,
          });
          api.addHandler({
            stage: "post-read",
            handler:
              resolver.id === apiResolver.id
                ? createLinearApiReadSelection(targets, api.read)
                : createLinearBodySelectionHandler(targets, api.read, resolver.id, owns),
          });
        },
      }),
    ),
    connectReadPlugin(pi, {
      protocol: READ_PROTOCOL,
      apiVersion: READ_API_VERSION,
      id: "linear",
      setup(api) {
        readApi = api;
        api.addHandler({ stage: "post-read", handler: auth.postRead });
        api.addResolver({ resolver: artifactResolver, priority: -210 });
        api.addResolver({ resolver: collections, priority: -200 });
        api.addResolver({ resolver: domains, priority: -180 });
        api.addResolver({ resolver: auth.resolver(createLinearAssetResolver()), priority: -160 });
        // Lower priorities run first, before the generic web resolver.
        api.addResolver({
          resolver: linearResolver,
          priority: -100,
        });
        api.describe({
          path: "Read native Linear URLs and displayed stable resources, fields, discussions and continuation links. Linked bodies remain lazy. Start with docs:linear, then choose its domain guide. /linear manages the active Linear connection.",
        });
      },
    }),
    connectReadPlugin(pi, {
      protocol: READ_PROTOCOL,
      apiVersion: READ_API_VERSION,
      id: "linear-jq",
      setup: registerLinearJsonViews,
    }),
    connectSearchPlugin(pi, {
      protocol: SEARCH_PROTOCOL,
      apiVersion: SEARCH_API_VERSION,
      id: "linear",
      setup(api) {
        searchConnected = true;
        api.addEnvironmentProvider(
          createLinearEnvironmentProvider((source, cwd, signal) =>
            auth.run(cwd, signal, () => readText(source, cwd, signal)),
          ),
        );
        api.addResolver({
          priority: -200,
          resolver: createAuthenticatedLinearSearch(
            auth,
            searchAxiObjects,
            readText,
            (selection, context) => api.registerSelection(selection, context),
          ),
        });
        api.describe(
          "Linear object discovery and scoped resource text Search. Read docs:linear-discovery for kinds and scope syntax. Exact shared Read/Search ranges stay bounded; linked bodies need separate queries. Incomplete coverage never proves absence.",
        );
        api.addPromptGuideline(
          "Linear discovery uses native API search for issues/projects/documents and API directory lookup for other advertised kinds. Read a result URL before searching its text. Do not claim global full-content coverage, follow links automatically, or assume AXI app Search and MCP Read use the same principal.",
        );
      },
    }),
  ]).then(() => undefined);
}
