/**
 * Granite — App Controller
 * Sidebar (DOM) + Canvas note rendering
 * Linear/Attio-inspired interactions
 */

(function () {
  // ── State ──
  let allNotes = [];
  let currentNote = null;
  let currentType = '';
  let searchTimeout = null;
  let isSearchMode = false;

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
  const canvasContainer = document.getElementById('canvas-container');
  const canvas = document.getElementById('note-canvas');
  const backlinksPanel = document.getElementById('backlinks-panel');
  const backlinksList = document.getElementById('backlinks-list');
  const backlinksCount = document.getElementById('backlinks-count');
  const emptyState = document.getElementById('empty-state');
  const contentWrapper = document.getElementById('content-wrapper');

  // ── API ──
  async function api(url) {
    const res = await fetch(url);
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

    typeFilters.querySelector('[data-type=""]').addEventListener('click', () => filterByType(''));

    await loadNotes();
    setupSearch();
    setupCanvas();
    setupKeyboard();
    setupSidebar();
  }

  // ── Search ──
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
      }, 180);
    });

    searchBox.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        searchBox.value = '';
        searchBox.blur();
        isSearchMode = false;
        renderNoteList(allNotes);
      }
      if (e.key === 'Enter') {
        const first = noteList.querySelector('.note-item');
        if (first) first.click();
      }
    });
  }

  // ── Canvas interactions ──
  function setupCanvas() {
    canvas._scrollOffset = 0;

    // Smooth scroll with momentum
    canvas.addEventListener('wheel', (e) => {
      if (!currentNote) return;
      e.preventDefault();
      const delta = e.deltaY;
      canvas._scrollOffset = Math.max(0, (canvas._scrollOffset || 0) + delta);
      const maxScroll = Math.max(0, (canvas._contentHeight || 0) - canvasContainer.clientHeight + 40);
      canvas._scrollOffset = Math.min(canvas._scrollOffset, maxScroll);
      CanvasRenderer.render(canvas, currentNote);
    }, { passive: false });

    // Click — wikilink navigation
    canvas.addEventListener('click', (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top + (canvas._scrollOffset || 0);
      const hit = CanvasRenderer.hitTest(x, y);
      if (hit && hit.slug) loadNote(hit.slug);
    });

    // Hover — cursor change on links
    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top + (canvas._scrollOffset || 0);
      const hit = CanvasRenderer.hitTest(x, y);
      canvas.style.cursor = hit ? 'pointer' : 'default';
    });

    // Resize
    const ro = new ResizeObserver(() => {
      if (currentNote) CanvasRenderer.render(canvas, currentNote);
    });
    ro.observe(canvasContainer);
  }

  // ── Keyboard shortcuts ──
  function setupKeyboard() {
    document.addEventListener('keydown', (e) => {
      // ⌘K — focus search
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        if (sidebar.classList.contains('collapsed')) toggleSidebar();
        searchBox.focus();
        searchBox.select();
      }
      // Escape — clear search / deselect note
      if (e.key === 'Escape' && document.activeElement !== searchBox) {
        if (currentNote) {
          currentNote = null;
          showEmptyState();
        }
      }
    });
  }

  // ── Sidebar toggle ──
  function setupSidebar() {
    document.getElementById('rail-toggle').addEventListener('click', toggleSidebar);
    document.getElementById('rail-search').addEventListener('click', () => {
      if (sidebar.classList.contains('collapsed')) toggleSidebar();
      setTimeout(() => { searchBox.focus(); searchBox.select(); }, 200);
    });
    document.getElementById('brand-mark').addEventListener('click', () => {
      currentNote = null;
      showEmptyState();
    });
  }

  function toggleSidebar() {
    sidebar.classList.toggle('expanded');
    sidebar.classList.toggle('collapsed');
    // Re-render canvas after transition
    setTimeout(() => {
      if (currentNote) CanvasRenderer.render(canvas, currentNote);
    }, 320);
  }

  // ── Data loading ──
  async function loadNotes() {
    const url = currentType ? `/api/notes?type=${currentType}` : '/api/notes';
    const data = await api(url);
    allNotes = data.notes;
    renderNoteList(allNotes);
  }

  function filterByType(type) {
    currentType = type;
    typeFilters.querySelectorAll('.type-chip').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.type === type);
    });
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

  // ── Render sidebar note list ──
  function renderNoteList(notes) {
    noteList.innerHTML = '';

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

  // ── Load and display a note ──
  async function loadNote(slug) {
    const note = await api(`/api/notes/${slug}`);
    if (note.error) return;

    currentNote = note;
    canvas._scrollOffset = 0;

    // Show content, hide empty state
    emptyState.style.display = 'none';
    noteHeader.style.display = 'block';
    canvasContainer.style.display = 'flex';

    // Fade in animation
    noteHeader.style.animation = 'none';
    noteHeader.offsetHeight; // reflow
    noteHeader.style.animation = 'fadeSlideIn 0.35s var(--ease-out)';

    // Header
    noteBreadcrumb.textContent = note.type;
    noteTitle.textContent = note.title;
    noteTypeBadge.textContent = note.type;
    noteTypeBadge.className = 'meta-badge';
    noteDate.textContent = formatDate(note.created);
    noteTags.innerHTML = (note.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('');

    // Render canvas with fade
    canvas.style.opacity = '0';
    CanvasRenderer.render(canvas, note);
    requestAnimationFrame(() => {
      canvas.style.transition = 'opacity 0.3s';
      canvas.style.opacity = '1';
    });

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
    noteList.querySelectorAll('.note-item').forEach(el => {
      const idx = Array.from(noteList.children).indexOf(el);
      const noteData = allNotes[idx];
      el.classList.toggle('active', noteData?.slug === slug);
    });

    // Scroll content to top
    contentWrapper.scrollTop = 0;
  }

  function showEmptyState() {
    noteHeader.style.display = 'none';
    canvasContainer.style.display = 'none';
    backlinksPanel.style.display = 'none';
    emptyState.style.display = 'flex';
  }

  // ── Helpers ──
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
