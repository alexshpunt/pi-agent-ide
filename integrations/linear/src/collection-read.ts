import type { ResourceResolver } from "pi-agent-ide/api/resource";
import { linearJsonContent } from "./json-read.ts";
import {
  createAxiCollectionReader,
  createAxiCommentReader,
  parseLinearCollectionAddress,
} from "./collections.ts";

/** Discussions and child collections are lazy resources, not automatic card expansion. */
export function createLinearCollectionResolver(): ResourceResolver {
  const collection = createAxiCollectionReader();
  const comment = createAxiCommentReader();
  return {
    id: "linear-collections",
    async tryResolve(source, context) {
      const address = parseLinearCollectionAddress(source);
      if (
        !address &&
        !/^linear:\/\/[A-Za-z0-9_-]+\/(issue|project|document)\/[^/]+\/comment\/[0-9a-f-]{36}$/iu.test(
          source,
        )
      )
        return { kind: "not-handled" };
      const snapshot = await (address ? collection : comment)(source, context.cwd, context.signal);
      return {
        kind: "resolved",
        resource: {
          source: snapshot.source,
          read: async () => linearJsonContent(snapshot),
        },
      };
    },
  };
}
