/**
 * Accessibility-tree-based page snapshots with stable UIDs for follow-up actions.
 */

import type { CDPClient, CDPRequestOptions } from "./cdp.js";

export type SnapshotNode = {
  uid: number;
  role: string;
  name: string;
  value?: string;
  backendNodeId: number;
  children?: SnapshotNode[];
};

export type Snapshot = {
  nodes: SnapshotNode[];
  byUid: Map<number, SnapshotNode>;
  text: string;
};

let nextUid = 1;

function walkAXTree(
  axNode: Record<string, unknown>,
  allNodes: Record<string, Record<string, unknown>>,
  byUid: Map<number, SnapshotNode>
): SnapshotNode | null {
  const role = ((axNode.role as Record<string, unknown>)?.value as string | undefined) ?? "";
  const name = ((axNode.name as Record<string, unknown>)?.value as string | undefined) ?? "";
  const value = (axNode.value as Record<string, unknown>)?.value as string | undefined;
  const backendNodeId = (axNode.backendDOMNodeId as number | undefined) ?? 0;
  const ignored = axNode.ignored as boolean;

  if (ignored && !name) return null;

  const uid = nextUid++;
  const children: SnapshotNode[] = [];

  const childIds = (axNode.childIds as string[] | undefined) ?? [];
  for (const childId of childIds) {
    const childAx = allNodes[childId];
    if (!childAx) continue;
    const childNode = walkAXTree(childAx, allNodes, byUid);
    if (childNode) children.push(childNode);
  }

  if (!name && !value && (role === "generic" || role === "none") && children.length <= 1) {
    return children[0] ?? null;
  }

  const node: SnapshotNode = {
    uid,
    role,
    name,
    ...(value !== undefined ? { value } : {}),
    backendNodeId,
    ...(children.length > 0 ? { children } : {}),
  };
  byUid.set(uid, node);
  return node;
}

function renderTree(nodes: SnapshotNode[], indent = 0): string {
  const lines: string[] = [];
  for (const node of nodes) {
    const pad = "  ".repeat(indent);
    const parts = [`[${node.uid}]`, node.role];
    if (node.name) parts.push(`"${node.name}"`);
    if (node.value) parts.push(`value="${node.value}"`);
    lines.push(`${pad}${parts.join(" ")}`);
    if (node.children) lines.push(renderTree(node.children, indent + 1));
  }
  return lines.join("\n");
}

export async function takeSnapshot(client: CDPClient, options: CDPRequestOptions = {}): Promise<Snapshot> {
  nextUid = 1;

  const result = await client.send("Accessibility.getFullAXTree", {}, options);
  const axNodes = result.nodes as Array<Record<string, unknown>> | undefined;

  if (!axNodes || axNodes.length === 0) {
    return { nodes: [], byUid: new Map(), text: "(empty page)" };
  }

  const indexed: Record<string, Record<string, unknown>> = {};
  for (const node of axNodes) {
    indexed[node.nodeId as string] = node;
  }

  const byUid = new Map<number, SnapshotNode>();
  const roots: SnapshotNode[] = [];
  const rootNode = walkAXTree(axNodes[0], indexed, byUid);
  if (rootNode) roots.push(rootNode);

  return { nodes: roots, byUid, text: renderTree(roots) };
}

export function resolveUid(snapshot: Snapshot, uid: number): SnapshotNode | undefined {
  return snapshot.byUid.get(uid);
}
