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

  const WORLD_PADDING = 110;
  const REPULSION = 3600;
  const MAX_REPULSION_DISTANCE_SQ = 190000;
  const LINK_DISTANCE = 74;
  const LINK_STRENGTH = 0.0082;
  const CENTER_FORCE = 0.0024;
  const COLLISION_PADDING = 6;
  const DAMPING = 0.9;
  const MIN_ALPHA = 0.0015;
  const VELOCITY_LIMIT = 10;
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

  function init(canvasEl, graphData, options = {}) {
    stop({ keepState: false });
    attachCanvas(canvasEl);
    applyOptions(options);
    buildGraph(graphData);
    bindEvents();
    resize();
    fitView();
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
    visibleNodes = [];
    revealOrder = [];
    revealIndex = 0;
    visibleEdgeCount = 0;
    transform = { x: 0, y: 0, scale: 1 };
    activeSlug = null;
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
    for (const edge of graphData.edges) {
      connectionCount[edge.source] = (connectionCount[edge.source] || 0) + 1;
      connectionCount[edge.target] = (connectionCount[edge.target] || 0) + 1;
    }

    const maxConnections = Math.max(1, ...Object.values(connectionCount));
    const rankedNodes = [...graphData.nodes].sort((a, b) => {
      const connectionDelta = (connectionCount[b.slug] || 0) - (connectionCount[a.slug] || 0);
      if (connectionDelta !== 0) return connectionDelta;
      return a.title.localeCompare(b.title);
    });
    const baseSpread = Math.max(300, Math.sqrt(Math.max(rankedNodes.length, 1)) * 72);

    nodes = rankedNodes.map((node, index) => {
      const connections = connectionCount[node.slug] || 0;
      const ratio = connections / maxConnections;
      const orbit = Math.sqrt(index + 1) / Math.sqrt(Math.max(rankedNodes.length, 1));
      const distance = orbit * baseSpread * (0.42 + (1 - ratio) * 0.46);
      const angle = index * Math.PI * (3 - Math.sqrt(5));
      const radius = getNodeRadius(connections);
      return {
        ...node,
        x: Math.cos(angle) * distance,
        y: Math.sin(angle) * distance * (0.92 + Math.random() * 0.12),
        vx: 0,
        vy: 0,
        radius,
        connections,
        weight: connections,
        color: TYPE_COLORS[node.type] || '#d37a57',
        visible: !progressiveReveal,
        appear: progressiveReveal ? 0 : 1,
      };
    });

    nodeBySlug = new Map(nodes.map(node => [node.slug, node]));
    adjacency = new Map(nodes.map(node => [node.slug, new Set()]));
    edges = graphData.edges
      .filter(edge => nodeBySlug.get(edge.source) && nodeBySlug.get(edge.target))
      .map(edge => {
        adjacency.get(edge.source).add(edge.target);
        adjacency.get(edge.target).add(edge.source);
        return {
          source: nodeBySlug.get(edge.source),
          target: nodeBySlug.get(edge.target),
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
    let priority = node.connections * 100 + node.radius;
    if (node.slug === activeSlug) priority += 100000;
    if (activeNeighbors.has(node.slug)) priority += 50000;
    return priority;
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
      const offset = 16 + node.radius * 1.85;
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

    for (let i = 0; i < simulationNodes.length; i++) {
      for (let j = i + 1; j < simulationNodes.length; j++) {
        const a = simulationNodes[i];
        const b = simulationNodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distanceSq = dx * dx + dy * dy || 1;
        if (distanceSq > MAX_REPULSION_DISTANCE_SQ) continue;
        const distance = Math.sqrt(distanceSq) || 1;
        const weightFactor = 0.72 + Math.sqrt(a.weight + b.weight + 2) * 0.12;
        const force = (REPULSION * weightFactor) / distanceSq * simulationAlpha;
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;

        const minDistance = a.radius + b.radius + COLLISION_PADDING;
        if (distance < minDistance) {
          const push = (minDistance - distance) * 0.05 * simulationAlpha;
          const px = (dx / distance) * push;
          const py = (dy / distance) * push;
          a.vx -= px;
          a.vy -= py;
          b.vx += px;
          b.vy += py;
        }
      }
    }

    for (const edge of edges) {
      if (!edge.source.visible || !edge.target.visible) continue;
      const dx = edge.target.x - edge.source.x;
      const dy = edge.target.y - edge.source.y;
      const distance = Math.sqrt(dx * dx + dy * dy) || 1;
      const desiredDistance = LINK_DISTANCE + (edge.source.radius + edge.target.radius) * 0.9;
      const force = (distance - desiredDistance) * LINK_STRENGTH * simulationAlpha;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      edge.source.vx += fx;
      edge.source.vy += fy;
      edge.target.vx -= fx;
      edge.target.vy -= fy;
    }

    for (const node of simulationNodes) {
      const anchorBias = node.slug === activeSlug ? 1.1 : 0.9 + Math.min(node.connections, 18) * 0.012;
      node.vx -= node.x * CENTER_FORCE * anchorBias * simulationAlpha;
      node.vy -= node.y * CENTER_FORCE * anchorBias * simulationAlpha;
    }

    for (const node of simulationNodes) {
      if (node === dragNode) continue;
      node.vx *= DAMPING;
      node.vy *= DAMPING;
      const speed = Math.sqrt(node.vx * node.vx + node.vy * node.vy);
      if (speed > VELOCITY_LIMIT) {
        node.vx = (node.vx / speed) * VELOCITY_LIMIT;
        node.vy = (node.vy / speed) * VELOCITY_LIMIT;
      }
      node.x += node.vx;
      node.y += node.vy;
    }

    simulationAlpha *= dragNode ? 0.995 : 0.986;
    if (simulationAlpha < MIN_ALPHA) simulationAlpha = 0;
    return simulationAlpha > 0;
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
      const thickness = highlighted ? 1.5 : 0.5 + Math.min(edgeWeight, 12) * 0.025;
      ctx.strokeStyle = highlighted
        ? `rgba(255, 236, 214, ${0.52 * edgeAlpha})`
        : `rgba(255, 224, 198, ${(0.06 + Math.min(edgeWeight, 16) * 0.004) * edgeAlpha})`;
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
      const nodeImportance = Math.min(1, Math.sqrt(node.weight + 1) / 4.4);
      const tint = mixHex(node.color, '#fff7ee', active ? 0.34 : hovered ? 0.22 : 0.14);

      if (active || hovered || appear < 1) {
        const glowRadius = radius * (appear < 1 ? 6.2 - appear * 2.2 : 5);
        const glow = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, glowRadius);
        if (appear < 1) {
          glow.addColorStop(0, `${hexToRgba(node.color, 0.18 + (1 - appear) * 0.22)}`);
          glow.addColorStop(1, `${hexToRgba(node.color, 0)}`);
        } else {
          glow.addColorStop(0, active ? 'rgba(211, 122, 87, 0.28)' : 'rgba(255, 244, 232, 0.16)');
          glow.addColorStop(1, 'rgba(255, 244, 232, 0)');
        }
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(node.x, node.y, glowRadius, 0, Math.PI * 2);
        ctx.fill();
      }

      const fill = ctx.createRadialGradient(
        node.x - radius * 0.22,
        node.y - radius * 0.28,
        radius * 0.2,
        node.x,
        node.y,
        radius * 1.12,
      );
      fill.addColorStop(0, hexToRgba(tint, (0.95 - nodeImportance * 0.12) * appear));
      fill.addColorStop(1, dimmed
        ? `rgba(255, 241, 226, ${0.1 * appear})`
        : hexToRgba(node.color, (0.8 + nodeImportance * 0.08) * appear));

      ctx.beginPath();
      ctx.fillStyle = fill;
      ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.fillStyle = dimmed
        ? `rgba(255, 244, 236, ${0.08 * appear})`
        : `rgba(255, 247, 238, ${(0.14 + nodeImportance * 0.12 + (hovered ? 0.08 : 0)) * appear})`;
      ctx.arc(node.x - radius * 0.18, node.y - radius * 0.22, radius * 0.42, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = active
        ? `rgba(255, 243, 229, ${0.9 * appear})`
        : hexToRgba(node.color, (appear < 1 ? 0.58 : 0.42) * appear);
      ctx.lineWidth = active ? 2.2 : 1;
      ctx.stroke();

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

  function drawBackgroundGlow() {
    const glowA = ctx.createRadialGradient(width * 0.18, height * 0.18, 0, width * 0.18, height * 0.18, width * 0.36);
    glowA.addColorStop(0, 'rgba(211, 122, 87, 0.05)');
    glowA.addColorStop(1, 'rgba(211, 122, 87, 0)');
    ctx.fillStyle = glowA;
    ctx.fillRect(0, 0, width, height);

    const glowB = ctx.createRadialGradient(width * 0.8, height * 0.72, 0, width * 0.8, height * 0.72, width * 0.32);
    glowB.addColorStop(0, 'rgba(103, 181, 161, 0.05)');
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
    const graphWidth = Math.max(bounds.maxX - bounds.minX, 1) + WORLD_PADDING * 2;
    const graphHeight = Math.max(bounds.maxY - bounds.minY, 1) + WORLD_PADDING * 2;
    const scale = Math.min(width / graphWidth, height / graphHeight, 1.6);
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
    for (const node of visibleNodes) {
      if (node === dragNode) continue;
      const bias = node.slug === activeSlug ? 0.35 : 1;
      node.vx += (Math.random() - 0.5) * 2.4 * bias;
      node.vy += (Math.random() - 0.5) * 2.4 * bias;
    }
    simulationAlpha = Math.max(simulationAlpha, 0.45);
    start();
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

  function getNodeRadius(weight) {
    return Math.max(4.8, Math.min(2.45 * Math.sqrt(weight + 1), 14));
  }

  function getLabelAlpha(node, importance) {
    const zoomAlpha = clamp(Math.log2(Math.max(transform.scale, 0.01)) + 1.02, 0, 1);
    return clamp(zoomAlpha * 0.74 + importance * 0.46 - 0.24, 0, 1);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
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
  };
})();
