#!/usr/bin/env bash
set -euo pipefail

# One-step installer for ExAC Citation Network Viewer (10.1038/nature19057)
# Installs Node.js 22 (if needed), uv + Python 3.12 venv + graph/Leiden libs,
# npm packages, and builds local graph data if missing or requested.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

NODE_VERSION="22.14.0"
MIN_NODE_MAJOR=20
PYTHON_VERSION="3.12"

REBUILD_DATA=false
REFRESH_OPENALEX=false
WITH_PLAYWRIGHT=false

usage() {
  cat <<'EOF'
Usage: ./install.sh [OPTIONS]

Sets up all dependencies for the ExAC Citation Network Viewer without requiring sudo:
  1. Ensures Node.js >= 20 is available (installs v22.14.0 into ~/.local/node if missing)
  2. Ensures uv is installed and creates a Python 3.12 virtual environment (.venv/)
  3. Installs Python ingestion libraries (igraph, leidenalg, numpy, requests, python-dotenv)
  4. Installs frontend Node.js dependencies (npm ci / npm install)
  5. Builds public/data/graph.json & lookup.json if missing (or when --rebuild-data / --refresh is passed)

Options:
  --rebuild-data      Force Stage 2 rebuild from ingest/cache/exac_raw.jsonl.gz (~6s, no API key needed)
  --refresh           Force Stage 1 fresh fetch from OpenAlex API (requires OPENALEX_API_KEY in .env)
  --with-playwright   Also install Python playwright for headless browser testing
  --help, -h          Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rebuild-data)
      REBUILD_DATA=true
      shift
      ;;
    --refresh)
      REFRESH_OPENALEX=true
      shift
      ;;
    --with-playwright)
      WITH_PLAYWRIGHT=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

log() {
  printf '\n\033[1;36m==> %s\033[0m\n' "$1"
}

warn() {
  printf '\033[1;33m[warn]\033[0m %s\n' "$1"
}

die() {
  printf '\033[1;31m[error]\033[0m %s\n' "$1" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Required command '$1' not found. Please install it first (e.g., sudo apt-get install -y $1)."
}

require_cmd curl
require_cmd tar

# Include common user-local bin paths
export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"

# Also check nvm if present
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
fi

# ---------------------------------------------------------------------------
# 1. Node.js >= 20
# ---------------------------------------------------------------------------
log "Step 1/5: Checking Node.js (>= v${MIN_NODE_MAJOR})"

NEED_NODE=true
if command -v node >/dev/null 2>&1; then
  CURRENT_NODE="$(node -v || true)"
  CURRENT_MAJOR="${CURRENT_NODE#v}"
  CURRENT_MAJOR="${CURRENT_MAJOR%%.*}"
  if [[ "$CURRENT_MAJOR" =~ ^[0-9]+$ ]] && (( CURRENT_MAJOR >= MIN_NODE_MAJOR )); then
    echo "Found Node.js ${CURRENT_NODE} ($(command -v node)) and npm $(npm -v)"
    NEED_NODE=false
  else
    warn "Found Node.js ${CURRENT_NODE}, which is older than v${MIN_NODE_MAJOR}."
  fi
fi

if [[ "$NEED_NODE" == true ]]; then
  OS_RAW="$(uname -s)"
  ARCH_RAW="$(uname -m)"

  case "$OS_RAW" in
    Linux)  NODE_OS="linux" ;;
    Darwin) NODE_OS="darwin" ;;
    *)      die "Unsupported OS for automatic Node.js install: ${OS_RAW}" ;;
  esac

  case "$ARCH_RAW" in
    x86_64|amd64)  NODE_ARCH="x64" ;;
    aarch64|arm64) NODE_ARCH="arm64" ;;
    *)             die "Unsupported architecture for automatic Node.js install: ${ARCH_RAW}" ;;
  esac

  if [[ "$NODE_OS" == "linux" ]]; then
    EXT="tar.xz"
    TAR_FLAG="-xJf"
  else
    EXT="tar.gz"
    TAR_FLAG="-xzf"
  fi

  NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${NODE_OS}-${NODE_ARCH}.${EXT}"
  TMP_ARCHIVE="$(mktemp "/tmp/node-${NODE_VERSION}.XXXXXX.${EXT}")"
  trap 'rm -f "$TMP_ARCHIVE"' EXIT

  echo "Installing Node.js v${NODE_VERSION} into $HOME/.local/node ..."
  curl -fsSL "$NODE_URL" -o "$TMP_ARCHIVE"
  mkdir -p "$HOME/.local/node"
  tar "$TAR_FLAG" "$TMP_ARCHIVE" -C "$HOME/.local/node" --strip-components=1
  rm -f "$TMP_ARCHIVE"
  trap - EXIT

  export PATH="$HOME/.local/node/bin:$PATH"

  PATH_LINE='export PATH="$HOME/.local/node/bin:$PATH"'
  for RC_FILE in "$HOME/.bashrc" "$HOME/.zshrc"; do
    if [[ -f "$RC_FILE" ]] && ! grep -Fq '.local/node/bin' "$RC_FILE"; then
      printf '\n# Added by exac-citation-network install.sh\n%s\n' "$PATH_LINE" >> "$RC_FILE"
    fi
  done

  echo "Installed Node.js $(node -v) and npm $(npm -v) in $HOME/.local/node"
fi

# ---------------------------------------------------------------------------
# 2. uv (Python toolchain & package manager)
# ---------------------------------------------------------------------------
log "Step 2/5: Checking uv"

if ! command -v uv >/dev/null 2>&1; then
  echo "Installing uv into $HOME/.local/bin ..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi
echo "Using $(uv --version)"

# ---------------------------------------------------------------------------
# 3. Python 3.12 virtual environment & ingestion dependencies
# ---------------------------------------------------------------------------
log "Step 3/5: Setting up Python ${PYTHON_VERSION} virtual environment (.venv/)"

if [[ ! -x ".venv/bin/python" ]]; then
  uv venv --python "$PYTHON_VERSION" .venv
else
  echo "Existing .venv found ($(.venv/bin/python --version))"
fi

PY_PACKAGES=(
  "igraph==1.0.0"
  "leidenalg==0.12.0"
  "numpy==2.5.5"
  "requests==2.34.2"
  "python-dotenv==1.2.4"
)
if [[ "$WITH_PLAYWRIGHT" == true ]]; then
  PY_PACKAGES+=("playwright==1.65.2")
fi

uv pip install --python .venv/bin/python "${PY_PACKAGES[@]}"
.venv/bin/python -c "import igraph, leidenalg, numpy, requests, dotenv; print('Python ingestion deps verified: igraph', igraph.__version__, '| leidenalg', leidenalg.__version__)"

# ---------------------------------------------------------------------------
# 4. Frontend Node.js dependencies
# ---------------------------------------------------------------------------
log "Step 4/5: Installing frontend npm dependencies"

if [[ -f "package-lock.json" ]]; then
  npm ci --no-audit --no-fund
else
  npm install --no-audit --no-fund
fi

# ---------------------------------------------------------------------------
# 5. Graph data check / build
# ---------------------------------------------------------------------------
log "Step 5/5: Checking local graph data (public/data/graph.json & lookup.json)"

if [[ "$REFRESH_OPENALEX" == true ]]; then
  if [[ ! -f ".env" ]] || ! grep -q '^OPENALEX_API_KEY=.\+' .env; then
    die "--refresh requires OPENALEX_API_KEY to be set in .env"
  fi
  echo "Running Stage 1 (OpenAlex refresh) + Stage 2 (Leiden & layout build)..."
  .venv/bin/python ingest/fetch_exac_network.py --refresh
elif [[ "$REBUILD_DATA" == true || ! -f "public/data/graph.json" || ! -f "public/data/lookup.json" ]]; then
  if [[ ! -f "ingest/cache/exac_raw.jsonl.gz" ]] && ([[ ! -f ".env" ]] || ! grep -q '^OPENALEX_API_KEY=.\+' .env); then
    die "Neither ingest/cache/exac_raw.jsonl.gz nor OPENALEX_API_KEY in .env was found."
  fi
  echo "Building public/data/graph.json and public/data/lookup.json..."
  .venv/bin/python ingest/fetch_exac_network.py
else
  echo "Prebuilt public/data/graph.json and public/data/lookup.json already exist (pass --rebuild-data to regenerate)."
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
cat <<'EOF'

========================================================================
 Installation complete!
========================================================================
Next steps:
  # Ensure newly installed Node/uv binaries are on PATH in this shell:
  export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"

  # Start the interactive WebGL viewer (http://127.0.0.1:5173):
  npm run dev

  # Or create a production build:
  npm run build

  # Optional: re-run Stage 2 clustering/layout from local cache (~6s):
  .venv/bin/python ingest/fetch_exac_network.py
========================================================================
EOF
