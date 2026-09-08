# Go

Detected extensions: `.go`.

| Kind      | Tool            | Detection                                   | Documentation                                                        |
| --------- | --------------- | ------------------------------------------- | -------------------------------------------------------------------- |
| formatter | `gofmt`         | `go.mod`                                    | [Official docs](https://pkg.go.dev/cmd/gofmt)                        |
| formatter | `goimports`     | `go.mod`                                    | [Official docs](https://pkg.go.dev/golang.org/x/tools/cmd/goimports) |
| linter    | `golangci-lint` | `.golangci.yml`, `.golangci.yaml`, `go.mod` | [Official docs](https://golangci-lint.run/)                          |
| lsp       | `gopls`         | `go.mod`, `go.work`                         | [Official docs](https://go.dev/gopls/)                               |
