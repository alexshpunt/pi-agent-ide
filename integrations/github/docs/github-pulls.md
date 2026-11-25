# Pull requests, reviews and threads

Read a native PR URL. Its card links the body, fields, normal conversation, inline comments, reviews, files and threads. Read each selected collection separately and follow its exact next page. File patches can be absent for binary or truncated diffs; that is not a complete patch.

Create a PR through the displayed pulls/new JSON schema with explicit existing head and base branches. Local branch changes and pushes remain normal Git work. Body and fields use resource editors; merge is a typed action requiring the known head SHA. IDE mode uses the shared approval policy; standalone runs it without confirmation. Read [Access](docs:github-access) for the mode-specific rules.

Normal PR conversation comments are issue comments. Inline review comments have separate resources and creation schemas including commit, file, line and side. Replies target a known comment with its PR identity. Read a thread before resolving it.

Create a pending review without an event. Submitting a review, or creating one with APPROVE/REQUEST_CHANGES/COMMENT, uses the shared approval policy in IDE mode. Standalone performs these actions without confirmation. Never approve as the human or work around self-review restrictions. API permission or self-review denial is a real refusal.

Read the action address before Write. Reread the returned resource. Unknown mutation results must not be replayed.
