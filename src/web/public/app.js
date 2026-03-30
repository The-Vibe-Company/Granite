/**
 * Granite — App Controller
 *
 * Sidebar, HTML note rendering, wikilink previews,
 * note creation, graph toggle, keyboard navigation.
 */

(function () {
  // ── State ──
  let allNotes = [];
  let currentNote = null;
  let currentType = '';
  let searchTimeout = null;
  let isSearchMode = false;
  let currentView = 'note'; // 'note' | 'graph'
  let isCreateOpen = false;
  let graphData = null;
  let previewCache = {};
  let previewTimeout = null;
  let keyboardIndex = -1;

  // ── DOM ──
  const sidebar = document.getElementById('sidebar');
  const searchBox = document.getElementById('search-box');
  const typeFilters = document.getElementById('type-filters');
  const noteList = document.getElementById('note-list');
  const noteHeader = document.getElementById('note-header');
  const noteTitle = document.getElementById('note-title');
  const noteBreadcrumb = document.getElementById('note-breadcrumb');
  const noteTypeBadge = document.getElementById('note-type-badge');
  const noteDate = document.getElementById('note-date');
  const noteTags = document.getElementById('note-tags');
  const noteBody = document.getElementById('note-body');
  const backlinksPanel = document.getElementById('backlinks-panel');
  const backlinksList = document.getElementById('backlinks-list');
  const backlinksCount = document.getElementById('backlinks-count');
  const emptyState = document.getElementById('empty-state');
  const contentWrapper = document.getElementById('content-wrapper');
  const graphView = document.getElementById('graph-view');
  const graphCanvas = document.getElementById('graph-canvas');
  const createPanel = document.getElementById('create-panel');
  const previewEl = document.getElementById('wikilink-preview');

  // ── API ──
  async function api(url, opts) {
    const res = await fetch(url, opts);
    return res.json();
  }

  // ── Init ──
  async function init() {
    const { types } = await api('/api/types');
    for (const name of Object.keys(types)) {
      const btn = document.createElement('button');
      btn.className = 'type-chip';
      btn.dataset.type = name;
      btn.textContent = name;
      btn.addEventListener('click', () => filterByType(name));
      typeFilters.appendChild(btn);
    }

    // Populate create panel type selector
    const createTypeSelect = document.getElementById('create-type');
    for (const name of Object.keys(types)) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      createTypeSelect.appendChild(opt);
    }

    typeFilters.querySelector('[data-type=""]').addEventListener('click', () => filterByType(''));

    await loadNotes();
    setupSearch();
    setupKeyboard();
    setupSidebar();
    setupCreate();
    setupWikilinkPreviews();
  }

  // ═══════════════════════════════════
  // SEARCH
  // ═══════════════════════════════════

  function setupSearch() {
    searchBox.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        const q = searchBox.value.trim();
        if (q.length > 0) {
          searchNotes(q);
          isSearchMode = true;
        } else {
          isSearchMode = false;
          renderNoteList(allNotes);
        }
        keyboardIndex = -1;
      }, 180);
    });

    searchBox.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        searchBox.value = '';
        searchBox.blur();
        isSearchMode = false;
        renderNoteList(allNotes);
        keyboardIndex = -1;
      }
      if (e.key === 'Enter') {
        const items = noteList.querySelectorAll('.note-item');
        const target = keyboardIndex >= 0 ? items[keyboardIndex] : items[0];
        if (target) target.click();
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        navigateList(1);
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        navigateList(-1);
      }
    });
  }

  // ═══════════════════════════════════
  // KEYBOARD NAVIGATION
  // ═══════════════════════════════════

  function navigateList(delta) {
    const items = noteList.querySelectorAll('.note-item');
    if (items.length === 0) return;

    // Clear old focus
    items.forEach(el => el.classList.remove('keyboard-focus'));

    keyboardIndex += delta;
    if (keyboardIndex < 0) keyboardIndex = items.length - 1;
    if (keyboardIndex >= items.length) keyboardIndex = 0;

    items[keyboardIndex].classList.add('keyboard-focus');
    items[keyboardIndex].scrollIntoView({ block: 'nearest' });
  }

  function setupKeyboard() {
    document.addEventListener('keydown', (e) => {
      // ⌘K — focus search
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        if (sidebar.classList.contains('collapsed')) toggleSidebar();
        closeCreate();
        searchBox.focus();
        searchBox.select();
      }

      // ⌘N — new note
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        toggleCreate();
      }

      // ⌘G — toggle graph
      if ((e.metaKey || e.ctrlKey) && e.key === 'g') {
        e.preventDefault();
        toggleGraph();
      }

      // Escape — close panels / deselect
      if (e.key === 'Escape' && document.activeElement !== searchBox) {
        if (isCreateOpen) {
          closeCreate();
        } else if (currentView === 'graph') {
          setView('note');
        } else if (currentNote) {
          currentNote = null;
          showEmptyState();
        }
      }

      // ↑/↓ in note list (when not focused on inputs)
      if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
        if (e.key === 'ArrowDown') { e.preventDefault(); navigateList(1); }
        if (e.key === 'ArrowUp') { e.preventDefault(); navigateList(-1); }
        if (e.key === 'Enter' && keyboardIndex >= 0) {
          const items = noteList.querySelectorAll('.note-item');
          if (items[keyboardIndex]) items[keyboardIndex].click();
        }
      }
    });
  }

  // ═══════════════════════════════════
  // SIDEBAR
  // ═══════════════════════════════════

  function setupSidebar() {
    document.getElementById('rail-toggle').addEventListener('click', toggleSidebar);
    document.getElementById('rail-search').addEventListener('click', () => {
      if (sidebar.classList.contains('collapsed')) toggleSidebar();
      closeCreate();
      setTimeout(() => { searchBox.focus(); searchBox.select(); }, 200);
    });
    document.getElementById('rail-graph').addEventListener('click', toggleGraph);
    document.getElementById('rail-new').addEventListener('click', toggleCreate);
    document.getElementById('brand-mark').addEventListener('click', () => {
      currentNote = null;
      setView('note');
      showEmptyState();
    });
  }

  function toggleSidebar() {
    sidebar.classList.toggle('expanded');
    sidebar.classList.toggle('collapsed');
  }

  // ═══════════════════════════════════
  // NOTE CREATION
  // ═══════════════════════════════════

  function setupCreate() {
    document.getElementById('create-panel-close').addEventListener('click', closeCreate);
    document.getElementById('create-submit').addEventListener('click', submitCreate);

    // Enter in title field submits if body is empty
    document.getElementById('create-title').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        document.getElementById('create-body').focus();
      }
    });
  }

  function toggleCreate() {
    if (isCreateOpen) {
      closeCreate();
    } else {
      openCreate();
    }
  }

  function openCreate() {
    if (sidebar.classList.contains('collapsed')) toggleSidebar();
    isCreateOpen = true;
    noteList.style.display = 'none';
    document.getElementById('type-filters').style.display = 'none';
    createPanel.style.display = 'flex';
    document.getElementById('rail-new').classList.add('active');
    setTimeout(() => document.getElementById('create-title').focus(), 100);
  }

  function closeCreate() {
    isCreateOpen = false;
    createPanel.style.display = 'none';
    noteList.style.display = '';
    document.getElementById('type-filters').style.display = '';
    document.getElementById('rail-new').classList.remove('active');
    // Reset form
    document.getElementById('create-title').value = '';
    document.getElementById('create-body').value = '';
  }

  async function submitCreate() {
    const type = document.getElementById('create-type').value;
    const title = document.getElementById('create-title').value.trim();
    const body = document.getElementById('create-body').value;

    if (!title) {
      document.getElementById('create-title').focus();
      return;
    }

    const result = await api('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, title, body }),
    });

    if (result.slug) {
      closeCreate();
      await loadNotes();
      loadNote(result.slug);
    }
  }

  // ═══════════════════════════════════
  // GRAPH
  // ═══════════════════════════════════

  function toggleGraph() {
    if (currentView === 'graph') {
      setView('note');
    } else {
      setView('graph');
    }
  }

  function setView(view) {
    currentView = view;
    const graphBtn = document.getElementById('rail-graph');

    if (view === 'graph') {
      graphBtn.classList.add('active');
      contentWrapper.style.display = 'none';
      emptyState.style.display = 'none';
      graphView.style.display = 'flex';
      loadGraph();
    } else {
      graphBtn.classList.remove('active');
      graphView.style.display = 'none';
      GraphEngine.stop();
      if (currentNote) {
        contentWrapper.style.display = 'flex';
        emptyState.style.display = 'none';
      } else {
        contentWrapper.style.display = 'none';
        emptyState.style.display = 'flex';
      }
    }
  }

  async function loadGraph() {
    if (!graphData) {
      graphData = await api('/api/graph');
    }
    GraphEngine.init(graphCanvas, graphData, {
      activeSlug: currentNote?.slug || null,
      onNavigate: (slug) => {
        loadNote(slug);
        setView('note');
      },
    });
  }

  // ═══════════════════════════════════
  // WIKILINK PREVIEWS
  // ═══════════════════════════════════

  function setupWikilinkPreviews() {
    document.addEventListener('mouseover', (e) => {
      const link = e.target.closest('.wikilink');
      if (!link) return;

      clearTimeout(previewTimeout);
      previewTimeout = setTimeout(() => showPreview(link), 300);
    });

    document.addEventListener('mouseout', (e) => {
      const link = e.target.closest('.wikilink');
      if (link || e.relatedTarget?.closest?.('.wikilink-preview')) return;

      clearTimeout(previewTimeout);
      hidePreview();
    });

    previewEl.addEventListener('mouseleave', hidePreview);

    // Click navigation
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

    // Position
    const rect = linkEl.getBoundingClientRect();
    const previewWidth = 280;
    let left = rect.left;
    let top = rect.bottom + 8;

    // Keep on screen
    if (left + previewWidth > window.innerWidth - 16) {
      left = window.innerWidth - previewWidth - 16;
    }
    if (top + 160 > window.innerHeight) {
      top = rect.top - 8;
      previewEl.style.transform = 'translateY(-100%)';
    } else {
      previewEl.style.transform = '';
    }

    previewEl.style.left = left + 'px';
    previewEl.style.top = top + 'px';

    // Content
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

  // ═══════════════════════════════════
  // DATA LOADING
  // ═══════════════════════════════════

  async function loadNotes() {
    const url = currentType ? `/api/notes?type=${currentType}` : '/api/notes';
    const data = await api(url);
    allNotes = data.notes;
    graphData = null; // Invalidate graph cache
    renderNoteList(allNotes);
  }

  function filterByType(type) {
    currentType = type;
    typeFilters.querySelectorAll('.type-chip').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.type === type);
    });
    keyboardIndex = -1;
    loadNotes();
  }

  async function searchNotes(query) {
    const data = await api(`/api/search?q=${encodeURIComponent(query)}`);
    renderNoteList(data.results.map(r => ({
      slug: r.slug,
      title: r.title,
      type: '',
      snippet: r.snippet,
    })));
  }

  // ═══════════════════════════════════
  // RENDER NOTE LIST
  // ═══════════════════════════════════

  function renderNoteList(notes) {
    noteList.innerHTML = '';
    keyboardIndex = -1;

    if (notes.length === 0) {
      noteList.innerHTML = '<div style="padding: 16px 12px; color: var(--text-3); font-size: 12px;">No notes found</div>';
      return;
    }

    for (const note of notes) {
      const item = document.createElement('div');
      item.className = 'note-item' + (currentNote?.slug === note.slug ? ' active' : '');

      let meta = '';
      if (note.type) {
        meta += `<span class="note-item-type ${note.type}">${note.type}</span>`;
      }
      if (note.modified) {
        if (note.type) meta += '<span class="note-item-dot"></span>';
        meta += `<span>${formatDate(note.modified)}</span>`;
      }

      let snippet = '';
      if (note.snippet) {
        snippet = `<div class="note-item-snippet">${note.snippet.replace(/>>>/g, '<mark>').replace(/<<</g, '</mark>')}</div>`;
      }

      item.innerHTML = `
        <div class="note-item-title">${esc(note.title)}</div>
        <div class="note-item-meta">${meta}</div>
        ${snippet}
      `;
      item.addEventListener('click', () => loadNote(note.slug));
      noteList.appendChild(item);
    }
  }

  // ═══════════════════════════════════
  // LOAD + RENDER NOTE
  // ═══════════════════════════════════

  async function loadNote(slug) {
    const note = await api(`/api/notes/${slug}`);
    if (note.error) return;

    currentNote = note;

    // Switch to note view if in graph
    if (currentView === 'graph') {
      setView('note');
    }

    // Show content, hide empty state
    emptyState.style.display = 'none';
    contentWrapper.style.display = 'flex';
    noteHeader.style.display = 'block';
    noteBody.style.display = 'block';

    // Animate header
    noteHeader.style.animation = 'none';
    noteHeader.offsetHeight;
    noteHeader.style.animation = 'fadeSlideIn 0.35s var(--ease-out)';

    // Header content
    noteBreadcrumb.textContent = note.type;
    noteTitle.textContent = note.title;
    noteTypeBadge.textContent = note.type;
    noteTypeBadge.className = 'meta-badge';
    noteDate.textContent = formatDate(note.created);
    noteTags.innerHTML = (note.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('');

    // Render markdown body as HTML
    noteBody.style.animation = 'none';
    noteBody.offsetHeight;
    noteBody.style.animation = 'fadeSlideIn 0.45s var(--ease-out) 0.05s both';
    noteBody.innerHTML = MarkdownRenderer.render(note.body, note.outgoing_links);

    // Backlinks
    if (note.backlinks && note.backlinks.length > 0) {
      backlinksPanel.style.display = 'block';
      backlinksCount.textContent = note.backlinks.length;
      backlinksList.innerHTML = '';
      for (const bl of note.backlinks) {
        const item = document.createElement('div');
        item.className = 'backlink-item';
        item.innerHTML = `
          <div class="backlink-title">
            <span class="backlink-arrow">←</span>
            ${esc(bl.source_title)}
          </div>
          ${bl.context ? `<div class="backlink-context">${esc(bl.context)}</div>` : ''}
        `;
        item.addEventListener('click', () => loadNote(bl.source_slug));
        backlinksList.appendChild(item);
      }
    } else {
      backlinksPanel.style.display = 'none';
    }

    // Update active state in list
    noteList.querySelectorAll('.note-item').forEach((el, idx) => {
      const noteData = isSearchMode ? null : allNotes[idx];
      el.classList.toggle('active', noteData?.slug === slug);
    });

    // Update graph if it was loaded
    if (graphData) {
      GraphEngine.setActiveSlug(slug);
    }

    contentWrapper.scrollTop = 0;
  }

  function showEmptyState() {
    noteHeader.style.display = 'none';
    noteBody.style.display = 'none';
    backlinksPanel.style.display = 'none';
    contentWrapper.style.display = 'none';
    emptyState.style.display = 'flex';
  }

  // ═══════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════

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

  // ── Boot ──
  init();
})();
