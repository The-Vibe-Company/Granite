/**
 * Granite — Force-Directed Graph Visualization
 *
 * Monochrome, organic, spread-out layout inspired by knowledge graph explorers.
 * Hub nodes are large, leaf nodes are tiny. Labels are clean and readable.
 */

const GraphEngine = (() => {

  // ── Visual constants ──
  const BG_COLOR = '#1a1a1e';
  const NODE_COLOR = 'rgba(200, 200, 210, 0.9)';
  const NODE_COLOR_DIM = 'rgba(200, 200, 210, 0.12)';
  const NODE_HOVER_COLOR = '#ffffff';
  const EDGE_COLOR = 'rgba(100, 100, 115, 0.18)';
  const EDGE_HOVER_COLOR = 'rgba(180, 180, 200, 0.45)';
  const LABEL_COLOR = 'rgba(190, 190, 200, 0.75)';
  const LABEL_HOVER_COLOR = '#ffffff';
  const LABEL_DIM = 'rgba(190, 190, 200, 0.08)';
  const ACTIVE_RING_COLOR = 'rgba(255, 255, 255, 0.6)';

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
  let dragStartPos = { x: 0, y: 0 };
  let dragDistance = 0;
  let activeSlug = null;
  let onNavigate = null;
  let isRunning = false;
  let simulationAlpha = 1;

  // ── Physics — spread out, organic layout ──
  const REPULSION = 5000;
  const ATTRACTION = 0.003;
  const GRAVITY = 0.004;
  const DAMPING = 0.85;
  const MIN_ALPHA = 0.001;
  const VELOCITY_LIMIT = 10;

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

    // Find max connections for relative sizing
    const maxCx = Math.max(1, ...Object.values(connectionCount));

    nodes = graphData.nodes.map((n, i) => {
      const connections = connectionCount[n.slug] || 0;
      const ratio = connections / maxCx;
      const angle = (i / graphData.nodes.length) * Math.PI * 2;
      const spread = Math.max(400, graphData.nodes.length * 30);
      return {
        ...n,
        x: Math.cos(angle) * spread * (0.3 + Math.random() * 0.7),
        y: Math.sin(angle) * spread * (0.3 + Math.random() * 0.7),
        vx: 0, vy: 0,
        // Dramatic size range: leaf=3, hub=28
        radius: Math.max(3, Math.round(3 + ratio * 25)),
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
        // Stronger repulsion for big nodes
        const sizeFactor = (a.radius + b.radius) * 0.15;
        const force = (REPULSION * sizeFactor) / (dist * dist) * simulationAlpha;
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

    // Very weak gravity — let nodes spread to edges
    for (const node of nodes) {
      node.vx -= node.x * GRAVITY * simulationAlpha;
      node.vy -= node.y * GRAVITY * simulationAlpha;
    }

    // Integrate
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

    simulationAlpha *= 0.994;
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

    // Draw edges — thin, subtle
    for (const edge of edges) {
      const isHighlighted = hoveredNode && (edge.source === hoveredNode || edge.target === hoveredNode);
      ctx.strokeStyle = isHighlighted ? EDGE_HOVER_COLOR : (dimming ? 'rgba(80, 80, 90, 0.06)' : EDGE_COLOR);
      ctx.lineWidth = isHighlighted ? 1 : 0.5;
      ctx.beginPath();
      ctx.moveTo(edge.source.x, edge.source.y);
      ctx.lineTo(edge.target.x, edge.target.y);
      ctx.stroke();
    }

    // Draw nodes — monochrome circles, no glow
    for (const node of nodes) {
      const isNeighbor = hoveredNeighbors.has(node);
      const isDimmed = dimming && !isNeighbor;
      const isHovered = node === hoveredNode;
      const isActive = node.slug === activeSlug;

      // Active ring
      if (isActive) {
        ctx.strokeStyle = ACTIVE_RING_COLOR;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius + 3, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Node circle
      if (isHovered) {
        ctx.fillStyle = NODE_HOVER_COLOR;
      } else if (isDimmed) {
        ctx.fillStyle = NODE_COLOR_DIM;
      } else {
        ctx.fillStyle = NODE_COLOR;
      }
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      ctx.fill();

      // Label — only show for nodes with enough connections or when hovered/neighbor
      const showLabel = isHovered || isActive || node.connections >= 3 || (dimming && isNeighbor);
      if (showLabel) {
        const fontSize = Math.max(9, Math.min(13, Math.round(8 + node.radius * 0.2)));
        ctx.font = `${fontSize}px "Instrument Sans", -apple-system, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';

        if (isHovered || isActive) {
          ctx.fillStyle = LABEL_HOVER_COLOR;
        } else if (isDimmed) {
          ctx.fillStyle = LABEL_DIM;
        } else {
          ctx.fillStyle = LABEL_COLOR;
        }

        // Truncate slug-style: kebab-case, shorter
        let label = node.slug;
        if (label.length > 28) label = label.slice(0, 26) + '…';
        ctx.fillText(label, node.x, node.y + node.radius + 5);
      }
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
    // Generous hit area for small nodes
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const dx = n.x - x, dy = n.y - y;
      const hitRadius = Math.max(n.radius, 8);
      if (dx * dx + dy * dy < hitRadius * hitRadius) return n;
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
        dragStartPos = { x: e.clientX, y: e.clientY };
        dragDistance = 0;
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
        dragDistance += Math.abs(e.movementX) + Math.abs(e.movementY);
        simulationAlpha = Math.max(simulationAlpha, 0.1);
        canvas.style.cursor = 'grabbing';
      } else if (isPanning) {
        transform.x = e.clientX - panStart.x;
        transform.y = e.clientY - panStart.y;
      } else {
        const node = findNodeAt(sx, sy);
        if (node !== hoveredNode) {
          hoveredNode = node;
          canvas.style.cursor = node ? 'pointer' : 'default';
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
        if (dragDistance < 5 && onNavigate) {
          onNavigate(dragNode.slug);
        }
        dragNode = null;
        canvas.style.cursor = 'default';
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
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left - width / 2;
      const my = e.clientY - rect.top - height / 2;
      transform.x = mx - (mx - transform.x) * (newScale / transform.scale);
      transform.y = my - (my - transform.y) * (newScale / transform.scale);
      transform.scale = newScale;
    }, { passive: false });

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
