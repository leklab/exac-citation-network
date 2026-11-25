export interface ClusterMeta {
  id: number;
  name: string;
  color: string;
  count: number;
  topTopics: string[];
  topSubfields: string[];
  topFields: string[];
  centroid: [number, number];
}

export interface GraphMeta {
  seedId: string;
  requestedSeedId: string;
  seedDoi: string;
  seedTitle: string;
  seedYear: number;
  seedCitations: number;
  generatedAt: string;
  nodeCount: number;
  edgeCount: number;
  internalEdgeCount: number;
  hubEdgeCount: number;
  leidenModularity: number;
  yearMin: number;
  yearMax: number;
  spaceSize: number;
  center: [number, number];
}

export interface GraphDataPayload {
  meta: GraphMeta;
  rootIndex: number;
  clusters: ClusterMeta[];
  yearHistogram: Record<string, number>;
  positions: number[];
  sizes: number[];
  years: number[];
  nodeClusters: number[];
  citations: number[];
  inDegree: number[];
  outDegree: number[];
  edges: number[];
}

export interface LookupTables {
  journals: string[];
  topics: string[];
  subfields: string[];
  fields: string[];
}

export interface LookupPayload {
  ids: string[];
  dois: string[];
  titles: string[];
  firstAuthors: string[];
  lastAuthors: string[];
  authors: string[];
  journalIdx: number[];
  topicIdx: number[];
  subfieldIdx: number[];
  fieldIdx: number[];
  leidenIds: number[];
  tables: LookupTables;
}

export interface NeighborRef {
  nodeIndex: number;
  direction: 'citing' | 'cited';
}

export interface LoadedNetwork {
  meta: GraphMeta;
  rootIndex: number;
  nodeCount: number;
  edgeCount: number;
  internalEdgeCount: number;
  clusters: ClusterMeta[];
  clusterRgba: [number, number, number, number][];
  yearHistogram: Record<number, number>;

  // Typed arrays for WebGL
  positions: Float32Array;
  sizes: Float32Array;
  basePointColors: Float32Array;
  years: Uint16Array;
  nodeClusters: Uint8Array;
  citations: Uint32Array;
  inDegree: Uint32Array;
  outDegree: Uint32Array;
  edges: Uint32Array; // [src0, tgt0, src1, tgt1, ...]

  // Adjacency in full ExAC subgraph (sorted by citation count desc lazily or upfront)
  citingNeighbors: number[][]; // papers that cite node i (incoming edges: u -> i)
  citedNeighbors: number[][]; // papers cited by node i (outgoing edges: i -> v)

  // Flat metadata lookup
  lookup: LookupPayload;

  // Lowercase search strings
  searchTitles: string[];
  searchAuthors: string[];
  searchDois: string[];
  searchIds: string[];
}
