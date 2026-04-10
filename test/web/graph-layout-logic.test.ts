import {
  buildLayoutState,
  detectCommunities,
  resolveNodeOverlaps,
  scoreBridgeNodes,
} from '../../src/web/public/graph-layout-logic.js';

function makeAdjacency(nodes: Array<{ slug: string }>, edges: Array<{ source: string; target: string }>) {
  const adjacency = new Map(nodes.map(node => [node.slug, new Set<string>()]));
  const connectionCount = new Map(nodes.map(node => [node.slug, 0]));

  for (const edge of edges) {
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
    connectionCount.set(edge.source, (connectionCount.get(edge.source) || 0) + 1);
    connectionCount.set(edge.target, (connectionCount.get(edge.target) || 0) + 1);
  }

  return { adjacency, connectionCount };
}

function makeTwoClusterGraph() {
  const nodes = [
    { slug: 'a1', title: 'A1', type: 'note' },
    { slug: 'a2', title: 'A2', type: 'note' },
    { slug: 'a3', title: 'A3', type: 'note' },
    { slug: 'a4', title: 'A4', type: 'synthesis' },
    { slug: 'b1', title: 'B1', type: 'note' },
    { slug: 'b2', title: 'B2', type: 'note' },
    { slug: 'b3', title: 'B3', type: 'source' },
    { slug: 'b4', title: 'B4', type: 'note' },
    { slug: 'bridge', title: 'Bridge', type: 'note' },
  ];

  const edges = [
    { source: 'a1', target: 'a2' },
    { source: 'a1', target: 'a3' },
    { source: 'a1', target: 'a4' },
    { source: 'a2', target: 'a3' },
    { source: 'a2', target: 'a4' },
    { source: 'a3', target: 'a4' },
    { source: 'b1', target: 'b2' },
    { source: 'b1', target: 'b3' },
    { source: 'b1', target: 'b4' },
    { source: 'b2', target: 'b3' },
    { source: 'b2', target: 'b4' },
    { source: 'b3', target: 'b4' },
    { source: 'bridge', target: 'a2' },
    { source: 'bridge', target: 'a4' },
    { source: 'bridge', target: 'b1' },
    { source: 'bridge', target: 'b3' },
  ];

  return { nodes, edges };
}

function centroidOf(state: ReturnType<typeof buildLayoutState>, clusterId: string) {
  const cloud = state.clusterClouds.get(clusterId);
  if (!cloud) {
    throw new Error(`Missing cluster cloud for ${clusterId}`);
  }
  return cloud;
}

describe('graph layout logic', () => {
  it('detects separate communities on a split graph', () => {
    const graph = makeTwoClusterGraph();
    const { adjacency, connectionCount } = makeAdjacency(graph.nodes, graph.edges);
    const communities = detectCommunities(graph.nodes, adjacency, connectionCount);

    expect(communities.meta.size).toBeGreaterThanOrEqual(2);
    expect(communities.bySlug.get('a1')).not.toBe(communities.bySlug.get('b1'));
  });

  it('marks bridge nodes that connect multiple communities', () => {
    const graph = makeTwoClusterGraph();
    const { adjacency, connectionCount } = makeAdjacency(graph.nodes, graph.edges);
    const communities = detectCommunities(graph.nodes, adjacency, connectionCount);
    const bridgeScores = scoreBridgeNodes(graph.nodes, adjacency, connectionCount, communities.bySlug);

    expect(bridgeScores.get('bridge')?.isBridge).toBe(true);
    expect(bridgeScores.get('bridge')?.corridorClusterIds.length).toBeGreaterThanOrEqual(2);
  });

  it('spreads cluster anchors further apart when cluster spacing increases', () => {
    const graph = makeTwoClusterGraph();
    const loose = buildLayoutState(graph, { clusterSpacing: 0.2, localCompactness: 0.5 });
    const wide = buildLayoutState(graph, { clusterSpacing: 0.95, localCompactness: 0.5 });
    const looseClusters = [...loose.clusterClouds.values()];
    const wideClusters = [...wide.clusterClouds.values()];

    const looseDistance = Math.hypot(looseClusters[0].x - looseClusters[1].x, looseClusters[0].y - looseClusters[1].y);
    const wideDistance = Math.hypot(wideClusters[0].x - wideClusters[1].x, wideClusters[0].y - wideClusters[1].y);

    expect(wideDistance).toBeGreaterThan(looseDistance);
  });

  it('makes regular clusters denser when local compactness increases', () => {
    const graph = makeTwoClusterGraph();
    const airy = buildLayoutState(graph, { clusterSpacing: 0.6, localCompactness: 0.05 });
    const dense = buildLayoutState(graph, { clusterSpacing: 0.6, localCompactness: 0.95 });

    const airyClusterId = airy.nodes.find(node => node.slug === 'a1')?.clusterId as string;
    const denseClusterId = dense.nodes.find(node => node.slug === 'a1')?.clusterId as string;
    const airyCenter = centroidOf(airy, airyClusterId);
    const denseCenter = centroidOf(dense, denseClusterId);

    const airyMembers = airy.nodes.filter(node => node.clusterId === airyClusterId && !node.isBridge);
    const denseMembers = dense.nodes.filter(node => node.clusterId === denseClusterId && !node.isBridge);

    const airyDistance = airyMembers.reduce((sum, node) => sum + Math.hypot(node.x - airyCenter.x, node.y - airyCenter.y), 0) / airyMembers.length;
    const denseDistance = denseMembers.reduce((sum, node) => sum + Math.hypot(node.x - denseCenter.x, node.y - denseCenter.y), 0) / denseMembers.length;

    expect(denseDistance).toBeLessThan(airyDistance);
  });

  it('resolves node overlaps strictly', () => {
    const nodes = [
      { slug: 'x', x: 0, y: 0, radius: 20, pinned: false },
      { slug: 'y', x: 8, y: 0, radius: 20, pinned: false },
      { slug: 'z', x: 16, y: 4, radius: 20, pinned: false },
    ];

    resolveNodeOverlaps(nodes, 6, 8);

    for (let leftIndex = 0; leftIndex < nodes.length; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex++) {
        const left = nodes[leftIndex];
        const right = nodes[rightIndex];
        const distance = Math.hypot(right.x - left.x, right.y - left.y);
        expect(distance).toBeGreaterThanOrEqual(left.radius + right.radius);
      }
    }
  });

  it('builds a settled layout without overlapping nodes and keeps bridges in the corridor', () => {
    const graph = makeTwoClusterGraph();
    const state = buildLayoutState(graph, { clusterSpacing: 0.72, localCompactness: 0.44 });

    expect(state.settled).toBe(true);
    expect(state.lastOverlapCount).toBe(0);

    for (let leftIndex = 0; leftIndex < state.nodes.length; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < state.nodes.length; rightIndex++) {
        const left = state.nodes[leftIndex];
        const right = state.nodes[rightIndex];
        const distance = Math.hypot(right.x - left.x, right.y - left.y);
        expect(distance).toBeGreaterThanOrEqual(left.radius + right.radius - 0.01);
      }
    }

    const bridge = state.nodes.find(node => node.slug === 'bridge');
    expect(bridge?.isBridge).toBe(true);
    const [clusterA, clusterB] = bridge?.bridgeClusterIds || [];
    const centerA = centroidOf(state, clusterA);
    const centerB = centroidOf(state, clusterB);
    const dx = centerB.x - centerA.x;
    const dy = centerB.y - centerA.y;
    const lengthSq = dx * dx + dy * dy;
    const progress = ((bridge!.x - centerA.x) * dx + (bridge!.y - centerA.y) * dy) / lengthSq;

    expect(progress).toBeGreaterThan(0.2);
    expect(progress).toBeLessThan(0.8);
  });
});
