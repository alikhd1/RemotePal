// Binary split tree for terminal panes inside one tab. Leaves hold a
// live SSH session; splits hold a direction and the first child's share
// of the space (ratio). All helpers are pure — they return new trees.

import type { SessionMeta } from "./SnippetsPanel";

export type SplitDir = "row" | "column";

export interface SshPane {
  /** stable identity: survives reconnect (sshId does not) */
  paneId: string;
  sshId: number;
  meta: SessionMeta;
  savedId?: string;
  disconnected: boolean;
}

export type PaneNode =
  | { type: "leaf"; pane: SshPane }
  | {
      type: "split";
      dir: SplitDir;
      ratio: number;
      first: PaneNode;
      second: PaneNode;
    };

/** Path from the root to a split node: which child to descend into. */
export type SplitPath = ("first" | "second")[];

export function leaves(node: PaneNode): SshPane[] {
  if (node.type === "leaf") return [node.pane];
  return [...leaves(node.first), ...leaves(node.second)];
}

export function findPane(node: PaneNode, paneId: string): SshPane | null {
  return leaves(node).find((p) => p.paneId === paneId) ?? null;
}

/** Replace the leaf `paneId` with a split of it and `pane` (new pane second). */
export function splitLeaf(
  node: PaneNode,
  paneId: string,
  dir: SplitDir,
  pane: SshPane,
): PaneNode {
  if (node.type === "leaf") {
    if (node.pane.paneId !== paneId) return node;
    return {
      type: "split",
      dir,
      ratio: 0.5,
      first: node,
      second: { type: "leaf", pane },
    };
  }
  return {
    ...node,
    first: splitLeaf(node.first, paneId, dir, pane),
    second: splitLeaf(node.second, paneId, dir, pane),
  };
}

/** Remove a leaf; its sibling takes the split's place. Null when empty. */
export function removeLeaf(node: PaneNode, paneId: string): PaneNode | null {
  if (node.type === "leaf") {
    return node.pane.paneId === paneId ? null : node;
  }
  const first = removeLeaf(node.first, paneId);
  const second = removeLeaf(node.second, paneId);
  if (first && second) {
    return first === node.first && second === node.second
      ? node
      : { ...node, first, second };
  }
  return first ?? second;
}

export function updatePane(
  node: PaneNode,
  paneId: string,
  patch: Partial<SshPane>,
): PaneNode {
  if (node.type === "leaf") {
    if (node.pane.paneId !== paneId) return node;
    return { type: "leaf", pane: { ...node.pane, ...patch } };
  }
  return {
    ...node,
    first: updatePane(node.first, paneId, patch),
    second: updatePane(node.second, paneId, patch),
  };
}

export function setRatioAt(
  node: PaneNode,
  path: SplitPath,
  ratio: number,
): PaneNode {
  if (node.type !== "split") return node;
  if (path.length === 0) return { ...node, ratio };
  const [head, ...rest] = path;
  return { ...node, [head]: setRatioAt(node[head], rest, ratio) };
}
