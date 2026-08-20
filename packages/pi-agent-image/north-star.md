# `pi-agent-image`

## Purpose

`pi-agent-image` recognizes and normalizes raster images from bytes.

It supports JPEG, static PNG, GIF, WebP, and BMP. BMP is converted to PNG. Images are normalized with Pi's public image helpers and returned as a provider-neutral text note followed by native ImageContent.

The package owns byte signatures, malformed-image behavior, animated PNG rejection, conversion, and resize hints. It performs no source I/O and does not use filenames as format authority.
