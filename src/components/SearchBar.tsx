import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { LoadedNetwork } from '../types';
import { getNodeJournal } from '../data/loadNetwork';

interface SearchBarProps {
  network: LoadedNetwork;
  onSelectResult: (nodeIndex: number) => void;
}

interface SearchHit {
  index: number;
  score: number;
}

export function SearchBar({ network, onSelectResult }: SearchBarProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Global "/" shortcut to focus search
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === '/' &&
        document.activeElement?.tagName !== 'INPUT' &&
        document.activeElement?.tagName !== 'TEXTAREA'
      ) {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const results = useMemo<SearchHit[]>(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];

    const tokens = q.split(/\s+/).filter(Boolean);
    const hits: SearchHit[] = [];

    for (let i = 0; i < network.nodeCount; i++) {
      const doi = network.searchDois[i];
      const id = network.searchIds[i];
      const title = network.searchTitles[i];
      const auth = network.searchAuthors[i];

      let score = 0;
      if (doi && (doi === q || doi.includes(q))) {
        score += 120;
      } else if (id && id.includes(q)) {
        score += 110;
      } else {
        // Multi-token match across title + authors + doi
        let matchedAll = true;
        for (let t = 0; t < tokens.length; t++) {
          const tok = tokens[t];
          if (title.includes(tok)) {
            score += title.startsWith(tok) ? 35 : 22;
          } else if (auth.includes(tok)) {
            score += 18;
          } else if (doi.includes(tok)) {
            score += 25;
          } else {
            matchedAll = false;
            break;
          }
        }
        if (!matchedAll) continue;
      }

      // Boost by log citation count so landmark papers float to the top
      score += Math.log1p(network.citations[i]) * 2.2;
      if (i === network.rootIndex) score += 25;
      hits.push({ index: i, score });
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, 12);
  }, [query, network]);

  useEffect(() => {
    setActiveIdx(0);
  }, [results]);

  const handleChoose = (nodeIndex: number) => {
    onSelectResult(nodeIndex);
    setOpen(false);
    inputRef.current?.blur();
  };

  return (
    <div ref={wrapRef} className="search-wrap">
      <div className="search-box glass">
        <Search size={15} color="#94a3b8" />
        <input
          ref={inputRef}
          className="search-input"
          type="text"
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActiveIdx((prev) => Math.min(results.length - 1, prev + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActiveIdx((prev) => Math.max(0, prev - 1));
            } else if (e.key === 'Enter' && results[activeIdx]) {
              e.preventDefault();
              handleChoose(results[activeIdx].index);
            } else if (e.key === 'Escape') {
              setOpen(false);
              inputRef.current?.blur();
            }
          }}
          placeholder="Search paper title, first/last author, or DOI..."
          aria-label="Search papers in ExAC citation network"
        />
        {query ? (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              inputRef.current?.focus();
            }}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#94a3b8',
              cursor: 'pointer',
              display: 'flex',
              padding: 2,
            }}
            aria-label="Clear search"
          >
            <X size={14} />
          </button>
        ) : (
          <span className="kbd-hint">/</span>
        )}
      </div>

      {open && query.trim().length >= 2 && (
        <div className="search-results glass-strong">
          {results.length === 0 ? (
            <div style={{ padding: '14px 12px', fontSize: 12.5, color: '#94a3b8' }}>
              No papers matching &ldquo;{query.trim()}&rdquo; in the ExAC cohort.
            </div>
          ) : (
            results.map((hit, idx) => {
              const cluster = network.clusters[network.nodeClusters[hit.index]];
              const isRoot = hit.index === network.rootIndex;
              return (
                <button
                  key={hit.index}
                  type="button"
                  className={`search-item ${idx === activeIdx ? 'active' : ''}`}
                  onMouseEnter={() => setActiveIdx(idx)}
                  onClick={() => handleChoose(hit.index)}
                >
                  <div className="search-item-title">
                    {isRoot ? '★ ' : ''}
                    {network.lookup.titles[hit.index]}
                  </div>
                  <div className="search-item-meta">
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        background: isRoot ? '#fde047' : cluster?.color || '#38bdf8',
                        flexShrink: 0,
                      }}
                    />
                    <span>
                      {network.lookup.firstAuthors[hit.index] || 'Unknown'}
                      {network.lookup.lastAuthors[hit.index] &&
                      network.lookup.lastAuthors[hit.index] !==
                        network.lookup.firstAuthors[hit.index]
                        ? ` … ${network.lookup.lastAuthors[hit.index]}`
                        : ''}
                    </span>
                    <span className="mono">{network.years[hit.index]}</span>
                    <span style={{ opacity: 0.75 }}>{getNodeJournal(network, hit.index)}</span>
                    <span className="mono" style={{ color: '#7dd3fc', marginLeft: 'auto' }}>
                      {network.citations[hit.index].toLocaleString()} cites
                    </span>
                  </div>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
