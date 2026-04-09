/**
 * Granite — Atlas Graph Engine
 */

const GraphEngine = (() => {
  const TYPE_COLORS = {
    note: '#d37a57',
    source: '#67b5a1',
    synthesis: '#b394ff',
    output: '#e4b65f',
  };

  const DEFAULT_TUNING = {
    nodeScale: 1.1,
    clusterTightness: 0.62,
    labelDensity: 0.48,
    edgeOpacity: 0.56,
  };
  const MIN_ALPHA = 0.0015;
  const VELOCITY_LIMIT = 10;
  const APPEAR_DURATION_MS = 220;
  const ALPHA_DECAY = 1 - Math.pow(0.001, 1 / 240);

  let canvas;
  let ctx;
  let width = 0;
  let height = 0;
  let nodes = [];
  let edges = [];
  let nodeBySlug = new Map();
  let adjacency = new Map();
  let visibleNodes = [];
  let transform = { x: 0, y: 0, scale: 1 };
  let hoveredNode = null;
  let dragNode = null;
  let isPanning = false;
  let panStart = { x: 0, y: 0 };
  let dragDistance = 0;
  let activeSlug = null;
  let onSelect = null;
  let onOpen = null;
  let onStateChange = null;
  let progressiveReveal = true;
  let animFrame = null;
  let isRunning = false;
  let simulationAlpha = 1;
  let resizeObserver = null;
  let eventsBound = false;
  let revealOrder = [];
  let revealIndex = 0;
  let lastFrameTime = 0;
  let lastRevealTime = 0;
  let visibleEdgeCount = 0;
  let tuning = { ...DEFAULT_TUNING };
  let clusterMeta = new Map();
  let autoFitPending = false;
  let userAdjustedView = false;

  function init(canvasEl, graphData, options = {}) {
    stop({ keepState: false });
    attachCanvas(canvasEl);
    applyOptions(options);
    buildGraph(graphData);
    bindEvents();
    resize();
    fitView();
    autoFitPending = true;
    userAdjustedView = false;
    draw();
    publishState();
    if (shouldAnimate()) start();
  }

  function resume(canvasEl, options = {}) {
    attachCanvas(canvasEl);
    applyOptions(options);
    bindEvents();
    resize();
    draw();
    publishState();
    if (shouldAnimate()) start();
  }

  function destroy() {
    stop({ keepState: false });
    nodes = [];
    edges = [];
    nodeBySlug = new Map();
    adjacency = new Map();
    clusterMeta = new Map();
    visibleNodes = [];
    revealOrder = [];
    revealIndex = 0;
    visibleEdgeCount = 0;
    transform = { x: 0, y: 0, scale: 1 };
    activeSlug = null;
    autoFitPending = false;
    userAdjustedView = false;
    publishState();
  }

  function attachCanvas(canvasEl) {
    canvas = canvasEl;
    ctx = canvas ? canvas.getContext('2d') : null;
  }

  function applyOptions(options = {}) {
    onSelect = options.onSelect || onSelect || null;
    onOpen = options.onOpen || onOpen || null;
    onStateChange = options.onStateChange || onStateChange || null;
    activeSlug = options.activeSlug ?? activeSlug;
    if (options.tuning) {
      setTuning(options.tuning, { reheat: false, redraw: false, publish: false });
    }
    if (Object.prototype.hasOwnProperty.call(options, 'progressiveReveal')) {
      const nextValue = Boolean(options.progressiveReveal);
      if (nextValue !== progressiveReveal) {
        progressiveReveal = nextValue;
        if (!progressiveReveal) {
          revealAllNodes();
        }
      }
    }
  }

  function buildGraph(graphData) {
    const connectionCount = {};
    const slugSet = new Set(graphData.nodes.map(node => node.slug));
    const rawAdjacency = new Map(graphData.nodes.map(node => [node.slug, new Set()]));

    for (const edge of graphData.edges) {
      if (!slugSet.has(edge.source) || !slugSet.has(edge.target)) continue;
      connectionCount[edge.source] = (connectionCount[edge.source] || 0) + 1;
      connectionCount[edge.target] = (connectionCount[edge.target] || 0) + 1;
      rawAdjacency.get(edge.source).add(edge.target);
      rawAdjacency.get(edge.target).add(edge.source);
    }

    const maxConnections = Math.max(1, ...Object.values(connectionCount));
    const rankedNodes = [...graphData.nodes].sort((a, b) => {
      const connectionDelta = (connectionCount[b.slug] || 0) - (connectionCount[a.slug] || 0);
      if (connectionDelta !== 0) return connectionDelta;
      return a.title.localeCompare(b.title);
    });
    const layout = getLayoutTuning();
    const baseSpread = Math.max(
      layout.baseSpreadFloor,
      Math.sqrt(Math.max(rankedNodes.length, 1)) * layout.baseSpreadScale,
    );
    const communities = detectCommunities(rankedNodes, rawAdjacency, connectionCount);
    clusterMeta = communities.meta;
    const importanceBySlug = computeNodeImportance(
      rankedNodes,
      rawAdjacency,
      connectionCount,
      communities.bySlug,
      clusterMeta,
    );
    const communityAnchors = buildCommunityAnchors(clusterMeta, layout, baseSpread);
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));

    nodes = rankedNodes.map((node, index) => {
      const connections = connectionCount[node.slug] || 0;
      const ratio = connections / maxConnections;
      const clusterId = communities.bySlug.get(node.slug) || communities.primaryId;
      const clusterState = communityAnchors.get(clusterId) || communityAnchors.get(communities.primaryId);
      const importanceState = importanceBySlug.get(node.slug) || { score: 1, normalized: 0 };
      const localIndex = clusterState.memberIndex.get(node.slug) || 0;
      const orbit = Math.sqrt(localIndex + 1) / Math.sqrt(Math.max(clusterState.size, 1));
      const distance = orbit * clusterState.localSpread * (layout.innerOrbit + (1 - ratio) * layout.outerOrbit);
      const angle = localIndex * goldenAngle + index * 0.07;
      const radius = getNodeRadius(importanceState.score, connections, importanceState.normalized);
      return {
        ...node,
        x: clusterState.x + Math.cos(angle) * distance,
        y: clusterState.y + Math.sin(angle) * distance * (0.9 + Math.random() * 0.1),
        vx: 0,
        vy: 0,
        radius,
        connections,
        weight: connections,
        importanceScore: importanceState.score,
        importance: importanceState.normalized,
        clusterId,
        color: TYPE_COLORS[node.type] || '#d37a57',
        visible: !progressiveReveal,
        appear: progressiveReveal ? 0 : 1,
      };
    });

    nodeBySlug = new Map(nodes.map(node => [node.slug, node]));
    adjacency = rawAdjacency;
    edges = graphData.edges
      .filter(edge => nodeBySlug.get(edge.source) && nodeBySlug.get(edge.target))
      .map(edge => {
        const source = nodeBySlug.get(edge.source);
        const target = nodeBySlug.get(edge.target);
        const sourceDegree = Math.max(source.connections || 0, 1);
        const targetDegree = Math.max(target.connections || 0, 1);
        return {
          source,
          target,
          bias: sourceDegree / (sourceDegree + targetDegree),
          baseStrength: 1 / Math.max(1, Math.min(sourceDegree, targetDegree)),
          intraCluster: source.clusterId === target.clusterId,
          targetDistanceFactor: source.clusterId === target.clusterId ? 0.7 : 1.24,
          strengthFactor: source.clusterId === target.clusterId ? 1.22 : 0.82,
        };
      });

    revealOrder = buildRevealOrder();
    revealIndex = 0;
    visibleNodes = [];
    visibleEdgeCount = 0;
    hoveredNode = null;
    dragNode = null;
    isPanning = false;
    lastRevealTime = 0;
    simulationAlpha = progressiveReveal ? 0.3 : 0.16;

    if (progressiveReveal) {
      primeReveal();
    } else {
      revealAllNodes();
    }
  }

  function buildRevealOrder() {
    const activeNeighbors = new Set(activeSlug ? adjacency.get(activeSlug) || [] : []);
    return [...nodes].sort((a, b) => {
      const priorityDelta = getRevealPriority(b, activeNeighbors) - getRevealPriority(a, activeNeighbors);
      if (priorityDelta !== 0) return priorityDelta;
      return a.title.localeCompare(b.title);
    });
  }

  function getRevealPriority(node, activeNeighbors) {
    let priority = (node.importance || 0) * 320 + node.connections * 70 + node.radius * 2.2;
    if (node.slug === activeSlug) priority += 100000;
    if (activeNeighbors.has(node.slug)) priority += 50000;
    if (clusterMeta.get(node.clusterId)?.size >= 6) priority += 150;
    return priority;
  }

  function detectCommunities(rankedNodes, rawAdjacency, connectionCount) {
    const labels = new Map(rankedNodes.map(node => [node.slug, node.slug]));

    for (let iteration = 0; iteration < 10; iteration++) {
      let changed = false;
      for (const node of rankedNodes) {
        const neighbors = rawAdjacency.get(node.slug);
        if (!neighbors?.size) continue;
        const scores = new Map();
        for (const neighborSlug of neighbors) {
          const label = labels.get(neighborSlug);
          if (!label) continue;
          const weight = 1 + Math.min(connectionCount[neighborSlug] || 0, 12) * 0.06;
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

    mergeTinyCommunities(labels, rankedNodes, rawAdjacency);

    const grouped = new Map();
    for (const node of rankedNodes) {
      const label = labels.get(node.slug) || node.slug;
      if (!grouped.has(label)) grouped.set(label, []);
      grouped.get(label).push(node);
    }

    const sorted = [...grouped.values()]
      .map(members => {
        const orderedMembers = [...members].sort((a, b) => {
          const delta = (connectionCount[b.slug] || 0) - (connectionCount[a.slug] || 0);
          if (delta !== 0) return delta;
          return a.title.localeCompare(b.title);
        });
        const typeWeights = {};
        for (const member of orderedMembers) {
          typeWeights[member.type || 'note'] = (typeWeights[member.type || 'note'] || 0) + 1;
        }
        const dominantType = Object.entries(typeWeights).sort((a, b) => b[1] - a[1])[0]?.[0] || 'note';
        return {
          members: orderedMembers,
          size: orderedMembers.length,
          totalWeight: orderedMembers.reduce((sum, member) => sum + (connectionCount[member.slug] || 0), 0),
          dominantType,
        };
      })
      .sort((a, b) => b.totalWeight - a.totalWeight || b.size - a.size);

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
      primaryId: sorted.length ? 'cluster-0' : null,
    };
  }

  function mergeTinyCommunities(labels, rankedNodes, rawAdjacency) {
    const groupByLabel = () => {
      const grouped = new Map();
      for (const node of rankedNodes) {
        const label = labels.get(node.slug) || node.slug;
        if (!grouped.has(label)) grouped.set(label, []);
        grouped.get(label).push(node.slug);
      }
      return grouped;
    };

    for (let pass = 0; pass < 2; pass++) {
      const grouped = groupByLabel();
      let changed = false;
      for (const [label, members] of grouped) {
        if (members.length >= 3) continue;
        for (const slug of members) {
          const scores = new Map();
          for (const neighborSlug of rawAdjacency.get(slug) || []) {
            const neighborLabel = labels.get(neighborSlug);
            if (!neighborLabel || neighborLabel === label) continue;
            const groupSize = grouped.get(neighborLabel)?.length || 1;
            scores.set(neighborLabel, (scores.get(neighborLabel) || 0) + groupSize);
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

  function buildCommunityAnchors(meta, layout, baseSpread) {
    const anchors = new Map();
    const communities = [...meta.values()];
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    const orbitBase = baseSpread * 0.68;

    communities.forEach((community, index) => {
      const memberIndex = new Map(community.members.map((member, memberIdx) => [member.slug, memberIdx]));
      const ring = Math.sqrt(index + 0.35);
      const anchorRadius = index === 0 ? 0 : orbitBase * (0.34 + ring * 0.23);
      const angle = index * goldenAngle;
      anchors.set(community.id, {
        x: Math.cos(angle) * anchorRadius,
        y: Math.sin(angle) * anchorRadius * 0.84,
        size: community.size,
        localSpread: 28 + Math.sqrt(Math.max(community.totalWeight, 1)) * 6.8,
        memberIndex,
      });
    });

    return anchors;
  }

  function computeNodeImportance(rankedNodes, rawAdjacency, connectionCount, clusterLookup, meta) {
    const seeds = new Map();

    for (const node of rankedNodes) {
      const degree = connectionCount[node.slug] || 0;
      const neighbors = [...(rawAdjacency.get(node.slug) || [])];
      const neighborDegreeSignal = neighbors.length
        ? neighbors.reduce((sum, neighborSlug) => sum + Math.log1p(connectionCount[neighborSlug] || 0), 0) / neighbors.length
        : 0;
      const connectedClusters = new Set(
        neighbors
          .map(neighborSlug => clusterLookup.get(neighborSlug))
          .filter(Boolean),
      );
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
          + bridgeSignal * 0.38
          + typeSignal,
      );
    }

    let scores = new Map(seeds);
    for (let iteration = 0; iteration < 12; iteration++) {
      const nextScores = new Map();
      for (const node of rankedNodes) {
        let propagated = 0;
        for (const neighborSlug of rawAdjacency.get(node.slug) || []) {
          const neighborDegree = Math.max(connectionCount[neighborSlug] || 0, 1);
          propagated += (scores.get(neighborSlug) || 1) / Math.pow(neighborDegree, 0.88);
        }
        nextScores.set(node.slug, (seeds.get(node.slug) || 1) * 0.32 + propagated * 0.68);
      }
      scores = nextScores;
    }

    for (const cluster of meta.values()) {
      const orderedMembers = [...cluster.members].sort(
        (a, b) => (scores.get(b.slug) || 0) - (scores.get(a.slug) || 0),
      );
      if (orderedMembers[0]) {
        const leadBoost = 0.58 + Math.log1p(cluster.size) * 0.11;
        scores.set(orderedMembers[0].slug, (scores.get(orderedMembers[0].slug) || 0) + leadBoost);
      }
      if (orderedMembers.length >= 6 && orderedMembers[1]) {
        scores.set(orderedMembers[1].slug, (scores.get(orderedMembers[1].slug) || 0) + 0.22);
      }
    }

    const values = [...scores.values()];
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = Math.max(max - min, 1e-6);
    const bySlug = new Map();

    for (const node of rankedNodes) {
      const score = scores.get(node.slug) || 1;
      const normalized = Math.pow((score - min) / span, 0.84);
      bySlug.set(node.slug, { score, normalized });
    }

    return bySlug;
  }

  function primeReveal() {
    const initialCount = Math.min(nodes.length, Math.max(7, Math.round(Math.sqrt(nodes.length) * 1.6)));
    revealNextBatch(initialCount, { prime: true });
  }

  function revealNextBatch(count, options = {}) {
    let revealed = 0;
    while (revealed < count && revealIndex < revealOrder.length) {
      const node = revealOrder[revealIndex++];
      if (node.visible) continue;
      placeNodeForReveal(node);
      node.visible = true;
      node.appear = options.prime ? 0.55 : 0;
      visibleNodes.push(node);
      revealed += 1;
    }

    if (revealed > 0) {
      visibleEdgeCount = countVisibleEdges();
      simulationAlpha = Math.max(simulationAlpha, options.prime ? 0.24 : 0.3);
      publishState();
    }

    return revealed;
  }

  function revealAllNodes() {
    visibleNodes = [];
    for (const node of nodes) {
      node.visible = true;
      node.appear = 1;
      visibleNodes.push(node);
    }
    revealIndex = revealOrder.length;
    visibleEdgeCount = edges.length;
    simulationAlpha = Math.max(simulationAlpha, 0.18);
    publishState();
  }

  function placeNodeForReveal(node) {
    const layout = getLayoutTuning();
    const visibleNeighbors = [...(adjacency.get(node.slug) || [])]
      .map(slug => nodeBySlug.get(slug))
      .filter(candidate => candidate?.visible);

    if (visibleNeighbors.length > 0) {
      const centroid = visibleNeighbors.reduce((acc, candidate) => {
        acc.x += candidate.x;
        acc.y += candidate.y;
        return acc;
      }, { x: 0, y: 0 });
      centroid.x /= visibleNeighbors.length;
      centroid.y /= visibleNeighbors.length;
      const angle = (revealIndex + 1) * 0.73;
      const offset = layout.revealOffsetBase + node.radius * layout.revealOffsetScale;
      node.x = centroid.x + Math.cos(angle) * offset;
      node.y = centroid.y + Math.sin(angle) * offset;
    } else if (visibleNodes.length > 0) {
      const anchor = visibleNodes[revealIndex % visibleNodes.length];
      node.x = (node.x + anchor.x) / 2;
      node.y = (node.y + anchor.y) / 2;
    }

    node.vx = (Math.random() - 0.5) * 0.8;
    node.vy = (Math.random() - 0.5) * 0.8;
  }

  function bindEvents() {
    if (eventsBound || !canvas) return;
    eventsBound = true;

    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('mouseleave', handleMouseLeave);
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    canvas.addEventListener('dblclick', handleDoubleClick);

    resizeObserver = new ResizeObserver(() => {
      resize();
      draw();
    });
    resizeObserver.observe(canvas.parentElement);
  }

  function resize() {
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const container = canvas.parentElement;
    width = container.clientWidth;
    height = container.clientHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function handleMouseDown(event) {
    const { x, y } = getLocalPoint(event);
    const node = findNodeAt(x, y);
    if (node) {
      dragNode = node;
      dragNode.vx = 0;
      dragNode.vy = 0;
      dragDistance = 0;
      simulationAlpha = Math.max(simulationAlpha, 0.35);
      start();
      return;
    }
    isPanning = true;
    userAdjustedView = true;
    panStart = { x: event.clientX - transform.x, y: event.clientY - transform.y };
    draw();
  }

  function handleMouseMove(event) {
    const { x, y } = getLocalPoint(event);

    if (dragNode) {
      const world = screenToWorld(x, y);
      dragNode.x = world.x;
      dragNode.y = world.y;
      dragDistance += Math.abs(event.movementX) + Math.abs(event.movementY);
      simulationAlpha = Math.max(simulationAlpha, 0.12);
      canvas.style.cursor = 'grabbing';
      draw();
      return;
    }

    if (isPanning) {
      transform.x = event.clientX - panStart.x;
      transform.y = event.clientY - panStart.y;
      draw();
      return;
    }

    const node = findNodeAt(x, y);
    hoveredNode = node;
    canvas.style.cursor = node ? 'pointer' : 'default';

    const tooltip = document.getElementById('graph-tooltip');
    if (!node) {
      tooltip.style.opacity = '0';
      draw();
      return;
    }

    tooltip.textContent = node.title;
    tooltip.style.left = `${event.clientX + 14}px`;
    tooltip.style.top = `${event.clientY - 8}px`;
    tooltip.style.opacity = '1';
    draw();
  }

  function handleMouseUp() {
    if (dragNode && dragDistance < 5) {
      activeSlug = dragNode.slug;
      if (onSelect) onSelect(dragNode.slug);
      publishState();
    }
    dragNode = null;
    isPanning = false;
    canvas.style.cursor = 'default';
    if (shouldAnimate()) {
      start();
    } else {
      draw();
    }
  }

  function handleMouseLeave() {
    hoveredNode = null;
    dragNode = null;
    isPanning = false;
    hideTooltip();
    draw();
  }

  function handleDoubleClick(event) {
    const { x, y } = getLocalPoint(event);
    const node = findNodeAt(x, y);
    if (!node || !onOpen) return;
    activeSlug = node.slug;
    publishState();
    onOpen(node.slug);
  }

  function handleWheel(event) {
    event.preventDefault();
    userAdjustedView = true;
    const factor = event.deltaY > 0 ? 0.92 : 1.08;
    const nextScale = Math.max(0.12, Math.min(5, transform.scale * factor));
    const rect = canvas.getBoundingClientRect();
    const localX = event.clientX - rect.left - width / 2;
    const localY = event.clientY - rect.top - height / 2;
    transform.x = localX - (localX - transform.x) * (nextScale / transform.scale);
    transform.y = localY - (localY - transform.y) * (nextScale / transform.scale);
    transform.scale = nextScale;
    draw();
  }

  function getLocalPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function advanceReveal(now) {
    if (!progressiveReveal || revealIndex >= revealOrder.length) return false;

    const interval = getRevealInterval();
    if (!lastRevealTime) {
      lastRevealTime = now;
      return false;
    }
    if (now - lastRevealTime < interval) return false;

    lastRevealTime = now;
    const batch = getRevealBatchSize();
    revealNextBatch(batch);
    return true;
  }

  function getRevealInterval() {
    if (nodes.length >= 220) return 40;
    if (nodes.length >= 120) return 56;
    if (nodes.length >= 70) return 72;
    return 88;
  }

  function getRevealBatchSize() {
    if (nodes.length >= 220) return 8;
    if (nodes.length >= 120) return 5;
    if (nodes.length >= 70) return 3;
    return 2;
  }

  function advanceAppearances(delta) {
    let changed = false;
    const step = delta / APPEAR_DURATION_MS;
    for (const node of visibleNodes) {
      if (node.appear >= 1) continue;
      node.appear = Math.min(1, node.appear + step);
      changed = true;
    }
    return changed;
  }

  function simulate() {
    if (simulationAlpha < MIN_ALPHA) {
      simulationAlpha = 0;
      return false;
    }

    const simulationNodes = visibleNodes;
    if (!simulationNodes.length) return false;
    const layout = getLayoutTuning();

    const centroids = getVisibleClusterCentroids(simulationNodes);

    applyCenterForce(simulationNodes, layout);
    applyLinkForce(layout);
    applyCommunityForce(simulationNodes, centroids, layout);
    applyClusterRepulsion(centroids, layout);
    applyRepulsionForce(simulationNodes, layout);
    applyCollisionForce(simulationNodes, layout);

    for (const node of simulationNodes) {
      if (node === dragNode) continue;
      node.vx *= layout.velocityDecay;
      node.vy *= layout.velocityDecay;
      const speed = Math.sqrt(node.vx * node.vx + node.vy * node.vy);
      if (speed > VELOCITY_LIMIT) {
        node.vx = (node.vx / speed) * VELOCITY_LIMIT;
        node.vy = (node.vy / speed) * VELOCITY_LIMIT;
      }
      node.x += node.vx;
      node.y += node.vy;
    }

    simulationAlpha += (0 - simulationAlpha) * (dragNode ? ALPHA_DECAY * 0.18 : ALPHA_DECAY);
    if (simulationAlpha < MIN_ALPHA) simulationAlpha = 0;
    return simulationAlpha > 0;
  }

  function applyCenterForce(simulationNodes, layout) {
    for (const node of simulationNodes) {
      const anchorBias = node.slug === activeSlug
        ? 1.08
        : 0.88 + Math.min(node.connections, 18) * 0.01 + (node.importance || 0) * 0.08;
      node.vx += (0 - node.x) * layout.centerForce * anchorBias * simulationAlpha;
      node.vy += (0 - node.y) * layout.centerForce * anchorBias * simulationAlpha;
    }
  }

  function applyLinkForce(layout) {
    for (const edge of edges) {
      if (!edge.source.visible || !edge.target.visible) continue;
      const dx = (edge.target.x + edge.target.vx) - (edge.source.x + edge.source.vx);
      const dy = (edge.target.y + edge.target.vy) - (edge.source.y + edge.source.vy);
      let distance = Math.sqrt(dx * dx + dy * dy);
      if (!distance) distance = 1;
        const targetDistance = layout.linkDistance * edge.targetDistanceFactor;
      const strength = edge.baseStrength * layout.linkStrength * edge.strengthFactor * simulationAlpha;
      const force = ((distance - targetDistance) / distance) * strength;
      const fx = dx * force;
      const fy = dy * force;
      const targetBias = edge.bias;
      const sourceBias = 1 - targetBias;
      edge.target.vx -= fx * targetBias;
      edge.target.vy -= fy * targetBias;
      edge.source.vx += fx * sourceBias;
      edge.source.vy += fy * sourceBias;
    }
  }

  function applyCommunityForce(simulationNodes, centroids, layout) {
    for (const node of simulationNodes) {
      const community = centroids.get(node.clusterId);
      if (!community || community.count < 4) continue;
      const bias = 0.72 + Math.min(community.count, 12) * 0.035;
      node.vx += (community.x - node.x) * layout.communityForce * bias * simulationAlpha;
      node.vy += (community.y - node.y) * layout.communityForce * bias * simulationAlpha;
    }
  }

  function applyClusterRepulsion(centroids, layout) {
    const groups = [...centroids.values()].filter(group => group.count >= 3);
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const a = groups[i];
        const b = groups[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distance = Math.sqrt(dx * dx + dy * dy);
        const minDistance = (Math.sqrt(a.count) + Math.sqrt(b.count)) * layout.clusterSpacing;
        if (distance >= minDistance) continue;
        if (!distance) {
          dx = (Math.random() - 0.5) * 0.01;
          dy = (Math.random() - 0.5) * 0.01;
          distance = Math.sqrt(dx * dx + dy * dy);
        }
        const force = ((minDistance - distance) / minDistance) * layout.clusterRepulsion * simulationAlpha;
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        const aBias = 1 / Math.max(1.2, Math.sqrt(a.count));
        const bBias = 1 / Math.max(1.2, Math.sqrt(b.count));

        for (const member of a.members) {
          member.vx -= fx * aBias;
          member.vy -= fy * aBias;
        }
        for (const member of b.members) {
          member.vx += fx * bBias;
          member.vy += fy * bBias;
        }
      }
    }
  }

  function applyRepulsionForce(simulationNodes, layout) {
    for (let i = 0; i < simulationNodes.length; i++) {
      for (let j = i + 1; j < simulationNodes.length; j++) {
        const a = simulationNodes[i];
        const b = simulationNodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distanceSq = dx * dx + dy * dy;
        if (distanceSq > layout.maxRepulsionDistanceSq) continue;
        if (distanceSq < 1) {
          dx = (Math.random() - 0.5) * 0.01;
          dy = (Math.random() - 0.5) * 0.01;
          distanceSq = dx * dx + dy * dy;
        }
        const distance = Math.sqrt(distanceSq);
        const clampDistance = Math.max(distance, layout.repulsionDistanceMin);
        const weightFactor = 0.8 + Math.sqrt(a.weight + b.weight + 2) * 0.1;
        const clusterFactor = a.clusterId === b.clusterId ? 0.72 : 1.44;
        const force = (layout.repulsion * weightFactor * clusterFactor * simulationAlpha) / (clampDistance * clampDistance);
        const fx = (dx / clampDistance) * force;
        const fy = (dy / clampDistance) * force;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }
  }

  function applyCollisionForce(simulationNodes, layout) {
    for (let i = 0; i < simulationNodes.length; i++) {
      for (let j = i + 1; j < simulationNodes.length; j++) {
        const a = simulationNodes[i];
        const b = simulationNodes[j];
        let dx = (b.x + b.vx) - (a.x + a.vx);
        let dy = (b.y + b.vy) - (a.y + a.vy);
        let distance = Math.sqrt(dx * dx + dy * dy);
        const minDistance = a.radius + b.radius + layout.collisionPadding;
        if (distance >= minDistance) continue;
        if (!distance) {
          dx = (Math.random() - 0.5) * 0.01;
          dy = (Math.random() - 0.5) * 0.01;
          distance = Math.sqrt(dx * dx + dy * dy);
        }
        const overlap = (minDistance - distance) / distance * layout.collisionStrength * simulationAlpha;
        const fx = dx * overlap;
        const fy = dy * overlap;
        const bias = (b.radius * b.radius) / ((a.radius * a.radius) + (b.radius * b.radius));
        b.vx += fx * bias;
        b.vy += fy * bias;
        a.vx -= fx * (1 - bias);
        a.vy -= fy * (1 - bias);
      }
    }
  }

  function getVisibleClusterCentroids(sourceNodes) {
    const groups = new Map();
    for (const node of sourceNodes) {
      if (!node.clusterId) continue;
      if (!groups.has(node.clusterId)) {
        groups.set(node.clusterId, { x: 0, y: 0, weight: 0, count: 0, members: [] });
      }
      const group = groups.get(node.clusterId);
      const weight = 1 + Math.sqrt(node.weight + 1) * 0.12 + (node.importance || 0) * 0.9;
      group.x += node.x * weight;
      group.y += node.y * weight;
      group.weight += weight;
      group.count += 1;
      group.members.push(node);
    }
    for (const group of groups.values()) {
      group.x /= Math.max(group.weight, 1);
      group.y /= Math.max(group.weight, 1);
    }
    return groups;
  }

  function draw() {
    if (!ctx) return;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#1e1713';
    ctx.fillRect(0, 0, width, height);

    drawBackgroundGlow();

    ctx.save();
    ctx.translate(width / 2 + transform.x, height / 2 + transform.y);
    ctx.scale(transform.scale, transform.scale);

    drawClusterClouds();

    const neighbors = new Set();
    if (hoveredNode) {
      for (const edge of edges) {
        if (!edge.source.visible || !edge.target.visible) continue;
        if (edge.source === hoveredNode) neighbors.add(edge.target);
        if (edge.target === hoveredNode) neighbors.add(edge.source);
      }
      neighbors.add(hoveredNode);
    }

    for (const edge of edges) {
      if (!edge.source.visible || !edge.target.visible) continue;
      const edgeAlpha = Math.min(edge.source.appear, edge.target.appear);
      if (edgeAlpha <= 0) continue;
      const highlighted = hoveredNode && (edge.source === hoveredNode || edge.target === hoveredNode);
      const edgeWeight = Math.min(edge.source.weight, edge.target.weight);
      const thickness = highlighted
        ? 1.65
        : 0.34 + Math.min(edgeWeight, 12) * 0.02 + (edge.intraCluster ? 0.16 : 0);
      const edgeOpacityScale = lerp(0.15, 2.35, tuning.edgeOpacity);
      const highlightAlpha = Math.min(0.92, 0.52 * edgeAlpha * edgeOpacityScale);
      const baseAlpha = Math.min(
        edge.intraCluster ? 0.48 : 0.22,
        (0.05 + Math.min(edgeWeight, 16) * 0.004)
        * edgeAlpha
        * edgeOpacityScale
        * (edge.intraCluster ? 1.55 : 0.7),
      );
      const edgeColor = edge.intraCluster
        ? mixHex(edge.source.color, edge.target.color, 0.5)
        : '#7d685b';
      ctx.strokeStyle = highlighted
        ? `rgba(255, 236, 214, ${highlightAlpha})`
        : hexToRgba(edgeColor, baseAlpha);
      ctx.lineWidth = thickness;
      ctx.beginPath();
      ctx.moveTo(edge.source.x, edge.source.y);
      ctx.lineTo(edge.target.x, edge.target.y);
      ctx.stroke();
    }

    for (const node of visibleNodes) {
      const dimmed = hoveredNode && !neighbors.has(node);
      const active = node.slug === activeSlug;
      const hovered = node === hoveredNode;
      const appear = node.appear;
      const radius = node.radius * (0.72 + appear * 0.28);
      const nodeImportance = Math.max(
        node.importance || 0,
        Math.min(1, Math.sqrt(node.weight + 1) / 4.8),
      );
      const shellColor = mixHex(node.color, '#251912', active ? 0.14 : hovered ? 0.08 : 0.04);
      const rimColor = mixHex(node.color, '#fff1de', active ? 0.28 : hovered ? 0.18 : 0.11);
      const coreColor = mixHex(node.color, '#fff6eb', 0.2 + nodeImportance * 0.08);

      if (active || hovered || appear < 1) {
        const glowRadius = radius * (appear < 1 ? 5.4 - appear * 1.9 : 3.8);
        const glow = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, glowRadius);
        if (appear < 1) {
          glow.addColorStop(0, `${hexToRgba(node.color, 0.14 + (1 - appear) * 0.18)}`);
          glow.addColorStop(1, `${hexToRgba(node.color, 0)}`);
        } else {
          glow.addColorStop(0, active ? 'rgba(255, 239, 224, 0.22)' : `${hexToRgba(node.color, 0.14)}`);
          glow.addColorStop(1, 'rgba(255, 244, 232, 0)');
        }
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(node.x, node.y, glowRadius, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.beginPath();
      ctx.fillStyle = dimmed
        ? `rgba(255, 241, 226, ${0.1 * appear})`
        : hexToRgba(shellColor, (0.92 + nodeImportance * 0.04) * appear);
      ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = active
        ? `rgba(255, 245, 232, ${0.92 * appear})`
        : hexToRgba(rimColor, (0.72 + nodeImportance * 0.14) * appear);
      ctx.lineWidth = active ? 2.1 : hovered ? 1.55 : 1.12;
      ctx.stroke();

      if (nodeImportance > 0.42 || active) {
        ctx.beginPath();
        ctx.strokeStyle = active
          ? `rgba(255, 245, 232, ${0.34 * appear})`
          : hexToRgba(node.color, (0.14 + nodeImportance * 0.08) * appear);
        ctx.lineWidth = 0.9;
        ctx.arc(node.x, node.y, radius + 2 + nodeImportance * 1.5, 0, Math.PI * 2);
        ctx.stroke();
      }

      if (nodeImportance > 0.32 || active || hovered) {
        const coreRadius = Math.max(1.4, radius * (0.16 + nodeImportance * 0.04));
        ctx.beginPath();
        ctx.fillStyle = dimmed
          ? `rgba(255, 247, 238, ${0.1 * appear})`
          : hexToRgba(coreColor, (0.74 + (hovered ? 0.06 : 0)) * appear);
        ctx.arc(node.x, node.y, coreRadius, 0, Math.PI * 2);
        ctx.fill();
      }

      let labelAlpha = active || hovered ? appear : getLabelAlpha(node, nodeImportance) * appear;
      if (hoveredNode && neighbors.has(node)) {
        labelAlpha = Math.max(labelAlpha, 0.42 * appear);
      }
      if (labelAlpha < 0.16) continue;

      ctx.font = `${Math.max(10, Math.min(13, Math.round(9 + node.radius * 0.12)))}px "Manrope", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = dimmed
        ? `rgba(255, 236, 214, ${0.18 * labelAlpha})`
        : `rgba(255, 242, 229, ${0.82 * labelAlpha})`;
      const label = truncate(node.title, active || hovered ? 30 : 22);
      ctx.fillText(label, node.x, node.y + radius + 8);
    }

    ctx.restore();
  }

  function drawClusterClouds() {
    const grouped = new Map();
    for (const node of visibleNodes) {
      const meta = clusterMeta.get(node.clusterId);
      if (!meta || meta.size < 4) continue;
      if (!grouped.has(node.clusterId)) grouped.set(node.clusterId, []);
      grouped.get(node.clusterId).push(node);
    }

    for (const [clusterId, members] of grouped) {
      const meta = clusterMeta.get(clusterId);
      let centroidX = 0;
      let centroidY = 0;
      let weightTotal = 0;
      for (const member of members) {
        const weight = 1 + Math.sqrt(member.weight + 1) * 0.14;
        centroidX += member.x * weight;
        centroidY += member.y * weight;
        weightTotal += weight;
      }
      centroidX /= Math.max(weightTotal, 1);
      centroidY /= Math.max(weightTotal, 1);

      let extent = 24;
      for (const member of members) {
        const dx = member.x - centroidX;
        const dy = member.y - centroidY;
        extent = Math.max(extent, Math.sqrt(dx * dx + dy * dy) + member.radius * 1.4);
      }

      const color = TYPE_COLORS[meta.dominantType] || '#d37a57';
      const glow = ctx.createRadialGradient(centroidX, centroidY, 0, centroidX, centroidY, extent * 1.55);
      glow.addColorStop(0, hexToRgba(color, 0.042));
      glow.addColorStop(0.55, hexToRgba(color, 0.012));
      glow.addColorStop(1, hexToRgba(color, 0));
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(centroidX, centroidY, extent * 1.55, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawBackgroundGlow() {
    const glowA = ctx.createRadialGradient(width * 0.18, height * 0.18, 0, width * 0.18, height * 0.18, width * 0.36);
    glowA.addColorStop(0, 'rgba(211, 122, 87, 0.035)');
    glowA.addColorStop(1, 'rgba(211, 122, 87, 0)');
    ctx.fillStyle = glowA;
    ctx.fillRect(0, 0, width, height);

    const glowB = ctx.createRadialGradient(width * 0.8, height * 0.72, 0, width * 0.8, height * 0.72, width * 0.32);
    glowB.addColorStop(0, 'rgba(103, 181, 161, 0.035)');
    glowB.addColorStop(1, 'rgba(103, 181, 161, 0)');
    ctx.fillStyle = glowB;
    ctx.fillRect(0, 0, width, height);
  }

  function tick(now) {
    if (!isRunning) return;

    const delta = lastFrameTime ? Math.min(48, now - lastFrameTime) : 16;
    lastFrameTime = now;

    advanceReveal(now);
    const appearing = advanceAppearances(delta);
    const simulating = simulate();
    draw();

    if (shouldAnimate(appearing || simulating)) {
      animFrame = requestAnimationFrame(tick);
      return;
    }

    isRunning = false;
    animFrame = null;
    lastFrameTime = 0;
    if (autoFitPending && !userAdjustedView) {
      autoFitPending = false;
      fitView();
    }
    publishState();
  }

  function start() {
    if (isRunning || !canvas) return;
    if (!shouldAnimate()) {
      draw();
      return;
    }
    isRunning = true;
    lastFrameTime = 0;
    animFrame = requestAnimationFrame(tick);
  }

  function stop(options = {}) {
    isRunning = false;
    if (animFrame) cancelAnimationFrame(animFrame);
    animFrame = null;
    lastFrameTime = 0;
    if (!options.keepState) {
      hoveredNode = null;
      dragNode = null;
      isPanning = false;
      hideTooltip();
    }
  }

  function shouldAnimate(extraSignal = false) {
    return Boolean(
      extraSignal
      || dragNode
      || simulationAlpha >= MIN_ALPHA
      || (progressiveReveal && revealIndex < revealOrder.length)
      || visibleNodes.some(node => node.appear < 1)
    );
  }

  function screenToWorld(sx, sy) {
    return {
      x: (sx - width / 2 - transform.x) / transform.scale,
      y: (sy - height / 2 - transform.y) / transform.scale,
    };
  }

  function findNodeAt(sx, sy) {
    const world = screenToWorld(sx, sy);
    for (let index = visibleNodes.length - 1; index >= 0; index--) {
      const node = visibleNodes[index];
      const dx = node.x - world.x;
      const dy = node.y - world.y;
      const radius = Math.max(node.radius, 10);
      if (dx * dx + dy * dy <= radius * radius) return node;
    }
    return null;
  }

  function fitView() {
    if (!nodes.length) return;
    const bounds = getBounds(nodes);
    const worldPadding = getLayoutTuning().worldPadding;
    const graphWidth = Math.max(bounds.maxX - bounds.minX, 1) + worldPadding * 2;
    const graphHeight = Math.max(bounds.maxY - bounds.minY, 1) + worldPadding * 2;
    const scale = Math.min(width / graphWidth, height / graphHeight, 1.74);
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;
    transform.scale = scale;
    transform.x = -centerX * scale;
    transform.y = -centerY * scale;
    draw();
  }

  function centerOnSlug(slug) {
    ensureNodeVisible(slug);
    const node = nodeBySlug.get(slug);
    if (!node) return;
    const preferredScale = Math.max(transform.scale, 0.78);
    transform.scale = preferredScale;
    transform.x = -node.x * preferredScale;
    transform.y = -node.y * preferredScale;
    activeSlug = slug;
    simulationAlpha = Math.max(simulationAlpha, 0.2);
    draw();
    start();
  }

  function setActiveSlug(slug) {
    activeSlug = slug;
    ensureNodeVisible(slug);
    draw();
    publishState();
  }

  function setProgressiveReveal(enabled) {
    const nextValue = Boolean(enabled);
    if (nextValue === progressiveReveal) return;
    progressiveReveal = nextValue;
    if (!progressiveReveal) {
      revealAllNodes();
      draw();
      start();
      return;
    }
    publishState();
    draw();
  }

  function ensureNodeVisible(slug) {
    if (!slug) return;
    const node = nodeBySlug.get(slug);
    if (!node || node.visible) return;
    placeNodeForReveal(node);
    node.visible = true;
    node.appear = 1;
    visibleNodes.push(node);
    visibleEdgeCount = countVisibleEdges();
    simulationAlpha = Math.max(simulationAlpha, 0.2);
    publishState();
  }

  function reheat() {
    const layout = getLayoutTuning();
    for (const node of visibleNodes) {
      if (node === dragNode) continue;
      const bias = node.slug === activeSlug ? 0.35 : 1;
      node.vx += (Math.random() - 0.5) * layout.reheatJitter * bias;
      node.vy += (Math.random() - 0.5) * layout.reheatJitter * bias;
    }
    simulationAlpha = Math.max(simulationAlpha, 0.45);
    start();
  }

  function setTuning(nextTuning, options = {}) {
    const normalized = normalizeTuning(nextTuning);
    const changed = Object.keys(DEFAULT_TUNING).some(key => Math.abs(normalized[key] - tuning[key]) > 0.0001);
    if (!changed) return false;

    tuning = normalized;
    refreshNodeMetrics();

    if (!nodes.length) return true;

    simulationAlpha = Math.max(simulationAlpha, options.reheat === false ? 0.18 : 0.36);
    if (options.reheat !== false) {
      reheat();
    } else {
      if (options.redraw !== false) draw();
      if (options.publish !== false) publishState();
    }
    return true;
  }

  function refreshNodeMetrics() {
    for (const node of nodes) {
      node.radius = getNodeRadius(
        node.importanceScore || 1,
        node.weight || node.connections || 0,
        node.importance || 0,
      );
    }
  }

  function getBounds(sourceNodes) {
    if (!sourceNodes.length) {
      return { minX: -1, maxX: 1, minY: -1, maxY: 1 };
    }
    const minX = Math.min(...sourceNodes.map(node => node.x - node.radius));
    const maxX = Math.max(...sourceNodes.map(node => node.x + node.radius));
    const minY = Math.min(...sourceNodes.map(node => node.y - node.radius));
    const maxY = Math.max(...sourceNodes.map(node => node.y + node.radius));
    return { minX, maxX, minY, maxY };
  }

  function countVisibleEdges() {
    let count = 0;
    for (const edge of edges) {
      if (edge.source.visible && edge.target.visible) count += 1;
    }
    return count;
  }

  function getState() {
    return {
      totalNodes: nodes.length,
      totalEdges: edges.length,
      visibleNodes: visibleNodes.length,
      visibleEdges: visibleEdgeCount,
      progressiveReveal,
      revealComplete: !progressiveReveal || revealIndex >= revealOrder.length,
    };
  }

  function publishState() {
    if (onStateChange) onStateChange(getState());
  }

  function hideTooltip() {
    const tooltip = document.getElementById('graph-tooltip');
    if (tooltip) tooltip.style.opacity = '0';
  }

  function truncate(text, maxLength) {
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
  }

  function getNodeRadius(importanceScore, weight, importanceNormalized = 0) {
    const radius = 3.4
      + Math.log1p(weight + 1) * 1.05
      + Math.log1p(importanceScore + 1) * 2.15
      + Math.pow(importanceNormalized, 1.18) * 5.4;
    return clamp(radius * tuning.nodeScale, 3.6, 22);
  }

  function getLabelAlpha(node, importance) {
    const labelBias = tuning.labelDensity;
    const zoomAlpha = clamp(Math.log2(Math.max(transform.scale, 0.01)) + lerp(0.78, 1.34, labelBias), 0, 1);
    return clamp(
      zoomAlpha * lerp(0.58, 0.9, labelBias)
      + importance * lerp(0.28, 0.56, labelBias)
      - lerp(0.36, 0.14, labelBias),
      0,
      1,
    );
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function lerp(min, max, amount) {
    return min + (max - min) * amount;
  }

  function getLayoutTuning() {
    const tightness = tuning.clusterTightness;
    return {
      worldPadding: lerp(110, 76, tightness),
      repulsion: lerp(11200, 5400, tightness),
      repulsionDistanceMin: lerp(46, 30, tightness),
      maxRepulsionDistanceSq: lerp(360000, 210000, tightness),
      linkDistance: lerp(108, 62, tightness),
      linkStrength: lerp(0.24, 0.42, tightness),
      centerForce: lerp(0.0012, 0.0026, tightness),
      communityForce: lerp(0.0026, 0.0049, tightness),
      clusterRepulsion: lerp(0.56, 0.88, tightness),
      clusterSpacing: lerp(26, 34, tightness),
      collisionPadding: lerp(8, 3.6, tightness),
      collisionStrength: lerp(0.84, 1.04, tightness),
      velocityDecay: lerp(0.7, 0.6, tightness),
      baseSpreadFloor: lerp(340, 244, tightness),
      baseSpreadScale: lerp(78, 54, tightness),
      innerOrbit: lerp(0.5, 0.3, tightness),
      outerOrbit: lerp(0.5, 0.26, tightness),
      revealOffsetBase: lerp(18, 11, tightness),
      revealOffsetScale: lerp(2.1, 1.55, tightness),
      reheatJitter: lerp(2.9, 1.95, tightness),
    };
  }


  function normalizeTuning(nextTuning = {}) {
    const nodeScale = Number(nextTuning.nodeScale);
    const clusterTightness = Number(nextTuning.clusterTightness);
    const labelDensity = Number(nextTuning.labelDensity);
    const edgeOpacity = Number(nextTuning.edgeOpacity);
    return {
      nodeScale: clamp(Number.isFinite(nodeScale) ? nodeScale : DEFAULT_TUNING.nodeScale, 0.72, 1.9),
      clusterTightness: clamp(Number.isFinite(clusterTightness) ? clusterTightness : DEFAULT_TUNING.clusterTightness, 0, 1),
      labelDensity: clamp(Number.isFinite(labelDensity) ? labelDensity : DEFAULT_TUNING.labelDensity, 0, 1),
      edgeOpacity: clamp(Number.isFinite(edgeOpacity) ? edgeOpacity : DEFAULT_TUNING.edgeOpacity, 0, 1),
    };
  }

  function hexToRgba(hex, alpha) {
    const clean = hex.replace('#', '');
    const value = Number.parseInt(clean, 16);
    const r = (value >> 16) & 255;
    const g = (value >> 8) & 255;
    const b = value & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function mixHex(hexA, hexB, ratio) {
    const blend = clamp(ratio, 0, 1);
    const a = Number.parseInt(hexA.replace('#', ''), 16);
    const b = Number.parseInt(hexB.replace('#', ''), 16);
    const ar = (a >> 16) & 255;
    const ag = (a >> 8) & 255;
    const ab = a & 255;
    const br = (b >> 16) & 255;
    const bg = (b >> 8) & 255;
    const bb = b & 255;
    const r = Math.round(ar + (br - ar) * blend);
    const g = Math.round(ag + (bg - ag) * blend);
    const bMix = Math.round(ab + (bb - ab) * blend);
    return `#${[r, g, bMix].map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
  }

  return {
    init,
    resume,
    destroy,
    start,
    stop,
    resize,
    setActiveSlug,
    setProgressiveReveal,
    getState,
    reheat,
    draw,
    fitView,
    centerOnSlug,
    setTuning,
  };
})();
