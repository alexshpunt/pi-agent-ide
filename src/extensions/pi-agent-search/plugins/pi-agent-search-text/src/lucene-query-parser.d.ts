declare module "lucene-query-parser" {
  export interface LuceneQueryNode {
    readonly field?: string;
    readonly term?: string;
    readonly prefix?: string | null;
    readonly similarity?: number | null;
    readonly proximity?: number | null;
    readonly boost?: number | null;
    readonly regexpr?: boolean;
    readonly left?: LuceneQueryNode;
    readonly operator?: string;
    readonly right?: LuceneQueryNode | null;
  }

  const parser: {
    parse(query: string): LuceneQueryNode;
  };

  export default parser;
}
