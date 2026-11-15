#!/usr/bin/env bash
set -euo pipefail

# The sandbox has no GPU devices. Pin the CPU runtime and model outside timed trials.
version=1.23.0
revision=4bcdf5ed93f791259eb130b577a240f753d68dd8
case "$(uname -sm)" in
  'Linux x86_64')
    platform=linux-x64
    digest=b6deea7f2e22c10c043019f294a0ea4d2a6c0ae52a009c34847640db75ec5580
    ;;
  'Linux aarch64')
    platform=linux-aarch64
    digest=0b9f47d140411d938e47915824d8daaa424df95a88b5f1fc843172a75168f7a0
    ;;
  *) printf 'Unsupported ColGREP runtime platform\n' >&2; exit 1 ;;
esac

if [[ "${1:-}" == --download ]]; then
  target=${2:?Pass a new asset directory}
  test ! -e "$target"
  mkdir -p "$(dirname "$target")"
  stage=$(mktemp -d "${target}.tmp-XXXXXX")
  trap 'rm -rf "$stage"' EXIT
  fetch() {
    curl --fail --show-error --location --proto '=https' --proto-redir '=https' \
      --connect-timeout 10 --max-time 600 --retry 2 --retry-max-time 900 \
      --output "$2" "$1"
  }
  fetch "https://github.com/microsoft/onnxruntime/releases/download/v${version}/onnxruntime-${platform}-${version}.tgz" "$stage/runtime.tgz"
  printf '%s  %s\n' "$digest" "$stage/runtime.tgz" | sha256sum --check --status
  mkdir "$stage/runtime" "$stage/model"
  tar -xzf "$stage/runtime.tgz" --strip-components=1 -C "$stage/runtime"
  rm "$stage/runtime.tgz"
  model_file() {
    fetch "https://huggingface.co/lightonai/LateOn-Code-edge/resolve/${revision}/$1" "$stage/model/$1"
    if [[ "$3" == git ]]; then
      test "$(git hash-object "$stage/model/$1")" = "$2"
    else
      printf '%s  %s\n' "$2" "$stage/model/$1" | sha256sum --check --status
    fi
  }
  model_file tokenizer.json 96c43dc3658a846ca2ea791db47e446683ec88c9 git
  model_file config_sentence_transformers.json 327c03b09494cdce2a1f4fe3ac30468ec19df8b5 git
  model_file config.json e5f64c0ad0998d9f311747828afb9b49058cb330 git
  model_file onnx_config.json 8b7dfc8773460ebc486a9705f9fa386c50bd13cb git
  model_file model_int8.onnx eac35bdaa862e2762e6455337f7a3e704b05dbc4259f00929fcc8e10207f11c7 sha256
  (cd "$stage"; sha256sum runtime/lib/libonnxruntime.so model/* > checksums.sha256)
  mv --no-target-directory --no-clobber "$stage" "$target"
  test ! -e "$stage"
  printf 'ColGREP assets ready: %s\n' "$target"
  exit 0
fi

command -v colgrep
assets=${CAPABILITY_COLGREP_ASSETS:?Prepare assets with prepare-colgrep.sh --download first}
(cd "$assets"; sha256sum --check --status checksums.sha256)
runtime=/state/colgrep-runtime
mkdir -p "$runtime/lib"
cp "$assets/runtime/lib/libonnxruntime.so" "$runtime/lib/libonnxruntime.so"
test "${ORT_DYLIB_PATH:?Missing private runtime path}" = "$runtime/lib/libonnxruntime.so"
test "${COLGREP_FORCE_CPU:?Missing CPU execution policy}" = 1
sha256sum "$assets/checksums.sha256"
colgrep settings --parallel 1 --batch-size 1 --int8
colgrep set-model "$assets/model"
colgrep init --yes --color never
