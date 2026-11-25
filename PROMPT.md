# Original Prompt

> **Prompt Attribution:** **Gemini Hydrogen Low** was used to generate the prompt below for Antigravity.
>
> *Note: The OpenAlex API key from the original prompt has been redacted below so it is not accidentally committed to version control.*

Build a two-part project for an interactive, GPU-accelerated citation network viewer of 10.1038/nature19057 (OpenAlex ID W2510424803):

1. Environment, Caching & Data Ingestion (ingest/)

Create a `.env` file containing `OPENALEX_API_KEY=<REDACTED_OPENALEX_API_KEY>` and ensure `.env` and `ingest/cache/` are added to `.gitignore` so neither the key nor large raw dumps are committed.

Write a Python script (`ingest/fetch_exac_network.py`) with two-stage local persistence:

Stage 1 (Raw Local Cache): Load `OPENALEX_API_KEY` from `.env` and query `https://api.openalex.org/works?filter=cites:W2510424803&per_page=200&cursor=*&api_key=...` (plus the seed paper `W2510424803` itself as the root node) with exponential backoff on 429/500 responses, selecting `id,doi,title,publication_year,cited_by_count,authorships,primary_location,primary_topic,referenced_works`. Save the raw records locally to `ingest/cache/exac_raw.jsonl.gz` (or SQLite). If the cache file already exists, read directly from disk instead of hitting the API unless a `--refresh` CLI flag is passed.

Stage 2 (Graph & Layout Build): From the local cache, construct the internal directed edge list (`source -> target`) where both papers exist in the ExAC citing cohort (or point to `W2510424803`). Run igraph + Leiden community detection (alongside OpenAlex `primary_topic.subfield` / `field` labels) to assign topic clusters, compute normalized node sizes (log-scaled `cited_by_count`), and export a compact `public/data/graph.json` along with flat lookup tables so the web viewer loads 100% locally with zero runtime API calls.

2. Interactive WebGL Viewer (src/)

Build a dark-mode React + TypeScript + Vite web app using `@cosmos.gl/graph` (v3+ WebGL engine) to render the entire 10,000+ node network at 60fps.

Visual Encoding: Color nodes by subfield/Leiden cluster with a glowing dark-mode palette, size nodes by log citation count, highlight `W2510424803` (ExAC) prominently at the center, and render subtle translucent citation edges that brighten on hover/selection.

Interactive Controls:

- A publication-year timeline slider (2016–2026) with a Play/Pause button that progressively reveals the citation wave over time and updates live node/edge counters.
- A cluster legend & filter to isolate or highlight specific downstream fields (e.g., Clinical Variant Interpretation, Gene Constraint, Rare Disease Discovery, Population Genomics).
- A search bar (by paper title, first/last author, or DOI) that smoothly zooms the camera to the matching node.
- A glassmorphic side drawer showing full metadata (title, authors, journal, year, citation count, subfield, direct DOI/OpenAlex links, and top cited/citing neighbors within the ExAC subgraph) when any node is clicked.

Run the ingestion script first to populate the local cache and `public/data/graph.json`, then start the dev server and verify the rendered graph in the preview browser.
