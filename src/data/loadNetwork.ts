import type { GraphDataPayload, LoadedNetwork, LookupPayload } from '../types';

export function hexToRgba(hex: string, alpha = 1): [number, number, number, number] {
  const clean = hex.replace('#', '');
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean;
  const num = parseInt(full, 16);
  const r = ((num >> 16) & 255) / 255;
  const g = ((num >> 8) & 255) / 255;
  const b = (num & 255) / 255;
  return [r, g, b, alpha];
}

export const ROOT_COLOR_HEX = '#fde047';
export const ROOT_COLOR_RGBA: [number, number, number, number] = [1.0, 0.9, 0.34, 1.0];

export async function loadLocalNetwork(): Promise<LoadedNetwork> {
  const [graphRes, lookupRes] = await Promise.all([
    fetch('/data/graph.json'),
    fetch('/data/lookup.json'),
  ]);

  if (!graphRes.ok) {
    throw new Error(`Failed to load /data/graph.json (HTTP ${graphRes.status})`);
  }
  if (!lookupRes.ok) {
    throw new Error(`Failed to load /data/lookup.json (HTTP ${lookupRes.status})`);
  }

  const [graphData, lookup]: [GraphDataPayload, LookupPayload] = await Promise.all([
    graphRes.json(),
    lookupRes.json(),
  ]);

  const nodeCount = graphData.meta.nodeCount;
  const edgeCount = graphData.meta.edgeCount;
  const rootIndex = graphData.rootIndex;

  const positions = new Float32Array(graphData.positions);
  const sizes = new Float32Array(graphData.sizes);
  const years = new Uint16Array(graphData.years);
  const nodeClusters = new Uint8Array(graphData.nodeClusters);
  const citations = new Uint32Array(graphData.citations);
  const inDegree = new Uint32Array(graphData.inDegree);
  const outDegree = new Uint32Array(graphData.outDegree);
  const edges = new Uint32Array(graphData.edges);

  const clusterRgba = graphData.clusters.map((c) => hexToRgba(c.color, 0.92));

  // Build per-node RGBA array (with subtle luminosity boost for high-citation nodes and golden root)
  const basePointColors = new Float32Array(nodeCount * 4);
  for (let i = 0; i < nodeCount; i++) {
    const o = i * 4;
    if (i === rootIndex) {
      basePointColors[o] = ROOT_COLOR_RGBA[0];
      basePointColors[o + 1] = ROOT_COLOR_RGBA[1];
      basePointColors[o + 2] = ROOT_COLOR_RGBA[2];
      basePointColors[o + 3] = 1.0;
    } else {
      const c = clusterRgba[nodeClusters[i]] ?? [0.6, 0.7, 0.85, 0.9];
      // Boost brightness slightly for higher citation landmark papers
      const boost = Math.min(0.22, Math.log1p(citations[i]) * 0.025);
      basePointColors[o] = Math.min(1, c[0] + boost);
      basePointColors[o + 1] = Math.min(1, c[1] + boost);
      basePointColors[o + 2] = Math.min(1, c[2] + boost);
      basePointColors[o + 3] = 0.88 + Math.min(0.12, boost * 0.5);
    }
  }

  // Build directed adjacency lists (src -> tgt means src cites tgt)
  const citingNeighbors: number[][] = Array.from({ length: nodeCount }, () => []);
  const citedNeighbors: number[][] = Array.from({ length: nodeCount }, () => []);

  for (let e = 0; e < edgeCount; e++) {
    const src = edges[e * 2];
    const tgt = edges[e * 2 + 1];
    citedNeighbors[src].push(tgt);
    citingNeighbors[tgt].push(src);
  }

  // Build lowercase search indices
  const searchTitles = new Array<string>(nodeCount);
  const searchAuthors = new Array<string>(nodeCount);
  const searchDois = new Array<string>(nodeCount);
  const searchIds = new Array<string>(nodeCount);

  for (let i = 0; i < nodeCount; i++) {
    searchTitles[i] = (lookup.titles[i] || '').toLowerCase();
    searchAuthors[i] = `${lookup.firstAuthors[i] || ''} ${lookup.lastAuthors[i] || ''} ${lookup.authors[i] || ''}`.toLowerCase();
    searchDois[i] = (lookup.dois[i] || '').toLowerCase();
    searchIds[i] = (lookup.ids[i] || '').toLowerCase();
  }
  // Ensure root paper also matches requested OpenAlex ID alias (W2510424803) and "ExAC"
  if (graphData.meta.requestedSeedId) {
    searchIds[rootIndex] = `${searchIds[rootIndex]} ${graphData.meta.requestedSeedId.toLowerCase()} exac`;
  }

  const yearHistogram: Record<number, number> = {};
  for (const [k, v] of Object.entries(graphData.yearHistogram)) {
    yearHistogram[Number(k)] = v;
  }

  return {
    meta: graphData.meta,
    rootIndex,
    nodeCount,
    edgeCount,
    internalEdgeCount: graphData.meta.internalEdgeCount,
    clusters: graphData.clusters,
    clusterRgba,
    yearHistogram,
    positions,
    sizes,
    basePointColors,
    years,
    nodeClusters,
    citations,
    inDegree,
    outDegree,
    edges,
    citingNeighbors,
    citedNeighbors,
    lookup,
    searchTitles,
    searchAuthors,
    searchDois,
    searchIds,
  };
}

export function getNodeJournal(net: LoadedNetwork, idx: number): string {
  return net.lookup.tables.journals[net.lookup.journalIdx[idx]] || 'Unknown Venue';
}

export function getNodeTopic(net: LoadedNetwork, idx: number): string {
  return net.lookup.tables.topics[net.lookup.topicIdx[idx]] || 'Unclassified';
}

export function getNodeSubfield(net: LoadedNetwork, idx: number): string {
  return net.lookup.tables.subfields[net.lookup.subfieldIdx[idx]] || 'Genetics & Genomics';
}

export function getNodeField(net: LoadedNetwork, idx: number): string {
  return net.lookup.tables.fields[net.lookup.fieldIdx[idx]] || 'Life Sciences';
}
