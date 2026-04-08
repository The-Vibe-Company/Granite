/**
 * Granite — App Controller
 */
(function () {
  // ── State ──
  let allNotes = [];
  let currentNote = null;
  let currentType = '';
  let currentView = 'graph';
  let graphData = null;
  let previewCache = {};
  let previewTimeout = null;
  let commandIndex = -1;
  let commandResults = [];
  let releaseTrap = null;

  // ── DOM ──
  const noteList = document.getElementById('note-list');
  const typeFilters = document.getElementById('type-filters');
  const noteView = document.getElementById('note-view');
  const noteScroll = document.getElementById('note-scroll');
  const noteTypeLine = document.getElementById('note-type-line');
  const noteSlug = document.getElementById('note-slug');
  const noteKicker = document.getElementById('note-kicker');
  const noteTitle = document.getElementById('note-title');
  const noteDeck = document.getElementById('note-deck');
  const noteDate = document.getElementById('note-date');
  const noteModified = document.getElementById('note-modified');
  const noteLinkCount = document.getElementById('note-link-count');
  const noteMetaGrid = document.getElementById('note-meta-grid');
  const noteTags = document.getElementById('note-tags');
  const noteAliases = document.getElementById('note-aliases');
  const noteBody = document.getElementById('note-body');
  const backlinks = document.getElementById('backlinks');
  const backlinksList = document.getElementById('backlinks-list');
  const backlinksCount = document.getElementById('backlinks-count');
  const emptyState = document.getElementById('empty-state');
  const graphView = document.getElementById('graph-view');
  const graphCanvas = document.getElementById('graph-canvas');
  const previewEl = document.getElementById('wikilink-preview');
  const vaultTotal = document.getElementById('vault-total');
  const vaultUpdated = document.getElementById('vault-updated');
  const navListTitle = document.getElementById('nav-list-title');
  const navFilterCount = document.getElementById('nav-filter-count');
  const graphSummary = document.getElementById('graph-summary');
  const graphNodeCount = document.getElementById('graph-node-count');
  const graphEdgeCount = document.getElementById('graph-edge-count');
  const graphDensestType = document.getElementById('graph-densest-type');
  const graphFocusTitle = document.getElementById('graph-focus-title');
  const graphFocusMeta = document.getElementById('graph-focus-meta');
  const graphFocusState = document.getElementById('graph-focus-state');
  const graphFocusLinks = document.getElementById('graph-focus-links');
  const graphFocusBacklinks = document.getElementById('graph-focus-backlinks');
  const graphFocusMode = document.getElementById('graph-focus-mode');

  // Command bar
  const commandOverlay = document.getElementById('command-bar-overlay');
  const commandInput = document.getElementById('command-input');
  const commandResultsEl = document.getElementById('command-results');

  // Create
  const createOverlay = document.getElementById('create-overlay');

  // ── API ──
  async function api(url, opts) {
    try {
      const res = await fetch(url, opts);
      if (!res.ok) return { error: `HTTP ${res.status}` };
      return res.json();
    } catch (err) {
      return { error: err.message };
    }
  }

  // ── Init ──
  async function init() {
    const { types } = await api('/api/types');
    for (const name of Object.keys(types)) {
      const btn = document.createElement('button');
      btn.className = 'type-pill';
      btn.dataset.type = name;
      btn.textContent = name;
      btn.addEventListener('click', () => filterByType(name));
      typeFilters.appendChild(btn);
    }
    typeFilters.querySelector('[data-type=""]').addEventListener('click', () => filterByType(''));

    const createType = document.getElementById('create-type');
    for (const name of Object.keys(types)) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      createType.appendChild(opt);
    }

    await loadNotes();
    setupKeyboard();
    setupNav();
    setupCreate();
    setupCommand();
    setupWikilinkPreviews();
    setupGraphHud();
    initGrain();
    setView('graph');
  }

  // ═══ GRAIN TEXTURE (static, rendered once) ═══
  function initGrain() {
    const c = document.getElementById('grain');
    const ctx = c.getContext('2d');
    // Render a small 256x256 noise tile, CSS will repeat it
    const size = 256;
    c.width = size;
    c.height = size;
    c.style.width = '100%';
    c.style.height = '100%';
    c.style.imageRendering = 'auto';
    const imageData = ctx.createImageData(size, size);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const v = Math.random() * 255;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);
  }

  // ═══ COMMAND BAR ═══
  function setupCommand() {
    let debounce = null;
    commandInput.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(async () => {
        const q = commandInput.value.trim();
        if (q.length === 0) {
          // Show all notes
          renderCommandResults(allNotes.map(n => ({
            slug: n.slug, title: n.title, type: n.type, modified: n.modified,
          })));
          return;
        }
        const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
        renderCommandResults(data.results.map(r => ({
          slug: r.slug, title: r.title, snippet: r.snippet,
        })));
      }, 120);
    });

    commandInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeCommand(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); navigateCommand(1); }
      if (e.key === 'ArrowUp') { e.preventDefault(); navigateCommand(-1); }
      if (e.key === 'Enter') {
        e.preventDefault();
        const item = commandResults[commandIndex >= 0 ? commandIndex : 0];
        if (item) { closeCommand(); loadNote(item.slug); }
      }
    });

    commandOverlay.addEventListener('click', (e) => {
      if (e.target === commandOverlay) closeCommand();
    });
  }

  function openCommand() {
    commandOverlay.classList.remove('hidden');
    commandInput.value = '';
    commandInput.focus();
    commandInput.setAttribute('aria-expanded', 'true');
    releaseTrap = trapFocus(document.getElementById('command-bar'));
    commandIndex = -1;
    // Show all notes initially
    renderCommandResults(allNotes.map(n => ({
      slug: n.slug, title: n.title, type: n.type, modified: n.modified,
    })));
  }

  function closeCommand() {
    if (releaseTrap) { releaseTrap(); releaseTrap = null; }
    commandOverlay.classList.add('hidden');
    commandInput.setAttribute('aria-expanded', 'false');
    commandInput.removeAttribute('aria-activedescendant');
    commandResultsEl.innerHTML = '';
    commandResults = [];
  }

  function renderCommandResults(results) {
    commandResults = results;
    commandIndex = -1;
    commandResultsEl.innerHTML = '';
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const el = document.createElement('div');
      el.className = 'command-result';
      el.setAttribute('role', 'option');
      el.id = `cmd-result-${i}`;
      let html = `<div class="command-result-title">${esc(r.title)}</div>`;
      if (r.type || r.modified) {
        const parts = [];
        if (r.type) parts.push(r.type);
        if (r.modified) parts.push(formatDate(r.modified));
        html += `<div class="command-result-meta">${parts.join(' · ')}</div>`;
      }
      if (r.snippet) {
        html += `<div class="command-result-snippet">${r.snippet.replace(/>>>/g, '<mark>').replace(/<<</g, '</mark>')}</div>`;
      }
      el.innerHTML = html;
      el.addEventListener('click', () => { closeCommand(); loadNote(r.slug); });
      commandResultsEl.appendChild(el);
    }
  }

  function navigateCommand(delta) {
    const items = commandResultsEl.querySelectorAll('.command-result');
    if (!items.length) return;
    items.forEach(el => el.classList.remove('focused'));
    commandIndex += delta;
    if (commandIndex < 0) commandIndex = items.length - 1;
    if (commandIndex >= items.length) commandIndex = 0;
    items[commandIndex].classList.add('focused');
    items[commandIndex].scrollIntoView({ block: 'nearest' });
    commandInput.setAttribute('aria-activedescendant', items[commandIndex].id);
  }

  // ═══ KEYBOARD ═══
  function setupKeyboard() {
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        openCommand();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        openCreate();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'g') {
        e.preventDefault();
        toggleGraph();
      }
      if (e.key === 'Escape') {
        if (!commandOverlay.classList.contains('hidden')) { closeCommand(); return; }
        if (!createOverlay.classList.contains('hidden')) { closeCreate(); return; }
        if (currentView === 'graph' && currentNote) { setView('note'); return; }
      }
    });
  }

  // ═══ NAV ═══
  const nav = document.getElementById('nav');
  const navBackdrop = document.getElementById('nav-backdrop');

  function setupNav() {
    document.getElementById('nav-search').addEventListener('click', openCommand);
    const navNew = document.getElementById('nav-new');
    if (navNew) navNew.addEventListener('click', openCreate);
    document.getElementById('nav-graph').addEventListener('click', toggleGraph);

    // Mobile
    const mobileMenu = document.getElementById('mobile-menu');
    const mobileSearch = document.getElementById('mobile-search');
    if (mobileMenu) mobileMenu.addEventListener('click', openMobileNav);
    if (mobileSearch) mobileSearch.addEventListener('click', openCommand);
    if (navBackdrop) navBackdrop.addEventListener('click', closeMobileNav);
  }

  function setupGraphHud() {
    document.getElementById('graph-fit').addEventListener('click', () => GraphEngine.fitView());
    document.getElementById('graph-reheat').addEventListener('click', () => GraphEngine.reheat());
    document.getElementById('graph-focus-active').addEventListener('click', () => {
      if (!currentNote) return;
      GraphEngine.centerOnSlug(currentNote.slug);
      GraphEngine.reheat();
    });
  }

  function openMobileNav() {
    nav.classList.add('open');
    navBackdrop.classList.remove('hidden');
    requestAnimationFrame(() => navBackdrop.classList.add('visible'));
  }

  function closeMobileNav() {
    nav.classList.remove('open');
    navBackdrop.classList.remove('visible');
    setTimeout(() => navBackdrop.classList.add('hidden'), 200);
  }

  // ═══ CREATE ═══
  function setupCreate() {
    document.getElementById('create-close').addEventListener('click', closeCreate);
    document.getElementById('create-submit').addEventListener('click', submitCreate);
    createOverlay.addEventListener('click', (e) => {
      if (e.target === createOverlay) closeCreate();
    });
    document.getElementById('create-title').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        document.getElementById('create-body').focus();
      }
    });
  }

  let releaseCreateTrap = null;
  function openCreate() {
    createOverlay.classList.remove('hidden');
    releaseCreateTrap = trapFocus(document.getElementById('create-dialog'));
    setTimeout(() => document.getElementById('create-title').focus(), 50);
  }
  function closeCreate() {
    if (releaseCreateTrap) { releaseCreateTrap(); releaseCreateTrap = null; }
    createOverlay.classList.add('hidden');
    document.getElementById('create-title').value = '';
    document.getElementById('create-body').value = '';
  }

  let isSubmitting = false;
  async function submitCreate() {
    if (isSubmitting) return;
    const type = document.getElementById('create-type').value;
    const title = document.getElementById('create-title').value.trim();
    const body = document.getElementById('create-body').value;
    if (!title) { document.getElementById('create-title').focus(); return; }
    const btn = document.getElementById('create-submit');
    isSubmitting = true;
    btn.disabled = true;
    btn.textContent = 'Creating...';
    const result = await api('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, title, body }),
    });
    isSubmitting = false;
    btn.disabled = false;
    btn.textContent = 'Create';
    if (result.error) return;
    if (result.slug) {
      closeCreate();
      await loadNotes();
      loadNote(result.slug);
    }
  }

  // ═══ GRAPH ═══
  function toggleGraph() {
    setView(currentView === 'graph' ? 'note' : 'graph');
  }

  function setView(view) {
    currentView = view;
    const graphBtn = document.getElementById('nav-graph');
    if (view === 'graph') {
      graphBtn.classList.add('active');
      noteView.style.display = 'none';
      emptyState.style.display = 'none';
      graphView.classList.remove('hidden');
      loadGraph();
    } else {
      graphBtn.classList.remove('active');
      graphView.classList.add('hidden');
      GraphEngine.stop();
      if (currentNote) {
        noteView.style.display = 'flex';
        emptyState.style.display = 'none';
      } else {
        noteView.style.display = 'none';
        emptyState.style.display = 'flex';
      }
    }
  }

  async function loadGraph() {
    if (!graphData) {
      graphData = await api('/api/graph');
      updateGraphSummary(graphData);
    }
    updateGraphFocus();
    GraphEngine.init(graphCanvas, graphData, {
      activeSlug: currentNote?.slug || null,
      onNavigate: (slug) => { loadNote(slug); setView('note'); },
    });
  }

  // ═══ WIKILINK PREVIEWS ═══
  function setupWikilinkPreviews() {
    document.addEventListener('mouseover', (e) => {
      const link = e.target.closest('.wikilink');
      if (!link) return;
      clearTimeout(previewTimeout);
      previewTimeout = setTimeout(() => showPreview(link), 300);
    });
    document.addEventListener('mouseout', (e) => {
      const link = e.target.closest('.wikilink');
      if (link || e.relatedTarget?.closest?.('#wikilink-preview')) return;
      clearTimeout(previewTimeout);
      hidePreview();
    });
    previewEl.addEventListener('mouseleave', hidePreview);
    document.addEventListener('click', (e) => {
      const link = e.target.closest('.wikilink');
      if (!link) return;
      e.preventDefault();
      hidePreview();
      const slug = link.dataset.slug;
      if (slug) loadNote(slug);
    });
  }

  async function showPreview(linkEl) {
    const slug = linkEl.dataset.slug;
    if (!slug) return;
    let data = previewCache[slug];
    if (!data) {
      data = await api(`/api/notes/${slug}`);
      if (data.error) return;
      previewCache[slug] = data;
    }
    const rect = linkEl.getBoundingClientRect();
    let left = rect.left;
    let top = rect.bottom + 8;
    if (left + 280 > window.innerWidth - 16) left = window.innerWidth - 296;
    if (top + 160 > window.innerHeight) {
      top = rect.top - 8;
      previewEl.style.transform = 'translateY(-100%)';
    } else {
      previewEl.style.transform = '';
    }
    previewEl.style.left = left + 'px';
    previewEl.style.top = top + 'px';
    previewEl.querySelector('.preview-type').textContent = data.type || '';
    previewEl.querySelector('.preview-title').textContent = data.title || '';
    previewEl.querySelector('.preview-snippet').textContent = (data.body || '').slice(0, 150).replace(/[#*_`>\[\]]/g, '');
    const tagsEl = previewEl.querySelector('.preview-tags');
    tagsEl.innerHTML = (data.tags || []).map(t => `<span class="preview-tag">${esc(t)}</span>`).join('');
    previewEl.classList.add('visible');
  }

  function hidePreview() {
    clearTimeout(previewTimeout);
    previewEl.classList.remove('visible');
  }

  // ═══ DATA ═══
  async function loadNotes() {
    const url = currentType ? `/api/notes?type=${currentType}` : '/api/notes';
    const data = await api(url);
    allNotes = data.notes;
    graphData = null;
    updateVaultSummary(allNotes);
    renderNoteList(allNotes);
  }

  function filterByType(type) {
    currentType = type;
    typeFilters.querySelectorAll('.type-pill').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.type === type);
    });
    loadNotes();
  }

  // ═══ RENDER ═══
  function renderNoteList(notes) {
    navListTitle.textContent = currentType ? `${currentType} notes` : 'All notes';
    navFilterCount.textContent = String(notes.length);
    noteList.innerHTML = '';
    if (notes.length === 0) {
      noteList.innerHTML = '<div style="padding:16px 12px;color:var(--ink-faint);font-size:12px;">No notes in this slice.</div>';
      return;
    }
    for (const note of notes) {
      const item = document.createElement('div');
      item.className = 'note-item' + (currentNote?.slug === note.slug ? ' active' : '');
      item.setAttribute('role', 'listitem');
      item.setAttribute('tabindex', '0');
      item.setAttribute('aria-label', `${note.title}${note.type ? ', type ' + note.type : ''}`);
      let meta = '';
      if (note.type) meta += `<span class="note-item-type ${note.type}">${note.type}</span>`;
      if (note.modified) {
        if (note.type) meta += '<span class="note-item-dot"></span>';
        meta += `<span>${formatDate(note.modified)}</span>`;
      }
      item.innerHTML = `
        <div class="note-item-title">${esc(note.title)}</div>
        <div class="note-item-meta">${meta}</div>
      `;
      item.addEventListener('click', () => { closeMobileNav(); loadNote(note.slug); });
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); closeMobileNav(); loadNote(note.slug); }
      });
      noteList.appendChild(item);
    }
  }

  async function loadNote(slug) {
    const note = await api(`/api/notes/${slug}`);
    if (note.error) return;
    currentNote = note;

    if (currentView === 'graph') setView('note');

    emptyState.style.display = 'none';
    noteView.style.display = 'flex';

    // Re-trigger animation via class toggle
    const article = document.getElementById('note-article');
    article.classList.remove('animate');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => article.classList.add('animate'));
    });

    noteTypeLine.textContent = note.type || 'note';
    noteSlug.textContent = note.slug;
    noteKicker.textContent = `${formatTypeLabel(note.type)} note`;
    noteTitle.textContent = note.title;
    noteDeck.textContent = extractDeck(note.body);
    noteDate.textContent = formatDate(note.created);
    noteModified.textContent = formatDate(note.modified || note.created);
    noteLinkCount.textContent = String((note.outgoing_links || []).filter(link => link.resolved).length);
    noteTags.innerHTML = (note.tags || []).map(t => `<span class="tag">#${esc(t)}</span>`).join('');
    noteAliases.innerHTML = (note.aliases || []).map(alias => `<span class="alias-chip">${esc(alias)}</span>`).join('');
    noteMetaGrid.innerHTML = renderMetaGrid(note);

    noteBody.innerHTML = MarkdownRenderer.render(note.body, note.outgoing_links);
    updateGraphFocus();

    if (note.backlinks && note.backlinks.length > 0) {
      backlinks.style.display = 'block';
      backlinksCount.textContent = note.backlinks.length;
      backlinksList.innerHTML = '';
      for (const bl of note.backlinks) {
        const item = document.createElement('div');
        item.className = 'backlink-item';
        item.setAttribute('role', 'link');
        item.setAttribute('tabindex', '0');
        item.innerHTML = `
          <div class="backlink-title"><span class="backlink-arrow">\u2190</span>${esc(bl.source_title)}</div>
          ${bl.context ? `<div class="backlink-context">${esc(bl.context)}</div>` : ''}
        `;
        item.addEventListener('click', () => loadNote(bl.source_slug));
        item.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); loadNote(bl.source_slug); }
        });
        backlinksList.appendChild(item);
      }
    } else {
      backlinks.style.display = 'none';
    }

    noteList.querySelectorAll('.note-item').forEach((el, idx) => {
      el.classList.toggle('active', allNotes[idx]?.slug === slug);
    });

    if (graphData) GraphEngine.setActiveSlug(slug);
    noteScroll.scrollTop = 0;
  }

  // ═══ FOCUS TRAP ═══
  function trapFocus(container) {
    const focusable = container.querySelectorAll(
      'input, select, textarea, button:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (!focusable.length) return null;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    function handler(e) {
      if (e.key !== 'Tab') return;
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    container.addEventListener('keydown', handler);
    return () => container.removeEventListener('keydown', handler);
  }

  // ═══ HELPERS ═══
  function esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function updateVaultSummary(notes) {
    vaultTotal.textContent = String(notes.length);
    if (notes.length === 0) {
      vaultUpdated.textContent = '-';
      return;
    }
    const latest = [...notes]
      .filter(note => note.modified || note.created)
      .sort((a, b) => new Date(b.modified || b.created) - new Date(a.modified || a.created))[0];
    vaultUpdated.textContent = formatDate(latest.modified || latest.created);
  }

  function updateGraphSummary(data) {
    const counts = {};
    for (const node of data.nodes || []) {
      counts[node.type || 'note'] = (counts[node.type || 'note'] || 0) + 1;
    }
    const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    graphNodeCount.textContent = String(data.nodes?.length || 0);
    graphEdgeCount.textContent = String(data.edges?.length || 0);
    graphDensestType.textContent = dominant ? dominant[0] : '-';
    graphSummary.textContent = dominant
      ? `${data.nodes.length} notes · ${data.edges.length} links · ${formatTypeLabel(dominant[0])} dominant`
      : 'No graph data available yet.';
  }

  function updateGraphFocus() {
    if (!currentNote) {
      graphFocusTitle.textContent = 'No note selected';
      graphFocusMeta.textContent = 'Hover a node, inspect a cluster, then open a note.';
      graphFocusState.textContent = 'Exploration';
      graphFocusLinks.textContent = '0';
      graphFocusBacklinks.textContent = '0';
      graphFocusMode.textContent = 'Atlas';
      document.getElementById('graph-focus-bar').classList.add('graph-focus-idle');
      return;
    }
    const backlinkCount = currentNote.backlinks?.length || 0;
    const linkCount = currentNote.outgoing_links?.filter(link => link.resolved).length || 0;
    graphFocusTitle.textContent = currentNote.title;
    graphFocusMeta.textContent = `${formatTypeLabel(currentNote.type)} node with ${linkCount} outgoing links and ${backlinkCount} backlinks.`;
    graphFocusState.textContent = formatTypeLabel(currentNote.type);
    graphFocusLinks.textContent = String(linkCount);
    graphFocusBacklinks.textContent = String(backlinkCount);
    graphFocusMode.textContent = 'Focused';
    document.getElementById('graph-focus-bar').classList.remove('graph-focus-idle');
  }

  function renderMetaGrid(note) {
    const items = [
      ['Type', note.type || 'note'],
      ['Status', note.status],
      ['Source', note.source],
      ['Review', note.review_state],
      ['Durability', note.durability],
      ['Derived from', Array.isArray(note.derived_from) ? note.derived_from.join(', ') : ''],
    ].filter(([, value]) => value && String(value).trim().length > 0);

    if (!items.length) {
      return '<div class="note-meta-item"><span class="note-meta-label">State</span><span class="note-meta-value">Metadata will appear here when present.</span></div>';
    }

    return items.map(([label, value]) => `
      <div class="note-meta-item">
        <span class="note-meta-label">${esc(label)}</span>
        <span class="note-meta-value">${esc(String(value))}</span>
      </div>
    `).join('');
  }

  function extractDeck(body) {
    const text = body
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/!\[[^\]]*]\([^)]+\)/g, ' ')
      .replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, '$2$1')
      .replace(/[#>*`_-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return 'A structured note inside the Granite atlas.';
    return text.length > 210 ? `${text.slice(0, 207).trim()}...` : text;
  }

  function formatTypeLabel(type) {
    return type ? type.charAt(0).toUpperCase() + type.slice(1) : 'Note';
  }

  init();
})();
