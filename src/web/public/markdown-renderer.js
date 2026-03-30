/**
 * Granite — HTML Markdown Renderer
 *
 * Converts markdown + wikilinks to semantic HTML.
 * Wikilinks become real <a> elements with hover previews.
 */

const MarkdownRenderer = (() => {

  // ── Inline parser — handles [[wikilinks]], **bold**, *italic*, `code`, [links](url) ──
  function parseInline(text, outgoingLinks) {
    const re = /(\[\[([^\]]+)\]\])|(`([^`]+)`)|(\*\*(.+?)\*\*)|(\*(.+?)\*)|(\[([^\]]+)\]\(([^)]+)\))/g;
    let result = '';
    let lastIndex = 0;
    let match;

    while ((match = re.exec(text)) !== null) {
      if (match.index > lastIndex) {
        result += escapeHtml(text.slice(lastIndex, match.index));
      }

      if (match[1]) {
        // [[wikilink]] or [[target|display]]
        const inner = match[2];
        const parts = inner.split('|');
        const target = parts[0].trim();
        const display = parts.length > 1 ? parts[1].trim() : target;
        const linkInfo = outgoingLinks?.find(l => l.target === target);
        const resolved = linkInfo?.resolved ?? false;
        const slug = linkInfo?.resolved_slug || null;

        if (resolved && slug) {
          result += `<a class="wikilink" data-slug="${escapeAttr(slug)}" data-resolved="true" href="javascript:void(0)">${escapeHtml(display)}</a>`;
        } else {
          result += `<span class="wikilink-broken">${escapeHtml(display)}</span>`;
        }
      } else if (match[3]) {
        // `inline code`
        result += `<code class="inline-code">${escapeHtml(match[4])}</code>`;
      } else if (match[5]) {
        // **bold**
        result += `<strong>${escapeHtml(match[6])}</strong>`;
      } else if (match[7]) {
        // *italic*
        result += `<em>${escapeHtml(match[8])}</em>`;
      } else if (match[9]) {
        // [text](url)
        result += `<a class="external-link" href="${escapeAttr(match[11])}" target="_blank" rel="noopener">${escapeHtml(match[10])}</a>`;
      }

      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
      result += escapeHtml(text.slice(lastIndex));
    }

    return result;
  }

  // ── Block-level markdown parser ──
  function render(body, outgoingLinks) {
    const lines = body.split('\n');
    const blocks = [];
    let inCodeBlock = false;
    let codeBuffer = [];
    let codeLang = '';
    let inList = false;
    let listType = null; // 'ul' or 'ol'
    let listItems = [];

    function flushList() {
      if (listItems.length > 0) {
        const tag = listType === 'ol' ? 'ol' : 'ul';
        blocks.push(`<${tag} class="md-list">${listItems.join('')}</${tag}>`);
        listItems = [];
        inList = false;
        listType = null;
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Code block toggle
      if (line.startsWith('```')) {
        if (inCodeBlock) {
          const langClass = codeLang ? ` data-lang="${escapeAttr(codeLang)}"` : '';
          const langLabel = codeLang ? `<span class="code-lang">${escapeHtml(codeLang)}</span>` : '';
          blocks.push(`<div class="code-block"${langClass}>${langLabel}<pre><code>${escapeHtml(codeBuffer.join('\n'))}</code></pre></div>`);
          codeBuffer = [];
          inCodeBlock = false;
        } else {
          flushList();
          inCodeBlock = true;
          codeLang = line.slice(3).trim();
        }
        continue;
      }

      if (inCodeBlock) {
        codeBuffer.push(line);
        continue;
      }

      // Blank line
      if (line.trim() === '') {
        flushList();
        continue;
      }

      // Headings
      const hMatch = line.match(/^(#{1,3})\s+(.+)/);
      if (hMatch) {
        flushList();
        const level = hMatch[1].length;
        const content = parseInline(hMatch[2], outgoingLinks);
        blocks.push(`<h${level} class="md-h${level}">${content}</h${level}>`);
        continue;
      }

      // Horizontal rule
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
        flushList();
        blocks.push('<hr class="md-hr">');
        continue;
      }

      // Blockquote
      if (line.startsWith('>')) {
        flushList();
        const text = line.replace(/^>\s?/, '');
        const content = parseInline(text, outgoingLinks);
        blocks.push(`<blockquote class="md-blockquote">${content}</blockquote>`);
        continue;
      }

      // Unordered list
      const bulletMatch = line.match(/^(\s*)[*\-+]\s+(.+)/);
      if (bulletMatch) {
        if (listType !== 'ul') flushList();
        inList = true;
        listType = 'ul';
        const content = parseInline(bulletMatch[2], outgoingLinks);
        listItems.push(`<li>${content}</li>`);
        continue;
      }

      // Ordered list
      const numMatch = line.match(/^(\s*)\d+\.\s+(.+)/);
      if (numMatch) {
        if (listType !== 'ol') flushList();
        inList = true;
        listType = 'ol';
        const content = parseInline(numMatch[2], outgoingLinks);
        listItems.push(`<li>${content}</li>`);
        continue;
      }

      // Body paragraph
      flushList();
      const content = parseInline(line, outgoingLinks);
      blocks.push(`<p class="md-body">${content}</p>`);
    }

    // Flush remaining
    flushList();
    if (inCodeBlock && codeBuffer.length > 0) {
      blocks.push(`<div class="code-block"><pre><code>${escapeHtml(codeBuffer.join('\n'))}</code></pre></div>`);
    }

    return blocks.join('\n');
  }

  // ── Helpers ──
  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttr(str) {
    return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  return { render, parseInline, escapeHtml };
})();
