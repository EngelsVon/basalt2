#!/usr/bin/env bash
set -euo pipefail

echo "=== Basalt SBF build helper (Kaggle-friendly) ==="

# Resolve repo root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

PROGRAM_DIR="programs/basalt_inscription"
TOML="$PROGRAM_DIR/Cargo.toml"
SOLANA_VERSION="${SOLANA_VERSION:-v1.17.28}"

# Show environment
echo "[info] Working directory: $PWD"
command -v rustc >/dev/null 2>&1 && rustc --version || echo "[warn] rustc not found"
command -v cargo >/dev/null 2>&1 && cargo --version || echo "[warn] cargo not found"

# Auto-install Solana toolchain if cargo-build-sbf is missing
if ! command -v cargo-build-sbf >/dev/null 2>&1; then
  echo "[info] Installing Solana toolchain ${SOLANA_VERSION}..."
  curl -sSfL "https://release.solana.com/${SOLANA_VERSION}/install" | sh -s -
  export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
else
  echo "[ok] cargo-build-sbf is present"
fi

# Re-check versions after potential install
command -v solana >/dev/null 2>&1 && solana --version || echo "[warn] solana not found in PATH"
command -v cargo-build-sbf >/dev/null 2>&1 && cargo-build-sbf --version || echo "[warn] cargo-build-sbf still not found"

# Ensure program Cargo.toml does NOT contain ahash (we removed it from source to avoid stdsimd issue)
# (Allow ahash pinning via [patch.crates-io])
if awk 'BEGIN{in_dep=0} /^\s*\[.*\]\s*$/ { in_dep = ($0 ~ /^\s*\[dependencies\]\s*$/) } in_dep && /^\s*ahash\s*=/ { found=1 } END{ exit found?0:1 }' "$TOML"; then
  echo "[error] Detected 'ahash' under [dependencies] in $TOML. Please remove the direct dependency; transitive pin via [patch.crates-io] is allowed." >&2
  exit 1
fi
if grep -qE '^\s*ahash\s*=' "$TOML"; then
  echo "[error] Detected 'ahash' in $TOML. Please remove the dependency; source code no longer uses it." >&2
  exit 1
fi

# Build with cargo-build-sbf
set +e
( cd "$PROGRAM_DIR" && cargo clean -p basalt_inscription 2>/dev/null )
( cd "$PROGRAM_DIR" && cargo-build-sbf -v )
code=$?
set -e

# Report outcome and artifacts
if [ $code -eq 0 ]; then
  echo "[success] Build succeeded. Artifacts:"
  ls -la "$REPO_ROOT/target/deploy" || true
  ls -la "$PROGRAM_DIR/target/deploy" || true
  exit 0
else
  echo "[fail] Build failed (code=$code). Please copy full build logs from Kaggle for analysis." >&2
  exit $code
fi