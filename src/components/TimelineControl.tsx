import { useState } from 'react';
import { Calendar, ChevronDown, ChevronUp, Pause, Play, RotateCcw } from 'lucide-react';

interface TimelineControlProps {
  yearMin: number;
  yearMax: number;
  currentYear: number;
  isPlaying: boolean;
  yearHistogram: Record<number, number>;
  visibleNodes: number;
  totalNodes: number;
  visibleEdges: number;
  onYearChange: (year: number) => void;
  onTogglePlay: () => void;
  onResetYear: () => void;
}

export function TimelineControl({
  yearMin,
  yearMax,
  currentYear,
  isPlaying,
  yearHistogram,
  visibleNodes,
  totalNodes,
  visibleEdges,
  onYearChange,
  onTogglePlay,
  onResetYear,
}: TimelineControlProps) {
  const [collapsed, setCollapsed] = useState(false);

  const years: number[] = [];
  for (let y = yearMin; y <= yearMax; y++) {
    years.push(y);
  }
  const maxBar = Math.max(1, ...years.map((y) => yearHistogram[y] || 0));

  return (
    <section
      className={`timeline-dock glass-strong ${collapsed ? 'collapsed' : ''}`}
      aria-label="Publication year timeline"
    >
      {collapsed ? (
        <div className="timeline-collapsed-bar">
          <button
            type="button"
            className="play-btn mini"
            onClick={onTogglePlay}
            title={isPlaying ? 'Pause citation wave (Space)' : 'Play citation wave 2016–2026 (Space)'}
            aria-label={isPlaying ? 'Pause timeline' : 'Play timeline'}
          >
            {isPlaying ? <Pause size={13} /> : <Play size={13} style={{ marginLeft: 1 }} />}
          </button>

          <button
            type="button"
            className="timeline-collapse-toggle"
            onClick={() => setCollapsed(false)}
            title="Expand publication-year timeline"
            aria-expanded={false}
          >
            <Calendar size={14} color="#38bdf8" />
            <span className="legend-title">
              Timeline · <span className="mono" style={{ color: '#f8fafc' }}>{currentYear}</span>
            </span>
            <span className="timeline-collapsed-stats mono">
              <span style={{ color: '#7dd3fc' }}>{visibleNodes.toLocaleString()}</span> papers ·{' '}
              <span style={{ color: '#fde047' }}>{visibleEdges.toLocaleString()}</span> edges
            </span>
            <ChevronUp size={15} />
          </button>
        </div>
      ) : (
        <>
          <div className="timeline-top">
            <div className="timeline-controls">
              <button
                type="button"
                className="play-btn"
                onClick={onTogglePlay}
                title={
                  isPlaying
                    ? 'Pause citation wave (Space)'
                    : 'Play citation wave 2016–2026 (Space)'
                }
                aria-label={isPlaying ? 'Pause timeline' : 'Play timeline'}
              >
                {isPlaying ? <Pause size={16} /> : <Play size={16} style={{ marginLeft: 2 }} />}
              </button>

              <div className="year-badge">
                {currentYear}
                <span>
                  {yearMin}–{currentYear} wave
                </span>
              </div>

              {currentYear < yearMax && (
                <button
                  type="button"
                  className="icon-btn"
                  style={{ padding: '4px 8px', fontSize: 11 }}
                  onClick={onResetYear}
                  title="Show all years through 2026"
                >
                  <RotateCcw size={12} />
                  All Years
                </button>
              )}
            </div>

            <div className="timeline-right">
              <div className="live-counters">
                <div className="counter-pill">
                  <span className="counter-val" style={{ color: '#7dd3fc' }}>
                    {visibleNodes.toLocaleString()}
                    <span style={{ color: '#64748b', fontWeight: 500, fontSize: 11 }}>
                      {' '}
                      / {totalNodes.toLocaleString()}
                    </span>
                  </span>
                  <span className="counter-lbl">Visible Papers</span>
                </div>

                <div className="counter-pill">
                  <span className="counter-val" style={{ color: '#fde047' }}>
                    {visibleEdges.toLocaleString()}
                  </span>
                  <span className="counter-lbl">Visible Edges</span>
                </div>
              </div>

              <button
                type="button"
                className="icon-btn timeline-minimize-btn"
                onClick={() => setCollapsed(true)}
                title="Collapse timeline panel"
                aria-label="Collapse timeline panel"
                aria-expanded={true}
              >
                <ChevronDown size={15} />
              </button>
            </div>
          </div>

          <div className="timeline-track-wrap">
            <div
              className="year-bars"
              style={{ gridTemplateColumns: `repeat(${years.length}, 1fr)` }}
            >
              {years.map((y) => {
                const count = yearHistogram[y] || 0;
                const hPct = Math.max(8, (count / maxBar) * 100);
                const active = y <= currentYear;
                const isHead = y === currentYear;
                return (
                  <div
                    key={y}
                    className="year-bar-col"
                    onClick={() => onYearChange(y)}
                    title={`${y}: ${count.toLocaleString()} papers`}
                  >
                    <div
                      className="year-bar"
                      style={{
                        height: `${hPct}%`,
                        background: isHead
                          ? 'linear-gradient(180deg, #fde047 0%, #38bdf8 100%)'
                          : active
                            ? 'linear-gradient(180deg, rgba(56,189,248,0.85) 0%, rgba(167,139,250,0.45) 100%)'
                            : 'rgba(148, 163, 184, 0.18)',
                      }}
                    />
                  </div>
                );
              })}
            </div>

            <input
              type="range"
              className="timeline-slider"
              min={yearMin}
              max={yearMax}
              step={1}
              value={currentYear}
              onChange={(e) => onYearChange(Number(e.target.value))}
              aria-label="Filter papers up to publication year"
            />

            <div className="year-ticks">
              {years.map((y) => (
                <span
                  key={y}
                  style={{
                    color: y === currentYear ? '#38bdf8' : undefined,
                    fontWeight: y === currentYear ? 700 : 400,
                  }}
                >
                  {y}
                </span>
              ))}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
