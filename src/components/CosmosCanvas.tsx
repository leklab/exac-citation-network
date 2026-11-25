import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { Graph, type GraphConfig } from '@cosmos.gl/graph';
import type { LoadedNetwork } from '../types';
import { getNodeJournal } from '../data/loadNetwork';

export interface CosmosCanvasHandle {
  zoomToNode: (index: number, scale?: number) => void;
  fitView: () => void;
  focusRoot: () => void;
  zoomToCluster: (clusterId: number) => void;
}

interface CosmosCanvasProps {
  network: LoadedNetwork;
  maxYear: number;
  selectedClusters: Set<number>; // empty = all clusters active
  hoveredClusterId: number | null;
  selectedNodeIndex: number | null;
  showHubEdges: boolean;
  onSelectNode: (index: number | null) => void;
  onStatsChange: (stats: { visibleNodes: number; visibleEdges: number }) => void;
}

interface HoverCardState {
  index: number;
  x: number;
  y: number;
}

interface ScreenOverlayState {
  rootPos: [number, number] | null;
  zoom: number;
  clusterPositions: { id: number; name: string; color: string; x: number; y: number }[];
}

export const CosmosCanvas = forwardRef<CosmosCanvasHandle, CosmosCanvasProps>(
  function CosmosCanvas(
    {
      network,
      maxYear,
      selectedClusters,
      hoveredClusterId,
      selectedNodeIndex,
      showHubEdges,
      onSelectNode,
      onStatsChange,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const graphRef = useRef<Graph | null>(null);
    const readyRef = useRef<boolean>(false);

    // Track currently rendered visible links for instant hover/selection brightening
    const activeLinksMetaRef = useRef<{
      incidentByNode: Map<number, { linkIdx: number; direction: 'in' | 'out'; neighbor: number }[]>;
      baseLinkColors: Float32Array;
      baseLinkWidths: Float32Array;
      linkCount: number;
    }>({
      incidentByNode: new Map(),
      baseLinkColors: new Float32Array(0),
      baseLinkWidths: new Float32Array(0),
      linkCount: 0,
    });

    const visibleMaskRef = useRef<Uint8Array>(new Uint8Array(network.nodeCount));
    const hoveredNodeRef = useRef<number | null>(null);
    const selectedNodeRef = useRef<number | null>(selectedNodeIndex);
    selectedNodeRef.current = selectedNodeIndex;

    const [hoverCard, setHoverCard] = useState<HoverCardState | null>(null);
    const [overlay, setOverlay] = useState<ScreenOverlayState>({
      rootPos: null,
      zoom: 0.3,
      clusterPositions: [],
    });

    const mousePosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

    const syncOverlays = useCallback(() => {
      const g = graphRef.current;
      if (!g || !readyRef.current) return;
      const zoom = g.getZoomLevel();
      const rx = network.positions[network.rootIndex * 2];
      const ry = network.positions[network.rootIndex * 2 + 1];
      const rootScreen = g.spaceToScreenPosition([rx, ry]);

      const clusterPositions = network.clusters.map((c) => {
        const [sx, sy] = g.spaceToScreenPosition(c.centroid);
        return { id: c.id, name: c.name, color: c.color, x: sx, y: sy };
      });

      setOverlay({
        rootPos:
          Number.isFinite(rootScreen[0]) && Number.isFinite(rootScreen[1])
            ? [rootScreen[0], rootScreen[1]]
            : null,
        zoom,
        clusterPositions,
      });
    }, [network]);

    // Apply focus/hover brightening for nodes & incident citation links
    const applyFocusHighlight = useCallback(
      (focusIdx: number | null, clusterPreviewId: number | null) => {
        const g = graphRef.current;
        if (!g || !readyRef.current) return;

        const { incidentByNode, baseLinkColors, baseLinkWidths, linkCount } =
          activeLinksMetaRef.current;

        if (focusIdx !== null && visibleMaskRef.current[focusIdx]) {
          const incident = incidentByNode.get(focusIdx) || [];
          const hlPoints = new Set<number>([focusIdx]);
          const hlLinks: number[] = [];

          // Clone base link buffers so incident links get luminous accent colors & thicker strokes
          const colors = new Float32Array(baseLinkColors);
          const widths = new Float32Array(baseLinkWidths);

          for (let k = 0; k < incident.length; k++) {
            const item = incident[k];
            hlPoints.add(item.neighbor);
            hlLinks.push(item.linkIdx);
            const o = item.linkIdx * 4;
            if (item.direction === 'in') {
              // Incoming citation (paper cites focus node): bright electric cyan
              colors[o] = 0.22;
              colors[o + 1] = 0.82;
              colors[o + 2] = 0.99;
              colors[o + 3] = 0.88;
            } else {
              // Outgoing reference (focus node cites paper): luminous warm amber-gold
              colors[o] = 0.99;
              colors[o + 1] = 0.78;
              colors[o + 2] = 0.24;
              colors[o + 3] = 0.92;
            }
            widths[item.linkIdx] = item.neighbor === network.rootIndex ? 1.5 : 2.1;
          }

          if (linkCount > 0) {
            g.setLinkColors(colors);
            g.setLinkWidths(widths);
          }

          g.setConfigPartial({
            focusedPointIndex: focusIdx,
            highlightedPointIndices: Array.from(hlPoints),
            highlightedLinkIndices: hlLinks,
            pointGreyoutOpacity: 0.14,
            linkGreyoutOpacity: 0.025,
          });
          g.render(0, 0);
          return;
        }

        // Cluster hover preview (when no node is hovered/selected)
        if (clusterPreviewId !== null) {
          const hlPoints: number[] = [network.rootIndex];
          for (let i = 0; i < network.nodeCount; i++) {
            if (
              visibleMaskRef.current[i] &&
              network.nodeClusters[i] === clusterPreviewId
            ) {
              hlPoints.push(i);
            }
          }
          if (linkCount > 0) {
            g.setLinkColors(baseLinkColors);
            g.setLinkWidths(baseLinkWidths);
          }
          g.setConfigPartial({
            focusedPointIndex: undefined,
            highlightedPointIndices: hlPoints,
            highlightedLinkIndices: undefined,
            pointGreyoutOpacity: 0.12,
            linkGreyoutOpacity: 0.05,
          });
          g.render(0, 0);
          return;
        }

        // Reset to normal state
        if (linkCount > 0) {
          g.setLinkColors(baseLinkColors);
          g.setLinkWidths(baseLinkWidths);
        }
        g.setConfigPartial({
          focusedPointIndex: undefined,
          highlightedPointIndices: undefined,
          highlightedLinkIndices: undefined,
          pointGreyoutOpacity: 0.16,
          linkGreyoutOpacity: 0.06,
        });
        g.render(0, 0);
      },
      [network],
    );

    // Initialize @cosmos.gl/graph once
    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const config: GraphConfig = {
        enableSimulation: false,
        rescalePositions: false,
        spaceSize: network.meta.spaceSize || 4096,
        backgroundColor: '#05070e',
        transitionDuration: 0,
        pointDefaultSize: 4,
        pointOpacity: 0.96,
        pointSizeScale: 1.0,
        scalePointsOnZoom: true,
        pointDefaultStrokeWidth: 0.75,
        pointDefaultStrokeColor: 'darken',
        pointStrokeContrast: 0.09,
        renderHoveredPointRing: true,
        hoveredPointCursor: 'pointer',
        hoveredPointRingColor: '#ffffff',
        focusedPointRingColor: '#fde047',
        outlinedPointIndices: [network.rootIndex],
        outlinedPointRingColor: '#fde047',
        pointGreyoutOpacity: 0.16,
        renderLinks: true,
        linkBlending: true,
        linkDefaultWidth: 0.65,
        linkWidthScale: 1.0,
        linkOpacity: 0.92,
        linkGreyoutOpacity: 0.04,
        linkVisibilityDistanceRange: [60, 420],
        linkVisibilityMinTransparency: 0.15,
        curvedLinks: true,
        curvedLinkSegments: 9,
        curvedLinkWeight: 0.7,
        curvedLinkControlPointDistance: 0.35,
        fitViewOnInit: true,
        fitViewDelay: 80,
        fitViewPadding: 0.09,
        fitViewDuration: 500,
        onPointClick: (index) => {
          onSelectNode(index);
        },
        onBackgroundClick: () => {
          onSelectNode(null);
        },
        onPointMouseOver: (index) => {
          hoveredNodeRef.current = index;
          setHoverCard({
            index,
            x: mousePosRef.current.x,
            y: mousePosRef.current.y,
          });
          applyFocusHighlight(index, null);
        },
        onPointMouseOut: () => {
          hoveredNodeRef.current = null;
          setHoverCard(null);
          applyFocusHighlight(selectedNodeRef.current, null);
        },
        onZoom: () => {
          syncOverlays();
        },
        onZoomEnd: () => {
          syncOverlays();
        },
      };

      const graph = new Graph(container, config);
      graphRef.current = graph;

      let cancelled = false;
      graph.ready.then(() => {
        if (cancelled) return;
        readyRef.current = true;

        // Per-node custom strokes (bright radiant gold ring on ExAC root)
        const strokeColors = new Float32Array(network.nodeCount * 4);
        strokeColors.fill(Number.NaN);
        const ro = network.rootIndex * 4;
        strokeColors[ro] = 1.0;
        strokeColors[ro + 1] = 0.98;
        strokeColors[ro + 2] = 0.85;
        strokeColors[ro + 3] = 1.0;

        const strokeWidths = new Float32Array(network.nodeCount);
        strokeWidths.fill(Number.NaN);
        strokeWidths[network.rootIndex] = 2.8;

        // Slightly amplify ExAC root point size for unmistakable center prominence
        const renderSizes = new Float32Array(network.sizes);
        renderSizes[network.rootIndex] = 34;

        graph.setPointColors(network.basePointColors);
        graph.setPointSizes(renderSizes);
        graph.setPointStrokeColors(strokeColors);
        graph.setPointStrokeWidths(strokeWidths);
        graph.setPointRenderOrder([network.rootIndex]);

        // Initial positions & links will be pushed by the filter effect immediately
        // Keep ExAC beacon synced as fitViewOnInit / zoom transitions finish on any GPU speed
        let lastRx = Number.NaN;
        let lastRy = Number.NaN;
        const pollInterval = window.setInterval(() => {
          if (cancelled || !graphRef.current || !readyRef.current) return;
          const rx = network.positions[network.rootIndex * 2];
          const ry = network.positions[network.rootIndex * 2 + 1];
          const [sx, sy] = graphRef.current.spaceToScreenPosition([rx, ry]);
          if (
            Number.isFinite(sx) &&
            Number.isFinite(sy) &&
            (Math.abs(sx - lastRx) > 0.5 || Math.abs(sy - lastRy) > 0.5)
          ) {
            lastRx = sx;
            lastRy = sy;
            syncOverlays();
          }
        }, 120);
        const stopPollTimeout = window.setTimeout(() => {
          window.clearInterval(pollInterval);
        }, 6000);
        return () => {
          window.clearInterval(pollInterval);
          window.clearTimeout(stopPollTimeout);
        };
      });

      const onPointerMove = (ev: MouseEvent) => {
        mousePosRef.current = { x: ev.clientX, y: ev.clientY };
        if (hoveredNodeRef.current !== null) {
          setHoverCard({
            index: hoveredNodeRef.current,
            x: ev.clientX,
            y: ev.clientY,
          });
        }
      };
      container.addEventListener('mousemove', onPointerMove, { passive: true });

      const onResize = () => syncOverlays();
      window.addEventListener('resize', onResize);

      return () => {
        cancelled = true;
        readyRef.current = false;
        container.removeEventListener('mousemove', onPointerMove);
        window.removeEventListener('resize', onResize);
        graph.destroy();
        graphRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [network]);

    // Update visible nodes & links whenever maxYear, selectedClusters, or showHubEdges change
    useEffect(() => {
      const graph = graphRef.current;
      if (!graph) return;

      const applyFilters = () => {
        const n = network.nodeCount;
        const rootIdx = network.rootIndex;
        const filterClusters = selectedClusters.size > 0;

        const filteredPositions = new Float32Array(n * 2);
        const mask = visibleMaskRef.current;
        let visibleNodes = 0;

        for (let i = 0; i < n; i++) {
          const isRoot = i === rootIdx;
          const passYear = network.years[i] <= maxYear;
          const passCluster =
            !filterClusters || selectedClusters.has(network.nodeClusters[i]);

          if (isRoot || (passYear && passCluster)) {
            mask[i] = 1;
            filteredPositions[i * 2] = network.positions[i * 2];
            filteredPositions[i * 2 + 1] = network.positions[i * 2 + 1];
            visibleNodes++;
          } else {
            mask[i] = 0;
            filteredPositions[i * 2] = Number.NaN;
            filteredPositions[i * 2 + 1] = Number.NaN;
          }
        }

        // Filter links to those with both endpoints visible
        const maxEdges = showHubEdges ? network.edgeCount : network.internalEdgeCount;
        const activeSrcTgt: number[] = [];
        const incidentByNode = new Map<
          number,
          { linkIdx: number; direction: 'in' | 'out'; neighbor: number }[]
        >();

        for (let e = 0; e < maxEdges; e++) {
          const src = network.edges[e * 2];
          const tgt = network.edges[e * 2 + 1];
          if (!mask[src] || !mask[tgt]) continue;
          const linkIdx = activeSrcTgt.length / 2;
          activeSrcTgt.push(src, tgt);

          let outList = incidentByNode.get(src);
          if (!outList) {
            outList = [];
            incidentByNode.set(src, outList);
          }
          outList.push({ linkIdx, direction: 'out', neighbor: tgt });

          let inList = incidentByNode.get(tgt);
          if (!inList) {
            inList = [];
            incidentByNode.set(tgt, inList);
          }
          inList.push({ linkIdx, direction: 'in', neighbor: src });
        }

        const linkCount = activeSrcTgt.length / 2;
        const linksTyped = new Float32Array(activeSrcTgt);
        const baseLinkColors = new Float32Array(linkCount * 4);
        const baseLinkWidths = new Float32Array(linkCount);

        for (let k = 0; k < linkCount; k++) {
          const src = activeSrcTgt[k * 2];
          const tgt = activeSrcTgt[k * 2 + 1];
          const o = k * 4;
          const isHub = tgt === rootIdx || src === rootIdx;
          if (isHub) {
            // Very subtle golden-slate rays into the ExAC center
            const c = network.clusterRgba[network.nodeClusters[src]] ?? [0.6, 0.7, 0.9, 1];
            baseLinkColors[o] = c[0] * 0.65 + 0.35;
            baseLinkColors[o + 1] = c[1] * 0.65 + 0.28;
            baseLinkColors[o + 2] = c[2] * 0.45 + 0.12;
            baseLinkColors[o + 3] = 0.045;
            baseLinkWidths[k] = 0.45;
          } else {
            // Subtle translucent internal cluster citation web
            const c = network.clusterRgba[network.nodeClusters[src]] ?? [0.5, 0.7, 0.95, 1];
            baseLinkColors[o] = c[0];
            baseLinkColors[o + 1] = c[1];
            baseLinkColors[o + 2] = c[2];
            baseLinkColors[o + 3] = 0.13;
            baseLinkWidths[k] = 0.65;
          }
        }

        activeLinksMetaRef.current = {
          incidentByNode,
          baseLinkColors,
          baseLinkWidths,
          linkCount,
        };

        graph.setPointPositions(filteredPositions, true);
        graph.setLinks(linksTyped);
        if (linkCount > 0) {
          graph.setLinkColors(baseLinkColors);
          graph.setLinkWidths(baseLinkWidths);
        }
        graph.render(0, 0);

        onStatsChange({ visibleNodes, visibleEdges: linkCount });

        // Re-apply selection highlight if a node is currently selected
        const focus = hoveredNodeRef.current ?? selectedNodeRef.current;
        if (focus !== null || hoveredClusterId !== null) {
          applyFocusHighlight(focus, focus === null ? hoveredClusterId : null);
        }
        syncOverlays();
      };

      if (readyRef.current) {
        applyFilters();
      } else {
        graph.ready.then(applyFilters);
      }
    }, [
      network,
      maxYear,
      selectedClusters,
      showHubEdges,
      hoveredClusterId,
      applyFocusHighlight,
      onStatsChange,
      syncOverlays,
    ]);

    // Respond to selectedNodeIndex or hoveredClusterId changes
    useEffect(() => {
      if (!readyRef.current) return;
      const focus = hoveredNodeRef.current ?? selectedNodeIndex;
      applyFocusHighlight(focus, focus === null ? hoveredClusterId : null);
    }, [selectedNodeIndex, hoveredClusterId, applyFocusHighlight]);

    useImperativeHandle(
      ref,
      () => ({
        zoomToNode: (index: number, scale = 5.5) => {
          const g = graphRef.current;
          if (!g || !readyRef.current) return;
          g.zoomToPointByIndex(index, 750, scale, true, false);
        },
        fitView: () => {
          const g = graphRef.current;
          if (!g || !readyRef.current) return;
          g.fitView(600, 0.09, false);
        },
        focusRoot: () => {
          const g = graphRef.current;
          if (!g || !readyRef.current) return;
          g.zoomToPointByIndex(network.rootIndex, 700, 3.2, true, false);
        },
        zoomToCluster: (clusterId: number) => {
          const g = graphRef.current;
          if (!g || !readyRef.current) return;
          const indices: number[] = [];
          for (let i = 0; i < network.nodeCount; i++) {
            if (visibleMaskRef.current[i] && network.nodeClusters[i] === clusterId) {
              indices.push(i);
            }
          }
          if (indices.length > 0) {
            g.fitViewByPointIndices(indices, 650, 0.18, false);
          }
        },
      }),
      [network],
    );

    const hoveredTitle =
      hoverCard !== null ? network.lookup.titles[hoverCard.index] : '';
    const hoveredCluster =
      hoverCard !== null
        ? network.clusters[network.nodeClusters[hoverCard.index]]
        : null;

    return (
      <div className="canvas-layer">
        <div ref={containerRef} style={{ width: '100%', height: '100%' }} />

        {/* Synchronized 2D HUD overlay for ExAC center beacon */}
        <div className="hud-overlay">
          {overlay.rootPos && (
            <div
              className="exac-beacon"
              style={{
                left: `${overlay.rootPos[0]}px`,
                top: `${overlay.rootPos[1]}px`,
              }}
            >
              <div className="exac-pulse" />
              <div className="exac-label-chip">
                ★ ExAC · Nature 2016 ({network.meta.seedCitations.toLocaleString()} cites)
              </div>
            </div>
          )}
        </div>

        {/* Crisp Hover Tooltip */}
        {hoverCard !== null && (
          <div
            className="hover-tooltip"
            style={{
              left: `${Math.min(window.innerWidth - 330, hoverCard.x + 16)}px`,
              top: `${Math.min(window.innerHeight - 140, hoverCard.y + 16)}px`,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                marginBottom: 4,
                fontSize: 10.5,
                color: hoverCard.index === network.rootIndex ? '#fde047' : hoveredCluster?.color,
                fontWeight: 600,
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  background:
                    hoverCard.index === network.rootIndex
                      ? '#fde047'
                      : hoveredCluster?.color || '#38bdf8',
                }}
              />
              {hoverCard.index === network.rootIndex
                ? 'SEED PAPER · ExAC (10.1038/nature19057)'
                : hoveredCluster?.name}
            </div>
            <div
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                color: '#f8fafc',
                lineHeight: 1.35,
                marginBottom: 5,
              }}
            >
              {hoveredTitle}
            </div>
            <div
              style={{
                fontSize: 11,
                color: '#94a3b8',
                display: 'flex',
                flexWrap: 'wrap',
                gap: '4px 10px',
              }}
            >
              <span>{network.lookup.firstAuthors[hoverCard.index] || 'Unknown author'}</span>
              <span className="mono">{network.years[hoverCard.index]}</span>
              <span>{getNodeJournal(network, hoverCard.index)}</span>
              <span className="mono" style={{ color: '#7dd3fc' }}>
                {network.citations[hoverCard.index].toLocaleString()} citations
              </span>
            </div>
          </div>
        )}
      </div>
    );
  },
);
