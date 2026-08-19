# Known gaps

This document lists only gaps owned by `pi-agent-filesystem`.

## Platform path recognition

The source recognizer distinguishes explicit schemes and common drive paths, but it has not been verified against every platform-native path form.

This gap is closed when platform-specific integration tests cover the supported host path forms.

Additional content formats are not a filesystem-provider gap. They are added as independent type packages and filesystem adapter extensions.
