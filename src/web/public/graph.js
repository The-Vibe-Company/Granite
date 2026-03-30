/**
 * Granite — Force-Directed Graph Visualization
 *
 * Interactive canvas graph showing note connections.
 * Physics: repulsion between all nodes, attraction along edges, gravity to center.
 * Interactions: drag, zoom, pan, click-to-navigate, hover highlight.
 */

const GraphEngine = (() => {

  // ── Type colors ──
  const TYPE_COLORS = {
    fleeting:   { fill: '#fbbf24', glow: 'rgba(251, 191, 36, 0.3)' },
    permanent:  { fill: '#a5b4fc', glow: 'rgba(165, 180, 252, 0.3)' },
    reference:  { fill: '#34d399', glow: 'rgba(52, 211, 153, 0.3)' },
    person:     { fill: '#f9a8d4', glow: 'rgba(249, 168, 212, 0.3)' },
    meeting:    { fill: '#93c5fd', glow: 'rgba(147, 197, 253, 0.3)' },
    project:    { fill: '#c4b5fd', glow: 'rgba(196, 181, 253, 0.3)' },
    decision:   { fill: '#fca5a5', glow: 'rgba(252, 165, 165, 0.3)' },
    _default:   { fill: '#6e6e7a', glow: 'rgba(110, 110, 122, 0.3)' },
  };

  const BG_COLOR = '#08080a';
  const EDGE_COLOR = 'rgba(70, 70, 85, 0.35)';
  const EDGE_HIGHLIGHT = 'rgba(165, 180, 252, 0.6)';
  const LABEL_COLOR = '#b0b0b8';
  const LABEL_DIM = 'rgba(110, 110, 122, 0.3)';
  const LABEL_FONT = '11px "Instrument Sans", sans-serif';
  const NODE_ACTIVE_RING = '#6366f1';

  // ── State ──
  let canvas, ctx;
  let nodes = [], edges = [];
  let width, height;
  let transform = { x: 0, y: 0, scale: 1 };
  let animFrame = null;
  let hoveredNode = null;
  let dragNode = null;
  let isPanning = false;
  let panStart = { x: 0, y: 0 };
  let activeSlug = null;
  let onNavigate = null;
  let isRunning = false;
  let simulationAlpha = 1;

  // ── Physics constants ──
  const REPULSION = 800;
  const ATTRACTION = 0.008;
  const GRAVITY = 0.02;
  const DAMPING = 0.88;
  const MIN_ALPHA = 0.001;
  const VELOCITY_LIMIT = 8;

  function getTypeColor(type) {
    return TYPE_COLORS[type] || TYPE_COLORS._default;
  }

  function init(canvasEl, graphData, options = {}) {
    canvas = canvasEl;
    ctx = canvas.getContext('2d');
    onNavigate = options.onNavigate || null;
    activeSlug = options.activeSlug || null;

    // Build nodes
    const connectionCount = {};
    for (const e of graphData.edges) {
      connectionCount[e.source] = (connectionCount[e.source] || 0) + 1;
      connectionCount[e.target] = (connectionCount[e.target] || 0) + 1;
    }

    nodes = graphData.nodes.map((n, i) => {
      const connections = connectionCount[n.slug] || 0;
      const angle = (i / graphData.nodes.length) * Math.PI * 2;
      const spread = Math.min(300, graphData.nodes.length * 15);
      return {
        ...n,
        x: Math.cos(angle) * spread * (0.5 + Math.random() * 0.5),
        y: Math.sin(angle) * spread * (0.5 + Math.random() * 0.5),
        vx: 0, vy: 0,
        radius: Math.max(4, Math.min(14, 4 + connections * 1.5)),
        connections,
      };
    });

    // Build edge references
    const nodeMap = {};
    nodes.forEach(n => nodeMap[n.slug] = n);
    edges = graphData.edges
      .filter(e => nodeMap[e.source] && nodeMap[e.target])
      .map(e => ({ source: nodeMap[e.source], target: nodeMap[e.target] }));

    // Reset
    transform = { x: 0, y: 0, scale: 1 };
    simulationAlpha = 1;

    resize();
    setupEvents();
    start();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const container = canvas.parentElement;
    width = container.clientWidth;
    height = container.clientHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ── Physics simulation ──
  function simulate() {
    if (simulationAlpha < MIN_ALPHA) return;

    // Repulsion (all pairs)
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = REPULSION / (dist * dist) * simulationAlpha;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx -= fx; a.vy -= fy;
        b.vx += fx; b.vy += fy;
      }
    }

    // Attraction (edges)
    for (const edge of edges) {
      const dx = edge.target.x - edge.source.x;
      const dy = edge.target.y - edge.source.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = dist * ATTRACTION * simulationAlpha;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      edge.source.vx += fx; edge.source.vy += fy;
      edge.target.vx -= fx; edge.target.vy -= fy;
    }

    // Gravity toward center
    for (const node of nodes) {
      node.vx -= node.x * GRAVITY * simulationAlpha;
      node.vy -= node.y * GRAVITY * simulationAlpha;
    }

    // Integrate
    for (const node of nodes) {
      if (node === dragNode) continue;
      node.vx *= DAMPING;
      node.vy *= DAMPING;
      // Clamp velocity
      const speed = Math.sqrt(node.vx * node.vx + node.vy * node.vy);
      if (speed > VELOCITY_LIMIT) {
        node.vx = (node.vx / speed) * VELOCITY_LIMIT;
        node.vy = (node.vy / speed) * VELOCITY_LIMIT;
      }
      node.x += node.vx;
      node.y += node.vy;
    }

    simulationAlpha *= 0.995;
  }

  // ── Render ──
  function draw() {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.translate(width / 2 + transform.x, height / 2 + transform.y);
    ctx.scale(transform.scale, transform.scale);

    const hoveredNeighbors = new Set();
    if (hoveredNode) {
      for (const e of edges) {
        if (e.source === hoveredNode) hoveredNeighbors.add(e.target);
        if (e.target === hoveredNode) hoveredNeighbors.add(e.source);
      }
      hoveredNeighbors.add(hoveredNode);
    }

    const dimming = hoveredNode !== null;

    // Draw edges
    for (const edge of edges) {
      const isHighlighted = hoveredNode && (edge.source === hoveredNode || edge.target === hoveredNode);
      ctx.strokeStyle = isHighlighted ? EDGE_HIGHLIGHT : (dimming ? 'rgba(50, 50, 60, 0.15)' : EDGE_COLOR);
      ctx.lineWidth = isHighlighted ? 1.5 : 0.75;
      ctx.beginPath();
      ctx.moveTo(edge.source.x, edge.source.y);
      ctx.lineTo(edge.target.x, edge.target.y);
      ctx.stroke();
    }

    // Draw nodes
    for (const node of nodes) {
      const colors = getTypeColor(node.type);
      const isNeighbor = hoveredNeighbors.has(node);
      const isDimmed = dimming && !isNeighbor;
      const isActive = node.slug === activeSlug;

      // Glow for hovered/active
      if ((node === hoveredNode || isActive) && !isDimmed) {
        ctx.fillStyle = colors.glow;
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius + 6, 0, Math.PI * 2);
        ctx.fill();
      }

      // Active ring
      if (isActive) {
        ctx.strokeStyle = NODE_ACTIVE_RING;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius + 3, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Node circle
      ctx.globalAlpha = isDimmed ? 0.15 : 1;
      ctx.fillStyle = colors.fill;
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      ctx.fill();

      // Label
      ctx.font = LABEL_FONT;
      ctx.fillStyle = isDimmed ? LABEL_DIM : LABEL_COLOR;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const label = node.title.length > 24 ? node.title.slice(0, 22) + '…' : node.title;
      ctx.fillText(label, node.x, node.y + node.radius + 5);
      ctx.globalAlpha = 1;
    }

    ctx.restore();
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

  // ── Coordinate transforms ──
  function screenToWorld(sx, sy) {
    return {
      x: (sx - width / 2 - transform.x) / transform.scale,
      y: (sy - height / 2 - transform.y) / transform.scale,
    };
  }

  function findNodeAt(sx, sy) {
    const { x, y } = screenToWorld(sx, sy);
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const dx = n.x - x, dy = n.y - y;
      if (dx * dx + dy * dy < (n.radius + 4) * (n.radius + 4)) return n;
    }
    return null;
  }

  // ── Events ──
  function setupEvents() {
    canvas.addEventListener('mousedown', (e) => {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      const node = findNodeAt(sx, sy);
      if (node) {
        dragNode = node;
        dragNode.vx = 0;
        dragNode.vy = 0;
        simulationAlpha = Math.max(simulationAlpha, 0.3);
      } else {
        isPanning = true;
        panStart = { x: e.clientX - transform.x, y: e.clientY - transform.y };
      }
    });

    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;

      if (dragNode) {
        const { x, y } = screenToWorld(sx, sy);
        dragNode.x = x;
        dragNode.y = y;
        simulationAlpha = Math.max(simulationAlpha, 0.1);
      } else if (isPanning) {
        transform.x = e.clientX - panStart.x;
        transform.y = e.clientY - panStart.y;
      } else {
        const node = findNodeAt(sx, sy);
        if (node !== hoveredNode) {
          hoveredNode = node;
          canvas.style.cursor = node ? 'pointer' : 'grab';
          // Show tooltip
          const tooltip = document.getElementById('graph-tooltip');
          if (node) {
            tooltip.textContent = node.title;
            tooltip.style.left = (e.clientX + 12) + 'px';
            tooltip.style.top = (e.clientY - 8) + 'px';
            tooltip.style.opacity = '1';
          } else {
            tooltip.style.opacity = '0';
          }
        } else if (node) {
          const tooltip = document.getElementById('graph-tooltip');
          tooltip.style.left = (e.clientX + 12) + 'px';
          tooltip.style.top = (e.clientY - 8) + 'px';
        }
      }
    });

    canvas.addEventListener('mouseup', (e) => {
      if (dragNode) {
        // If barely moved, treat as click
        const rect = canvas.getBoundingClientRect();
        const node = findNodeAt(e.clientX - rect.left, e.clientY - rect.top);
        if (node && node === dragNode && onNavigate) {
          onNavigate(node.slug);
        }
        dragNode = null;
      }
      isPanning = false;
    });

    canvas.addEventListener('mouseleave', () => {
      hoveredNode = null;
      isPanning = false;
      dragNode = null;
      document.getElementById('graph-tooltip').style.opacity = '0';
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const scaleFactor = e.deltaY > 0 ? 0.92 : 1.08;
      const newScale = Math.max(0.1, Math.min(5, transform.scale * scaleFactor));

      // Zoom toward cursor
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left - width / 2;
      const my = e.clientY - rect.top - height / 2;
      transform.x = mx - (mx - transform.x) * (newScale / transform.scale);
      transform.y = my - (my - transform.y) * (newScale / transform.scale);
      transform.scale = newScale;
    }, { passive: false });

    // Resize observer
    const ro = new ResizeObserver(() => { resize(); });
    ro.observe(canvas.parentElement);
  }

  function setActiveSlug(slug) {
    activeSlug = slug;
  }

  function reheat() {
    simulationAlpha = 0.5;
    if (!isRunning) start();
  }

  return { init, start, stop, resize, setActiveSlug, reheat, draw };
})();
