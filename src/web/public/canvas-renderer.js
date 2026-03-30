/**
 * Granite Canvas Renderer
 *
 * Premium text rendering engine inspired by Pretext's approach:
 * precise measurement, line-by-line layout, per-character styling.
 * Renders markdown onto <canvas> with editorial typography.
 */

const CanvasRenderer = (() => {

  // ── Typography system ──
  const FONTS = {
    serif:  '"Instrument Serif", Georgia, serif',
    sans:   '"Instrument Sans", -apple-system, sans-serif',
    mono:   '"JetBrains Mono", "SF Mono", monospace',
  };

  const THEME = {
    bg:             '#0b0b0e',
    text:           '#e4e4e8',
    textBright:     '#f8f8fa',
    textDim:        '#7e7e8a',
    heading:        '#ffffff',
    headingAccent:  '#b4c0fc',
    link:           '#818cf8',
    linkBroken:     '#f87171',
    linkUnderline:  'rgba(129, 140, 248, 0.35)',
    codeBg:         '#141418',
    codeBorder:     '#222228',
    codeText:       '#c4ccda',
    quoteBorder:    '#3b3b45',
    quoteText:      '#9a9aaa',
    bulletDot:      '#4e4e5a',
    hrColor:        '#222228',
    selection:      'rgba(99, 102, 241, 0.2)',
  };

  // Style definitions — font, size, weight, color, spacing
  const STYLES = {
    h1: {
      font: `400 28px/1.25 ${FONTS.serif}`,
      size: 28, color: THEME.heading,
      marginTop: 32, marginBottom: 14,
      letterSpacing: -0.3,
    },
    h2: {
      font: `400 22px/1.3 ${FONTS.serif}`,
      size: 22, color: THEME.heading,
      marginTop: 28, marginBottom: 10,
      letterSpacing: -0.2,
    },
    h3: {
      font: `600 15px/1.4 ${FONTS.sans}`,
      size: 15, color: THEME.headingAccent,
      marginTop: 24, marginBottom: 8,
      letterSpacing: 0.3,
      transform: 'uppercase',
    },
    body: {
      font: `400 14.5px/1.7 ${FONTS.sans}`,
      size: 14.5, color: THEME.text,
      marginTop: 0, marginBottom: 4,
      letterSpacing: 0.1,
    },
    bullet: {
      font: `400 14.5px/1.7 ${FONTS.sans}`,
      size: 14.5, color: THEME.text,
      marginTop: 1, marginBottom: 1,
      letterSpacing: 0.1,
    },
    code: {
      font: `400 12.5px/1.6 ${FONTS.mono}`,
      size: 12.5, color: THEME.codeText,
      marginTop: 12, marginBottom: 12,
      padding: 14, radius: 6,
      bg: THEME.codeBg, border: THEME.codeBorder,
    },
    blockquote: {
      font: `italic 400 14.5px/1.7 ${FONTS.serif}`,
      size: 14.5, color: THEME.quoteText,
      marginTop: 10, marginBottom: 10,
      borderColor: THEME.quoteBorder,
    },
  };

  const LINE_HEIGHT_RATIO = 1.7;
  const PADDING_X = 32;
  const PADDING_Y = 28;
  const MAX_WIDTH = 600;

  // ── Font size extractor ──
  function getFontSize(style) {
    return style.size || 14.5;
  }

  // ── Markdown parser ──
  function parseMarkdown(body, outgoingLinks) {
    const lines = body.split('\n');
    const segments = [];
    let inCodeBlock = false;
    let codeBuffer = [];
    let codeLang = '';

    for (const line of lines) {
      if (line.startsWith('```')) {
        if (inCodeBlock) {
          segments.push({ type: 'code', text: codeBuffer.join('\n'), lang: codeLang });
          codeBuffer = [];
          inCodeBlock = false;
        } else {
          inCodeBlock = true;
          codeLang = line.slice(3).trim();
        }
        continue;
      }
      if (inCodeBlock) { codeBuffer.push(line); continue; }
      if (line.trim() === '') { segments.push({ type: 'blank' }); continue; }

      const hMatch = line.match(/^(#{1,3})\s+(.+)/);
      if (hMatch) {
        const level = hMatch[1].length;
        segments.push({ type: `h${level}`, text: hMatch[2], spans: parseInline(hMatch[2], outgoingLinks) });
        continue;
      }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
        segments.push({ type: 'hr' });
        continue;
      }
      if (line.startsWith('>')) {
        const text = line.replace(/^>\s?/, '');
        segments.push({ type: 'blockquote', text, spans: parseInline(text, outgoingLinks) });
        continue;
      }
      const bulletMatch = line.match(/^(\s*)[*\-+]\s+(.+)/);
      if (bulletMatch) {
        segments.push({ type: 'bullet', text: bulletMatch[2], indent: Math.floor(bulletMatch[1].length / 2), spans: parseInline(bulletMatch[2], outgoingLinks) });
        continue;
      }
      // Numbered list
      const numMatch = line.match(/^(\s*)\d+\.\s+(.+)/);
      if (numMatch) {
        segments.push({ type: 'bullet', text: numMatch[2], indent: Math.floor(numMatch[1].length / 2), spans: parseInline(numMatch[2], outgoingLinks), numbered: true });
        continue;
      }
      segments.push({ type: 'body', text: line, spans: parseInline(line, outgoingLinks) });
    }
    if (inCodeBlock && codeBuffer.length > 0) {
      segments.push({ type: 'code', text: codeBuffer.join('\n'), lang: codeLang });
    }
    return segments;
  }

  // ── Inline parser ──
  function parseInline(text, outgoingLinks) {
    const spans = [];
    const re = /(\[\[([^\]]+)\]\])|(`([^`]+)`)|(\*\*(.+?)\*\*)|(\*(.+?)\*)/g;
    let lastIndex = 0;
    let match;

    while ((match = re.exec(text)) !== null) {
      if (match.index > lastIndex) {
        spans.push({ type: 'text', text: text.slice(lastIndex, match.index) });
      }
      if (match[1]) {
        const inner = match[2];
        const parts = inner.split('|');
        const target = parts[0].trim();
        const display = parts.length > 1 ? parts[1].trim() : target;
        const linkInfo = outgoingLinks?.find(l => l.target === target);
        spans.push({ type: 'wikilink', text: display, target, resolved: linkInfo?.resolved ?? false, slug: linkInfo?.resolved_slug || null });
      } else if (match[3]) {
        spans.push({ type: 'inline_code', text: match[4] });
      } else if (match[5]) {
        spans.push({ type: 'bold', text: match[6] });
      } else if (match[7]) {
        spans.push({ type: 'italic', text: match[8] });
      }
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      spans.push({ type: 'text', text: text.slice(lastIndex) });
    }
    return spans;
  }

  // ── Text measurement & wrapping ──
  function wrapText(ctx, text, maxWidth) {
    const words = text.split(/(\s+)/);
    const lines = [];
    let currentLine = '';
    for (const word of words) {
      const testLine = currentLine + word;
      if (ctx.measureText(testLine).width > maxWidth && currentLine.trim() !== '') {
        lines.push(currentLine);
        currentLine = word.trimStart();
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) lines.push(currentLine);
    return lines.length > 0 ? lines : [''];
  }

  // ── Span layout: wrap text across spans preserving span styling ──
  function layoutSpans(ctx, spans, baseFont, maxWidth) {
    const fullText = spans.map(s => s.text).join('');
    ctx.font = baseFont;
    const wrappedLines = wrapText(ctx, fullText, maxWidth);

    const charMap = [];
    for (const span of spans) {
      for (let i = 0; i < span.text.length; i++) charMap.push(span);
    }

    const result = [];
    let charIdx = 0;
    for (const line of wrappedLines) {
      const lineSpans = [];
      let runStart = charIdx;
      let currentSpan = charMap[charIdx];
      for (let i = 0; i < line.length; i++) {
        const span = charMap[charIdx + i];
        if (span !== currentSpan) {
          lineSpans.push({ span: currentSpan, text: line.slice(runStart - charIdx, i) });
          currentSpan = span;
          runStart = charIdx + i;
        }
      }
      lineSpans.push({ span: currentSpan, text: line.slice(runStart - charIdx) });
      result.push(lineSpans);
      charIdx += line.length;
    }
    return result;
  }

  // ── Hit boxes for interactive elements ──
  let hitBoxes = [];

  function clearHitBoxes() { hitBoxes = []; }

  function registerHitBox(x, y, width, height, data) {
    hitBoxes.push({ x, y, width, height, ...data });
  }

  function hitTest(x, y) {
    for (const box of hitBoxes) {
      if (x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height) {
        return box;
      }
    }
    return null;
  }

  // ── Drawing helpers ──
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // Subtle underline with custom thickness and offset
  function drawUnderline(ctx, x, y, width, color, opts = {}) {
    const { thickness = 1, offset = 3, dashed = false } = opts;
    ctx.strokeStyle = color;
    ctx.lineWidth = thickness;
    if (dashed) ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, y + offset);
    ctx.lineTo(x + width, y + offset);
    ctx.stroke();
    if (dashed) ctx.setLineDash([]);
  }

  // ── Main render ──
  function render(canvas, note, opts = {}) {
    const dpr = window.devicePixelRatio || 1;
    const container = canvas.parentElement;
    const displayWidth = container.clientWidth;
    const displayHeight = container.clientHeight;

    canvas.width = displayWidth * dpr;
    canvas.height = displayHeight * dpr;
    canvas.style.width = displayWidth + 'px';
    canvas.style.height = displayHeight + 'px';

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // Fill background
    ctx.fillStyle = THEME.bg;
    ctx.fillRect(0, 0, displayWidth, displayHeight);

    clearHitBoxes();

    const contentWidth = Math.min(displayWidth - PADDING_X * 2, MAX_WIDTH);
    const offsetX = (displayWidth - contentWidth) / 2;
    const scrollOffset = canvas._scrollOffset || 0;
    let y = PADDING_Y - scrollOffset;

    const segments = parseMarkdown(note.body, note.outgoing_links);
    let bulletIndex = 0;

    for (const seg of segments) {
      // ── Blank line ──
      if (seg.type === 'blank') {
        y += 10;
        bulletIndex = 0;
        continue;
      }

      // ── Horizontal rule ──
      if (seg.type === 'hr') {
        y += 20;
        ctx.strokeStyle = THEME.hrColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        const hrInset = contentWidth * 0.2;
        ctx.moveTo(offsetX + hrInset, y);
        ctx.lineTo(offsetX + contentWidth - hrInset, y);
        ctx.stroke();
        y += 20;
        continue;
      }

      // ── Code block ──
      if (seg.type === 'code') {
        const style = STYLES.code;
        y += style.marginTop;
        ctx.font = style.font;

        const codeLines = seg.text.split('\n');
        const lineH = style.size * 1.6;
        const blockHeight = codeLines.length * lineH + style.padding * 2;

        // Background with border
        ctx.fillStyle = style.bg;
        roundRect(ctx, offsetX, y, contentWidth, blockHeight, style.radius);
        ctx.fill();
        ctx.strokeStyle = style.border;
        ctx.lineWidth = 1;
        roundRect(ctx, offsetX, y, contentWidth, blockHeight, style.radius);
        ctx.stroke();

        // Code text
        ctx.fillStyle = style.color;
        for (let i = 0; i < codeLines.length; i++) {
          ctx.fillText(codeLines[i], offsetX + style.padding, y + style.padding + (i + 0.75) * lineH);
        }

        y += blockHeight + style.marginBottom;
        continue;
      }

      // ── Blockquote ──
      if (seg.type === 'blockquote') {
        const style = STYLES.blockquote;
        y += style.marginTop;
        ctx.font = style.font;
        const lineH = style.size * LINE_HEIGHT_RATIO;
        const lines = layoutSpans(ctx, seg.spans, style.font, contentWidth - 24);

        // Accent border
        const borderHeight = lines.length * lineH + 4;
        ctx.fillStyle = style.borderColor;
        roundRect(ctx, offsetX, y - 2, 2, borderHeight, 1);
        ctx.fill();

        for (const lineSpans of lines) {
          y += lineH;
          drawSpanLine(ctx, lineSpans, offsetX + 18, y - style.size * 0.35, style, scrollOffset);
        }
        y += style.marginBottom;
        continue;
      }

      // ── Headings, body, bullets ──
      const styleKey = seg.type.startsWith('h') ? seg.type : (seg.type === 'bullet' ? 'bullet' : 'body');
      const style = STYLES[styleKey];
      if (!style) continue;

      y += style.marginTop;

      // Set font
      const fontStr = style.font;
      ctx.font = fontStr;

      const fontSize = getFontSize(style);
      const lineH = fontSize * LINE_HEIGHT_RATIO;
      const indentPx = seg.type === 'bullet' ? (seg.indent || 0) * 18 + 20 : 0;
      const availWidth = contentWidth - indentPx;

      if (seg.spans) {
        // Handle h3 uppercase transform
        let processedSpans = seg.spans;
        if (style.transform === 'uppercase') {
          processedSpans = seg.spans.map(s => ({ ...s, text: s.text.toUpperCase() }));
        }

        const lines = layoutSpans(ctx, processedSpans, fontStr, availWidth);

        for (let li = 0; li < lines.length; li++) {
          y += lineH;
          let xOff = offsetX + indentPx;

          // Bullet marker
          if (seg.type === 'bullet' && li === 0) {
            if (seg.numbered) {
              bulletIndex++;
              ctx.fillStyle = THEME.textDim;
              ctx.font = `500 12px ${FONTS.sans}`;
              ctx.fillText(`${bulletIndex}.`, offsetX + (seg.indent || 0) * 18, y - fontSize * 0.35);
              ctx.font = fontStr;
            } else {
              ctx.fillStyle = THEME.bulletDot;
              ctx.beginPath();
              ctx.arc(offsetX + (seg.indent || 0) * 18 + 8, y - fontSize * 0.4, 2, 0, Math.PI * 2);
              ctx.fill();
            }
          }

          drawSpanLine(ctx, lines[li], xOff, y - fontSize * 0.35, style, scrollOffset);
        }
      }

      y += style.marginBottom;
    }

    canvas._contentHeight = y + scrollOffset + PADDING_Y;
  }

  // ── Draw a line of styled spans ──
  function drawSpanLine(ctx, lineSpans, x, y, baseStyle, scrollOffset) {
    for (const { span, text } of lineSpans) {
      if (!span) { x += ctx.measureText(text).width; continue; }

      const fontSize = getFontSize(baseStyle);
      let color = baseStyle.color;
      let needsRestore = false;

      switch (span.type) {
        case 'wikilink':
          color = span.resolved ? THEME.link : THEME.linkBroken;
          break;
        case 'bold':
          ctx.font = `600 ${fontSize}px ${FONTS.sans}`;
          color = THEME.textBright;
          needsRestore = true;
          break;
        case 'italic':
          ctx.font = `italic ${fontSize}px ${FONTS.serif}`;
          needsRestore = true;
          break;
        case 'inline_code':
          ctx.font = `400 ${Math.max(fontSize - 2, 11)}px ${FONTS.mono}`;
          needsRestore = true;
          break;
      }

      // Inline code background
      if (span.type === 'inline_code') {
        const w = ctx.measureText(text).width;
        ctx.fillStyle = THEME.codeBg;
        roundRect(ctx, x - 3, y - fontSize * 0.7, w + 6, fontSize * 1.1, 3);
        ctx.fill();
        ctx.strokeStyle = THEME.codeBorder;
        ctx.lineWidth = 0.5;
        roundRect(ctx, x - 3, y - fontSize * 0.7, w + 6, fontSize * 1.1, 3);
        ctx.stroke();
        color = THEME.codeText;
      }

      ctx.fillStyle = color;

      // Letter spacing for headings
      if (baseStyle.letterSpacing && baseStyle.letterSpacing !== 0 && Math.abs(baseStyle.letterSpacing) > 0.15) {
        x = drawWithLetterSpacing(ctx, text, x, y, baseStyle.letterSpacing);
      } else {
        ctx.fillText(text, x, y);
      }

      const textWidth = ctx.measureText(text).width;

      // Wikilink underline
      if (span.type === 'wikilink') {
        const underColor = span.resolved ? THEME.linkUnderline : THEME.linkBroken;
        drawUnderline(ctx, x, y, textWidth, underColor, {
          thickness: span.resolved ? 1.5 : 1,
          offset: 3,
          dashed: !span.resolved,
        });

        // Hit box
        if (span.resolved && span.slug) {
          registerHitBox(x, y + scrollOffset - fontSize, textWidth, fontSize * 1.5, { slug: span.slug });
        }
      }

      if (!baseStyle.letterSpacing || Math.abs(baseStyle.letterSpacing) <= 0.15) {
        x += textWidth;
      }

      if (needsRestore) ctx.font = baseStyle.font;
    }
  }

  // ── Draw text with custom letter spacing ──
  function drawWithLetterSpacing(ctx, text, x, y, spacing) {
    for (const char of text) {
      ctx.fillText(char, x, y);
      x += ctx.measureText(char).width + spacing;
    }
    return x;
  }

  return { render, hitTest, parseMarkdown };
})();
