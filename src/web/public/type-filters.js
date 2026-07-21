/**
 * Granite — Type Filter Registry
 *
 * Resolves the filter list from the configured type registry and the types
 * that are actually present in the selected vault's graph.
 */
window.GraniteTypeFilters = (() => {
  'use strict';

  function configuredTypeNames(typesPayload) {
    const candidates = Array.isArray(typesPayload)
      ? typesPayload.map(type => {
          if (typeof type === 'string') return type;
          if (!type || typeof type !== 'object') return null;
          if (typeof type.name === 'string' && type.name.length > 0) return type.name;
          return typeof type.type === 'string' ? type.type : null;
        })
      : typesPayload && typeof typesPayload === 'object'
        ? Object.keys(typesPayload)
        : [];

    const seen = new Set();
    return candidates.filter(type => {
      if (typeof type !== 'string' || type.length === 0 || seen.has(type)) return false;
      seen.add(type);
      return true;
    });
  }

  function visibleTypeNames(typesPayload, nodes) {
    const present = new Set();
    for (const node of Array.isArray(nodes) ? nodes : []) {
      if (node && typeof node.type === 'string' && node.type.length > 0) {
        present.add(node.type);
      }
    }

    const configured = configuredTypeNames(typesPayload);
    const configuredSet = new Set(configured);
    const visible = configured.filter(type => present.has(type));
    const unregistered = [...present]
      .filter(type => !configuredSet.has(type))
      .sort((a, b) => a.localeCompare(b));

    return visible.concat(unregistered);
  }

  function noteType(result, nodesBySlug) {
    if (result && typeof result.type === 'string' && result.type.length > 0) {
      return result.type;
    }

    const graphType = result && nodesBySlug?.[result.slug]?.type;
    return typeof graphType === 'string' && graphType.length > 0 ? graphType : 'note';
  }

  return { visibleTypeNames, noteType };
})();
