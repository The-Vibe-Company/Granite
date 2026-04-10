import {
  applyTuningToState,
  buildLayoutState,
  finalizeLayoutState,
  focusNodeInState,
  iterateLayout,
  reheatState,
  serializeFrame,
  serializeGraph,
} from './graph-layout-logic.js';

let layoutState = null;
let loopTimer = null;

function clearLoop() {
  if (loopTimer) {
    clearTimeout(loopTimer);
    loopTimer = null;
  }
}

function postCurrentFrame(includeGraph = false) {
  if (!layoutState) return;
  const frame = serializeFrame(layoutState);
  self.postMessage({
    type: 'layoutFrame',
    frame,
    graph: includeGraph ? serializeGraph(layoutState) : null,
  });
}

function scheduleLoop() {
  if (loopTimer || !layoutState) return;
  loopTimer = setTimeout(runLoop, 16);
}

function runLoop() {
  loopTimer = null;
  if (!layoutState) return;

  iterateLayout(layoutState, 4);
  if (!layoutState.settled && layoutState.iteration >= 320) {
    finalizeLayoutState(layoutState);
  }
  postCurrentFrame(false);

  if (layoutState.settled) {
    self.postMessage({
      type: 'settled',
      stats: serializeFrame(layoutState).stats,
    });
    return;
  }

  scheduleLoop();
}

self.onmessage = (event) => {
  const { type, graph, tuning, activeSlug, slug, x, y } = event.data || {};

  switch (type) {
    case 'initGraph': {
      clearLoop();
      layoutState = buildLayoutState(graph, tuning, activeSlug || null);
      postCurrentFrame(true);
      if (!layoutState.settled) scheduleLoop();
      break;
    }

    case 'setTuning': {
      if (!layoutState) break;
      clearLoop();
      applyTuningToState(layoutState, tuning || {});
      reheatState(layoutState, 0.8);
      postCurrentFrame(false);
      scheduleLoop();
      break;
    }

    case 'reheat': {
      if (!layoutState) break;
      clearLoop();
      reheatState(layoutState, 1);
      postCurrentFrame(false);
      scheduleLoop();
      break;
    }

    case 'pinNode': {
      if (!layoutState || !slug) break;
      const node = layoutState.nodesBySlug.get(slug);
      if (!node) break;
      node.pinned = true;
      node.pinX = x;
      node.pinY = y;
      node.x = x;
      node.y = y;
      node.vx = 0;
      node.vy = 0;
      layoutState.settled = false;
      layoutState.stableTicks = 0;
      postCurrentFrame(false);
      scheduleLoop();
      break;
    }

    case 'releaseNode': {
      if (!layoutState || !slug) break;
      const node = layoutState.nodesBySlug.get(slug);
      if (!node) break;
      node.pinned = false;
      delete node.pinX;
      delete node.pinY;
      reheatState(layoutState, 0.55);
      postCurrentFrame(false);
      scheduleLoop();
      break;
    }

    case 'focusNode': {
      if (!layoutState) break;
      focusNodeInState(layoutState, slug || null);
      postCurrentFrame(false);
      scheduleLoop();
      break;
    }

    default:
      break;
  }
};
