import { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize2, Network, Sparkles } from 'lucide-react';
import type { LoadedNetwork } from './types';
import { loadLocalNetwork } from './data/loadNetwork';
import { CosmosCanvas, type CosmosCanvasHandle } from './components/CosmosCanvas';
import { SearchBar } from './components/SearchBar';
import { ClusterLegend } from './components/ClusterLegend';
import { TimelineControl } from './components/TimelineControl';
import { NodeDrawer } from './components/NodeDrawer';

export default function App() {
  const [network, setNetwork] = useState<LoadedNetwork | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [currentYear, setCurrentYear] = useState<number>(2026);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [selectedClusters, setSelectedClusters] = useState<Set<number>>(new Set());
  const [hoveredClusterId, setHoveredClusterId] = useState<number | null>(null);
  const [selectedNodeIndex, setSelectedNodeIndex] = useState<number | null>(null);
  const [showHubEdges, setShowHubEdges] = useState<boolean>(false);
  const [visibleStats, setVisibleStats] = useState<{
    visibleNodes: number;
    visibleEdges: number;
  }>({ visibleNodes: 0, visibleEdges: 0 });

  const canvasRef = useRef<CosmosCanvasHandle | null>(null);

  // Load 100% local static JSON graph + lookup tables
  useEffect(() => {
    let active = true;
    loadLocalNetwork()
      .then((loaded) => {
        if (!active) return;
        setNetwork(loaded);
        setCurrentYear(loaded.meta.yearMax);
        setVisibleStats({
          visibleNodes: loaded.nodeCount,
          visibleEdges: loaded.internalEdgeCount,
        });
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, []);

  // Timeline wave playback timer (2016 -> 2026)
  useEffect(() => {
    if (!isPlaying || !network) return;
    const id = window.setInterval(() => {
      setCurrentYear((prev) => {
        if (prev >= network.meta.yearMax) {
          setIsPlaying(false);
          return network.meta.yearMax;
        }
        return prev + 1;
      });
    }, 850);
    return () => window.clearInterval(id);
  }, [isPlaying, network]);

  // Global keyboard shortcuts (Space = Play/Pause, Esc = Close drawer)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        document.activeElement?.tagName === 'INPUT' ||
        document.activeElement?.tagName === 'TEXTAREA'
      ) {
        return;
      }
      if (e.key === 'Escape') {
        setSelectedNodeIndex(null);
      } else if (e.key === ' ' && network) {
        e.preventDefault();
        setIsPlaying((playing) => {
          if (!playing && currentYear >= network.meta.yearMax) {
            setCurrentYear(network.meta.yearMin);
          }
          return !playing;
        });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [network, currentYear]);

  const handleTogglePlay = useCallback(() => {
    if (!network) return;
    setIsPlaying((playing) => {
      if (!playing && currentYear >= network.meta.yearMax) {
        setCurrentYear(network.meta.yearMin);
      }
      return !playing;
    });
  }, [network, currentYear]);

  const handleToggleCluster = useCallback(
    (clusterId: number, multi: boolean) => {
      setSelectedClusters((prev) => {
        const next = new Set(prev);
        if (multi) {
          if (next.has(clusterId)) next.delete(clusterId);
          else next.add(clusterId);
        } else {
          if (next.size === 1 && next.has(clusterId)) {
            next.clear();
          } else {
            next.clear();
            next.add(clusterId);
          }
        }
        return next;
      });
    },
    [],
  );

  // Navigate to a specific node from Search or Drawer neighbor click
  const handleJumpToNode = useCallback(
    (nodeIndex: number) => {
      if (!network) return;
      // Ensure node is visible under current year & cluster filters
      const nodeYear = network.years[nodeIndex];
      if (nodeYear > currentYear) {
        setIsPlaying(false);
        setCurrentYear(nodeYear);
      }
      if (
        nodeIndex !== network.rootIndex &&
        selectedClusters.size > 0 &&
        !selectedClusters.has(network.nodeClusters[nodeIndex])
      ) {
        setSelectedClusters(new Set());
      }
      setSelectedNodeIndex(nodeIndex);
      // Slight delay if filters just expanded so point position is active before zoom
      window.setTimeout(() => {
        canvasRef.current?.zoomToNode(nodeIndex, nodeIndex === network.rootIndex ? 3.4 : 6.0);
      }, 60);
    },
    [network, currentYear, selectedClusters],
  );

  if (error) {
    return (
      <div className="loading-screen">
        <div style={{ color: '#fb7185', fontWeight: 700, fontSize: 16 }}>
          Failed to load ExAC Citation Network
        </div>
        <div className="mono" style={{ color: '#94a3b8', fontSize: 12.5, maxWidth: 520, textAlign: 'center' }}>
          {error}
        </div>
        <div style={{ color: '#64748b', fontSize: 12 }}>
          Ensure <code>ingest/fetch_exac_network.py</code> has populated <code>public/data/graph.json</code>.
        </div>
      </div>
    );
  }

  if (!network) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
        <div style={{ fontWeight: 600, fontSize: 15, color: '#e2e8f0' }}>
          Initializing ExAC WebGL Citation Universe...
        </div>
        <div className="mono" style={{ fontSize: 11.5, color: '#64748b' }}>
          10.1038/nature19057 · Local GPU Buffer Load
        </div>
      </div>
    );
  }

  return (
    <main className="app-shell">
      {/* Full-viewport WebGL GPU Graph */}
      <CosmosCanvas
        ref={canvasRef}
        network={network}
        maxYear={currentYear}
        selectedClusters={selectedClusters}
        hoveredClusterId={hoveredClusterId}
        selectedNodeIndex={selectedNodeIndex}
        showHubEdges={showHubEdges}
        onSelectNode={setSelectedNodeIndex}
        onStatsChange={setVisibleStats}
      />

      {/* Top HUD Header: Brand + Search + Quick Camera Controls */}
      <header className="top-header">
        <div className="brand-card glass">
          <div className="brand-orb">Ex</div>
          <div>
            <div className="brand-title">ExAC Citation Network</div>
            <div className="brand-sub">
              <span className="brand-dot" />
              <span>10.1038/nature19057 · {network.meta.seedId}</span>
            </div>
          </div>
        </div>

        <SearchBar network={network} onSelectResult={handleJumpToNode} />

        <div className="action-toolbar glass">
          <button
            type="button"
            className="icon-btn gold"
            onClick={() => handleJumpToNode(network.rootIndex)}
            title="Center & inspect ExAC seed paper (Lek et al. 2016)"
          >
            <Sparkles size={14} />
            ExAC Root
          </button>
          <button
            type="button"
            className={`icon-btn ${showHubEdges ? 'active' : ''}`}
            onClick={() => setShowHubEdges((v) => !v)}
            title="Toggle direct citation rays into ExAC root node"
          >
            <Network size={14} />
            {showHubEdges ? 'All Edges' : 'Cohort Web'}
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => canvasRef.current?.fitView()}
            title="Fit entire network to viewport"
          >
            <Maximize2 size={14} />
            Fit
          </button>
        </div>
      </header>

      {/* Left Cluster Legend & Filter */}
      <ClusterLegend
        clusters={network.clusters}
        totalNodes={network.nodeCount}
        selectedClusters={selectedClusters}
        onToggleCluster={handleToggleCluster}
        onClearClusters={() => setSelectedClusters(new Set())}
        onHoverCluster={setHoveredClusterId}
        leidenModularity={network.meta.leidenModularity}
      />

      {/* Right Glassmorphic Paper Metadata Drawer */}
      {selectedNodeIndex !== null && (
        <NodeDrawer
          network={network}
          nodeIndex={selectedNodeIndex}
          onClose={() => setSelectedNodeIndex(null)}
          onSelectNeighbor={handleJumpToNode}
          onFocusNode={(idx) => canvasRef.current?.zoomToNode(idx, 5.5)}
        />
      )}

      {/* Bottom Publication-Year Timeline Scrubber & Live Counters */}
      <TimelineControl
        yearMin={network.meta.yearMin}
        yearMax={network.meta.yearMax}
        currentYear={currentYear}
        isPlaying={isPlaying}
        yearHistogram={network.yearHistogram}
        visibleNodes={visibleStats.visibleNodes}
        totalNodes={network.nodeCount}
        visibleEdges={visibleStats.visibleEdges}
        onYearChange={(y) => {
          setIsPlaying(false);
          setCurrentYear(y);
        }}
        onTogglePlay={handleTogglePlay}
        onResetYear={() => {
          setIsPlaying(false);
          setCurrentYear(network.meta.yearMax);
        }}
      />
    </main>
  );
}
