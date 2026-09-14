export interface SyntaxPosition {
  readonly row: number;
  readonly column: number;
}

/** Parser-neutral syntax node used by AST outlines and scope anchors. */
export interface SyntaxNode {
  readonly type: string;
  readonly text: string;
  readonly isNamed: boolean;
  readonly hasError: boolean;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startPosition: SyntaxPosition;
  readonly endPosition: SyntaxPosition;
  readonly parent: SyntaxNode | null;
  readonly namedChildren: readonly SyntaxNode[];
  readonly namedChildCount: number;
  childForFieldName(name: string): SyntaxNode | null;
}

/** Parser-neutral syntax tree used by AST read views. */
export interface SyntaxTree {
  readonly rootNode: SyntaxNode;
}
