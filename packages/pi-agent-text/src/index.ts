export {
  isTextAnchorResolutionAttempt,
  isTextAnchorResolver,
  TextAnchor,
  type TextAnchorDescriptionSource,
  type TextAnchorRecoveryRange,
  type TextAnchorRejection,
  type TextAnchorResolutionAttempt,
  type TextAnchorResolver,
  type TextAnchorResolverContext,
} from "./text-anchor.js";

export {
  type PresentedTextRow,
  renderPresentedTextRows,
  type TextChangeMarker,
} from "./presented-text.js";

export { getTextSourceLine, type TextSourceLine, withTextSourceLine } from "./source-line.js";

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
} from "./text-document.js";

export {
  createTextContentConverter,
  isTextualMediaType,
  textFromAgentContent,
} from "./text-converter.js";
