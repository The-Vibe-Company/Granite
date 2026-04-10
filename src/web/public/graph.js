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
    clusterSpacing: 0.64,
    localCompactness: 0.5,
    labelDensity: 0.48,
    edgeOpacity: 0.56,
  };

  const APPEAR_DURATION_MS = 220;

  let canvas;
  let ctx;
  let width = 0;
  let height = 0;
  let nodes = [];
  let edges = [];
  let nodeBySlug = new Map();
  let adjacency = new Map();
  let visibleNodes = [];
  let clusterMeta = new Map();
  let transform = { x: 0, y: 0, scale: 1 };
  let hoveredNode = null;
  let dragNode = null;
  let pendingDragNode = null;
  let isPanning = false;
  let panStart = { x: 0, y: 0 };
  let dragDistance = 0;
  let activeSlug = null;
  let onSelect = null;
  let onOpen = null;
  let onStateChange = null;
  let progressiveReveal = true;
  let tuning = { ...DEFAULT_TUNING };
  let revealOrder = [];
  let revealIndex = 0;
  let visibleEdgeCount = 0;
  let lastRevealTime = 0;
  let lastFrameTime = 0;
  let renderFrame = null;
  let renderRunning = false;
  let renderDirty = false;
  let workerAnimating = false;
  let workerSettled = true;
  let worker = null;
  let workerGraphData = null;
  let workerGraphReady = false;
  let resizeObserver = null;
  let eventsBound = false;
  let autoFitPending = false;
  let userAdjustedView = false;
  let pendingPinFrame = null;
  let pendingPinPayload = null;

  function init(canvasEl, graphData, options = {}) {
    stop({ keepState: false });
    attachCanvas(canvasEl);
    applyOptions(options);
    resetGraphState();
    workerGraphData = graphData;
    createWorker();
    bindEvents();
    resize();
    draw();
    publishState();
  }

  function resume(canvasEl, options = {}) {
    attachCanvas(canvasEl);
    applyOptions(options);
    bindEvents();
    resize();
    draw();
    publishState();
  }

  function destroy() {
    stop({ keepState: false });
    terminateWorker();
    resetGraphState();
    nodes = [];
    edges = [];
    nodeBySlug = new Map();
    adjacency = new Map();
    clusterMeta = new Map();
    visibleNodes = [];
    workerGraphData = null;
    workerGraphReady = false;
    transform = { x: 0, y: 0, scale: 1 };
    publishState();
  }

  function resetGraphState() {
    hoveredNode = null;
    dragNode = null;
    pendingDragNode = null;
    isPanning = false;
    dragDistance = 0;
    revealOrder = [];
    revealIndex = 0;
    visibleNodes = [];
    visibleEdgeCount = 0;
    lastRevealTime = 0;
    lastFrameTime = 0;
    workerAnimating = false;
    workerSettled = false;
    autoFitPending = true;
    userAdjustedView = false;
    if (pendingPinFrame) cancelAnimationFrame(pendingPinFrame);
    pendingPinFrame = null;
    pendingPinPayload = null;
  }

  function attachCanvas(canvasEl) {
    canvas = canvasEl;
    ctx = canvas ? canvas.getContext('2d') : null;
  }

  function createWorker() {
    terminateWorker();
    worker = new Worker('/graph-layout-worker.js', { type: 'module' });
    worker.onmessage = handleWorkerMessage;
    worker.postMessage({
      type: 'initGraph',
      graph: workerGraphData,
      tuning,
      activeSlug,
    });
  }

  function terminateWorker() {
    if (!worker) return;
    worker.terminate();
    worker = null;
  }

  function handleWorkerMessage(event) {
    const { type, frame, graph, stats } = event.data || {};

    if (type === 'layoutFrame') {
      if (graph) {
        applyGraphSnapshot(graph);
      }
      if (frame) {
        applyWorkerFrame(frame);
      }
      workerSettled = Boolean(frame?.stats?.settled);
      workerAnimating = !workerSettled;
      renderDirty = true;
      start();
      publishState();
      return;
    }

    if (type === 'settled') {
      workerSettled = true;
      workerAnimating = false;
      renderDirty = true;
      start();
      if (stats) publishState();
    }
  }

  function applyGraphSnapshot(graph) {
    clusterMeta = new Map((graph.clusters || []).map(cluster => [cluster.id, cluster]));
    nodes = (graph.nodes || []).map(node => ({
      ...node,
      visible: !progressiveReveal,
      appear: progressiveReveal ? 0 : 1,
    }));
    edges = (graph.edges || []).map(edge => ({
      ...edge,
      sourceSlug: edge.source,
      targetSlug: edge.target,
      source: null,
      target: null,
    }));
    nodeBySlug = new Map(nodes.map(node => [node.slug, node]));

    for (const edge of edges) {
      edge.source = nodeBySlug.get(edge.sourceSlug);
      edge.target = nodeBySlug.get(edge.targetSlug);
    }

    rebuildAdjacency();
    rebuildRevealOrder();
    visibleNodes = progressiveReveal ? [] : [...nodes];
    revealIndex = 0;
    visibleEdgeCount = progressiveReveal ? 0 : edges.length;
    workerGraphReady = true;

    if (progressiveReveal) {
      primeReveal();
    }
    if (!progressiveReveal) {
      revealAllNodes();
    }
  }

  function applyWorkerFrame(frame) {
    for (const patch of frame.nodes || []) {
      const node = nodeBySlug.get(patch.slug);
      if (!node) continue;
      if (dragNode && dragNode.slug === patch.slug) continue;
      node.x = patch.x;
      node.y = patch.y;
      node.vx = patch.vx;
      node.vy = patch.vy;
      node.radius = patch.radius;
      node.clusterId = patch.clusterId;
      node.isBridge = patch.isBridge;
      node.bridgeClusterIds = patch.bridgeClusterIds;
      node.importance = patch.importance;
      node.weight = patch.weight;
    }

    visibleEdgeCount = countVisibleEdges();
  }

  function rebuildAdjacency() {
    adjacency = new Map(nodes.map(node => [node.slug, new Set()]));
    for (const edge of edges) {
      if (!edge.source || !edge.target) continue;
      adjacency.get(edge.source.slug)?.add(edge.target.slug);
      adjacency.get(edge.target.slug)?.add(edge.source.slug);
    }
  }

  function rebuildRevealOrder() {
    const activeNeighbors = new Set(activeSlug ? adjacency.get(activeSlug) || [] : []);
    revealOrder = [...nodes].sort((left, right) => {
      const priorityDelta = getRevealPriority(right, activeNeighbors) - getRevealPriority(left, activeNeighbors);
      if (priorityDelta !== 0) return priorityDelta;
      return left.title.localeCompare(right.title);
    });
  }

  function getRevealPriority(node, activeNeighbors) {
    let priority = (node.importance || 0) * 320 + (node.connections || 0) * 70 + (node.radius || 0) * 2.2;
    if (node.slug === activeSlug) priority += 100000;
    if (activeNeighbors.has(node.slug)) priority += 50000;
    if (clusterMeta.get(node.clusterId)?.size >= 6) priority += 150;
    if (node.isBridge) priority += 180;
    return priority;
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
      pendingDragNode = node;
      dragDistance = 0;
      return;
    }
    isPanning = true;
    userAdjustedView = true;
    panStart = { x: event.clientX - transform.x, y: event.clientY - transform.y };
    draw();
  }

  function handleMouseMove(event) {
    const { x, y } = getLocalPoint(event);

    if (pendingDragNode && !dragNode) {
      dragDistance += Math.abs(event.movementX) + Math.abs(event.movementY);
      if (dragDistance >= 4) {
        dragNode = pendingDragNode;
        pendingDragNode = null;
        const world = screenToWorld(x, y);
        dragNode.x = world.x;
        dragNode.y = world.y;
        dragNode.vx = 0;
        dragNode.vy = 0;
        postToWorker('pinNode', {
          slug: dragNode.slug,
          x: world.x,
          y: world.y,
        });
        start();
      }
    }

    if (dragNode) {
      const world = screenToWorld(x, y);
      dragNode.x = world.x;
      dragNode.y = world.y;
      dragNode.vx = 0;
      dragNode.vy = 0;
      dragDistance += Math.abs(event.movementX) + Math.abs(event.movementY);
      schedulePinUpdate({
        slug: dragNode.slug,
        x: world.x,
        y: world.y,
      });
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
    if (dragNode) {
      flushPinUpdate();
      postToWorker('releaseNode', { slug: dragNode.slug });
    } else if (pendingDragNode) {
      activeSlug = pendingDragNode.slug;
      if (onSelect) onSelect(pendingDragNode.slug);
    }
    dragNode = null;
    pendingDragNode = null;
    isPanning = false;
    canvas.style.cursor = 'default';
    draw();
    publishState();
  }

  function handleMouseLeave() {
    hoveredNode = null;
    if (dragNode) {
      flushPinUpdate();
      postToWorker('releaseNode', { slug: dragNode.slug });
    }
    dragNode = null;
    pendingDragNode = null;
    isPanning = false;
    hideTooltip();
    draw();
  }

  function handleDoubleClick(event) {
    const { x, y } = getLocalPoint(event);
    const node = findNodeAt(x, y);
    if (!node || !onOpen) return;
    activeSlug = node.slug;
    postToWorker('focusNode', { slug: node.slug });
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

  function start() {
    if (renderRunning || !canvas) return;
    renderRunning = true;
    lastFrameTime = 0;
    renderFrame = requestAnimationFrame(tick);
  }

  function stop(options = {}) {
    renderRunning = false;
    if (renderFrame) cancelAnimationFrame(renderFrame);
    renderFrame = null;
    lastFrameTime = 0;
    if (!options.keepState) {
      hoveredNode = null;
      dragNode = null;
      pendingDragNode = null;
      isPanning = false;
      hideTooltip();
    }
  }

  function tick(now) {
    if (!renderRunning) return;

    const delta = lastFrameTime ? Math.min(48, now - lastFrameTime) : 16;
    lastFrameTime = now;

    const revealChanged = advanceReveal(now);
    const appearanceChanged = advanceAppearances(delta);

    if (renderDirty || revealChanged || appearanceChanged) {
      draw();
      renderDirty = false;
    }

    if (shouldAnimate(revealChanged || appearanceChanged)) {
      renderFrame = requestAnimationFrame(tick);
      return;
    }

    renderRunning = false;
    renderFrame = null;
    lastFrameTime = 0;

    if (autoFitPending && workerSettled && !userAdjustedView) {
      autoFitPending = false;
      fitView();
    }
    publishState();
  }

  function shouldAnimate(extraSignal = false) {
    return Boolean(
      extraSignal
      || workerAnimating
      || dragNode
      || (progressiveReveal && revealIndex < revealOrder.length)
      || visibleNodes.some(node => node.appear < 1),
    );
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

  function primeReveal() {
    if (!nodes.length) return;
    const initialCount = Math.min(nodes.length, Math.max(7, Math.round(Math.sqrt(nodes.length) * 1.6)));
    revealNextBatch(initialCount, { prime: true });
  }

  function revealNextBatch(count, options = {}) {
    let revealed = 0;
    while (revealed < count && revealIndex < revealOrder.length) {
      const node = revealOrder[revealIndex++];
      if (node.visible) continue;
      node.visible = true;
      node.appear = options.prime ? 0.55 : 0;
      visibleNodes.push(node);
      revealed += 1;
    }

    if (revealed > 0) {
      visibleEdgeCount = countVisibleEdges();
      publishState();
      renderDirty = true;
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
    renderDirty = true;
    publishState();
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

  function draw() {
    if (!ctx) return;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#1e1713';
    ctx.fillRect(0, 0, width, height);
    drawBackgroundGlow();

    ctx.save();
    ctx.translate(width / 2 + transform.x, height / 2 + transform.y);
    ctx.scale(transform.scale, transform.scale);

    const clusterClouds = getVisibleClusterClouds();
    drawClusterClouds(clusterClouds);

    const exactEdgeContext = getExactEdgeContext();
    drawEdges(clusterClouds, exactEdgeContext);
    drawNodes(exactEdgeContext.neighbors);

    ctx.restore();
  }

  function getVisibleClusterClouds() {
    const grouped = new Map();
    for (const node of visibleNodes) {
      if (!node.clusterId) continue;
      if (!grouped.has(node.clusterId)) {
        grouped.set(node.clusterId, { x: 0, y: 0, weight: 0, members: [] });
      }
      const group = grouped.get(node.clusterId);
      const weight = node.isBridge ? 0.42 : 1 + Math.sqrt(node.weight + 1) * 0.14 + (node.importance || 0) * 0.9;
      group.x += node.x * weight;
      group.y += node.y * weight;
      group.weight += weight;
      group.members.push(node);
    }

    const clouds = new Map();
    for (const [clusterId, group] of grouped) {
      const meta = clusterMeta.get(clusterId);
      if (!meta || group.members.length < 3) continue;

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
        meta,
      });
    }

    return clouds;
  }

  function drawClusterClouds(clusterClouds) {
    for (const cloud of clusterClouds.values()) {
      const color = TYPE_COLORS[cloud.meta.dominantType] || TYPE_COLORS.note;
      const glow = ctx.createRadialGradient(cloud.x, cloud.y, 0, cloud.x, cloud.y, cloud.extent * 1.6);
      glow.addColorStop(0, hexToRgba(color, 0.042));
      glow.addColorStop(0.55, hexToRgba(color, 0.012));
      glow.addColorStop(1, hexToRgba(color, 0));
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cloud.x, cloud.y, cloud.extent * 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function getExactEdgeContext() {
    const exactEdges = new Set();
    const neighbors = new Set();
    const emphasisNodes = new Set();
    const activeNode = activeSlug ? nodeBySlug.get(activeSlug) : null;

    if (hoveredNode) emphasisNodes.add(hoveredNode);
    if (dragNode) emphasisNodes.add(dragNode);
    if (activeNode) emphasisNodes.add(activeNode);

    if (!emphasisNodes.size) {
      return { exactEdges, neighbors, activeNode };
    }

    for (const edge of edges) {
      if (!edge.source?.visible || !edge.target?.visible) continue;
      const exact = emphasisNodes.has(edge.source) || emphasisNodes.has(edge.target);
      if (!exact) continue;
      const key = `${edge.source.slug}|${edge.target.slug}`;
      exactEdges.add(key);
      neighbors.add(edge.source);
      neighbors.add(edge.target);
    }

    return { exactEdges, neighbors, activeNode };
  }

  function drawEdges(clusterClouds, exactEdgeContext) {
    const bundles = new Map();
    const exactEdges = exactEdgeContext.exactEdges;
    const suppressWeakEdges = !hoveredNode && !dragNode && !exactEdgeContext.activeNode;

    for (const edge of edges) {
      if (!edge.source?.visible || !edge.target?.visible) continue;
      const edgeAlpha = Math.min(edge.source.appear, edge.target.appear);
      if (edgeAlpha <= 0) continue;
      const key = `${edge.source.slug}|${edge.target.slug}`;

      if (exactEdges.has(key) || (edge.intraCluster && edge.structural)) {
        drawExactEdge(edge, edgeAlpha, exactEdges.has(key));
        continue;
      }

      if (edge.intraCluster) continue;
      if (suppressWeakEdges && !edge.structural) continue;
      if (!edge.pairKey) continue;
      if (!bundles.has(edge.pairKey)) {
        bundles.set(edge.pairKey, {
          count: 0,
          edgeAlpha: 0,
          sourceClusterId: edge.source.clusterId,
          targetClusterId: edge.target.clusterId,
          strongestStructuralWeight: 0,
        });
      }
      const bundle = bundles.get(edge.pairKey);
      bundle.count += 1;
      bundle.edgeAlpha = Math.max(bundle.edgeAlpha, edgeAlpha);
      bundle.strongestStructuralWeight = Math.max(bundle.strongestStructuralWeight, edge.structuralWeight || 0);
    }

    for (const bundle of bundles.values()) {
      const sourceCloud = clusterClouds.get(bundle.sourceClusterId);
      const targetCloud = clusterClouds.get(bundle.targetClusterId);
      if (!sourceCloud || !targetCloud) continue;

      const opacityScale = lerp(0.08, 0.22, tuning.edgeOpacity);
      const width = 0.5 + Math.log1p(bundle.count) * 0.36 + Math.min(0.9, bundle.strongestStructuralWeight * 0.12);
      ctx.strokeStyle = `rgba(165, 145, 129, ${Math.min(0.22, opacityScale * bundle.edgeAlpha)})`;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(sourceCloud.x, sourceCloud.y);
      ctx.lineTo(targetCloud.x, targetCloud.y);
      ctx.stroke();
    }
  }

  function drawExactEdge(edge, edgeAlpha, emphasized) {
    const edgeWeight = Math.min(edge.source.weight || 0, edge.target.weight || 0);
    const thickness = emphasized
      ? 1.72
      : 0.34 + Math.min(edgeWeight, 12) * 0.02 + (edge.intraCluster ? 0.18 : 0.04);
    const edgeOpacityScale = lerp(0.14, 2.2, tuning.edgeOpacity);
    const highlightAlpha = Math.min(0.94, 0.56 * edgeAlpha * edgeOpacityScale);
    const baseAlpha = Math.min(
      edge.intraCluster ? 0.52 : 0.18,
      (0.05 + Math.min(edgeWeight, 16) * 0.004)
      * edgeAlpha
      * edgeOpacityScale
      * (edge.intraCluster ? 1.52 : 0.56),
    );
    const edgeColor = edge.intraCluster
      ? mixHex(edge.source.color, edge.target.color, 0.5)
      : '#7d685b';

    ctx.strokeStyle = emphasized
      ? `rgba(255, 236, 214, ${highlightAlpha})`
      : hexToRgba(edgeColor, baseAlpha);
    ctx.lineWidth = thickness;
    ctx.beginPath();
    ctx.moveTo(edge.source.x, edge.source.y);
    ctx.lineTo(edge.target.x, edge.target.y);
    ctx.stroke();
  }

  function drawNodes(neighbors) {
    for (const node of visibleNodes) {
      const active = node.slug === activeSlug;
      const hovered = node === hoveredNode;
      const dimmed = hoveredNode && !neighbors.has(node);
      const appear = node.appear;
      const radius = node.radius * (0.72 + appear * 0.28);
      const nodeImportance = Math.max(
        node.importance || 0,
        Math.min(1, Math.sqrt((node.weight || 0) + 1) / 4.8),
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

      if (node.isBridge) {
        ctx.beginPath();
        ctx.strokeStyle = hexToRgba('#fff4e6', (active ? 0.42 : 0.2) * appear);
        ctx.lineWidth = active ? 1.3 : 0.9;
        ctx.arc(node.x, node.y, radius + 3.2, 0, Math.PI * 2);
        ctx.stroke();
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
    const bounds = getBounds(visibleNodes.length ? visibleNodes : nodes);
    const worldPadding = lerp(120, 86, tuning.clusterSpacing);
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
    postToWorker('focusNode', { slug });
    draw();
  }

  function setActiveSlug(slug) {
    activeSlug = slug;
    rebuildRevealOrder();
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
    node.visible = true;
    node.appear = 1;
    visibleNodes.push(node);
    visibleEdgeCount = countVisibleEdges();
    renderDirty = true;
    publishState();
  }

  function reheat() {
    postToWorker('reheat', {});
    workerAnimating = true;
    start();
  }

  function setTuning(nextTuning, options = {}) {
    const normalized = normalizeTuning(nextTuning);
    const changed = Object.keys(DEFAULT_TUNING).some(key => Math.abs(normalized[key] - tuning[key]) > 0.0001);
    if (!changed) return false;

    const layoutChanged = Math.abs(normalized.nodeScale - tuning.nodeScale) > 0.0001
      || Math.abs(normalized.clusterSpacing - tuning.clusterSpacing) > 0.0001
      || Math.abs(normalized.localCompactness - tuning.localCompactness) > 0.0001;
    tuning = normalized;

    if (layoutChanged) {
      postToWorker('setTuning', { tuning });
      workerAnimating = true;
      start();
    } else if (options.redraw !== false) {
      draw();
    }

    if (options.publish !== false) publishState();
    return true;
  }

  function postToWorker(type, payload) {
    if (!worker) return;
    worker.postMessage({ type, ...payload });
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
      if (edge.source?.visible && edge.target?.visible && edge.structural) count += 1;
    }
    return count;
  }

  function schedulePinUpdate(payload) {
    pendingPinPayload = payload;
    if (pendingPinFrame) return;
    pendingPinFrame = requestAnimationFrame(() => {
      pendingPinFrame = null;
      if (!pendingPinPayload) return;
      postToWorker('pinNode', pendingPinPayload);
      pendingPinPayload = null;
    });
  }

  function flushPinUpdate() {
    if (pendingPinFrame) {
      cancelAnimationFrame(pendingPinFrame);
      pendingPinFrame = null;
    }
    if (pendingPinPayload) {
      postToWorker('pinNode', pendingPinPayload);
      pendingPinPayload = null;
    }
  }

  function getState() {
    return {
      totalNodes: nodes.length,
      totalEdges: edges.length,
      visibleNodes: visibleNodes.length,
      visibleEdges: visibleEdgeCount,
      progressiveReveal,
      revealComplete: !progressiveReveal || revealIndex >= revealOrder.length,
      settled: workerSettled,
      graphReady: workerGraphReady,
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

  function normalizeTuning(nextTuning = {}) {
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

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function lerp(min, max, amount) {
    return min + (max - min) * amount;
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
