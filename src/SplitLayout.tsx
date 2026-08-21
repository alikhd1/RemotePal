import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { PaneNode, SplitDir, SplitPath, SshPane } from "./splitTree";

const GUTTER = 4; // px
const MIN_PANE_PX = 80;

// A rectangle as percent-of-container plus a pixel correction, so
// gutters keep a fixed pixel width at any nesting depth.
type Dim = [pct: number, px: number];
interface Frac {
  left: Dim;
  top: Dim;
  width: Dim;
  height: Dim;
}

interface PlacedPane {
  pane: SshPane;
  rect: Frac;
}

interface PlacedGutter {
  dir: SplitDir;
  path: SplitPath;
  rect: Frac;
  /** rect of the split this gutter belongs to, for drag math */
  region: Frac;
}

const FULL: Frac = {
  left: [0, 0],
  top: [0, 0],
  width: [100, 0],
  height: [100, 0],
};

// Panes and gutters are rendered as a FLAT absolutely-positioned list
// keyed by stable ids: re-splitting only changes styles, so React never
// remounts a live terminal (remounting would kill its SSH session).
function collect(
  node: PaneNode,
  rect: Frac,
  path: SplitPath,
  panes: PlacedPane[],
  gutters: PlacedGutter[],
) {
  if (node.type === "leaf") {
    panes.push({ pane: node.pane, rect });
    return;
  }
  const { dir, ratio } = node;
  const half = GUTTER / 2;
  let first: Frac;
  let second: Frac;
  let gutterRect: Frac;
  if (dir === "row") {
    const at: Dim = [
      rect.left[0] + rect.width[0] * ratio,
      rect.left[1] + rect.width[1] * ratio,
    ];
    first = { ...rect, width: [rect.width[0] * ratio, rect.width[1] * ratio - half] };
    second = {
      ...rect,
      left: [at[0], at[1] + half],
      width: [rect.width[0] * (1 - ratio), rect.width[1] * (1 - ratio) - half],
    };
    gutterRect = { ...rect, left: [at[0], at[1] - half], width: [0, GUTTER] };
  } else {
    const at: Dim = [
      rect.top[0] + rect.height[0] * ratio,
      rect.top[1] + rect.height[1] * ratio,
    ];
    first = { ...rect, height: [rect.height[0] * ratio, rect.height[1] * ratio - half] };
    second = {
      ...rect,
      top: [at[0], at[1] + half],
      height: [rect.height[0] * (1 - ratio), rect.height[1] * (1 - ratio) - half],
    };
    gutterRect = { ...rect, top: [at[0], at[1] - half], height: [0, GUTTER] };
  }
  gutters.push({ dir, path, rect: gutterRect, region: rect });
  collect(node.first, first, [...path, "first"], panes, gutters);
  collect(node.second, second, [...path, "second"], panes, gutters);
}

function css(rect: Frac): CSSProperties {
  const dim = ([pct, px]: Dim) => `calc(${pct}% + ${px}px)`;
  return {
    left: dim(rect.left),
    top: dim(rect.top),
    width: dim(rect.width),
    height: dim(rect.height),
  };
}

const pathKey = (path: SplitPath) => path.join("/") || "root";

interface Props {
  root: PaneNode;
  renderLeaf: (pane: SshPane) => ReactNode;
  onRatioChange: (path: SplitPath, ratio: number) => void;
}

/** Renders a pane tree; drag the gutters to resize siblings. */
function SplitLayout({ root, renderLeaf, onRatioChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const panes: PlacedPane[] = [];
  const gutters: PlacedGutter[] = [];
  collect(root, FULL, [], panes, gutters);

  function startDrag(e: React.MouseEvent, g: PlacedGutter) {
    e.preventDefault();
    const el = containerRef.current;
    if (!el) return;
    const c = el.getBoundingClientRect();
    const horizontal = g.dir === "row";
    const startPx = horizontal
      ? c.left + (g.region.left[0] / 100) * c.width + g.region.left[1]
      : c.top + (g.region.top[0] / 100) * c.height + g.region.top[1];
    const sizePx = horizontal
      ? (g.region.width[0] / 100) * c.width + g.region.width[1]
      : (g.region.height[0] / 100) * c.height + g.region.height[1];
    if (sizePx < MIN_PANE_PX * 2) return;
    setDragging(pathKey(g.path));
    const min = MIN_PANE_PX / sizePx;
    const onMove = (ev: MouseEvent) => {
      const pos = (horizontal ? ev.clientX : ev.clientY) - startPx;
      onRatioChange(
        g.path,
        Math.min(1 - min, Math.max(min, pos / sizePx)),
      );
    };
    const onUp = () => {
      setDragging(null);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return (
    <div
      ref={containerRef}
      className={"split-root" + (panes.length > 1 ? " multi" : "")}
    >
      {panes.map((p) => (
        <div key={p.pane.paneId} className="split-pane" style={css(p.rect)}>
          {renderLeaf(p.pane)}
        </div>
      ))}
      {gutters.map((g) => {
        const key = pathKey(g.path);
        return (
          <div
            key={key}
            className={
              `split-gutter ${g.dir}` + (dragging === key ? " dragging" : "")
            }
            style={css(g.rect)}
            onMouseDown={(e) => startDrag(e, g)}
          />
        );
      })}
    </div>
  );
}

export default SplitLayout;
