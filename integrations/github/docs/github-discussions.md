# Discussions

Discussions use GitHub's GraphQL API under the same App identity. Read the repository's discussion collection, category list and exact continuation links. Discussions must be enabled and the App must have the required permissions.

Read a post card before selecting #body, fields or comments. Comments and replies are separate resources with verified repository identity; an opaque node ID must never be used to escape the requested repository.

Read a displayed creation/action schema, then Write JSON. Create a post in an explicit category; add a comment or reply to the intended post/comment. Reread after saving. A selected permalink comment must resolve to that comment, not silently return its parent post. Unsupported permalink lookup is explicit.
