/**
 * Granite — HTML Markdown Renderer
 *
 * Converts markdown + wikilinks to semantic HTML.
 * Supports: headings, lists, blockquotes, code, tables, inline formatting, wikilinks.
 */
window.MarkdownRenderer = (() => {

  function parseInline(text, outgoingLinks) {
    const re = /(\[\[([^\]]+)\]\])|(`([^`]+)`)|(\*\*(.+?)\*\*)|(\*(.+?)\*)|(\[([^\]]+)\]\(([^)]+)\))|(!\[([^\]]*)\]\(([^)]+)\))/g;
    let result = '';
    let lastIndex = 0;
    let match;

    while ((match = re.exec(text)) !== null) {
      if (match.index > lastIndex) result += escapeHtml(text.slice(lastIndex, match.index));

      if (match[1]) {
        const inner = match[2];
        const parts = inner.split('|');
        const target = parts[0].trim();
        const display = parts.length > 1 ? parts[1].trim() : target;
        const linkInfo = outgoingLinks?.find(l => l.target === target);
        const resolved = linkInfo?.resolved ?? false;
        const slug = linkInfo?.resolved_slug || null;
        if (resolved && slug) {
          result += `<a class="wikilink" data-slug="${escapeAttr(slug)}" href="#" role="link">${escapeHtml(display)}</a>`;
        } else {
          result += `<span class="wikilink-broken">${escapeHtml(display)}</span>`;
        }
      } else if (match[3]) {
        result += `<code class="inline-code">${escapeHtml(match[4])}</code>`;
      } else if (match[5]) {
        result += `<strong>${escapeHtml(match[6])}</strong>`;
      } else if (match[7]) {
        result += `<em>${escapeHtml(match[8])}</em>`;
      } else if (match[9]) {
        result += `<a class="external-link" href="${escapeAttr(match[11])}" target="_blank" rel="noopener">${escapeHtml(match[10])}</a>`;
      } else if (match[12]) {
        // Image: ![alt](src)
        const alt = match[13];
        const src = match[14];
        // Resolve relative paths to /assets/. <img> requests can't carry the
        // X-Granite-Instance header, so the active cloud instance rides along
        // as a query param for the local gateway to route.
        let resolvedSrc = src.startsWith('http') ? src : `/assets/${src.replace(/^\.?\/?assets\//, '')}`;
        if (!src.startsWith('http') && window.GRANITE_INSTANCE) {
          resolvedSrc += (resolvedSrc.includes('?') ? '&' : '?') + 'instance=' + encodeURIComponent(window.GRANITE_INSTANCE);
        }
        result += `<img class="md-image" src="${escapeAttr(resolvedSrc)}" alt="${escapeAttr(alt)}" loading="lazy">`;
      }
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) result += escapeHtml(text.slice(lastIndex));
    return result;
  }

  function render(body, outgoingLinks) {
    const lines = body.split('\n');
    const blocks = [];
    let inCodeBlock = false;
    let codeBuffer = [];
    let codeLang = '';
    let inList = false;
    let listType = null;
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

      // Code block
      if (line.startsWith('```')) {
        if (inCodeBlock) {
          const langLabel = codeLang ? `<span class="code-lang">${escapeHtml(codeLang)}</span>` : '';
          blocks.push(`<div class="code-block">${langLabel}<pre><code>${escapeHtml(codeBuffer.join('\n'))}</code></pre></div>`);
          codeBuffer = [];
          inCodeBlock = false;
        } else {
          flushList();
          inCodeBlock = true;
          codeLang = line.slice(3).trim();
        }
        continue;
      }
      if (inCodeBlock) { codeBuffer.push(line); continue; }

      // Blank line
      if (line.trim() === '') { flushList(); continue; }

      // Table detection: line starts with |
      if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
        flushList();
        const tableLines = [];
        let j = i;
        while (j < lines.length && lines[j].trim().startsWith('|') && lines[j].trim().endsWith('|')) {
          tableLines.push(lines[j]);
          j++;
        }
        if (tableLines.length >= 2) {
          blocks.push(renderTable(tableLines, outgoingLinks));
          i = j - 1;
          continue;
        }
      }

      // Headings
      const hMatch = line.match(/^(#{1,3})\s+(.+)/);
      if (hMatch) {
        flushList();
        const level = hMatch[1].length;
        blocks.push(`<h${level} class="md-h${level}">${parseInline(hMatch[2], outgoingLinks)}</h${level}>`);
        continue;
      }

      // HR
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
        flushList();
        blocks.push('<hr class="md-hr">');
        continue;
      }

      // Blockquote
      if (line.startsWith('>')) {
        flushList();
        const text = line.replace(/^>\s?/, '');
        blocks.push(`<blockquote class="md-blockquote">${parseInline(text, outgoingLinks)}</blockquote>`);
        continue;
      }

      // Unordered list
      const bulletMatch = line.match(/^(\s*)[*\-+]\s+(.+)/);
      if (bulletMatch) {
        if (listType !== 'ul') flushList();
        inList = true;
        listType = 'ul';
        listItems.push(`<li>${parseInline(bulletMatch[2], outgoingLinks)}</li>`);
        continue;
      }

      // Ordered list
      const numMatch = line.match(/^(\s*)\d+\.\s+(.+)/);
      if (numMatch) {
        if (listType !== 'ol') flushList();
        inList = true;
        listType = 'ol';
        listItems.push(`<li>${parseInline(numMatch[2], outgoingLinks)}</li>`);
        continue;
      }

      // Paragraph
      flushList();
      blocks.push(`<p class="md-body">${parseInline(line, outgoingLinks)}</p>`);
    }

    flushList();
    if (inCodeBlock && codeBuffer.length > 0) {
      blocks.push(`<div class="code-block"><pre><code>${escapeHtml(codeBuffer.join('\n'))}</code></pre></div>`);
    }
    return blocks.join('\n');
  }

  function renderTable(tableLines, outgoingLinks) {
    const parseRow = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
    const headers = parseRow(tableLines[0]);
    // Skip separator row (index 1)
    const rows = tableLines.slice(2).map(parseRow);

    let html = '<div class="md-table-wrap"><table class="md-table"><thead><tr>';
    for (const h of headers) html += `<th>${parseInline(h, outgoingLinks)}</th>`;
    html += '</tr></thead><tbody>';
    for (const row of rows) {
      html += '<tr>';
      for (const cell of row) html += `<td>${parseInline(cell, outgoingLinks)}</td>`;
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    return html;
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function escapeAttr(str) {
    return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  return { render, parseInline, escapeHtml };
})();
