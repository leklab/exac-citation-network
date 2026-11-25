# ExAC Citation Network Viewer (`10.1038/nature19057`)

Interactive, GPU-accelerated WebGL citation network explorer for the ExAC flagship paper (*Analysis of protein-coding genetic variation in 60,706 humans*, Lek et al., *Nature* 2016; DOI `10.1038/nature19057`, canonical OpenAlex ID `W2256016639`, requested alias `W2510424803`).

> Built using **Antigravity** (`agy` v1.5.15) with **Gemini 4 Neon High**. See the original build specification in [PROMPT.md](./PROMPT.md).

## Architecture

### 1. Data Ingestion, Local Caching & Leiden Clustering (`ingest/`)
- `.env` stores `OPENALEX_API_KEY` (strictly gitignored).
- `ingest/cache/exac_raw.jsonl.gz` (~21 MB, well within GitHub's file size limits) is **committed and included in the repository** so anyone can inspect the raw OpenAlex snapshot or re-run Stage 2 clustering/layout locally without needing an OpenAlex API key.
- `ingest/fetch_exac_network.py` implements a two-stage pipeline:
  - **Stage 1 (Raw Local Cache)**: Queries OpenAlex for the seed paper (resolving `W2510424803` via DOI `10.1038/nature19057` -> `W2256016639`) and cursor-paginates all ~9,952 citing works with exponential backoff on HTTP 429/5xx, persisting to `ingest/cache/exac_raw.jsonl.gz`. Since the cache is included in the repo, Stage 1 is skipped automatically unless `--refresh` is passed.
  - **Stage 2 (Graph & Layout Build)**: Constructs the internal directed citation graph (`42,892` directed edges: `32,937` cohort-to-cohort internal citations + `9,955` hub citations to ExAC), runs `igraph` + `leidenalg` community detection paired with OpenAlex `primary_topic` / `subfield` / `field` labels, computes a center-anchored 2D galaxy layout and log-scaled node sizes, and exports compact `public/data/graph.json` + flat interned lookup tables `public/data/lookup.json`.

### 2. WebGL Interactive Viewer (`src/`)
- Dark-mode React + TypeScript + Vite app powered by `@cosmos.gl/graph` (v3.6+ WebGL2 engine).
- Loads 100% locally from `public/data/graph.json` and `public/data/lookup.json` with zero runtime API calls.
- Features:
  - **Visual encoding**: Bioluminescent cluster palette, log-scaled node sizing, prominent golden ExAC root node at the center, subtle curved translucent citation edges that brighten on hover/selection (cyan = incoming citing, gold = outgoing cited).
  - **Collapsible publication-year timeline (2016–2026)** with Play/Pause citation-wave animation, interactive histogram bars, and live visible paper/edge counters.
  - **Collapsible cluster legend & filter** to isolate or multi-select Leiden/subfield communities with hover-to-preview.
  - **Search bar** (`/`) by title, first/last author, DOI, or OpenAlex ID with smooth camera zoom (`zoomToPointByIndex`).
  - **Glassmorphic side drawer** with full paper metadata, external DOI/OpenAlex links, and clickable top citing/cited neighbors within the ExAC subgraph.

---

## Prerequisites & Dependencies

This project was developed and verified on **Ubuntu 26.10 (`x86_64`)**.

### Node.js & Frontend Dependencies
- **Node.js**: Tested on **`v22.14.0`** (Node.js 20+ recommended).
- **npm**: Tested on **`10.9.2`**.
- **Web Browser**: Any modern desktop browser with **WebGL 2** enabled (Chrome, Edge, Firefox, or Safari).
- **Key npm packages** (installed via `npm install`):
  - `@cosmos.gl/graph` (`^3.6.0`) — GPU-accelerated WebGL2 graph rendering engine
  - `react` & `react-dom` (`^19.0.0`)
  - `lucide-react` (`^0.469.0`)
  - `vite` (`^6.0.5`), `@vitejs/plugin-react` (`^4.3.4`), `typescript` (`^5.7.2`)

#### Installing Node.js (Ubuntu / Linux)
Choose any one of the following methods to install Node.js 22 (tested with `v22.14.0`):

- **Option A — `nvm` (recommended, no `sudo` required):**
  ```bash
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  source ~/.bashrc
  nvm install 22.14.0
  nvm use 22.14.0
  node -v && npm -v
  ```
- **Option B — Official standalone binary in `~/.local/node` (no `sudo` required):**
  ```bash
  curl -fsSL https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz -o /tmp/node.tar.xz
  mkdir -p ~/.local/node
  tar -xJf /tmp/node.tar.xz -C ~/.local/node --strip-components=1
  rm /tmp/node.tar.xz
  echo 'export PATH="$HOME/.local/node/bin:$PATH"' >> ~/.bashrc
  source ~/.bashrc
  node -v && npm -v
  ```
- **Option C — System-wide on Ubuntu via NodeSource (`apt`):**
  ```bash
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
  node -v && npm -v
  ```

### Python & Ingestion Dependencies
- **Python**: Tested on **Python `3.12.16`** inside `.venv` (managed via **`uv 0.13.9`**).
  - *Note*: Python **3.12** (or 3.11–3.13) is recommended so `igraph` and `leidenalg` install from prebuilt binary wheels. Newer interpreters (such as Ubuntu's system Python 3.14) may lack prebuilt wheels and attempt a C/C++ source build.
- **Required Python libraries** (for `ingest/fetch_exac_network.py`):
  - `igraph==1.0.0`
  - `leidenalg==0.12.0`
  - `numpy==2.5.5`
  - `requests==2.34.2`
  - `python-dotenv==1.2.4`
- **API Key (optional)**: Both the raw OpenAlex snapshot (`ingest/cache/exac_raw.jsonl.gz`, ~21 MB) and the prebuilt web assets (`public/data/graph.json`, `public/data/lookup.json`) are included in the repository. An OpenAlex API key in `.env` (`OPENALEX_API_KEY=...`) is only needed if you want to pull a fresher snapshot from OpenAlex using `--refresh`.

### Ubuntu System Packages & Shared Libraries
- **Standard tooling**:
  ```bash
  sudo apt-get update
  sudo apt-get install -y curl ca-certificates git
  ```
- **If using system Python instead of `uv`**:
  ```bash
  sudo apt-get install -y python3-venv python3-pip
  ```
- **Only if compiling `igraph` / `leidenalg` from source** (not needed when using prebuilt wheels on Python 3.12):
  ```bash
  sudo apt-get install -y build-essential cmake pkg-config python3-dev \
    libxml2-dev libgmp-dev libglpk-dev
  ```
- **Optional — Headless Chromium / Playwright browser testing on minimal Ubuntu**:
  If running automated headless browser verification (e.g., via Python `playwright==1.65.2` or `chrome-headless-shell`), Chromium requires NSS, NSPR, ALSA, and standard Linux graphics shared libraries (`libnspr4.so`, `libnss3.so`, `libnssutil3.so`, `libasound.so.2`, etc.):
  ```bash
  sudo apt-get install -y libnspr4 libnss3 libasound2t64 libgbm1 \
    libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libpango-1.0-0 libcairo2
  # Or let Playwright install OS dependencies automatically:
  # npx playwright install-deps chromium
  ```
  On environments without root access where shared libraries are placed in a custom directory (e.g. `~/.local/chromium-libs/root/usr/lib/x86_64-linux-gnu`), export `LD_LIBRARY_PATH` before launching headless Chromium, and pass `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --enable-webgl2` when running without a hardware GPU.

---

## Setup & Usage

### Quick Install (Recommended)
Run the included [install.sh](./install.sh) script to automatically set up everything (Node.js `v22.14.0` if missing, `uv`, Python `3.12` `.venv`, Python graph libraries, `npm` dependencies, and data verification) without requiring `sudo`:

```bash
chmod +x install.sh
./install.sh

# Useful optional flags:
./install.sh --rebuild-data     # Re-run Stage 2 Leiden clustering & layout from local cache (~6s)
./install.sh --refresh          # Fetch a fresh OpenAlex snapshot (requires OPENALEX_API_KEY in .env)
./install.sh --with-playwright  # Also install Playwright for headless browser testing
```

### Manual Setup

#### 1. Set up Python environment & ingest data
```bash
# Install uv (optional, fast Python/venv manager)
curl -LsSf https://astral.sh/uv/install.sh | sh

# Create Python 3.12 venv and install ingestion dependencies
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python igraph leidenalg numpy requests python-dotenv

# Rebuild public/data/graph.json & lookup.json directly from the committed
# ingest/cache/exac_raw.jsonl.gz (~6s, no API key required)
.venv/bin/python ingest/fetch_exac_network.py

# Optional: add your OpenAlex key to .env and fetch a fresh snapshot from OpenAlex
echo "OPENALEX_API_KEY=your_api_key_here" > .env
.venv/bin/python ingest/fetch_exac_network.py --refresh
```

#### 2. Install frontend dependencies & run the viewer
```bash
# Install Node dependencies
npm install

# Start Vite dev server (http://127.0.0.1:5173)
npm run dev

# Type-check and build production bundle
npm run build
```
