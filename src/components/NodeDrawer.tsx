import { useMemo, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Crosshair, ExternalLink, X } from 'lucide-react';
import type { LoadedNetwork } from '../types';
import {
  getNodeField,
  getNodeJournal,
  getNodeSubfield,
  getNodeTopic,
} from '../data/loadNetwork';

interface NodeDrawerProps {
  network: LoadedNetwork;
  nodeIndex: number;
  onClose: () => void;
  onSelectNeighbor: (nodeIndex: number) => void;
  onFocusNode: (nodeIndex: number) => void;
}

export function NodeDrawer({
  network,
  nodeIndex,
  onClose,
  onSelectNeighbor,
  onFocusNode,
}: NodeDrawerProps) {
  const [tab, setTab] = useState<'citing' | 'cited'>('citing');

  const isRoot = nodeIndex === network.rootIndex;
  const cluster = network.clusters[network.nodeClusters[nodeIndex]];
  const title = network.lookup.titles[nodeIndex];
  const authors = network.lookup.authors[nodeIndex] || 'Authors not listed';
  const journal = getNodeJournal(network, nodeIndex);
  const year = network.years[nodeIndex];
  const citations = network.citations[nodeIndex];
  const doi = network.lookup.dois[nodeIndex];
  const oaId = network.lookup.ids[nodeIndex];
  const field = getNodeField(network, nodeIndex);
  const subfield = getNodeSubfield(network, nodeIndex);
  const topic = getNodeTopic(network, nodeIndex);
  const leidenId = network.lookup.leidenIds[nodeIndex];

  const topCiting = useMemo(() => {
    const arr = network.citingNeighbors[nodeIndex] || [];
    return [...arr]
      .sort((a, b) => network.citations[b] - network.citations[a])
      .slice(0, 15);
  }, [network, nodeIndex]);

  const topCited = useMemo(() => {
    const arr = network.citedNeighbors[nodeIndex] || [];
    return [...arr]
      .sort((a, b) => network.citations[b] - network.citations[a])
      .slice(0, 15);
  }, [network, nodeIndex]);

  const activeList = tab === 'citing' ? topCiting : topCited;

  return (
    <aside className="detail-drawer glass-strong" aria-label="Paper metadata details">
      <div className="drawer-header">
        <div className="drawer-badges">
          {isRoot && <span className="root-pill">★ ExAC Seed Root</span>}
          {cluster && (
            <span
              className="cluster-pill"
              style={{
                background: `${cluster.color}1f`,
                borderColor: `${cluster.color}55`,
                color: cluster.color,
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  background: cluster.color,
                  boxShadow: `0 0 8px ${cluster.color}`,
                }}
              />
              {cluster.name}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button
            type="button"
            className="icon-btn"
            style={{ padding: 6 }}
            onClick={() => onFocusNode(nodeIndex)}
            title="Center camera on this paper"
            aria-label="Center camera on paper"
          >
            <Crosshair size={15} />
          </button>
          <button
            type="button"
            className="icon-btn"
            style={{ padding: 6 }}
            onClick={onClose}
            title="Close drawer (Esc)"
            aria-label="Close paper details"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="drawer-scroll">
        <div>
          <h2 className="paper-title">{title}</h2>
          <div className="paper-venue-row" style={{ marginTop: 8 }}>
            <span className="venue-tag">{journal}</span>
            <span className="mono" style={{ color: '#cbd5e1', fontWeight: 600 }}>
              {year}
            </span>
            <span className="mono" style={{ fontSize: 11, color: '#64748b' }}>
              {oaId}
              {isRoot && network.meta.requestedSeedId !== oaId
                ? ` (${network.meta.requestedSeedId})`
                : ''}
            </span>
          </div>
        </div>

        <p className="paper-authors">{authors}</p>

        <div className="metrics-grid">
          <div className="metric-card">
            <span className="metric-value" style={{ color: '#fde047' }}>
              {citations.toLocaleString()}
            </span>
            <span className="metric-label">Total Citations</span>
          </div>
          <div className="metric-card">
            <span className="metric-value" style={{ color: '#38bdf8' }}>
              {network.inDegree[nodeIndex].toLocaleString()}
            </span>
            <span className="metric-label">Cited By (ExAC)</span>
          </div>
          <div className="metric-card">
            <span className="metric-value" style={{ color: '#a78bfa' }}>
              {network.outDegree[nodeIndex].toLocaleString()}
            </span>
            <span className="metric-label">Cites (ExAC)</span>
          </div>
        </div>

        <div className="taxonomy-box">
          <div className="tax-row">
            <span className="tax-key">OpenAlex Field</span>
            <span className="tax-val">{field}</span>
          </div>
          <div className="tax-row">
            <span className="tax-key">Subfield</span>
            <span className="tax-val">{subfield}</span>
          </div>
          <div className="tax-row">
            <span className="tax-key">Primary Topic</span>
            <span className="tax-val">{topic}</span>
          </div>
          <div className="tax-row">
            <span className="tax-key">Leiden Partition</span>
            <span className="tax-val mono">#{leidenId}</span>
          </div>
        </div>

        <div className="external-links">
          {doi ? (
            <a
              className="ext-link"
              href={`https://doi.org/${doi}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink size={13} />
              DOI Paper
            </a>
          ) : (
            <span className="ext-link" style={{ opacity: 0.45, pointerEvents: 'none' }}>
              No DOI
            </span>
          )}
          <a
            className="ext-link secondary"
            href={`https://openalex.org/${oaId}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink size={13} />
            OpenAlex
          </a>
        </div>

        {/* Subgraph Neighbors */}
        <div>
          <div className="neighbor-tabs">
            <button
              type="button"
              className={`neighbor-tab ${tab === 'citing' ? 'active' : ''}`}
              onClick={() => setTab('citing')}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <ArrowDownLeft size={13} color="#38bdf8" />
                Top Citing ({network.citingNeighbors[nodeIndex].length.toLocaleString()})
              </span>
            </button>
            <button
              type="button"
              className={`neighbor-tab ${tab === 'cited' ? 'active' : ''}`}
              onClick={() => setTab('cited')}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <ArrowUpRight size={13} color="#fde047" />
                Top Cited ({network.citedNeighbors[nodeIndex].length.toLocaleString()})
              </span>
            </button>
          </div>

          <div className="neighbor-list" style={{ marginTop: 8 }}>
            {activeList.length === 0 ? (
              <div style={{ padding: '12px 6px', fontSize: 12, color: '#64748b' }}>
                {tab === 'citing'
                  ? 'No citing papers within the ExAC cohort.'
                  : 'No cited references within the ExAC cohort.'}
              </div>
            ) : (
              activeList.map((nIdx) => {
                const nc = network.clusters[network.nodeClusters[nIdx]];
                const nIsRoot = nIdx === network.rootIndex;
                return (
                  <button
                    key={nIdx}
                    type="button"
                    className="neighbor-card"
                    onClick={() => onSelectNeighbor(nIdx)}
                  >
                    <div className="neighbor-title">
                      {nIsRoot ? '★ ' : ''}
                      {network.lookup.titles[nIdx]}
                    </div>
                    <div className="neighbor-meta">
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          background: nIsRoot ? '#fde047' : nc?.color || '#38bdf8',
                          flexShrink: 0,
                        }}
                      />
                      <span>{network.lookup.firstAuthors[nIdx] || 'Unknown'}</span>
                      <span className="mono">{network.years[nIdx]}</span>
                      <span className="mono" style={{ marginLeft: 'auto', color: '#7dd3fc' }}>
                        {network.citations[nIdx].toLocaleString()} cites
                      </span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
