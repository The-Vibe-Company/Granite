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

  const WORLD_PADDING = 120;
  const REPULSION = 6000;
  const ATTRACTION = 0.0035;
  const GRAVITY = 0.0035;
  const DAMPING = 0.88;
  const MIN_ALPHA = 0.001;
  const VELOCITY_LIMIT = 10;

  let canvas;
  let ctx;
  let width = 0;
  let height = 0;
  let nodes = [];
  let edges = [];
  let transform = { x: 0, y: 0, scale: 1 };
  let hoveredNode = null;
  let dragNode = null;
  let isPanning = false;
  let panStart = { x: 0, y: 0 };
  let dragDistance = 0;
  let activeSlug = null;
  let onNavigate = null;
  let animFrame = null;
  let isRunning = false;
  let simulationAlpha = 1;
  let resizeObserver = null;
  let eventsBound = false;

  function init(canvasEl, graphData, options = {}) {
    canvas = canvasEl;
    ctx = canvas.getContext('2d');
    onNavigate = options.onNavigate || null;
    activeSlug = options.activeSlug || null;

    const connectionCount = {};
    for (const edge of graphData.edges) {
      connectionCount[edge.source] = (connectionCount[edge.source] || 0) + 1;
      connectionCount[edge.target] = (connectionCount[edge.target] || 0) + 1;
    }

    const maxConnections = Math.max(1, ...Object.values(connectionCount));
    const baseSpread = Math.max(460, graphData.nodes.length * 26);

    nodes = graphData.nodes.map((node, index) => {
      const connections = connectionCount[node.slug] || 0;
      const ratio = connections / maxConnections;
      const angle = (index / Math.max(graphData.nodes.length, 1)) * Math.PI * 2;
      const variance = 0.4 + Math.random() * 0.78;
      return {
        ...node,
        x: Math.cos(angle) * baseSpread * variance,
        y: Math.sin(angle) * baseSpread * variance,
        vx: 0,
        vy: 0,
        radius: Math.max(4, Math.round(5 + ratio * 24)),
        connections,
        color: TYPE_COLORS[node.type] || '#d37a57',
      };
    });

    const nodeMap = Object.fromEntries(nodes.map(node => [node.slug, node]));
    edges = graphData.edges
      .filter(edge => nodeMap[edge.source] && nodeMap[edge.target])
      .map(edge => ({
        source: nodeMap[edge.source],
        target: nodeMap[edge.target],
      }));

    resize();
    bindEvents();
    fitView();
    simulationAlpha = 1;
    start();
  }

  function bindEvents() {
    if (eventsBound || !canvas) return;
    eventsBound = true;

    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('mouseleave', handleMouseLeave);
    canvas.addEventListener('wheel', handleWheel, { passive: false });

    resizeObserver = new ResizeObserver(() => {
      resize();
      draw();
    });
    resizeObserver.observe(canvas.parentElement);
  }

  function resize() {
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
      return;
    }
    isPanning = true;
    panStart = { x: event.clientX - transform.x, y: event.clientY - transform.y };
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
      return;
    }

    if (isPanning) {
      transform.x = event.clientX - panStart.x;
      transform.y = event.clientY - panStart.y;
      return;
    }

    const node = findNodeAt(x, y);
    hoveredNode = node;
    canvas.style.cursor = node ? 'pointer' : 'default';

    const tooltip = document.getElementById('graph-tooltip');
    if (!node) {
      tooltip.style.opacity = '0';
      return;
    }

    tooltip.textContent = node.title;
    tooltip.style.left = `${event.clientX + 14}px`;
    tooltip.style.top = `${event.clientY - 8}px`;
    tooltip.style.opacity = '1';
  }

  function handleMouseUp() {
    if (dragNode && dragDistance < 5 && onNavigate) {
      onNavigate(dragNode.slug);
    }
    dragNode = null;
    isPanning = false;
    canvas.style.cursor = 'default';
  }

  function handleMouseLeave() {
    hoveredNode = null;
    dragNode = null;
    isPanning = false;
    document.getElementById('graph-tooltip').style.opacity = '0';
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
  }

  function getLocalPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function simulate() {
    if (simulationAlpha < MIN_ALPHA) return;

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const distance = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = (REPULSION * (a.radius + b.radius) * 0.15) / (distance * distance) * simulationAlpha;
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }

    for (const edge of edges) {
      const dx = edge.target.x - edge.source.x;
      const dy = edge.target.y - edge.source.y;
      const distance = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = distance * ATTRACTION * simulationAlpha;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      edge.source.vx += fx;
      edge.source.vy += fy;
      edge.target.vx -= fx;
      edge.target.vy -= fy;
    }

    for (const node of nodes) {
      node.vx -= node.x * GRAVITY * simulationAlpha;
      node.vy -= node.y * GRAVITY * simulationAlpha;
    }

    for (const node of nodes) {
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

    simulationAlpha *= 0.993;
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
        if (edge.source === hoveredNode) neighbors.add(edge.target);
        if (edge.target === hoveredNode) neighbors.add(edge.source);
      }
      neighbors.add(hoveredNode);
    }

    for (const edge of edges) {
      const highlighted = hoveredNode && (edge.source === hoveredNode || edge.target === hoveredNode);
      ctx.strokeStyle = highlighted ? 'rgba(255, 236, 214, 0.5)' : 'rgba(255, 224, 198, 0.08)';
      ctx.lineWidth = highlighted ? 1.6 : 0.7;
      ctx.beginPath();
      ctx.moveTo(edge.source.x, edge.source.y);
      ctx.lineTo(edge.target.x, edge.target.y);
      ctx.stroke();
    }

    for (const node of nodes) {
      const dimmed = hoveredNode && !neighbors.has(node);
      const active = node.slug === activeSlug;
      const hovered = node === hoveredNode;

      if (active || hovered) {
        const glow = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, node.radius * 5);
        glow.addColorStop(0, active ? 'rgba(211, 122, 87, 0.28)' : 'rgba(255, 244, 232, 0.16)');
        glow.addColorStop(1, 'rgba(255, 244, 232, 0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius * 5, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.beginPath();
      ctx.fillStyle = dimmed ? 'rgba(255, 241, 226, 0.12)' : `${hexToRgba(node.color, hovered ? 0.95 : 0.82)}`;
      ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = active ? 'rgba(255, 243, 229, 0.85)' : `${hexToRgba(node.color, 0.42)}`;
      ctx.lineWidth = active ? 2.2 : 1;
      ctx.stroke();

      const showLabel = active || hovered || node.connections >= 6 || (hoveredNode && neighbors.has(node) && node.connections >= 2);
      if (!showLabel) continue;

      ctx.font = `${Math.max(10, Math.min(13, Math.round(9 + node.radius * 0.12)))}px "Manrope", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = dimmed ? 'rgba(255, 236, 214, 0.16)' : 'rgba(255, 242, 229, 0.76)';
      const label = truncate(node.title, active || hovered ? 30 : 22);
      ctx.fillText(label, node.x, node.y + node.radius + 8);
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

  function tick() {
    simulate();
    draw();
    if (isRunning) animFrame = requestAnimationFrame(tick);
  }

  function start() {
    if (isRunning) return;
    isRunning = true;
    tick();
  }

  function stop() {
    isRunning = false;
    if (animFrame) cancelAnimationFrame(animFrame);
  }

  function screenToWorld(sx, sy) {
    return {
      x: (sx - width / 2 - transform.x) / transform.scale,
      y: (sy - height / 2 - transform.y) / transform.scale,
    };
  }

  function findNodeAt(sx, sy) {
    const world = screenToWorld(sx, sy);
    for (let index = nodes.length - 1; index >= 0; index--) {
      const node = nodes[index];
      const dx = node.x - world.x;
      const dy = node.y - world.y;
      const radius = Math.max(node.radius, 10);
      if (dx * dx + dy * dy <= radius * radius) return node;
    }
    return null;
  }

  function fitView() {
    if (!nodes.length) return;
    const bounds = getBounds();
    const graphWidth = Math.max(bounds.maxX - bounds.minX, 1) + WORLD_PADDING * 2;
    const graphHeight = Math.max(bounds.maxY - bounds.minY, 1) + WORLD_PADDING * 2;
    const scale = Math.min(width / graphWidth, height / graphHeight, 1.6);
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;
    transform.scale = scale;
    transform.x = -centerX * scale - width * 0.07;
    transform.y = -centerY * scale;
    draw();
  }

  function centerOnSlug(slug) {
    const node = nodes.find(candidate => candidate.slug === slug);
    if (!node) return;
    const preferredScale = Math.max(transform.scale, 0.78);
    transform.scale = preferredScale;
    transform.x = -node.x * preferredScale;
    transform.y = -node.y * preferredScale;
    activeSlug = slug;
    draw();
  }

  function setActiveSlug(slug) {
    activeSlug = slug;
    draw();
  }

  function reheat() {
    simulationAlpha = 0.45;
    if (!isRunning) start();
  }

  function getBounds() {
    const minX = Math.min(...nodes.map(node => node.x - node.radius));
    const maxX = Math.max(...nodes.map(node => node.x + node.radius));
    const minY = Math.min(...nodes.map(node => node.y - node.radius));
    const maxY = Math.max(...nodes.map(node => node.y + node.radius));
    return { minX, maxX, minY, maxY };
  }

  function truncate(text, maxLength) {
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
  }

  function hexToRgba(hex, alpha) {
    const clean = hex.replace('#', '');
    const value = Number.parseInt(clean, 16);
    const r = (value >> 16) & 255;
    const g = (value >> 8) & 255;
    const b = value & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  return { init, start, stop, resize, setActiveSlug, reheat, draw, fitView, centerOnSlug };
})();
