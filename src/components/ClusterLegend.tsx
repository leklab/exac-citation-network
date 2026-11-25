import { useState } from 'react';
import { ChevronDown, ChevronRight, Layers, RotateCcw } from 'lucide-react';
import type { ClusterMeta } from '../types';

interface ClusterLegendProps {
  clusters: ClusterMeta[];
  totalNodes: number;
  selectedClusters: Set<number>;
  onToggleCluster: (clusterId: number, multi: boolean) => void;
  onClearClusters: () => void;
  onHoverCluster: (clusterId: number | null) => void;
  leidenModularity: number;
}

export function ClusterLegend({
  clusters,
  totalNodes,
  selectedClusters,
  onToggleCluster,
  onClearClusters,
  onHoverCluster,
  leidenModularity,
}: ClusterLegendProps) {
  const [collapsed, setCollapsed] = useState(false);
  const maxCount = Math.max(1, ...clusters.map((c) => c.count));
  const hasSelection = selectedClusters.size > 0;

  return (
    <aside className={`legend-panel glass ${collapsed ? 'collapsed' : ''}`}>
      <div className="legend-header">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: '#cbd5e1',
            padding: 0,
          }}
        >
          <Layers size={14} color="#38bdf8" />
          <span className="legend-title">Leiden Clusters ({clusters.length})</span>
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>

        {hasSelection && !collapsed && (
          <button
            type="button"
            className="icon-btn"
            style={{ padding: '4px 8px', fontSize: 11 }}
            onClick={onClearClusters}
            title="Show all clusters"
          >
            <RotateCcw size={12} />
            Reset
          </button>
        )}
      </div>

      {!collapsed && (
        <>
          <div className="legend-body">
            {clusters.map((cluster) => {
              const isSelected = selectedClusters.has(cluster.id);
              const isDimmed = hasSelection && !isSelected;
              const pct = ((cluster.count / Math.max(1, totalNodes)) * 100).toFixed(1);
              const barPct = (cluster.count / maxCount) * 100;

              return (
                <button
                  key={cluster.id}
                  type="button"
                  className={`cluster-row ${isSelected ? 'selected' : ''} ${
                    isDimmed ? 'dimmed' : ''
                  }`}
                  onClick={(e) => onToggleCluster(cluster.id, e.shiftKey || e.metaKey || e.ctrlKey)}
                  onMouseEnter={() => onHoverCluster(cluster.id)}
                  onMouseLeave={() => onHoverCluster(null)}
                  title={`${cluster.name} — Click to isolate, Shift+Click to combine`}
                >
                  <div className="cluster-row-top">
                    <div className="cluster-label-wrap">
                      <span
                        className="cluster-swatch"
                        style={{
                          background: cluster.color,
                          boxShadow: `0 0 10px ${cluster.color}99`,
                        }}
                      />
                      <span className="cluster-name">{cluster.name}</span>
                    </div>
                    <span className="cluster-count">
                      {cluster.count.toLocaleString()}
                    </span>
                  </div>

                  <div className="cluster-bar-track">
                    <div
                      className="cluster-bar-fill"
                      style={{
                        width: `${barPct}%`,
                        background: cluster.color,
                        boxShadow: `0 0 8px ${cluster.color}88`,
                      }}
                    />
                  </div>

                  {cluster.topSubfields.length > 0 && (
                    <div className="cluster-subtags">
                      {pct}% · {cluster.topTopics[0] || cluster.topSubfields.join(' · ')}
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          <div className="legend-footer">
            <span>Click to isolate · Shift+Click multi</span>
            <span className="mono" title="Leiden RBConfiguration modularity">
              Q={leidenModularity.toFixed(2)}
            </span>
          </div>
        </>
      )}
    </aside>
  );
}
