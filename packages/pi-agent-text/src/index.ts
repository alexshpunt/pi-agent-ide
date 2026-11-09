export {
  attachTextAnchorRenderer,
  getTextAnchorRenderer,
  isTextAnchorRecoveryOutcome,
  renderTextAnchor,
  isTextAnchorResolutionAttempt,
  isTextAnchorResolver,
  TextAnchor,
  type TextAnchorDescriptionSource,
  type TextAnchorRenderContext,
  type TextAnchorRenderer,
  type TextAnchorRecoveryCandidate,
  type TextAnchorRecoveryCandidateRange,
  type TextAnchorRecoveryOutcome,
  type TextAnchorRecoveryPosition,
  type TextAnchorRecoveryRange,
  type TextAnchorRejection,
  type TextAnchorResolutionAttempt,
  type TextAnchorResolver,
  type TextAnchorResolverContext,
  type TextAnchorResolverRecoveryContext,
} from "./text-anchor.ts";

export {
  type PresentedTextRow,
  renderPresentedTextRows,
  type TextChangeMarker,
} from "./presented-text.ts";

export { getTextSourceLine, type TextSourceLine, withTextSourceLine } from "./source-line.ts";

export {
  documentLineAnchors,
  isLineAnchor,
  LINE_ANCHOR_PATTERN,
  lineAnchors,
  linesWithAnchor,
  PRESENTED_LINE_ANCHOR_PATTERN,
  textLineAnchors,
} from "./line-anchors.ts";

export {
  createTextDocument,
  isTextLinePresenter,
  isTextPresenterRegistration,
  renderPresentedTextDocument,
  renderTextDocument,
  type TextDocument,
  type TextLine,
  type TextLinePresentation,
  type TextLinePresenter,
  type TextPresentationContext,
  type TextPresenterRegistration,
} from "./text-document.ts";

export {
  createTextContentConverter,
  isTextualMediaType,
  textFromAgentContent,
} from "./text-converter.ts";

export {
  isTextTargetResolutionAttempt,
  type TextSelectionPosition,
  type TextSelectionRange,
  type TextTarget,
  type TextTargetResolutionAttempt,
  type TextTargetResolver,
  type TextTargetResolverContext,
} from "./text-target.ts";

export { storeText, restoreText, type StoredText } from "./stored-text.ts";
