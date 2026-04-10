const TYPE_COLORS = {
  note: '#d37a57',
  source: '#67b5a1',
  synthesis: '#b394ff',
  output: '#e4b65f',
};

export const DEFAULT_TUNING = {
  nodeScale: 1.1,
  clusterSpacing: 0.64,
  localCompactness: 0.5,
  labelDensity: 0.48,
  edgeOpacity: 0.56,
};

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function lerp(min, max, amount) {
  return min + (max - min) * amount;
}

export function normalizeTuning(nextTuning = {}) {
  const nodeScale = Number(nextTuning.nodeScale);
  const clusterSpacing = Number(nextTuning.clusterSpacing);
  const localCompactness = Number(nextTuning.localCompactness);
  const labelDensity = Number(nextTuning.labelDensity);
  const edgeOpacity = Number(nextTuning.edgeOpacity);

  return {
    nodeScale: clamp(Number.isFinite(nodeScale) ? nodeScale : DEFAULT_TUNING.nodeScale, 0.72, 1.9),
    clusterSpacing: clamp(Number.isFinite(clusterSpacing) ? clusterSpacing : DEFAULT_TUNING.clusterSpacing, 0, 1),
    localCompactness: clamp(Number.isFinite(localCompactness) ? localCompactness : DEFAULT_TUNING.localCompactness, 0, 1),
    labelDensity: clamp(Number.isFinite(labelDensity) ? labelDensity : DEFAULT_TUNING.labelDensity, 0, 1),
    edgeOpacity: clamp(Number.isFinite(edgeOpacity) ? edgeOpacity : DEFAULT_TUNING.edgeOpacity, 0, 1),
  };
}

function hashString(input) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function randomUnitFromSlug(slug) {
  return (hashString(slug) % 10000) / 10000;
}

function sortByWeight(a, b) {
  return b.totalWeight - a.totalWeight || b.size - a.size;
}

function buildAdjacency(nodes, edges) {
  const slugSet = new Set(nodes.map(node => node.slug));
  const adjacency = new Map(nodes.map(node => [node.slug, new Set()]));
  const connectionCount = new Map(nodes.map(node => [node.slug, 0]));
  const validEdges = [];

  for (const edge of edges) {
    if (!slugSet.has(edge.source) || !slugSet.has(edge.target) || edge.source === edge.target) continue;
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
    connectionCount.set(edge.source, (connectionCount.get(edge.source) || 0) + 1);
    connectionCount.set(edge.target, (connectionCount.get(edge.target) || 0) + 1);
    validEdges.push(edge);
  }

  return { adjacency, connectionCount, validEdges };
}

function buildStructuralAdjacency(rankedNodes, adjacency, connectionCount) {
  const weightedAdjacency = new Map(rankedNodes.map(node => [node.slug, new Map()]));
  const scoredEdges = new Map();

  function edgeKey(left, right) {
    return left < right ? `${left}|${right}` : `${right}|${left}`;
  }

  function scoreEdge(left, right) {
    const key = edgeKey(left, right);
    if (scoredEdges.has(key)) return scoredEdges.get(key);

    const leftNeighbors = adjacency.get(left) || new Set();
    const rightNeighbors = adjacency.get(right) || new Set();
    let shared = 0;
    for (const neighbor of leftNeighbors) {
      if (rightNeighbors.has(neighbor)) shared += 1;
    }

    const union = leftNeighbors.size + rightNeighbors.size - shared;
    const jaccard = union > 0 ? shared / union : 0;
    const minDegree = Math.min(connectionCount.get(left) || 0, connectionCount.get(right) || 0);
    const keep = minDegree <= 2
      || shared >= 4
      || jaccard >= 0.26
      || (shared >= 3 && minDegree <= 6)
      || (shared >= 2 && jaccard >= 0.2 && minDegree <= 4);
    const weight = 0.24 + shared * 0.24 + jaccard * 2.8;
    const scored = { keep, shared, jaccard, weight };
    scoredEdges.set(key, scored);
    return scored;
  }

  for (const node of rankedNodes) {
    for (const neighborSlug of adjacency.get(node.slug) || []) {
      if (neighborSlug <= node.slug) continue;
      const score = scoreEdge(node.slug, neighborSlug);
      if (!score.keep) continue;
      weightedAdjacency.get(node.slug).set(neighborSlug, score.weight);
      weightedAdjacency.get(neighborSlug).set(node.slug, score.weight);
    }
  }

  // Keep at least one structural edge for sparse nodes so they don't become meaningless singletons.
  for (const node of rankedNodes) {
    const weightedNeighbors = weightedAdjacency.get(node.slug);
    if (weightedNeighbors.size > 0) continue;

    let bestNeighbor = null;
    let bestWeight = -Infinity;
    for (const neighborSlug of adjacency.get(node.slug) || []) {
      const score = scoreEdge(node.slug, neighborSlug);
      if (score.weight > bestWeight) {
        bestWeight = score.weight;
        bestNeighbor = neighborSlug;
      }
    }

    if (bestNeighbor) {
      weightedAdjacency.get(node.slug).set(bestNeighbor, bestWeight);
      weightedAdjacency.get(bestNeighbor).set(node.slug, bestWeight);
    }
  }

  return weightedAdjacency;
}

function mergeTinyCommunities(labels, rankedNodes, weightedAdjacency) {
  const groupByLabel = () => {
    const grouped = new Map();
    for (const node of rankedNodes) {
      const label = labels.get(node.slug) || node.slug;
      if (!grouped.has(label)) grouped.set(label, []);
      grouped.get(label).push(node.slug);
    }
    return grouped;
  };

  for (let pass = 0; pass < 3; pass++) {
    const grouped = groupByLabel();
    let changed = false;

    for (const [label, members] of grouped) {
      if (members.length >= 3) continue;

      for (const slug of members) {
        const scores = new Map();
        for (const [neighborSlug, weight] of weightedAdjacency.get(slug) || []) {
          const neighborLabel = labels.get(neighborSlug);
          if (!neighborLabel || neighborLabel === label) continue;
          const groupSize = grouped.get(neighborLabel)?.length || 1;
          scores.set(neighborLabel, (scores.get(neighborLabel) || 0) + groupSize * weight);
        }

        let bestLabel = null;
        let bestScore = -Infinity;
        for (const [candidate, score] of scores) {
          if (score > bestScore) {
            bestScore = score;
            bestLabel = candidate;
          }
        }

        if (bestLabel) {
          labels.set(slug, bestLabel);
          changed = true;
        }
      }
    }

    if (!changed) break;
  }
}

export function detectCommunities(rankedNodes, adjacency, connectionCount) {
  const weightedAdjacency = buildStructuralAdjacency(rankedNodes, adjacency, connectionCount);
  const labels = new Map(rankedNodes.map(node => [node.slug, node.slug]));

  for (let iteration = 0; iteration < 18; iteration++) {
    let changed = false;
    for (const node of rankedNodes) {
      const neighbors = weightedAdjacency.get(node.slug);
      if (!neighbors?.size) continue;

      const scores = new Map();
      for (const [neighborSlug, structuralWeight] of neighbors) {
        const label = labels.get(neighborSlug);
        if (!label) continue;
        const neighborDegree = connectionCount.get(neighborSlug) || 0;
        const weight = structuralWeight * (1 + Math.min(neighborDegree, 18) * 0.04);
        scores.set(label, (scores.get(label) || 0) + weight);
      }

      let bestLabel = labels.get(node.slug);
      let bestScore = -Infinity;
      for (const [label, score] of scores) {
        if (score > bestScore || (score === bestScore && String(label) < String(bestLabel))) {
          bestScore = score;
          bestLabel = label;
        }
      }

      if (bestLabel !== labels.get(node.slug)) {
        labels.set(node.slug, bestLabel);
        changed = true;
      }
    }

    if (!changed) break;
  }

  mergeTinyCommunities(labels, rankedNodes, weightedAdjacency);

  const grouped = new Map();
  for (const node of rankedNodes) {
    const label = labels.get(node.slug) || node.slug;
    if (!grouped.has(label)) grouped.set(label, []);
    grouped.get(label).push(node);
  }

  const sorted = [...grouped.values()]
    .map(members => {
      const orderedMembers = [...members].sort((left, right) => {
        const delta = (connectionCount.get(right.slug) || 0) - (connectionCount.get(left.slug) || 0);
        if (delta !== 0) return delta;
        return left.title.localeCompare(right.title);
      });

      const typeWeights = {};
      for (const member of orderedMembers) {
        typeWeights[member.type || 'note'] = (typeWeights[member.type || 'note'] || 0) + 1;
      }

      const dominantType = Object.entries(typeWeights).sort((left, right) => right[1] - left[1])[0]?.[0] || 'note';
      return {
        members: orderedMembers,
        size: orderedMembers.length,
        totalWeight: orderedMembers.reduce((sum, member) => sum + (connectionCount.get(member.slug) || 0), 0),
        dominantType,
      };
    })
    .sort(sortByWeight);

  const bySlug = new Map();
  const meta = new Map();
  sorted.forEach((community, index) => {
    const id = `cluster-${index}`;
    meta.set(id, { ...community, id });
    for (const member of community.members) {
      bySlug.set(member.slug, id);
    }
  });

  return {
    bySlug,
    meta,
    structuralAdjacency: weightedAdjacency,
    primaryId: sorted.length ? 'cluster-0' : null,
  };
}

export function computeNodeImportance(rankedNodes, adjacency, connectionCount, clusterLookup, clusterMeta) {
  const seeds = new Map();

  for (const node of rankedNodes) {
    const degree = connectionCount.get(node.slug) || 0;
    const neighbors = [...(adjacency.get(node.slug) || [])];
    const neighborDegreeSignal = neighbors.length
      ? neighbors.reduce((sum, neighborSlug) => sum + Math.log1p(connectionCount.get(neighborSlug) || 0), 0) / neighbors.length
      : 0;
    const connectedClusters = new Set(neighbors.map(neighborSlug => clusterLookup.get(neighborSlug)).filter(Boolean));
    const bridgeSignal = Math.log1p(Math.max(0, connectedClusters.size - 1));
    const typeSignal = node.type === 'synthesis'
      ? 0.22
      : node.type === 'output'
        ? 0.14
        : 0;

    seeds.set(
      node.slug,
      1
        + Math.log1p(degree) * 0.92
        + neighborDegreeSignal * 0.42
        + bridgeSignal * 0.46
        + typeSignal,
    );
  }

  let scores = new Map(seeds);
  for (let iteration = 0; iteration < 14; iteration++) {
    const nextScores = new Map();
    for (const node of rankedNodes) {
      let propagated = 0;
      for (const neighborSlug of adjacency.get(node.slug) || []) {
        const neighborDegree = Math.max(connectionCount.get(neighborSlug) || 0, 1);
        propagated += (scores.get(neighborSlug) || 1) / Math.pow(neighborDegree, 0.9);
      }
      nextScores.set(node.slug, (seeds.get(node.slug) || 1) * 0.34 + propagated * 0.66);
    }
    scores = nextScores;
  }

  for (const cluster of clusterMeta.values()) {
    const orderedMembers = [...cluster.members].sort((left, right) => (scores.get(right.slug) || 0) - (scores.get(left.slug) || 0));
    if (orderedMembers[0]) {
      scores.set(orderedMembers[0].slug, (scores.get(orderedMembers[0].slug) || 0) + 0.66 + Math.log1p(cluster.size) * 0.14);
    }
    if (orderedMembers.length >= 5 && orderedMembers[1]) {
      scores.set(orderedMembers[1].slug, (scores.get(orderedMembers[1].slug) || 0) + 0.18);
    }
  }

  const values = [...scores.values()];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, 1e-6);
  const bySlug = new Map();

  for (const node of rankedNodes) {
    const score = scores.get(node.slug) || 1;
    const normalized = Math.pow((score - min) / span, 0.82);
    bySlug.set(node.slug, { score, normalized });
  }

  return bySlug;
}

export function scoreBridgeNodes(rankedNodes, adjacency, connectionCount, clusterLookup) {
  const bySlug = new Map();

  for (const node of rankedNodes) {
    const scores = new Map();
    for (const neighborSlug of adjacency.get(node.slug) || []) {
      const clusterId = clusterLookup.get(neighborSlug);
      if (!clusterId) continue;
      const neighborDegree = connectionCount.get(neighborSlug) || 0;
      const weight = 1 + Math.min(10, Math.sqrt(neighborDegree));
      scores.set(clusterId, (scores.get(clusterId) || 0) + weight);
    }

    const ordered = [...scores.entries()].sort((left, right) => right[1] - left[1]);
    const primaryClusterId = ordered[0]?.[0] || clusterLookup.get(node.slug) || null;
    const secondaryClusterId = ordered[1]?.[0] || null;
    const primaryWeight = ordered[0]?.[1] || 0;
    const secondaryWeight = ordered[1]?.[1] || 0;
    const ratio = primaryWeight > 0 ? secondaryWeight / primaryWeight : 0;
    const bridgeScore = ordered.length >= 2
      ? Math.log1p(primaryWeight + secondaryWeight) * ratio * Math.log1p(ordered.length)
      : 0;
    const isBridge = Boolean(
      ordered.length >= 2
      && secondaryWeight >= 1.4
      && ratio >= 0.28
      && (connectionCount.get(node.slug) || 0) >= 3,
    );

    bySlug.set(node.slug, {
      primaryClusterId,
      corridorClusterIds: ordered.slice(0, 3).map(([clusterId]) => clusterId),
      bridgeScore,
      isBridge,
    });
  }

  return bySlug;
}

function getNodeRadius(importanceScore, weight, importanceNormalized, nodeScale) {
  const radius = 3.4
    + Math.log1p(weight + 1) * 1.05
    + Math.log1p(importanceScore + 1) * 2.15
    + Math.pow(importanceNormalized, 1.18) * 5.4;
  return clamp(radius * nodeScale, 3.6, 22);
}

function getLayoutParams(tuning) {
  return {
    clusterSpacingDistance: lerp(240, 520, tuning.clusterSpacing),
    clusterRepulsion: lerp(0.02, 0.05, tuning.clusterSpacing),
    clusterCenterPull: lerp(0.0015, 0.0009, tuning.clusterSpacing),
    corridorPull: lerp(0.018, 0.026, tuning.clusterSpacing),
    localSpreadScale: lerp(1.22, 0.72, tuning.localCompactness),
    localAnchorPull: lerp(0.013, 0.021, tuning.localCompactness),
    localHubPadding: lerp(22, 14, tuning.localCompactness),
    linkDistanceIntra: lerp(92, 56, tuning.localCompactness),
    linkDistanceInter: lerp(176, 136, tuning.clusterSpacing),
    linkStrengthIntra: lerp(0.024, 0.042, tuning.localCompactness),
    linkStrengthInter: lerp(0.004, 0.009, tuning.clusterSpacing),
    bridgeLinkBoost: lerp(1.05, 1.24, tuning.clusterSpacing),
    repulsion: lerp(4200, 6200, tuning.clusterSpacing),
    repulsionDistance: lerp(150, 210, tuning.clusterSpacing),
    velocityDecay: lerp(0.76, 0.68, tuning.localCompactness),
    collisionPadding: lerp(8, 5, tuning.localCompactness),
    collisionPasses: 6,
  };
}

function buildClusterGraph(validEdges, nodeBySlug, bridgeBySlug, clusterMeta) {
  const pairMap = new Map();

  for (const edge of validEdges) {
    const source = nodeBySlug.get(edge.source);
    const target = nodeBySlug.get(edge.target);
    if (!source || !target) continue;
    if (source.clusterId === target.clusterId) continue;

    const left = source.clusterId < target.clusterId ? source.clusterId : target.clusterId;
    const right = left === source.clusterId ? target.clusterId : source.clusterId;
    const key = `${left}|${right}`;
    if (!pairMap.has(key)) {
      pairMap.set(key, {
        key,
        sourceClusterId: left,
        targetClusterId: right,
        weight: 0,
        weakWeight: 0,
        bridgeWeight: 0,
      });
    }

    const pair = pairMap.get(key);
    pair.weight += 1;
    const sourceImportance = source.importance || 0;
    const targetImportance = target.importance || 0;
    const weakSignal = 1 / Math.max(1, 1 + Math.max(sourceImportance, targetImportance) * 3.8);
    pair.weakWeight += weakSignal;
    if (bridgeBySlug.get(source.slug)?.isBridge || bridgeBySlug.get(target.slug)?.isBridge) {
      pair.bridgeWeight += 1;
    }
  }

  const clusterGraph = [...pairMap.values()];
  const hubMassByCluster = new Map();
  for (const [clusterId, cluster] of clusterMeta) {
    const ordered = cluster.members
      .map(member => nodeBySlug.get(member.slug))
      .filter(Boolean)
      .sort((left, right) => (right.importance || 0) - (left.importance || 0));
    const hubMass = ordered.slice(0, 2).reduce((sum, member) => sum + (member.importance || 0), 0);
    hubMassByCluster.set(clusterId, hubMass);
  }

  return { clusterGraph, hubMassByCluster };
}

export function buildClusterAnchors(clusterMeta, clusterGraph, tuning, hubMassByCluster) {
  const params = getLayoutParams(tuning);
  const anchors = new Map();
  const communities = [...clusterMeta.values()].sort(sortByWeight);

  communities.forEach((cluster, index) => {
    const ring = Math.sqrt(index + 0.4);
    const angle = index * GOLDEN_ANGLE;
    const baseRadius = index === 0 ? 0 : params.clusterSpacingDistance * (0.34 + ring * 0.24);
    anchors.set(cluster.id, {
      id: cluster.id,
      x: Math.cos(angle) * baseRadius,
      y: Math.sin(angle) * baseRadius * 0.82,
      vx: 0,
      vy: 0,
      size: cluster.size,
      totalWeight: cluster.totalWeight,
      hubMass: hubMassByCluster.get(cluster.id) || 0,
      dominantType: cluster.dominantType,
      memberIndex: new Map(cluster.members.map((member, memberIndex) => [member.slug, memberIndex])),
    });
  });

  for (let iteration = 0; iteration < 180; iteration++) {
    for (let leftIndex = 0; leftIndex < communities.length; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < communities.length; rightIndex++) {
        const left = anchors.get(communities[leftIndex].id);
        const right = anchors.get(communities[rightIndex].id);
        let dx = right.x - left.x;
        let dy = right.y - left.y;
        let distance = Math.sqrt(dx * dx + dy * dy);
        if (!distance) {
          dx = 0.01;
          dy = 0.01;
          distance = Math.sqrt(dx * dx + dy * dy);
        }

        const minDistance = params.clusterSpacingDistance * 0.28 * (Math.sqrt(left.size) + Math.sqrt(right.size))
          + (left.hubMass + right.hubMass) * 60;
        const repulsionForce = params.clusterRepulsion * Math.max(0, minDistance - distance) / minDistance;
        const repulsionX = (dx / distance) * repulsionForce;
        const repulsionY = (dy / distance) * repulsionForce;

        left.vx -= repulsionX / Math.max(1.2, Math.sqrt(left.size));
        left.vy -= repulsionY / Math.max(1.2, Math.sqrt(left.size));
        right.vx += repulsionX / Math.max(1.2, Math.sqrt(right.size));
        right.vy += repulsionY / Math.max(1.2, Math.sqrt(right.size));
      }
    }

    for (const pair of clusterGraph) {
      const source = anchors.get(pair.sourceClusterId);
      const target = anchors.get(pair.targetClusterId);
      if (!source || !target) continue;

      const weakFactor = pair.weakWeight + pair.bridgeWeight * 0.7;
      if (weakFactor <= 0) continue;

      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const targetDistance = params.clusterSpacingDistance * (0.42 + Math.min(2.2, weakFactor * 0.18));
      const strength = Math.min(0.018, 0.0028 + weakFactor * 0.0009);
      const force = ((distance - targetDistance) / distance) * strength;
      const fx = dx * force;
      const fy = dy * force;

      source.vx += fx;
      source.vy += fy;
      target.vx -= fx;
      target.vy -= fy;
    }

    for (const anchor of anchors.values()) {
      anchor.vx += (0 - anchor.x) * params.clusterCenterPull;
      anchor.vy += (0 - anchor.y) * params.clusterCenterPull;
      anchor.vx *= 0.88;
      anchor.vy *= 0.88;
      anchor.x += anchor.vx;
      anchor.y += anchor.vy;
    }
  }

  return anchors;
}

function buildSpatialGrid(nodes, cellSize) {
  const grid = new Map();
  for (const node of nodes) {
    const gx = Math.floor(node.x / cellSize);
    const gy = Math.floor(node.y / cellSize);
    const key = `${gx}:${gy}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(node);
  }
  return grid;
}

function getNearbyNodes(grid, node, cellSize) {
  const gx = Math.floor(node.x / cellSize);
  const gy = Math.floor(node.y / cellSize);
  const nearby = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const bucket = grid.get(`${gx + dx}:${gy + dy}`);
      if (bucket) nearby.push(...bucket);
    }
  }
  return nearby;
}

export function resolveNodeOverlaps(nodes, padding = 6, maxPasses = 6) {
  let overlapCount = 0;

  for (let pass = 0; pass < maxPasses; pass++) {
    let moved = false;
    const maxRadius = nodes.reduce((max, node) => Math.max(max, node.radius || 0), 0);
    const cellSize = Math.max(24, maxRadius * 2 + padding * 2);
    const grid = buildSpatialGrid(nodes, cellSize);
    const visitedPairs = new Set();

    for (const node of nodes) {
      const nearby = getNearbyNodes(grid, node, cellSize);
      for (const candidate of nearby) {
        if (candidate === node) continue;
        const pairKey = node.slug < candidate.slug ? `${node.slug}|${candidate.slug}` : `${candidate.slug}|${node.slug}`;
        if (visitedPairs.has(pairKey)) continue;
        visitedPairs.add(pairKey);

        let dx = candidate.x - node.x;
        let dy = candidate.y - node.y;
        let distance = Math.sqrt(dx * dx + dy * dy);
        const minDistance = node.radius + candidate.radius + padding;
        if (distance >= minDistance) continue;

        overlapCount += 1;
        moved = true;
        if (!distance) {
          dx = 0.01;
          dy = 0.01;
          distance = Math.sqrt(dx * dx + dy * dy);
        }

        const overlap = minDistance - distance;
        const ux = dx / distance;
        const uy = dy / distance;
        const moveNode = node.pinned ? 0 : candidate.pinned ? 1 : 0.5;
        const moveCandidate = node.pinned ? 1 : candidate.pinned ? 0 : 0.5;

        node.x -= ux * overlap * moveNode;
        node.y -= uy * overlap * moveNode;
        candidate.x += ux * overlap * moveCandidate;
        candidate.y += uy * overlap * moveCandidate;
      }
    }

    if (!moved) break;
  }

  return { overlapCount };
}

export function countNodeOverlaps(nodes, padding = 6) {
  const maxRadius = nodes.reduce((max, node) => Math.max(max, node.radius || 0), 0);
  const cellSize = Math.max(24, maxRadius * 2 + padding * 2);
  const grid = buildSpatialGrid(nodes, cellSize);
  const visitedPairs = new Set();
  let overlapCount = 0;

  for (const node of nodes) {
    const nearby = getNearbyNodes(grid, node, cellSize);
    for (const candidate of nearby) {
      if (candidate === node) continue;
      const pairKey = node.slug < candidate.slug ? `${node.slug}|${candidate.slug}` : `${candidate.slug}|${node.slug}`;
      if (visitedPairs.has(pairKey)) continue;
      visitedPairs.add(pairKey);

      const dx = candidate.x - node.x;
      const dy = candidate.y - node.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const minDistance = node.radius + candidate.radius + padding;
      if (distance < minDistance) overlapCount += 1;
    }
  }

  return overlapCount;
}

function computeClusterClouds(nodes, clusterMeta) {
  const grouped = new Map();
  for (const node of nodes) {
    if (!node.clusterId) continue;
    if (!grouped.has(node.clusterId)) {
      grouped.set(node.clusterId, { x: 0, y: 0, weight: 0, members: [], bridgeMembers: [] });
    }
    const group = grouped.get(node.clusterId);
    const weight = node.isBridge ? 0.42 : 1 + (node.importance || 0) * 0.8 + Math.sqrt(node.weight + 1) * 0.08;
    group.x += node.x * weight;
    group.y += node.y * weight;
    group.weight += weight;
    group.members.push(node);
    if (node.isBridge) group.bridgeMembers.push(node);
  }

  const clouds = new Map();
  for (const [clusterId, group] of grouped) {
    const meta = clusterMeta.get(clusterId);
    const centroidX = group.x / Math.max(group.weight, 1);
    const centroidY = group.y / Math.max(group.weight, 1);
    let extent = 24;
    for (const member of group.members) {
      const dx = member.x - centroidX;
      const dy = member.y - centroidY;
      extent = Math.max(extent, Math.sqrt(dx * dx + dy * dy) + member.radius * 1.6);
    }
    clouds.set(clusterId, {
      clusterId,
      x: centroidX,
      y: centroidY,
      extent,
      size: group.members.length,
      dominantType: meta?.dominantType || 'note',
    });
  }

  return clouds;
}

function applyClusterExpansion(state, factor) {
  for (const anchor of state.clusterAnchors.values()) {
    anchor.x *= factor;
    anchor.y *= factor;
  }

  for (const node of state.nodes) {
    if (node.pinned) continue;
    if (!node.isBridge) {
      const anchor = state.clusterAnchors.get(node.clusterId);
      if (!anchor) continue;
      node.x = anchor.x + (node.x - anchor.x) * factor;
      node.y = anchor.y + (node.y - anchor.y) * factor;
      continue;
    }
    node.x *= factor;
    node.y *= factor;
  }
}

function nudgeNodesTowardAnchors(state, amount) {
  for (const node of state.nodes) {
    if (node.pinned) continue;

    if (node.isBridge && node.bridgeClusterIds.length >= 2) {
      const primary = state.clusterAnchors.get(node.bridgeClusterIds[0]);
      const secondary = state.clusterAnchors.get(node.bridgeClusterIds[1]);
      if (primary && secondary) {
        const targetX = (primary.x + secondary.x) / 2;
        const targetY = (primary.y + secondary.y) / 2;
        node.x += (targetX - node.x) * amount * 0.7;
        node.y += (targetY - node.y) * amount * 0.7;
      }
      continue;
    }

    const anchor = state.clusterAnchors.get(node.clusterId);
    if (!anchor) continue;
    node.x += (anchor.x - node.x) * amount;
    node.y += (anchor.y - node.y) * amount;
  }
}

export function finalizeLayoutState(state) {
  const params = getLayoutParams(state.tuning);

  for (let phase = 0; phase < 20; phase++) {
    for (const node of state.nodes) {
      node.vx = 0;
      node.vy = 0;
    }

    resolveNodeOverlaps(state.nodes, params.collisionPadding + 1.5, params.collisionPasses + 10 + phase);
    state.lastOverlapCount = countNodeOverlaps(state.nodes, 0);
    if (state.lastOverlapCount === 0) break;

    applyClusterExpansion(state, 1.07 + phase * 0.01);
    nudgeNodesTowardAnchors(state, 0.08 + phase * 0.008);
  }

  resolveNodeOverlaps(state.nodes, params.collisionPadding + 1.5, params.collisionPasses + 18);
  state.lastOverlapCount = countNodeOverlaps(state.nodes, 0);
  state.clusterClouds = computeClusterClouds(state.nodes, state.clusterMeta);
  state.energy = 0;
  state.stableTicks = state.lastOverlapCount === 0 ? 6 : 0;
  state.settled = state.lastOverlapCount === 0;
  return state;
}

function buildInitialNodes(rankedNodes, connectionCount, clusterLookup, bridgeBySlug, importanceBySlug, clusterAnchors, tuning) {
  const clusterMemberOrder = new Map();
  for (const [clusterId, anchor] of clusterAnchors) {
    clusterMemberOrder.set(clusterId, [...anchor.memberIndex.entries()].sort((left, right) => left[1] - right[1]).map(([slug]) => slug));
  }

  const nodes = rankedNodes.map(node => {
    const bridge = bridgeBySlug.get(node.slug);
    const importanceState = importanceBySlug.get(node.slug) || { score: 1, normalized: 0 };
    const primaryClusterId = bridge?.primaryClusterId || clusterLookup.get(node.slug) || null;
    const radius = getNodeRadius(
      importanceState.score,
      connectionCount.get(node.slug) || 0,
      importanceState.normalized,
      tuning.nodeScale,
    );

    return {
      ...node,
      clusterId: primaryClusterId,
      bridgeScore: bridge?.bridgeScore || 0,
      isBridge: Boolean(bridge?.isBridge),
      bridgeClusterIds: bridge?.corridorClusterIds || (primaryClusterId ? [primaryClusterId] : []),
      connections: connectionCount.get(node.slug) || 0,
      weight: connectionCount.get(node.slug) || 0,
      importanceScore: importanceState.score,
      importance: importanceState.normalized,
      radius,
      color: TYPE_COLORS[node.type] || TYPE_COLORS.note,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      pinned: false,
    };
  });

  const nodesBySlug = new Map(nodes.map(node => [node.slug, node]));
  const params = getLayoutParams(tuning);
  const bridgeIndices = new Map();

  for (const node of nodes) {
    const clusterId = node.clusterId;
    const anchor = clusterId ? clusterAnchors.get(clusterId) : null;
    const primaryCluster = node.bridgeClusterIds[0] ? clusterAnchors.get(node.bridgeClusterIds[0]) : anchor;
    const secondaryCluster = node.bridgeClusterIds[1] ? clusterAnchors.get(node.bridgeClusterIds[1]) : null;

    if (node.isBridge && primaryCluster && secondaryCluster) {
      const pairKey = node.bridgeClusterIds[0] < node.bridgeClusterIds[1]
        ? `${node.bridgeClusterIds[0]}|${node.bridgeClusterIds[1]}`
        : `${node.bridgeClusterIds[1]}|${node.bridgeClusterIds[0]}`;
      const bridgeIndex = bridgeIndices.get(pairKey) || 0;
      bridgeIndices.set(pairKey, bridgeIndex + 1);

      const dx = secondaryCluster.x - primaryCluster.x;
      const dy = secondaryCluster.y - primaryCluster.y;
      const length = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const ux = dx / length;
      const uy = dy / length;
      const px = -uy;
      const py = ux;
      const offset = (bridgeIndex - 1.5) * (node.radius * 2.8 + 8);
      const progress = 0.48 + (randomUnitFromSlug(node.slug) - 0.5) * 0.16;
      node.x = primaryCluster.x + dx * progress + px * offset;
      node.y = primaryCluster.y + dy * progress + py * offset;
      continue;
    }

    if (!anchor) continue;
    const localIndex = anchor.memberIndex.get(node.slug) || 0;
    const spiralIndex = Math.max(localIndex, 0);
    const orbit = Math.sqrt(spiralIndex + 1);
    const angle = GOLDEN_ANGLE * spiralIndex + randomUnitFromSlug(node.slug) * Math.PI * 0.35;
    const localSpread = (42 + Math.sqrt(Math.max(anchor.totalWeight, 1)) * 7.6 + Math.sqrt(Math.max(anchor.size, 1)) * 15.5)
      * params.localSpreadScale;
    const hubPadding = params.localHubPadding + (node.importance || 0) * 14;
    const distance = hubPadding + orbit * (localSpread / Math.max(2.2, Math.sqrt(anchor.size)));
    node.x = anchor.x + Math.cos(angle) * distance;
    node.y = anchor.y + Math.sin(angle) * distance * 0.88;
  }

  return { nodes, nodesBySlug };
}

function buildEdges(validEdges, nodesBySlug, structuralAdjacency) {
  return validEdges
    .map(edge => {
      const source = nodesBySlug.get(edge.source);
      const target = nodesBySlug.get(edge.target);
      if (!source || !target) return null;
      const sourceDegree = Math.max(source.connections || 0, 1);
      const targetDegree = Math.max(target.connections || 0, 1);
      const pairKey = source.clusterId === target.clusterId
        ? null
        : source.clusterId < target.clusterId
          ? `${source.clusterId}|${target.clusterId}`
          : `${target.clusterId}|${source.clusterId}`;

      const structuralWeight = structuralAdjacency.get(source.slug)?.get(target.slug)
        || structuralAdjacency.get(target.slug)?.get(source.slug)
        || 0;
      return {
        source,
        target,
        sourceSlug: source.slug,
        targetSlug: target.slug,
        bias: sourceDegree / (sourceDegree + targetDegree),
        intraCluster: source.clusterId === target.clusterId,
        bridgeEdge: source.isBridge || target.isBridge,
        pairKey,
        structural: structuralWeight > 0,
        structuralWeight,
      };
    })
    .filter(Boolean);
}

function computeLayoutEnergy(nodes) {
  let total = 0;
  for (const node of nodes) {
    total += Math.sqrt(node.vx * node.vx + node.vy * node.vy);
  }
  return nodes.length ? total / nodes.length : 0;
}

function applyAnchorForces(state, params) {
  for (const node of state.nodes) {
    if (node.pinned) continue;

    if (node.isBridge && node.bridgeClusterIds.length >= 2) {
      const primary = state.clusterAnchors.get(node.bridgeClusterIds[0]);
      const secondary = state.clusterAnchors.get(node.bridgeClusterIds[1]);
      if (primary && secondary) {
        const corridorX = (primary.x + secondary.x) / 2;
        const corridorY = (primary.y + secondary.y) / 2;
        node.vx += (corridorX - node.x) * params.corridorPull * (1 + node.bridgeScore * 0.08);
        node.vy += (corridorY - node.y) * params.corridorPull * (1 + node.bridgeScore * 0.08);
      }
      continue;
    }

    const anchor = state.clusterAnchors.get(node.clusterId);
    if (!anchor) continue;
    const strength = params.localAnchorPull * (0.88 + (node.importance || 0) * 0.32);
    node.vx += (anchor.x - node.x) * strength;
    node.vy += (anchor.y - node.y) * strength;
  }
}

function applyLinkForces(state, params) {
  for (const edge of state.edges) {
    const source = edge.source;
    const target = edge.target;
    if (source.pinned && target.pinned) continue;

    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const targetDistance = edge.intraCluster
      ? params.linkDistanceIntra * (edge.bridgeEdge ? 1.06 : 1)
      : params.linkDistanceInter * (edge.bridgeEdge ? 0.78 : 1);
    const strength = edge.intraCluster
      ? params.linkStrengthIntra
      : params.linkStrengthInter * (edge.bridgeEdge ? params.bridgeLinkBoost : 1);
    const force = ((distance - targetDistance) / distance) * strength;
    const fx = dx * force;
    const fy = dy * force;
    const targetBias = edge.bias;
    const sourceBias = 1 - targetBias;

    if (!source.pinned) {
      source.vx += fx * sourceBias;
      source.vy += fy * sourceBias;
    }
    if (!target.pinned) {
      target.vx -= fx * targetBias;
      target.vy -= fy * targetBias;
    }
  }
}

function applyNodeRepulsion(state, params) {
  const grid = buildSpatialGrid(state.nodes, params.repulsionDistance);

  for (const node of state.nodes) {
    const nearby = getNearbyNodes(grid, node, params.repulsionDistance);
    for (const candidate of nearby) {
      if (candidate === node || candidate.slug <= node.slug) continue;
      let dx = candidate.x - node.x;
      let dy = candidate.y - node.y;
      let distanceSq = dx * dx + dy * dy;
      if (distanceSq > params.repulsionDistance * params.repulsionDistance) continue;
      if (distanceSq < 1) {
        dx = 0.01;
        dy = 0.01;
        distanceSq = dx * dx + dy * dy;
      }

      const distance = Math.sqrt(distanceSq);
      const weightFactor = 1 + Math.sqrt(node.weight + candidate.weight + 2) * 0.08 + ((node.importance || 0) + (candidate.importance || 0)) * 0.22;
      const clusterFactor = node.clusterId === candidate.clusterId ? 0.74 : 1.52;
      const force = (params.repulsion * weightFactor * clusterFactor) / distanceSq;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;

      if (!node.pinned) {
        node.vx -= fx;
        node.vy -= fy;
      }
      if (!candidate.pinned) {
        candidate.vx += fx;
        candidate.vy += fy;
      }
    }
  }
}

function applyClusterRepulsion(state, params) {
  const clouds = computeClusterClouds(state.nodes, state.clusterMeta);
  const groups = [...clouds.values()].filter(group => group.size >= 3);

  for (let leftIndex = 0; leftIndex < groups.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < groups.length; rightIndex++) {
      const left = groups[leftIndex];
      const right = groups[rightIndex];
      let dx = right.x - left.x;
      let dy = right.y - left.y;
      let distance = Math.sqrt(dx * dx + dy * dy);
      const minDistance = left.extent + right.extent + params.collisionPadding * 4;
      if (distance >= minDistance) continue;
      if (!distance) {
        dx = 0.01;
        dy = 0.01;
        distance = Math.sqrt(dx * dx + dy * dy);
      }

      const force = ((minDistance - distance) / minDistance) * 0.06;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;

      for (const node of state.nodes) {
        if (node.clusterId === left.clusterId && !node.pinned) {
          node.vx -= fx / Math.max(1.4, Math.sqrt(left.size));
          node.vy -= fy / Math.max(1.4, Math.sqrt(left.size));
        } else if (node.clusterId === right.clusterId && !node.pinned) {
          node.vx += fx / Math.max(1.4, Math.sqrt(right.size));
          node.vy += fy / Math.max(1.4, Math.sqrt(right.size));
        }
      }
    }
  }
}

export function iterateLayout(state, steps = 1) {
  const params = getLayoutParams(state.tuning);

  for (let iteration = 0; iteration < steps; iteration++) {
    applyAnchorForces(state, params);
    applyLinkForces(state, params);
    applyClusterRepulsion(state, params);
    applyNodeRepulsion(state, params);

    for (const node of state.nodes) {
      if (node.pinned) {
        node.x = node.pinX;
        node.y = node.pinY;
        node.vx = 0;
        node.vy = 0;
        continue;
      }

      node.vx *= params.velocityDecay;
      node.vy *= params.velocityDecay;
      node.x += node.vx;
      node.y += node.vy;
    }

    resolveNodeOverlaps(state.nodes, params.collisionPadding, params.collisionPasses);
    state.lastOverlapCount = countNodeOverlaps(state.nodes, 0);
    state.energy = computeLayoutEnergy(state.nodes);
    state.iteration += 1;

    if (state.lastOverlapCount > 0 && state.energy < 0.38) {
      state.overlapRetryBudget = Math.max(0, state.overlapRetryBudget - 1);
      if (state.overlapRetryBudget > 0) {
        applyClusterExpansion(state, 1.035);
      }
    }

    if (state.lastOverlapCount === 0 && state.energy < 0.12) {
      state.stableTicks += 1;
    } else {
      state.stableTicks = 0;
    }
  }

  state.clusterClouds = computeClusterClouds(state.nodes, state.clusterMeta);
  state.settled = state.stableTicks >= 6;
  return state;
}

export function buildLayoutState(graphData, nextTuning = {}, activeSlug = null) {
  const tuning = normalizeTuning(nextTuning);
  const graphNodes = [...(graphData.nodes || [])];
  const { adjacency, connectionCount, validEdges } = buildAdjacency(graphNodes, graphData.edges || []);
  const rankedNodes = [...graphNodes].sort((left, right) => {
    const connectionDelta = (connectionCount.get(right.slug) || 0) - (connectionCount.get(left.slug) || 0);
    if (connectionDelta !== 0) return connectionDelta;
    return left.title.localeCompare(right.title);
  });

  const communities = detectCommunities(rankedNodes, adjacency, connectionCount);
  const importanceBySlug = computeNodeImportance(rankedNodes, adjacency, connectionCount, communities.bySlug, communities.meta);
  const bridgeBySlug = scoreBridgeNodes(rankedNodes, adjacency, connectionCount, communities.bySlug);
  const skeletalNodes = rankedNodes.map(node => ({
    ...node,
    clusterId: bridgeBySlug.get(node.slug)?.primaryClusterId || communities.bySlug.get(node.slug) || communities.primaryId,
    importance: importanceBySlug.get(node.slug)?.normalized || 0,
  }));
  const skeletalNodeBySlug = new Map(skeletalNodes.map(node => [node.slug, node]));
  const { clusterGraph, hubMassByCluster } = buildClusterGraph(validEdges, skeletalNodeBySlug, bridgeBySlug, communities.meta);
  const clusterAnchors = buildClusterAnchors(communities.meta, clusterGraph, tuning, hubMassByCluster);
  const { nodes, nodesBySlug } = buildInitialNodes(rankedNodes, connectionCount, communities.bySlug, bridgeBySlug, importanceBySlug, clusterAnchors, tuning);
  const edges = buildEdges(validEdges, nodesBySlug, communities.structuralAdjacency);

  const state = {
    graphData,
    tuning,
    activeSlug,
    adjacency,
    connectionCount,
    rankedNodes,
    nodes,
    nodesBySlug,
    edges,
    clusterMeta: communities.meta,
    clusterLookup: communities.bySlug,
    structuralAdjacency: communities.structuralAdjacency,
    bridgeBySlug,
    clusterGraph,
    clusterAnchors,
    clusterClouds: new Map(),
    iteration: 0,
    energy: 1,
    lastOverlapCount: 0,
    overlapRetryBudget: 4,
    stableTicks: 0,
    settled: false,
  };

  let remaining = 520;
  while (!state.settled && remaining > 0) {
    iterateLayout(state, Math.min(40, remaining));
    remaining -= 40;
  }
  if (!state.settled) {
    finalizeLayoutState(state);
  }
  return state;
}

export function applyTuningToState(state, nextTuning) {
  const previous = state.tuning;
  const tuning = normalizeTuning(nextTuning);
  const spacingRatio = (0.7 + tuning.clusterSpacing) / (0.7 + previous.clusterSpacing);
  const compactnessRatio = lerp(1.18, 0.78, tuning.localCompactness) / lerp(1.18, 0.78, previous.localCompactness);

  state.tuning = tuning;
  for (const node of state.nodes) {
    node.radius = getNodeRadius(
      node.importanceScore || 1,
      node.weight || node.connections || 0,
      node.importance || 0,
      tuning.nodeScale,
    );
  }

  for (const anchor of state.clusterAnchors.values()) {
    anchor.x *= spacingRatio;
    anchor.y *= spacingRatio;
  }

  for (const node of state.nodes) {
    if (node.pinned) continue;
    if (node.isBridge) {
      node.x *= spacingRatio;
      node.y *= spacingRatio;
      continue;
    }
    const anchor = state.clusterAnchors.get(node.clusterId);
    if (!anchor) continue;
    node.x = anchor.x + (node.x - anchor.x) * compactnessRatio;
    node.y = anchor.y + (node.y - anchor.y) * compactnessRatio;
  }

  state.overlapRetryBudget = 4;
  state.stableTicks = 0;
  state.settled = false;
}

export function reheatState(state, intensity = 1) {
  for (const node of state.nodes) {
    if (node.pinned) continue;
    const jitter = (randomUnitFromSlug(node.slug + state.iteration) - 0.5) * (2.4 + (node.isBridge ? 0.8 : 0)) * intensity;
    const jitterY = (randomUnitFromSlug(`${state.iteration}-${node.slug}`) - 0.5) * (2.4 + (node.isBridge ? 0.8 : 0)) * intensity;
    node.vx += jitter;
    node.vy += jitterY;
  }
  state.stableTicks = 0;
  state.settled = false;
}

export function focusNodeInState(state, slug) {
  state.activeSlug = slug || null;
  const node = slug ? state.nodesBySlug.get(slug) : null;
  if (!node) return;

  node.vx *= 0.4;
  node.vy *= 0.4;
  if (node.clusterId) {
    const anchor = state.clusterAnchors.get(node.clusterId);
    if (anchor) {
      node.vx += (anchor.x - node.x) * 0.08;
      node.vy += (anchor.y - node.y) * 0.08;
    }
  }
  state.stableTicks = 0;
  state.settled = false;
}

export function serializeGraph(state) {
  return {
    nodes: state.nodes.map(node => ({
      slug: node.slug,
      title: node.title,
      type: node.type,
      color: node.color,
      clusterId: node.clusterId,
      bridgeClusterIds: [...node.bridgeClusterIds],
      isBridge: node.isBridge,
      bridgeScore: node.bridgeScore,
      connections: node.connections,
      weight: node.weight,
      importanceScore: node.importanceScore,
      importance: node.importance,
      radius: node.radius,
      x: node.x,
      y: node.y,
      vx: node.vx,
      vy: node.vy,
    })),
    edges: state.edges.map(edge => ({
      source: edge.sourceSlug,
      target: edge.targetSlug,
      intraCluster: edge.intraCluster,
      bridgeEdge: edge.bridgeEdge,
      structural: edge.structural,
      structuralWeight: edge.structuralWeight,
      pairKey: edge.pairKey,
      bias: edge.bias,
    })),
    clusters: [...state.clusterMeta.values()].map(cluster => ({
      id: cluster.id,
      size: cluster.size,
      totalWeight: cluster.totalWeight,
      dominantType: cluster.dominantType,
      members: cluster.members.map(member => member.slug),
    })),
  };
}

export function serializeFrame(state) {
  return {
    nodes: state.nodes.map(node => ({
      slug: node.slug,
      x: node.x,
      y: node.y,
      vx: node.vx,
      vy: node.vy,
      radius: node.radius,
      clusterId: node.clusterId,
      isBridge: node.isBridge,
      bridgeClusterIds: [...node.bridgeClusterIds],
      importance: node.importance,
      weight: node.weight,
    })),
    clusters: [...state.clusterClouds.values()].map(cluster => ({ ...cluster })),
    stats: {
      iteration: state.iteration,
      energy: state.energy,
      overlapCount: state.lastOverlapCount,
      settled: state.settled,
    },
  };
}
