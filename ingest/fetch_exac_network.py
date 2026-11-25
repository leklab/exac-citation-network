#!/usr/bin/env python3
"""
Two-stage OpenAlex ingestion, Leiden community detection, and WebGL graph builder
for the ExAC flagship paper (10.1038/nature19057 / OpenAlex W2510424803 -> W2256016639).

Stage 1 (Raw Local Cache):
  - Loads OPENALEX_API_KEY from .env
  - Resolves seed paper (tries requested OpenAlex ID W2510424803; falls back to
    DOI 10.1038/nature19057 if OpenAlex merged/redirected the ID)
  - Cursor-paginates all citing works with exponential backoff on 429/5xx errors
  - Persists raw JSON records to ingest/cache/exac_raw.jsonl.gz
  - Reuses local cache on subsequent runs unless --refresh is passed

Stage 2 (Graph & Layout Build):
  - Constructs internal directed citation edge list (source -> target) within the
    ExAC cohort plus the seed root node
  - Runs igraph + Leiden community detection on internal cohort citation edges,
    paired with OpenAlex primary_topic / subfield / field labels
  - Computes a center-anchored, cluster-organized 2D galaxy layout with ExAC at center
  - Computes log-scaled node sizes from cited_by_count
  - Exports compact public/data/graph.json and flat lookup tables public/data/lookup.json
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import os
import random
import re
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import igraph as ig
import leidenalg
import numpy as np
import requests
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = PROJECT_ROOT / "ingest" / "cache"
RAW_CACHE_PATH = CACHE_DIR / "exac_raw.jsonl.gz"
PUBLIC_DATA_DIR = PROJECT_ROOT / "public" / "data"
GRAPH_JSON_PATH = PUBLIC_DATA_DIR / "graph.json"
LOOKUP_JSON_PATH = PUBLIC_DATA_DIR / "lookup.json"

REQUESTED_SEED_ID = "W2510424803"
SEED_DOI = "10.1038/nature19057"
SELECT_FIELDS = (
    "id,doi,title,publication_year,cited_by_count,"
    "authorships,primary_location,primary_topic,referenced_works"
)
OPENALEX_BASE = "https://api.openalex.org"
SPACE_SIZE = 4096.0
CENTER_XY = SPACE_SIZE / 2.0

# Luminous dark-mode palette (high-contrast, bioluminescent accents)
CLUSTER_PALETTE = [
    "#38bdf8",  # 0: Electric Cyan
    "#a78bfa",  # 1: Neon Violet
    "#34d399",  # 2: Bioluminescent Emerald
    "#fb7185",  # 3: Coral Rose
    "#f59e0b",  # 4: Solar Amber
    "#60a5fa",  # 5: Cobalt Azure
    "#e879f9",  # 6: Plasma Magenta
    "#2dd4bf",  # 7: Seafoam Teal
    "#f97316",  # 8: Burnt Tangerine
    "#a3e635",  # 9: Acid Lime
    "#818cf8",  # 10: Periwinkle Indigo
    "#94a3b8",  # 11: Slate Silver (Other / Interdisciplinary)
]


def short_oa_id(raw_id: str | None) -> str:
    if not raw_id:
        return ""
    return raw_id.rsplit("/", 1)[-1].strip()


def clean_doi(raw_doi: str | None) -> str:
    if not raw_doi:
        return ""
    doi = raw_doi.strip()
    for prefix in ("https://doi.org/", "http://doi.org/", "https://dx.doi.org/", "doi:"):
        if doi.lower().startswith(prefix):
            doi = doi[len(prefix) :]
            break
    return doi


def request_with_backoff(
    session: requests.Session,
    url: str,
    params: dict[str, Any],
    max_retries: int = 8,
    base_delay: float = 1.0,
) -> requests.Response:
    """GET request with exponential backoff on 429 / 5xx / transient network errors."""
    for attempt in range(max_retries):
        try:
            resp = session.get(url, params=params, timeout=30)
            if resp.status_code == 200:
                return resp
            if resp.status_code == 404:
                return resp
            if resp.status_code in (429, 500, 502, 503, 504):
                retry_after = resp.headers.get("Retry-After")
                if retry_after:
                    try:
                        wait = float(retry_after)
                    except ValueError:
                        wait = base_delay * (2**attempt)
                else:
                    wait = min(60.0, base_delay * (2**attempt))
                wait += random.uniform(0.0, 0.6)
                print(
                    f"  [retry {attempt + 1}/{max_retries}] HTTP {resp.status_code} "
                    f"— sleeping {wait:.1f}s...",
                    flush=True,
                )
                time.sleep(wait)
                continue
            resp.raise_for_status()
            return resp
        except requests.RequestException as exc:
            wait = min(60.0, base_delay * (2**attempt)) + random.uniform(0.0, 0.6)
            print(
                f"  [retry {attempt + 1}/{max_retries}] Network error ({exc}) "
                f"— sleeping {wait:.1f}s...",
                flush=True,
            )
            time.sleep(wait)
    raise RuntimeError(f"Failed to fetch {url} after {max_retries} retries")


def resolve_seed_work(session: requests.Session, api_key: str) -> tuple[dict[str, Any], str]:
    """Fetch seed paper by requested OpenAlex ID, falling back to DOI if retired/404."""
    params = {"select": SELECT_FIELDS, "api_key": api_key}
    resp = request_with_backoff(
        session, f"{OPENALEX_BASE}/works/{REQUESTED_SEED_ID}", params
    )
    if resp.status_code == 200:
        data = resp.json()
        cid = short_oa_id(data.get("id"))
        if cid:
            return data, cid

    print(
        f"[Stage 1] {REQUESTED_SEED_ID} returned HTTP {resp.status_code} on OpenAlex; "
        f"resolving canonical work via DOI {SEED_DOI}...",
        flush=True,
    )
    doi_url = f"{OPENALEX_BASE}/works/https://doi.org/{SEED_DOI}"
    resp2 = request_with_backoff(session, doi_url, params)
    if resp2.status_code != 200:
        raise RuntimeError(
            f"Could not resolve seed work by ID ({REQUESTED_SEED_ID}) or DOI ({SEED_DOI}): "
            f"HTTP {resp2.status_code}"
        )
    data = resp2.json()
    canonical_id = short_oa_id(data.get("id"))
    print(
        f"[Stage 1] Resolved DOI {SEED_DOI} -> canonical OpenAlex ID {canonical_id} "
        f"('{data.get('title')}', cited_by_count={data.get('cited_by_count')})",
        flush=True,
    )
    return data, canonical_id


def run_stage1_fetch(api_key: str, refresh: bool = False) -> Path:
    """Stage 1: Fetch seed + all citing works from OpenAlex and cache as gzipped JSONL."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    if RAW_CACHE_PATH.exists() and not refresh:
        size_mb = RAW_CACHE_PATH.stat().st_size / (1024 * 1024)
        print(
            f"[Stage 1] Local cache exists ({RAW_CACHE_PATH}, {size_mb:.2f} MB). "
            "Skipping API fetch (pass --refresh to re-fetch).",
            flush=True,
        )
        return RAW_CACHE_PATH

    if not api_key:
        raise RuntimeError("OPENALEX_API_KEY not found in .env or environment.")

    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": "ExAC-Citation-Network-Viewer/1.0 (https://openalex.org)",
            "Accept": "application/json",
        }
    )

    seed_work, canonical_id = resolve_seed_work(session, api_key)
    seed_work["_is_seed"] = True
    seed_work["_requested_seed_id"] = REQUESTED_SEED_ID
    seed_work["_canonical_seed_id"] = canonical_id

    tmp_path = RAW_CACHE_PATH.with_suffix(".gz.tmp")
    cursor = "*"
    page = 0
    total_written = 0
    expected_total: int | None = None
    t0 = time.time()

    with gzip.open(tmp_path, "wt", encoding="utf-8") as gz:
        gz.write(json.dumps(seed_work, separators=(",", ":")) + "\n")
        total_written += 1

        while cursor:
            page += 1
            params = {
                "filter": f"cites:{canonical_id}",
                "per_page": 200,
                "cursor": cursor,
                "select": SELECT_FIELDS,
                "api_key": api_key,
            }
            resp = request_with_backoff(session, f"{OPENALEX_BASE}/works", params)
            payload = resp.json()
            meta = payload.get("meta") or {}
            if expected_total is None:
                expected_total = meta.get("count")
                print(
                    f"[Stage 1] Querying cites:{canonical_id} — "
                    f"{expected_total:,} citing works reported by OpenAlex.",
                    flush=True,
                )

            results = payload.get("results") or []
            if not results:
                break

            for work in results:
                gz.write(json.dumps(work, separators=(",", ":")) + "\n")
                total_written += 1

            next_cursor = meta.get("next_cursor")
            if page % 5 == 0 or not next_cursor:
                elapsed = time.time() - t0
                pct = (
                    (total_written - 1) / expected_total * 100.0
                    if expected_total
                    else 0.0
                )
                print(
                    f"  page {page:3d} | fetched {total_written - 1:,}/{expected_total or '?'} "
                    f"({pct:5.1f}%) | {elapsed:.1f}s",
                    flush=True,
                )
            cursor = next_cursor

    tmp_path.replace(RAW_CACHE_PATH)
    size_mb = RAW_CACHE_PATH.stat().st_size / (1024 * 1024)
    print(
        f"[Stage 1] Saved {total_written:,} raw records to {RAW_CACHE_PATH} "
        f"({size_mb:.2f} MB) in {time.time() - t0:.1f}s.",
        flush=True,
    )
    return RAW_CACHE_PATH


def extract_journal(work: dict[str, Any]) -> str:
    pl = work.get("primary_location") or {}
    source = pl.get("source") or {}
    name = (source.get("display_name") or "").strip()
    return name


def extract_authors(work: dict[str, Any]) -> tuple[str, str, str]:
    authorships = work.get("authorships") or []
    names: list[str] = []
    for a in authorships:
        author = a.get("author") or {}
        dn = (author.get("display_name") or "").strip()
        if dn:
            names.append(dn)
    if not names:
        return "", "", ""
    first_author = names[0]
    last_author = names[-1]
    if len(names) <= 10:
        summary = ", ".join(names)
    else:
        summary = f"{', '.join(names[:6])}, ... , {', '.join(names[-2:])} ({len(names)} authors)"
    return first_author, last_author, summary


def extract_topic_info(work: dict[str, Any]) -> tuple[str, str, str]:
    pt = work.get("primary_topic") or {}
    topic = (pt.get("display_name") or "").strip()
    subfield = ((pt.get("subfield") or {}).get("display_name") or "").strip()
    field = ((pt.get("field") or {}).get("display_name") or "").strip()
    return topic, subfield, field


def derive_cluster_label(
    top_topics: list[tuple[str, int]],
    top_subfields: list[tuple[str, int]],
    sample_titles: list[str],
    used_labels: set[str],
) -> str:
    """Create a crisp, scientifically accurate label for a Leiden community."""
    corpus = " ".join(
        [t for t, _ in top_topics[:5]]
        + [s for s, _ in top_subfields[:3]]
        + sample_titles[:60]
    ).lower()

    top_topic = top_topics[0][0] if top_topics else ""
    top_subfield = top_subfields[0][0] if top_subfields else ""

    # Domain-specific genomic/clinical heuristics grounded in actual community content
    rules: list[tuple[str, list[str]]] = [
        (
            "Clinical Variant Interpretation",
            ["acmg", "clinvar", "variant interpretation", "pathogenicity", "missense", "diagnostic yield", "clinical exome", "variant classification"],
        ),
        (
            "Gene Constraint & Population Genomics",
            ["constraint", "loss-of-function", "gnomad", "allele frequency", "purifying selection", "pli", "protein-coding", "population", "polygenic", "gwas", "biobank"],
        ),
        (
            "Neurodevelopmental & Psychiatric Genetics",
            ["autism", "epilepsy", "schizophrenia", "neurodevelopmental", "intellectual disability", "de novo", "seizure", "developmental delay", "brain", "alzheimer", "parkinson", "neurolog"],
        ),
        (
            "Cancer & Somatic Genomics",
            ["cancer", "tumor", "tumour", "carcinoma", "leukemia", "oncology", "brca", "somatic", "melanoma", "glioma", "lymphoma", "hereditary cancer"],
        ),
        (
            "Cardiovascular & Inherited Arrhythmias",
            ["cardiomyopathy", "arrhythmia", "brugada", "long qt", "aortic", "congenital heart", "cardiac", "atrial fibrillation", "hypertrophic", "coronary"],
        ),
        (
            "Rare Disease & Mendelian Discovery",
            ["rare disease", "mendelian", "syndrome", "biallelic", "recessive", "consanguin", "exome sequencing", "phenotyp", "malformation", "skeletal", "ciliopath"],
        ),
        (
            "Metabolic, Renal & Endocrine Genetics",
            ["kidney", "renal", "nephro", "diabetes", "lipid", "cholesterol", "metabolic", "mitochondri", "liver", "endocrine", "obesity"],
        ),
        (
            "Sensory, Ophthalmic & Hearing Genetics",
            ["retinal", "macular", "glaucoma", "hearing loss", "deafness", "ophthalm", "cochlear", "retinopathy", "vision", "blindness"],
        ),
        (
            "Immunology, Hematology & Autoimmune",
            ["immunodeficienc", "autoimmune", "hematolog", "blood", "platelet", "thromb", "inflammatory", "inborn errors of immunity", "lupus", "celiac"],
        ),
        (
            "Bioinformatics, Splicing & Functional Genomics",
            ["splicing", "deep learning", "machine learning", "benchmark", "pipeline", "annotation", "structural variant", "copy number", "cnv", "rna-seq", "transcriptom", "crispr", "functional assay", "alphamissense"],
        ),
        (
            "Pharmacogenomics & Precision Medicine",
            ["pharmacogen", "cyp2", "drug", "precision medicine", "secondary findings", "screening", "newborn screening"],
        ),
        (
            "Neuromuscular & Myopathy Genetics",
            ["myopathy", "neuropathy", "muscular dystrophy", "ataxia", "als", "amyotrophic", "charcot-marie", "neuromuscular"],
        ),
    ]

    best_label = None
    best_score = 0
    for label, keywords in rules:
        if label in used_labels:
            continue
        score = sum(corpus.count(kw) for kw in keywords)
        if score > best_score:
            best_score = score
            best_label = label

    if best_label and best_score >= 4:
        return best_label

    # Fallback directly to dominant OpenAlex topic or subfield
    for candidate in (top_topic, top_subfield):
        if candidate and candidate not in used_labels:
            return candidate
    if top_topic and top_subfield:
        combo = f"{top_subfield}: {top_topic}"
        if combo not in used_labels:
            return combo
    return f"Genomics Cluster ({top_subfield or 'General'})"


def compute_galaxy_layout(
    n_nodes: int,
    root_index: int,
    internal_edges: list[tuple[int, int]],
    node_clusters: list[int],
    n_clusters: int,
    citations: list[int],
    in_degree: list[int],
) -> np.ndarray:
    """
    Compute a crisp, non-overlapping 2D galaxy layout with:
      - ExAC root anchored at exact center (CENTER_XY, CENTER_XY)
      - Each cluster positioned in an organic sector around the center
      - Intra-cluster structure refined with igraph Fruchterman-Reingold force layout
      - High-citation landmark papers pulled slightly closer to the inner luminous ring
    """
    rng = np.random.default_rng(42)
    coords = np.zeros((n_nodes, 2), dtype=np.float64)
    coords[root_index] = [CENTER_XY, CENTER_XY]

    # Group non-root nodes by cluster
    cluster_members: dict[int, list[int]] = defaultdict(list)
    for i in range(n_nodes):
        if i == root_index:
            continue
        cluster_members[node_clusters[i]].append(i)

    # Order clusters by size descending (put "Other" last)
    cluster_ids = sorted(
        cluster_members.keys(),
        key=lambda c: len(cluster_members[c]),
        reverse=True,
    )

    # Compute angular sectors proportional to sqrt(cluster size) so large clusters get breathing room
    weights = np.array([math.sqrt(max(1, len(cluster_members[c]))) for c in cluster_ids])
    angles_span = (weights / weights.sum()) * (2.0 * math.pi)
    cluster_angles: dict[int, tuple[float, float]] = {}
    cursor_angle = -math.pi * 0.5  # Start at 12 o'clock
    for c, span in zip(cluster_ids, angles_span):
        center_angle = cursor_angle + span * 0.5
        cluster_angles[c] = (center_angle, span)
        cursor_angle += span

    # Map internal edges by cluster for fast local Fruchterman-Reingold layout
    intra_edges: dict[int, list[tuple[int, int]]] = defaultdict(list)
    inter_cluster_affinity: dict[int, list[int]] = defaultdict(list)
    for u, v in internal_edges:
        cu, cv = node_clusters[u], node_clusters[v]
        if cu == cv:
            intra_edges[cu].append((u, v))
        else:
            inter_cluster_affinity[u].append(cv)
            inter_cluster_affinity[v].append(cu)

    # Base ring radius from center (leaves a clean luminous clearing around ExAC)
    ring_radius = 1020.0

    for c in cluster_ids:
        members = cluster_members[c]
        m = len(members)
        if m == 0:
            continue

        center_angle, span = cluster_angles[c]
        # Cluster cloud radius scales gently with sqrt(m)
        cloud_radius = min(560.0, max(190.0, 12.5 * math.sqrt(m)))
        # Slightly stagger radial distance so adjacent clouds don't jam together
        c_rank = cluster_ids.index(c)
        r_offset = (85.0 if c_rank % 2 == 0 else -55.0)
        cx = CENTER_XY + (ring_radius + r_offset) * math.cos(center_angle)
        cy = CENTER_XY + (ring_radius + r_offset) * math.sin(center_angle)

        local_idx = {node_id: idx for idx, node_id in enumerate(members)}
        edges_local = [
            (local_idx[u], local_idx[v])
            for u, v in intra_edges[c]
            if u in local_idx and v in local_idx
        ]

        # Build local igraph for force-directed positioning of connected cluster core
        local_xy = np.zeros((m, 2), dtype=np.float64)
        if m >= 3 and len(edges_local) > 0:
            g_sub = ig.Graph(n=m, edges=edges_local, directed=False)
            g_sub.simplify(multiple=True, loops=True)
            degrees = np.array(g_sub.degree(), dtype=np.float64)

            # Separate connected vs isolated nodes in this cluster
            conn_indices = [idx for idx, d in enumerate(degrees) if d > 0]
            iso_indices = [idx for idx, d in enumerate(degrees) if d == 0]

            if len(conn_indices) >= 2:
                g_conn = g_sub.induced_subgraph(conn_indices)
                # Fast grid-accelerated Fruchterman-Reingold (sub-second per cluster)
                lay = np.array(
                    g_conn.layout_fruchterman_reingold(niter=85, grid="grid").coords,
                    dtype=np.float64,
                )
                # Robust normalize using 95th percentile radius so outliers don't squish the cloud
                lay -= np.median(lay, axis=0)
                radii = np.linalg.norm(lay, axis=1)
                p92 = np.percentile(radii, 92) if len(radii) > 5 else max(radii.max(), 1e-6)
                scale = (cloud_radius * 0.78) / max(p92, 1e-6)
                lay *= scale
                # Soft-clip extreme outliers
                radii2 = np.linalg.norm(lay, axis=1)
                max_r = cloud_radius * 1.18
                over = radii2 > max_r
                if np.any(over):
                    lay[over] *= (max_r / radii2[over])[:, None]

                for k, orig_i in enumerate(conn_indices):
                    local_xy[orig_i] = lay[k]
            elif len(conn_indices) == 1:
                local_xy[conn_indices[0]] = [0.0, 0.0]

            # Distribute isolated cluster members in an organic outer halo around the cluster core
            if iso_indices:
                iso_n = len(iso_indices)
                # Golden-angle spiral with organic jitter
                golden = math.pi * (3.0 - math.sqrt(5.0))
                for rank, orig_i in enumerate(iso_indices):
                    frac = (rank + 0.5) / iso_n
                    r = cloud_radius * (0.48 + 0.62 * math.sqrt(frac))
                    theta = rank * golden + rng.uniform(-0.18, 0.18)
                    local_xy[orig_i] = [
                        r * math.cos(theta) + rng.normal(0, 14.0),
                        r * math.sin(theta) + rng.normal(0, 14.0),
                    ]
        else:
            golden = math.pi * (3.0 - math.sqrt(5.0))
            for idx in range(m):
                frac = (idx + 0.5) / max(1, m)
                r = cloud_radius * 0.85 * math.sqrt(frac)
                theta = idx * golden
                local_xy[idx] = [r * math.cos(theta), r * math.sin(theta)]

        # Slight elliptical stretch tangent to the galaxy ring for graceful nebulae
        ux, uy = math.cos(center_angle), math.sin(center_angle)
        tx, ty = -uy, ux
        for idx, node_id in enumerate(members):
            lx, ly = local_xy[idx]
            # Project to radial & tangential components
            rad_comp = lx * ux + ly * uy
            tan_comp = lx * tx + ly * ty
            # Pull high-citation & high-in-degree landmark papers gently toward ExAC center
            cit_pull = min(0.32, 0.055 * math.log1p(citations[node_id] + 4 * in_degree[node_id]))
            px = cx + (rad_comp * 0.86) * ux + (tan_comp * 1.12) * tx
            py = cy + (rad_comp * 0.86) * uy + (tan_comp * 1.12) * ty

            # Gently nudge cross-cluster bridge papers toward their neighbor cluster's direction
            nbr_cs = inter_cluster_affinity.get(node_id)
            if nbr_cs:
                # Average vector toward linked neighbor cluster centers
                bx = 0.0
                by = 0.0
                for nc in nbr_cs[:8]:
                    if nc in cluster_angles:
                        na = cluster_angles[nc][0]
                        bx += CENTER_XY + ring_radius * math.cos(na)
                        by += CENTER_XY + ring_radius * math.sin(na)
                cnt = min(len(nbr_cs), 8)
                bx /= cnt
                by /= cnt
                bridge_w = min(0.24, 0.06 * len(nbr_cs))
                px = px * (1.0 - bridge_w) + bx * bridge_w
                py = py * (1.0 - bridge_w) + by * bridge_w

            # Pull landmark papers slightly inward toward ExAC
            px = px * (1.0 - cit_pull * 0.45) + CENTER_XY * (cit_pull * 0.45)
            py = py * (1.0 - cit_pull * 0.45) + CENTER_XY * (cit_pull * 0.45)

            # Enforce a clean luminous clearing around ExAC root
            dx, dy = px - CENTER_XY, py - CENTER_XY
            dist = math.hypot(dx, dy)
            min_clearing = 180.0
            if dist < min_clearing:
                if dist < 1e-6:
                    dx, dy, dist = ux, uy, 1.0
                px = CENTER_XY + (dx / dist) * (min_clearing + rng.uniform(5.0, 50.0))
                py = CENTER_XY + (dy / dist) * (min_clearing + rng.uniform(5.0, 50.0))

            coords[node_id] = [px, py]

    return coords


def run_stage2_build(raw_path: Path) -> None:
    """Stage 2: Stream-parse cached JSONL, run Leiden clustering, compute layout, export JSON."""
    t0 = time.time()
    print(f"[Stage 2] Streaming raw cache from {raw_path}...", flush=True)

    # Compact per-work records (discard bulky nested authorships/primary_location dicts immediately)
    compact_by_id: dict[str, dict[str, Any]] = {}
    seed_id: str | None = None
    requested_seed_id = REQUESTED_SEED_ID

    with gzip.open(raw_path, "rt", encoding="utf-8") as gz:
        for line in gz:
            line = line.strip()
            if not line:
                continue
            w = json.loads(line)
            wid = short_oa_id(w.get("id"))
            if not wid:
                continue
            is_seed = bool(w.get("_is_seed"))
            if is_seed:
                seed_id = wid
                requested_seed_id = w.get("_requested_seed_id", REQUESTED_SEED_ID)
            elif wid in compact_by_id:
                continue

            fa, la, auth_str = extract_authors(w)
            t_name, sf_name, f_name = extract_topic_info(w)
            yr = w.get("publication_year")
            if not isinstance(yr, int) or yr < 2016:
                yr = 2016
            elif yr > 2026:
                yr = 2026
            cit = w.get("cited_by_count")
            cit_int = int(cit) if isinstance(cit, int) and cit >= 0 else 0
            refs = [
                short_oa_id(r)
                for r in (w.get("referenced_works") or [])
                if r
            ]

            compact_by_id[wid] = {
                "title": (w.get("title") or "Untitled Work").strip(),
                "doi": clean_doi(w.get("doi")),
                "year": yr,
                "cit": cit_int,
                "fa": fa,
                "la": la,
                "authors": auth_str,
                "journal": extract_journal(w),
                "topic": t_name,
                "subfield": sf_name,
                "field": f_name,
                "refs": refs,
            }

    if not seed_id or seed_id not in compact_by_id:
        raise RuntimeError("Seed work not found in raw cache.")

    # Order nodes: seed at index 0, remaining works sorted by cited_by_count desc (stable)
    other_ids = [wid for wid in compact_by_id if wid != seed_id]
    other_ids.sort(
        key=lambda wid: (
            -compact_by_id[wid]["cit"],
            compact_by_id[wid]["year"],
            wid,
        )
    )
    node_ids = [seed_id] + other_ids
    id_to_idx = {wid: idx for idx, wid in enumerate(node_ids)}
    n_nodes = len(node_ids)
    root_index = 0

    print(f"[Stage 2] Deduplicated {n_nodes:,} unique works (seed={seed_id} at index 0).", flush=True)

    # Construct internal directed citation edge list (source -> target)
    internal_edges_set: set[tuple[int, int]] = set()
    hub_edges_set: set[tuple[int, int]] = set()
    in_degree = [0] * n_nodes
    out_degree = [0] * n_nodes

    for u_idx, wid in enumerate(node_ids):
        refs = compact_by_id[wid]["refs"]
        saw_root = False
        for v_id in refs:
            v_idx = id_to_idx.get(v_id)
            if v_idx is None or v_idx == u_idx:
                continue
            if v_idx == root_index or u_idx == root_index:
                hub_edges_set.add((u_idx, v_idx))
                if v_idx == root_index:
                    saw_root = True
            else:
                internal_edges_set.add((u_idx, v_idx))
        # Free ref list immediately after edge extraction
        compact_by_id[wid]["refs"] = []
        # Every citing work in the cohort cites the seed work
        if u_idx != root_index and not saw_root:
            hub_edges_set.add((u_idx, root_index))

    internal_edges = sorted(internal_edges_set)
    hub_edges = sorted(hub_edges_set)
    all_edges = internal_edges + hub_edges

    for u, v in all_edges:
        out_degree[u] += 1
        in_degree[v] += 1

    print(
        f"[Stage 2] Built {len(all_edges):,} directed edges "
        f"({len(internal_edges):,} cohort-to-cohort internal + {len(hub_edges):,} hub edges to {seed_id}).",
        flush=True,
    )

    # Extract per-node columnar metadata
    titles: list[str] = []
    dois: list[str] = []
    years: list[int] = []
    citations: list[int] = []
    first_authors: list[str] = []
    last_authors: list[str] = []
    author_strings: list[str] = []
    journals: list[str] = []
    topics: list[str] = []
    subfields: list[str] = []
    fields: list[str] = []

    for wid in node_ids:
        rec = compact_by_id.pop(wid)
        titles.append(rec["title"])
        dois.append(rec["doi"])
        years.append(rec["year"])
        citations.append(rec["cit"])
        first_authors.append(rec["fa"])
        last_authors.append(rec["la"])
        author_strings.append(rec["authors"])
        journals.append(rec["journal"])
        topics.append(rec["topic"])
        subfields.append(rec["subfield"])
        fields.append(rec["field"])

    # --- Leiden community detection on internal cohort edges (excluding universal hub) ---
    print("[Stage 2] Running igraph + Leiden community detection...", flush=True)
    g_internal = ig.Graph(n=n_nodes, edges=internal_edges, directed=False)
    g_internal.simplify(multiple=True, loops=True)

    partition = leidenalg.find_partition(
        g_internal,
        leidenalg.RBConfigurationVertexPartition,
        resolution_parameter=1.25,
        seed=42,
    )
    raw_membership = list(partition.membership)
    modularity = partition.modularity

    # Identify significant non-singleton Leiden communities (size >= 60, top 10)
    comm_nodes: dict[int, list[int]] = defaultdict(list)
    for i in range(1, n_nodes):
        if g_internal.degree(i) > 0:
            comm_nodes[raw_membership[i]].append(i)

    sorted_comms = sorted(
        [(cid, members) for cid, members in comm_nodes.items() if len(members) >= 60],
        key=lambda x: len(x[1]),
        reverse=True,
    )
    max_major = 10
    major_comms = sorted_comms[:max_major]
    major_comm_map = {cid: new_id for new_id, (cid, _) in enumerate(major_comms)}
    n_major = len(major_comms)
    other_cluster_id = n_major  # fallback cluster for unmatched isolates/micro-communities

    print(
        f"  Leiden modularity={modularity:.4f}, total active communities={len(comm_nodes)}, "
        f"major communities={n_major} (covering {sum(len(m) for _, m in major_comms):,} connected nodes).",
        flush=True,
    )

    # Build topic & subfield affinity profiles for each major Leiden community
    topic_cluster_counts: dict[str, Counter[int]] = defaultdict(Counter)
    subfield_cluster_counts: dict[str, Counter[int]] = defaultdict(Counter)
    for orig_cid, members in major_comms:
        new_id = major_comm_map[orig_cid]
        for idx in members:
            if topics[idx]:
                topic_cluster_counts[topics[idx]][new_id] += 1
            if subfields[idx]:
                subfield_cluster_counts[subfields[idx]][new_id] += 1

    # Assign final cluster IDs to every node
    node_clusters = [other_cluster_id] * n_nodes
    node_clusters[root_index] = 0  # Seed paper anchored to primary ExAC/Genomics cluster (rendered in gold)

    for i in range(1, n_nodes):
        raw_c = raw_membership[i]
        if g_internal.degree(i) > 0 and raw_c in major_comm_map:
            node_clusters[i] = major_comm_map[raw_c]
            continue

        # Assign isolated or micro-community nodes by OpenAlex primary_topic / subfield affinity
        t_name = topics[i]
        sf_name = subfields[i]
        assigned = False
        if t_name and t_name in topic_cluster_counts:
            best_c, best_cnt = topic_cluster_counts[t_name].most_common(1)[0]
            if best_cnt >= 3:
                node_clusters[i] = best_c
                assigned = True
        if not assigned and sf_name and sf_name in subfield_cluster_counts:
            best_c, best_cnt = subfield_cluster_counts[sf_name].most_common(1)[0]
            if best_cnt >= 10:
                node_clusters[i] = best_c
                assigned = True
        if not assigned:
            node_clusters[i] = other_cluster_id

    # Check if "Other" cluster has any nodes; if very few, keep it cleanly
    used_cluster_ids = sorted(set(node_clusters))
    remap = {old_c: new_c for new_c, old_c in enumerate(used_cluster_ids)}
    node_clusters = [remap[c] for c in node_clusters]
    n_clusters = len(used_cluster_ids)

    # Derive semantic cluster metadata & labels
    cluster_members_final: dict[int, list[int]] = defaultdict(list)
    for i, c in enumerate(node_clusters):
        cluster_members_final[c].append(i)

    used_labels: set[str] = set()
    cluster_meta: list[dict[str, Any]] = []
    for c in range(n_clusters):
        members = cluster_members_final[c]
        t_counts = Counter(topics[i] for i in members if topics[i])
        sf_counts = Counter(subfields[i] for i in members if subfields[i])
        f_counts = Counter(fields[i] for i in members if fields[i])
        sample_titles = [titles[i] for i in members[:80]]

        is_other = (used_cluster_ids[c] == other_cluster_id)
        if is_other:
            label = "Interdisciplinary & Other Fields"
        else:
            label = derive_cluster_label(
                t_counts.most_common(8),
                sf_counts.most_common(5),
                sample_titles,
                used_labels,
            )
        used_labels.add(label)
        color = CLUSTER_PALETTE[c % len(CLUSTER_PALETTE)]
        if is_other:
            color = CLUSTER_PALETTE[-1]

        cluster_meta.append(
            {
                "id": c,
                "name": label,
                "color": color,
                "count": len(members),
                "topTopics": [t for t, _ in t_counts.most_common(4)],
                "topSubfields": [s for s, _ in sf_counts.most_common(3)],
                "topFields": [f for f, _ in f_counts.most_common(2)],
            }
        )

    print("[Stage 2] Cluster breakdown:", flush=True)
    for cm in cluster_meta:
        print(
            f"  [{cm['id']:2d}] {cm['name']:<42s} n={cm['count']:5d}  "
            f"top_topics={cm['topTopics'][:2]}",
            flush=True,
        )

    # Compute 2D galaxy layout
    print("[Stage 2] Computing 2D center-anchored cluster galaxy layout...", flush=True)
    coords = compute_galaxy_layout(
        n_nodes=n_nodes,
        root_index=root_index,
        internal_edges=internal_edges,
        node_clusters=node_clusters,
        n_clusters=n_clusters,
        citations=citations,
        in_degree=in_degree,
    )

    # Record cluster visual centroids for HUD labels / navigation
    for cm in cluster_meta:
        members = [i for i in cluster_members_final[cm["id"]] if i != root_index]
        if members:
            pts = coords[members]
            cm["centroid"] = [
                round(float(np.median(pts[:, 0])), 1),
                round(float(np.median(pts[:, 1])), 1),
            ]
        else:
            cm["centroid"] = [CENTER_XY, CENTER_XY]

    # Log-scaled normalized node sizes
    log_cits = [math.log1p(c) for c in citations]
    max_log_cit = max(log_cits[1:]) if n_nodes > 1 else 1.0
    max_log_cit = max(max_log_cit, 1.0)
    sizes: list[float] = []
    for i, lc in enumerate(log_cits):
        if i == root_index:
            sizes.append(24.0)
        else:
            norm = min(1.0, lc / max_log_cit)
            # Crisp dynamic range: small recent papers ~2.4px, landmarks ~13.5px
            sz = 2.4 + 11.2 * (norm**1.15)
            sizes.append(round(sz, 2))

    # Year histogram (2016..2026)
    year_hist = Counter(years)
    year_min = min(2016, min(years))
    year_max = max(2026, max(years))
    year_histogram = {str(y): int(year_hist.get(y, 0)) for y in range(year_min, year_max + 1)}

    # Flatten positions & edges for ultra-fast typed-array loading in cosmos.gl
    flat_positions: list[float] = []
    for i in range(n_nodes):
        flat_positions.append(round(float(coords[i, 0]), 1))
        flat_positions.append(round(float(coords[i, 1]), 1))

    flat_edges: list[int] = []
    for u, v in all_edges:
        flat_edges.append(u)
        flat_edges.append(v)

    # String-interning helper for compact lookup tables
    def intern_column(values: list[str]) -> tuple[list[str], list[int]]:
        table: list[str] = [""]
        index_map: dict[str, int] = {"": 0}
        out_idx: list[int] = []
        for val in values:
            idx = index_map.get(val)
            if idx is None:
                idx = len(table)
                index_map[val] = idx
                table.append(val)
            out_idx.append(idx)
        return table, out_idx

    journals_table, journal_idx = intern_column(journals)
    topics_table, topic_idx = intern_column(topics)
    subfields_table, subfield_idx = intern_column(subfields)
    fields_table, field_idx = intern_column(fields)

    PUBLIC_DATA_DIR.mkdir(parents=True, exist_ok=True)

    graph_payload = {
        "meta": {
            "seedId": seed_id,
            "requestedSeedId": requested_seed_id,
            "seedDoi": dois[root_index] or SEED_DOI,
            "seedTitle": titles[root_index],
            "seedYear": years[root_index],
            "seedCitations": citations[root_index],
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "nodeCount": n_nodes,
            "edgeCount": len(all_edges),
            "internalEdgeCount": len(internal_edges),
            "hubEdgeCount": len(hub_edges),
            "leidenModularity": round(float(modularity), 4),
            "yearMin": year_min,
            "yearMax": year_max,
            "spaceSize": int(SPACE_SIZE),
            "center": [CENTER_XY, CENTER_XY],
        },
        "rootIndex": root_index,
        "clusters": cluster_meta,
        "yearHistogram": year_histogram,
        "positions": flat_positions,
        "sizes": sizes,
        "years": years,
        "nodeClusters": node_clusters,
        "citations": citations,
        "inDegree": in_degree,
        "outDegree": out_degree,
        "edges": flat_edges,
    }

    lookup_payload = {
        "ids": node_ids,
        "dois": dois,
        "titles": titles,
        "firstAuthors": first_authors,
        "lastAuthors": last_authors,
        "authors": author_strings,
        "journalIdx": journal_idx,
        "topicIdx": topic_idx,
        "subfieldIdx": subfield_idx,
        "fieldIdx": field_idx,
        "leidenIds": raw_membership,
        "tables": {
            "journals": journals_table,
            "topics": topics_table,
            "subfields": subfields_table,
            "fields": fields_table,
        },
    }

    with open(GRAPH_JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(graph_payload, f, separators=(",", ":"))
    with open(LOOKUP_JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(lookup_payload, f, separators=(",", ":"))

    g_mb = GRAPH_JSON_PATH.stat().st_size / (1024 * 1024)
    l_mb = LOOKUP_JSON_PATH.stat().st_size / (1024 * 1024)
    print(
        f"[Stage 2] Exported {GRAPH_JSON_PATH} ({g_mb:.2f} MB) and "
        f"{LOOKUP_JSON_PATH} ({l_mb:.2f} MB) in {time.time() - t0:.1f}s.",
        flush=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Fetch and build the ExAC (10.1038/nature19057) citation network."
    )
    parser.add_argument(
        "--refresh",
        action="store_true",
        help="Re-fetch raw data from OpenAlex API even if local cache exists.",
    )
    args = parser.parse_args()

    load_dotenv(PROJECT_ROOT / ".env")
    api_key = os.getenv("OPENALEX_API_KEY", "").strip()

    raw_path = run_stage1_fetch(api_key=api_key, refresh=args.refresh)
    run_stage2_build(raw_path)


if __name__ == "__main__":
    main()
