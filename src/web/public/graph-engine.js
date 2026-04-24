/* Granite Graph Engine — community detection, Barnes-Hut physics, WebGL renderer.
 *
 * Exports:
 *   window.GraphEngine.detectCommunities(notes, links)   → { communityOf, list }
 *   window.GraphEngine.createSimulation(notes, links, W, H) → simulation
 *   window.GraphEngine.createRenderer(canvas, simulation, opts) → renderer
 *
 * The simulation runs a live loop, applies Barnes-Hut repulsion (O(n log n)),
 * weighted springs, centering, hover repulsion, and damping. The renderer
 * draws glowing nodes + curved-ish edges via WebGL instanced quads and lines.
 */

(function () {
  const G = {};

  // ========================================================================
  // Community detection — label propagation (fast approximation of Louvain)
  // ========================================================================
  G.detectCommunities = function detectCommunities(notes, links) {
    const neighbors = {};
    for (const n of notes) neighbors[n.slug] = [];
    for (const l of links) {
      neighbors[l.source].push(l.target);
      neighbors[l.target].push(l.source);
    }

    // Seed: use authored community if present, else slug hash.
    const label = {};
    for (const n of notes) label[n.slug] = n.community || n.slug;

    // Run label propagation
    for (let iter = 0; iter < 20; iter++) {
      let changed = 0;
      // Randomize order
      const order = notes.map(n => n.slug).sort(() => Math.random() - 0.5);
      for (const slug of order) {
        const nbrs = neighbors[slug];
        if (!nbrs.length) continue;
        const count = {};
        for (const nb of nbrs) {
          count[label[nb]] = (count[label[nb]] || 0) + 1;
        }
        let best = label[slug], bestCount = -1;
        for (const [k, v] of Object.entries(count)) {
          if (v > bestCount || (v === bestCount && k < best)) { best = k; bestCount = v; }
        }
        if (best !== label[slug]) { label[slug] = best; changed++; }
      }
      if (changed === 0) break;
    }

    // Canonicalize: assign integer ids 0..k-1, count sizes
    const idOf = new Map();
    const sizes = [];
    const communityOf = {};
    for (const slug of Object.keys(label)) {
      const key = label[slug];
      if (!idOf.has(key)) { idOf.set(key, idOf.size); sizes.push(0); }
      const id = idOf.get(key);
      communityOf[slug] = id;
      sizes[id]++;
    }

    // Palette — one hue per community. Widen saturation + lightness so
    // adjacent communities read as distinctly different even on a dark stage.
    const palette = [];
    const K = idOf.size;
    const golden = 137.508;
    for (let i = 0; i < K; i++) {
      const hue = (i * golden + 24) % 360;
      const sat = 70 + (i * 13) % 26;       // 70..95
      const lit = 48 + (i * 17) % 22;       // 48..70
      palette.push(hslToRgb(hue / 360, sat / 100, lit / 100));
    }

    return { communityOf, sizes, K, palette };
  };

  function hslToRgb(h, s, l) {
    let r, g, b;
    if (s === 0) r = g = b = l;
    else {
      const hue2rgb = (p, q, t) => {
        if (t < 0) t += 1; if (t > 1) t -= 1;
        if (t < 1/6) return p + (q - p) * 6 * t;
        if (t < 1/2) return q;
        if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
        return p;
      };
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1/3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1/3);
    }
    return [r, g, b];
  }

  // ========================================================================
  // Barnes-Hut quadtree
  // ========================================================================
  function Quad(x, y, w, h) {
    this.x = x; this.y = y; this.w = w; this.h = h;
    this.mass = 0; this.cx = 0; this.cy = 0;
    this.node = null;       // leaf: a single node
    this.children = null;   // internal: 4 children
  }
  Quad.prototype.insert = function insert(n) {
    this.mass += 1;
    this.cx += n.x; this.cy += n.y;
    if (!this.children && this.node === null) { this.node = n; return; }
    // If the cell is already smaller than a pixel, treat it as a bucket.
    // Otherwise two coincident points would recurse forever.
    if (!this.children && this.w < 1) { return; }
    if (!this.children) {
      // split
      const hw = this.w / 2, hh = this.h / 2;
      this.children = [
        new Quad(this.x, this.y, hw, hh),
        new Quad(this.x + hw, this.y, hw, hh),
        new Quad(this.x, this.y + hh, hw, hh),
        new Quad(this.x + hw, this.y + hh, hw, hh),
      ];
      // re-insert existing
      const prev = this.node;
      this.node = null;
      this._insertIntoChild(prev);
    }
    this._insertIntoChild(n);
  };
  Quad.prototype._insertIntoChild = function (n) {
    const hw = this.w / 2, hh = this.h / 2;
    const xi = n.x < this.x + hw ? 0 : 1;
    const yi = n.y < this.y + hh ? 0 : 1;
    this.children[yi * 2 + xi].insert(n);
  };

  // ========================================================================
  // Simulation
  // ========================================================================
  G.createSimulation = function createSimulation(notes, links, W = 2000, H = 1400, opts = {}) {
    // Community detection first
    const { communityOf, sizes, K, palette } = G.detectCommunities(notes, links);

    // Node state (typed arrays for hot loop)
    const n = notes.length;
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    const vx = new Float32Array(n);
    const vy = new Float32Array(n);
    const community = new Int32Array(n);
    const degree = new Int32Array(n);
    const radius = new Float32Array(n);
    const alpha = new Float32Array(n); // per-node activation (for animation)
    const slugOf = new Array(n);
    const idxOf = {};
    for (let i = 0; i < n; i++) {
      slugOf[i] = notes[i].slug;
      idxOf[notes[i].slug] = i;
      community[i] = communityOf[notes[i].slug] ?? 0;
    }

    // Deterministic hash
    const hash = s => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); };

    // Build link arrays
    const linkA = new Int32Array(links.length);
    const linkB = new Int32Array(links.length);
    const linkW = new Float32Array(links.length); // weight
    const linkIntra = new Uint8Array(links.length);
    for (let i = 0; i < links.length; i++) {
      linkA[i] = idxOf[links[i].source];
      linkB[i] = idxOf[links[i].target];
      linkW[i] = 1.0;
      linkIntra[i] = community[linkA[i]] === community[linkB[i]] ? 1 : 0;
      degree[linkA[i]]++;
      degree[linkB[i]]++;
    }

    // Initial layout: place communities on a rough ring, jitter within
    const communityCenters = [];
    for (let i = 0; i < K; i++) {
      const a = (i / K) * Math.PI * 2;
      communityCenters.push({
        x: W/2 + Math.cos(a) * W * 0.28,
        y: H/2 + Math.sin(a) * H * 0.28 * 0.85,
      });
    }
    for (let i = 0; i < n; i++) {
      const c = communityCenters[community[i]];
      const h = hash(slugOf[i]);
      const r = 40 + (h % 200);
      const ang = (h % 360) * Math.PI / 180;
      // Index-based jitter guarantees no two nodes share the same spawn point.
      // Identical positions send the Barnes-Hut quadtree into infinite split.
      const jx = ((i * 2654435761) >>> 0) / 0xffffffff - 0.5;
      const jy = ((i * 40503) >>> 0) / 0xffffffff - 0.5;
      x[i] = c.x + Math.cos(ang) * r + jx * 8;
      y[i] = c.y + Math.sin(ang) * r + jy * 8;
      radius[i] = 2.5 + Math.min(14, Math.sqrt(degree[i]) * 2.2);
      alpha[i] = 1;
    }

    // Parameters
    const state = {
      n, x, y, vx, vy, community, degree, radius, alpha, slugOf, idxOf,
      links, linkA, linkB, linkW, linkIntra, W, H, palette, K, communityOf,
      // physics
      repel: opts.repel ?? 120,           // per-node repulsion strength
      linkStrength: opts.linkStrength ?? 0.015,
      linkDistance: opts.linkDistance ?? 55,
      bridgeMult: 1.6,                     // inter-community links pulled harder
      centerK: 0.004,                      // stronger pull so the cloud stays compact
      damping: 0.86,
      theta: 0.9,                          // Barnes-Hut threshold
      cooling: 1,                          // global alpha (cools slightly then stabilizes)
      coolTarget: 0.35,
      coolRate: 0.012,                     // ~1.5s to fully cool from a user-initiated nudge
      // interaction
      hoverX: null, hoverY: null, hoverR: 120, hoverStrength: 0,
      pinnedIdx: -1, pinX: 0, pinY: 0,
      active: -1,
    };

    // Quadtree reused
    let quad = null;

    state.step = function step(dt) {
      // Cool toward target so motion never fully stops but stays calm
      state.cooling = Math.max(state.coolTarget, state.cooling - state.coolRate);
      const a = state.cooling;

      // Build quadtree
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < n; i++) {
        if (x[i] < minX) minX = x[i]; if (x[i] > maxX) maxX = x[i];
        if (y[i] < minY) minY = y[i]; if (y[i] > maxY) maxY = y[i];
      }
      const pad = 50;
      const w = (maxX - minX) + pad * 2;
      const h = (maxY - minY) + pad * 2;
      const size = Math.max(w, h, 100);
      quad = new Quad(minX - pad, minY - pad, size, size);
      for (let i = 0; i < n; i++) {
        quad.insert({ x: x[i], y: y[i], i });
      }

      // Repulsion via Barnes-Hut
      const theta = state.theta;
      const repel = state.repel;
      for (let i = 0; i < n; i++) {
        let fx = 0, fy = 0;
        const stack = [quad];
        while (stack.length) {
          const q = stack.pop();
          if (!q || q.mass === 0) continue;
          const cx = q.cx / q.mass;
          const cy = q.cy / q.mass;
          const dx = x[i] - cx;
          const dy = y[i] - cy;
          const dist2 = dx*dx + dy*dy + 0.01;
          if (q.node) {
            if (q.node.i === i) continue;
            const f = repel / dist2;
            fx += dx * f; fy += dy * f;
          } else if (q.children) {
            if (q.w / Math.sqrt(dist2) < theta) {
              const f = repel * q.mass / dist2;
              fx += dx * f; fy += dy * f;
            } else {
              for (const c of q.children) stack.push(c);
            }
          }
        }
        vx[i] += fx * a;
        vy[i] += fy * a;
      }

      // Spring links
      const kSpring = state.linkStrength;
      const L = state.linkDistance;
      for (let i = 0; i < linkA.length; i++) {
        const ai = linkA[i], bi = linkB[i];
        const dx = x[bi] - x[ai];
        const dy = y[bi] - y[ai];
        const d = Math.sqrt(dx*dx + dy*dy) + 0.01;
        // Target distance: shorter for intra-community
        const target = linkIntra[i] ? L : L * 1.8;
        const strength = linkIntra[i] ? kSpring : kSpring * state.bridgeMult;
        const diff = (d - target) * strength * linkW[i];
        const fx = dx / d * diff;
        const fy = dy / d * diff;
        vx[ai] += fx * a; vy[ai] += fy * a;
        vx[bi] -= fx * a; vy[bi] -= fy * a;
      }

      // Centering — scaled by cooling so freeze() truly stops all motion.
      const cxw = W/2, cyw = H/2;
      const ck = state.centerK * a;
      for (let i = 0; i < n; i++) {
        vx[i] += (cxw - x[i]) * ck;
        vy[i] += (cyw - y[i]) * ck;
      }

      // Hover repulsion — cursor pushes nearby nodes outward
      if (state.hoverX !== null && state.hoverStrength > 0) {
        const hr = state.hoverR;
        const hr2 = hr * hr;
        for (let i = 0; i < n; i++) {
          const dx = x[i] - state.hoverX;
          const dy = y[i] - state.hoverY;
          const d2 = dx*dx + dy*dy;
          if (d2 < hr2) {
            const d = Math.sqrt(d2) + 0.1;
            const falloff = (1 - d / hr);
            const f = state.hoverStrength * falloff * falloff;
            vx[i] += dx / d * f;
            vy[i] += dy / d * f;
          }
        }
      }

      // Pinned node (dragging)
      if (state.pinnedIdx >= 0) {
        x[state.pinnedIdx] = state.pinX;
        y[state.pinnedIdx] = state.pinY;
        vx[state.pinnedIdx] = 0; vy[state.pinnedIdx] = 0;
      }

      // Integrate
      const damp = state.damping;
      for (let i = 0; i < n; i++) {
        vx[i] *= damp; vy[i] *= damp;
        // speed cap
        const v2 = vx[i]*vx[i] + vy[i]*vy[i];
        if (v2 > 400) {
          const s = 20 / Math.sqrt(v2);
          vx[i] *= s; vy[i] *= s;
        }
        x[i] += vx[i];
        y[i] += vy[i];
      }
    };

    state.setHover = function (wx, wy, strength = 600) {
      state.hoverX = wx; state.hoverY = wy; state.hoverStrength = strength;
    };
    state.clearHover = function () { state.hoverX = null; state.hoverStrength = 0; };
    state.setActive = function (slug) {
      state.active = slug ? (idxOf[slug] ?? -1) : -1;
    };
    state.prebake = function prebake(steps = 180) {
      const prevCool = state.cooling;
      state.cooling = 1;
      for (let s = 0; s < steps; s++) state.step(1 / 60);
      state.cooling = prevCool;
    };
    state.freeze = function freeze() {
      state.cooling = 0;
      state.coolTarget = 0;
      // Zero velocities so residual inertia can't keep drifting nodes.
      for (let i = 0; i < n; i++) { vx[i] = 0; vy[i] = 0; }
    };
    state.nudge = function nudge(amount = 0.35) {
      state.coolTarget = 0;
      state.cooling = Math.min(1, state.cooling + amount);
    };
    state.edgeAlpha = 1;
    state.pickNode = function (wx, wy, extraWorld = 0) {
      // Search nearest within radius. extraWorld lets callers account for zoom
      // (pass e.g. 14 / view.k so the hit target stays ~14 screen pixels).
      let best = -1, bestD = Infinity;
      for (let i = 0; i < n; i++) {
        const dx = wx - x[i], dy = wy - y[i];
        const d = dx*dx + dy*dy;
        const r = radius[i] + 6 + extraWorld;
        if (d < r * r && d < bestD) { best = i; bestD = d; }
      }
      return best;
    };

    return state;
  };

  // ========================================================================
  // WebGL renderer
  // ========================================================================
  G.createRenderer = function createRenderer(canvas, sim, opts = {}) {
    const gl = canvas.getContext("webgl", { antialias: true, alpha: true, premultipliedAlpha: false });
    if (!gl) throw new Error("WebGL not supported");

    // View transform (world → screen)
    const view = { tx: 0, ty: 0, k: 1 };
    let dpr = window.devicePixelRatio || 1;

    function resize() {
      dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
    resize();

    // === Node shader: instanced glowing disks ===
    const nodeVS = `
      attribute vec2 aCorner;
      attribute vec2 aPos;
      attribute float aRadius;
      attribute vec3 aColor;
      attribute float aAlpha;
      attribute float aState;   // 0=normal, 1=active, 2=hop1, 3=hop2, 4=dim
      uniform vec2 uResolution;
      uniform vec2 uTranslate;
      uniform float uScale;
      varying vec2 vCorner;
      varying vec3 vColor;
      varying float vAlpha;
      varying float vState;
      varying float vRadius;
      void main() {
        // Scale factor — active/hop1 get a halo extension
        float extend = 6.0;
        if (aState < 0.5) extend = 4.0;
        else if (aState < 1.5) extend = 10.0;  // active
        else if (aState < 2.5) extend = 7.0;   // hop1
        float r = (aRadius + extend) * uScale;
        vec2 world = aPos + uTranslate;
        vec2 px = world * uScale;
        vec2 corner = aCorner * r;
        vec2 screen = px + corner;
        vec2 clip = screen / uResolution * 2.0 - 1.0;
        clip.y = -clip.y;
        gl_Position = vec4(clip, 0.0, 1.0);
        vCorner = aCorner;
        vColor = aColor;
        vAlpha = aAlpha;
        vState = aState;
        vRadius = aRadius * uScale;
      }
    `;
    const nodeFS = `
      precision mediump float;
      varying vec2 vCorner;
      varying vec3 vColor;
      varying float vAlpha;
      varying float vState;
      varying float vRadius;
      void main() {
        float d = length(vCorner);              // 0..~1 at corner
        // inner disk
        float rNorm = 1.0;
        // Use vRadius vs. the pixel position: we want the disk at d < (r / r_ext)
        // Since we built the quad at (r+extend), the disk sits at d < r/(r+extend)
        float extend = 4.0;
        if (vState >= 0.5 && vState < 1.5) extend = 10.0;
        else if (vState >= 1.5 && vState < 2.5) extend = 7.0;
        float diskEdge = vRadius / (vRadius + extend);

        // Disk
        float disk = smoothstep(diskEdge + 0.02, diskEdge - 0.02, d);

        // Highlight inside (top-left)
        vec2 hl = vCorner - vec2(-0.28, -0.28);
        float highlight = (1.0 - smoothstep(0.0, 0.55, length(hl))) * disk * 0.32;

        // Outer glow — strong, so each node broadcasts its community hue.
        float glow = (1.0 - smoothstep(diskEdge, 1.0, d)) * 0.95;

        // Active pulse ring
        float pulse = 0.0;
        if (vState >= 0.5 && vState < 1.5) {
          float ring = smoothstep(diskEdge + 0.03, diskEdge + 0.06, d) * (1.0 - smoothstep(diskEdge + 0.06, diskEdge + 0.12, d));
          pulse = ring * 0.8;
        }

        vec3 base = vColor;
        vec3 col = base * (disk * 1.0) + vec3(highlight) + base * glow * 0.5 + vec3(pulse);
        float alpha = (disk + glow * 0.55 + pulse) * vAlpha;
        if (alpha < 0.003) discard;
        gl_FragColor = vec4(col, alpha);
      }
    `;

    // === Edge shader: instanced lines ===
    const edgeVS = `
      attribute vec2 aPos;  // endpoint position (0 or 1 along the edge)
      attribute vec2 aA;
      attribute vec2 aB;
      attribute vec3 aColor;
      attribute float aAlpha;
      uniform vec2 uResolution;
      uniform vec2 uTranslate;
      uniform float uScale;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vec2 world = mix(aA, aB, aPos.x) + uTranslate;
        vec2 px = world * uScale;
        vec2 clip = px / uResolution * 2.0 - 1.0;
        clip.y = -clip.y;
        gl_Position = vec4(clip, 0.0, 1.0);
        vColor = aColor;
        vAlpha = aAlpha;
      }
    `;
    const edgeFS = `
      precision mediump float;
      varying vec3 vColor;
      varying float vAlpha;
      void main() { gl_FragColor = vec4(vColor, vAlpha); }
    `;

    function compile(vs, fs) {
      const compileShader = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
          throw new Error(gl.getShaderInfoLog(s));
        }
        return s;
      };
      const prog = gl.createProgram();
      gl.attachShader(prog, compileShader(gl.VERTEX_SHADER, vs));
      gl.attachShader(prog, compileShader(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(prog));
      }
      return prog;
    }

    const nodeProg = compile(nodeVS, nodeFS);
    const edgeProg = compile(edgeVS, edgeFS);

    // ===== Instanced-via-attribute divisor simulation =====
    // We don't use ANGLE_instanced_arrays for max compat; instead we draw N nodes
    // as N quads (6 verts each), writing per-instance data into each vertex. Fast
    // enough for ~1000 nodes.
    const n = sim.n;

    // Node buffers (6 verts per node)
    const QUAD_CORNERS = new Float32Array([
      -1, -1,   1, -1,   1, 1,
      -1, -1,   1, 1,   -1, 1,
    ]);
    const nodeCorners = new Float32Array(n * 6 * 2);
    for (let i = 0; i < n; i++) {
      for (let v = 0; v < 6; v++) {
        nodeCorners[(i * 6 + v) * 2    ] = QUAD_CORNERS[v * 2];
        nodeCorners[(i * 6 + v) * 2 + 1] = QUAD_CORNERS[v * 2 + 1];
      }
    }
    const nodePos = new Float32Array(n * 6 * 2);
    const nodeRadius = new Float32Array(n * 6);
    const nodeColor = new Float32Array(n * 6 * 3);
    const nodeAlpha = new Float32Array(n * 6);
    const nodeState = new Float32Array(n * 6);

    const bufCorner = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bufCorner);
    gl.bufferData(gl.ARRAY_BUFFER, nodeCorners, gl.STATIC_DRAW);
    const bufPos = gl.createBuffer();
    const bufRadius = gl.createBuffer();
    const bufColor = gl.createBuffer();
    const bufAlpha = gl.createBuffer();
    const bufState = gl.createBuffer();

    // Edge buffers (2 verts per edge)
    const L = sim.links.length;
    const edgePos = new Float32Array(L * 2 * 2); // aPos.x = 0 or 1
    for (let i = 0; i < L; i++) {
      edgePos[i * 4 + 0] = 0; edgePos[i * 4 + 1] = 0;
      edgePos[i * 4 + 2] = 1; edgePos[i * 4 + 3] = 0;
    }
    const edgeA = new Float32Array(L * 2 * 2);
    const edgeB = new Float32Array(L * 2 * 2);
    const edgeColor = new Float32Array(L * 2 * 3);
    const edgeAlpha = new Float32Array(L * 2);

    const bufEdgePos = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bufEdgePos);
    gl.bufferData(gl.ARRAY_BUFFER, edgePos, gl.STATIC_DRAW);
    const bufEdgeA = gl.createBuffer();
    const bufEdgeB = gl.createBuffer();
    const bufEdgeColor = gl.createBuffer();
    const bufEdgeAlpha = gl.createBuffer();

    function setAttrib(prog, name, buffer, size) {
      const loc = gl.getAttribLocation(prog, name);
      if (loc < 0) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    }

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const renderer = {
      view,
      setView(v) { Object.assign(view, v); },
      resize,
      hops: { hop1: new Set(), hop2: new Set() },
      setHops(h) { this.hops = h; },
      hovered: -1,
      setHovered(i) { this.hovered = i; },
      draw(pulsePhase = 0) {
        const W = canvas.width, H = canvas.height;
        // Background gradient is CSS; clear to transparent
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        // ---- Update edge buffers ----
        const activeIdx = sim.active;
        const hop1 = this.hops.hop1, hop2 = this.hops.hop2;
        for (let i = 0; i < L; i++) {
          const a = sim.linkA[i], b = sim.linkB[i];
          const ax = sim.x[a], ay = sim.y[a];
          const bx = sim.x[b], by = sim.y[b];
          edgeA[i * 4 + 0] = ax; edgeA[i * 4 + 1] = ay;
          edgeA[i * 4 + 2] = ax; edgeA[i * 4 + 3] = ay;
          edgeB[i * 4 + 0] = bx; edgeB[i * 4 + 1] = by;
          edgeB[i * 4 + 2] = bx; edgeB[i * 4 + 3] = by;

          const [ar, ag, ab] = sim.palette[sim.community[a]];
          const [br, bg, bb] = sim.palette[sim.community[b]];
          // Intra-community edges glow clearly so clusters read as coherent
          // neighbourhoods. Inter-community edges fade to near-invisible to
          // cut visual noise across the starfield.
          let alpha = sim.linkIntra[i] ? 0.38 : 0.035;
          if (activeIdx >= 0) {
            // When a node is selected, only keep the edges that touch it.
            // Everything else collapses to near-zero so the local subgraph
            // reads clearly.
            if (a === activeIdx || b === activeIdx) alpha = 0.95;
            else if (hop1.has(sim.slugOf[a]) && hop1.has(sim.slugOf[b])) alpha = 0.18;
            else alpha = 0.0;
          }
          // Multiply by the sim's global edge-alpha so the arrival animation
          // can fade edges in after nodes.
          const aa = alpha * (sim.edgeAlpha ?? 1);
          edgeAlpha[i * 2] = aa; edgeAlpha[i * 2 + 1] = aa;
          // Blend colors along the edge using endpoint community colors
          edgeColor[i * 6 + 0] = ar; edgeColor[i * 6 + 1] = ag; edgeColor[i * 6 + 2] = ab;
          edgeColor[i * 6 + 3] = br; edgeColor[i * 6 + 4] = bg; edgeColor[i * 6 + 5] = bb;
        }

        // Draw edges
        gl.useProgram(edgeProg);
        gl.uniform2f(gl.getUniformLocation(edgeProg, "uResolution"), W, H);
        gl.uniform2f(gl.getUniformLocation(edgeProg, "uTranslate"), view.tx, view.ty);
        gl.uniform1f(gl.getUniformLocation(edgeProg, "uScale"), view.k * dpr);
        setAttrib(edgeProg, "aPos", bufEdgePos, 2);
        gl.bindBuffer(gl.ARRAY_BUFFER, bufEdgeA); gl.bufferData(gl.ARRAY_BUFFER, edgeA, gl.DYNAMIC_DRAW);
        setAttrib(edgeProg, "aA", bufEdgeA, 2);
        gl.bindBuffer(gl.ARRAY_BUFFER, bufEdgeB); gl.bufferData(gl.ARRAY_BUFFER, edgeB, gl.DYNAMIC_DRAW);
        setAttrib(edgeProg, "aB", bufEdgeB, 2);
        gl.bindBuffer(gl.ARRAY_BUFFER, bufEdgeColor); gl.bufferData(gl.ARRAY_BUFFER, edgeColor, gl.DYNAMIC_DRAW);
        setAttrib(edgeProg, "aColor", bufEdgeColor, 3);
        gl.bindBuffer(gl.ARRAY_BUFFER, bufEdgeAlpha); gl.bufferData(gl.ARRAY_BUFFER, edgeAlpha, gl.DYNAMIC_DRAW);
        setAttrib(edgeProg, "aAlpha", bufEdgeAlpha, 1);
        gl.drawArrays(gl.LINES, 0, L * 2);

        // ---- Update node buffers ----
        const pulse = 0.6 + 0.4 * Math.sin(pulsePhase * 3.4);
        for (let i = 0; i < n; i++) {
          const slug = sim.slugOf[i];
          let state = 0; // normal
          let alpha = activeIdx < 0 ? 1 : 0.25;
          if (i === activeIdx) { state = 1; alpha = 1; }
          else if (hop1.has(slug)) { state = 2; alpha = 1; }
          else if (hop2.has(slug)) { state = 3; alpha = 0.75; }
          else if (activeIdx >= 0) { state = 4; alpha = 0.25; }
          if (i === this.hovered) { state = 2; alpha = 1; }
          const [r, g, b] = sim.palette[sim.community[i]];
          // Per-node reveal multiplier (drives the arrival animation).
          const reveal = sim.alpha[i];
          const finalAlpha = alpha * reveal;
          for (let v = 0; v < 6; v++) {
            const o = (i * 6 + v);
            nodePos[o * 2    ] = sim.x[i];
            nodePos[o * 2 + 1] = sim.y[i];
            nodeRadius[o] = sim.radius[i];
            nodeColor[o * 3    ] = r;
            nodeColor[o * 3 + 1] = g;
            nodeColor[o * 3 + 2] = b;
            nodeAlpha[o] = finalAlpha;
            nodeState[o] = state;
          }
        }

        gl.useProgram(nodeProg);
        gl.uniform2f(gl.getUniformLocation(nodeProg, "uResolution"), W, H);
        gl.uniform2f(gl.getUniformLocation(nodeProg, "uTranslate"), view.tx, view.ty);
        gl.uniform1f(gl.getUniformLocation(nodeProg, "uScale"), view.k * dpr);
        setAttrib(nodeProg, "aCorner", bufCorner, 2);
        gl.bindBuffer(gl.ARRAY_BUFFER, bufPos); gl.bufferData(gl.ARRAY_BUFFER, nodePos, gl.DYNAMIC_DRAW);
        setAttrib(nodeProg, "aPos", bufPos, 2);
        gl.bindBuffer(gl.ARRAY_BUFFER, bufRadius); gl.bufferData(gl.ARRAY_BUFFER, nodeRadius, gl.DYNAMIC_DRAW);
        setAttrib(nodeProg, "aRadius", bufRadius, 1);
        gl.bindBuffer(gl.ARRAY_BUFFER, bufColor); gl.bufferData(gl.ARRAY_BUFFER, nodeColor, gl.DYNAMIC_DRAW);
        setAttrib(nodeProg, "aColor", bufColor, 3);
        gl.bindBuffer(gl.ARRAY_BUFFER, bufAlpha); gl.bufferData(gl.ARRAY_BUFFER, nodeAlpha, gl.DYNAMIC_DRAW);
        setAttrib(nodeProg, "aAlpha", bufAlpha, 1);
        gl.bindBuffer(gl.ARRAY_BUFFER, bufState); gl.bufferData(gl.ARRAY_BUFFER, nodeState, gl.DYNAMIC_DRAW);
        setAttrib(nodeProg, "aState", bufState, 1);
        gl.drawArrays(gl.TRIANGLES, 0, n * 6);
      },
      // Coordinate helpers — screen (css px) ↔ world
      screenToWorld(sx, sy) {
        // account for canvas css → buffer
        return {
          x: sx / view.k - view.tx,
          y: sy / view.k - view.ty,
        };
      },
      worldToScreen(wx, wy) {
        return { x: (wx + view.tx) * view.k, y: (wy + view.ty) * view.k };
      },
    };

    return renderer;
  };

  window.GraphEngine = G;
})();
