# Terraform

Detected extensions: `.tf`, `.tfvars`.

| Kind      | Tool            | Detection             | Documentation                                                               |
| --------- | --------------- | --------------------- | --------------------------------------------------------------------------- |
| formatter | `terraform-fmt` | `.terraform.lock.hcl` | [Official docs](https://developer.hashicorp.com/terraform/cli/commands/fmt) |
| linter    | `tflint`        | `.tflint.hcl`         | [Official docs](https://github.com/terraform-linters/tflint)                |
| lsp       | `terraform-ls`  | `.terraform.lock.hcl` | [Official docs](https://github.com/hashicorp/terraform-ls)                  |
