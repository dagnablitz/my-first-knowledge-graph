const GRAPH_DATA = window.GRAPH_DATA;
if (!('closedBy' in HTMLDialogElement.prototype)) {
  const outside = (e, dialog) => {
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
    let pressedOutside = false;
    dialog.addEventListener('pointerdown', (e) => { pressedOutside = outside(e, dialog); });
    dialog.addEventListener('pointerup', (e) => { if (pressedOutside && outside(e, dialog)) dialog.close(); });
  }
}
const canvas = document.getElementById('graph-canvas');
const canvasContainer = document.getElementById('canvas-container');
const ctx = canvas.getContext('2d');
let width = 800, height = 600;
let dpr = window.devicePixelRatio || 1;
const nodeMap = new Map();
const neighborsMap = new Map();
GRAPH_DATA.nodes.forEach((n) => {
  n.vx = 0;
  n.vy = 0;
  n.radius = n.nodeType === 'group' ? 24 : (n.nodeType === 'concept' ? 18 : (n.groups && n.groups.length > 1 ? 9 : 6));
  nodeMap.set(n.id, n);
  neighborsMap.set(n.id, new Set());
});
const edges = GRAPH_DATA.edges.map(e => {
  const s = nodeMap.get(e.source);
  const t = nodeMap.get(e.target);
  neighborsMap.get(s.id).add(t.id);
  neighborsMap.get(t.id).add(s.id);
  return { ...e, sourceNode: s, targetNode: t };
});
const groupNodes = GRAPH_DATA.nodes.filter(n => n.nodeType === 'group');
const conceptNodes = GRAPH_DATA.nodes.filter(n => n.nodeType === 'concept');
const resourceNodes = GRAPH_DATA.nodes.filter(n => n.nodeType === 'resource');
let layoutMode = 'force';
let showAllLinks = true;
let activeRType = 'ALL';
let searchQuery = '';
let selectedNode = null;
let hoveredNode = null;
let draggedNode = null;
let pathStartNode = null;
let highlightedPathNodes = new Set();
let highlightedPathEdges = new Set();
let autoFitMode = 'all';
let baselineAllScale = 0.85;
let camX = 0, camY = 0, camScale = 0.85;
let targetCamX = 0, targetCamY = 0, targetCamScale = 0.85;
let isPanning = false;
let panStartX = 0, panStartY = 0;
let pointerDownPos = { x: 0, y: 0 };
let alpha = 1.0;
let tickCount = 0;
function initPositions() {
  const gCount = groupNodes.length;
  groupNodes.forEach((g, i) => {
    const angle = (i / gCount) * Math.PI * 2 - Math.PI / 2;
    g.x = Math.cos(angle) * 340;
    g.y = Math.sin(angle) * 340;
  });
  const cCount = conceptNodes.length;
  conceptNodes.forEach((c, i) => {
    const angle = (i / cCount) * Math.PI * 2;
    c.x = Math.cos(angle) * 145;
    c.y = Math.sin(angle) * 145;
  });
  resourceNodes.forEach((r, i) => {
    const primaryGroup = nodeMap.get(r.groups[0]);
    const angle = (i * 2.39996) % (Math.PI * 2);
    const dist = 45 + (i % 7) * 12;
    r.x = (primaryGroup ? primaryGroup.x : 0) + Math.cos(angle) * dist;
    r.y = (primaryGroup ? primaryGroup.y : 0) + Math.sin(angle) * dist;
  });
}
initPositions();
function isNodeVisible(n) {
  if (n.nodeType === 'group' || n.nodeType === 'concept') return true;
  if (!showAllLinks) {
    if (!selectedNode) return false;
    if (selectedNode.id === n.id) return true;
    return neighborsMap.get(selectedNode.id).has(n.id);
  }
  if (activeRType === 'BRIDGE_ONLY') {
    return n.groups && n.groups.length > 1;
  }
  if (activeRType !== 'ALL' && n.resourceType !== activeRType) {
    return false;
  }
  return true;
}
function matchesSearch(n) {
  if (!searchQuery) return true;
  const q = searchQuery.toLowerCase();
  return (
    n.label.toLowerCase().includes(q) ||
    (n.description && n.description.toLowerCase().includes(q)) ||
    (n.url && n.url.toLowerCase().includes(q)) ||
    (n.resourceType && n.resourceType.toLowerCase().includes(q))
  );
}
function computeCameraFit(nodesToFit, isSingleFocus = false) {
  if (!nodesToFit || nodesToFit.length === 0) return;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  nodesToFit.forEach(n => {
    const labelPadX = isSingleFocus ? 58 : 42;
    const labelPadBottom = isSingleFocus ? 30 : 24;
    const labelPadTop = isSingleFocus ? 18 : 14;
    minX = Math.min(minX, n.x - n.radius - labelPadX);
    maxX = Math.max(maxX, n.x + n.radius + labelPadX);
    minY = Math.min(minY, n.y - n.radius - labelPadTop);
    maxY = Math.max(maxY, n.y + n.radius + labelPadBottom);
  });
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const spanW = Math.max(70, maxX - minX);
  const spanH = Math.max(70, maxY - minY);
  const padX = Math.min(44, Math.max(16, width * 0.05));
  const padY = Math.min(44, Math.max(16, height * 0.06));
  const availW = Math.max(80, width - padX * 2);
  const availH = Math.max(80, height - padY * 2);
  let fitScale = Math.min(availW / spanW, availH / spanH);
  fitScale = Math.min(3.8, Math.max(0.18, fitScale));
  targetCamX = -cx;
  targetCamY = -cy;
  targetCamScale = fitScale;
}
function updateDynamicCameraTargets() {
  const allVisible = GRAPH_DATA.nodes.filter(isNodeVisible);
  if (allVisible.length > 0) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    allVisible.forEach(n => {
      minX = Math.min(minX, n.x - n.radius - 42);
      maxX = Math.max(maxX, n.x + n.radius + 42);
      minY = Math.min(minY, n.y - n.radius - 14);
      maxY = Math.max(maxY, n.y + n.radius + 24);
    });
    const padX = Math.min(44, Math.max(16, width * 0.05));
    const padY = Math.min(44, Math.max(16, height * 0.06));
    const availW = Math.max(80, width - padX * 2);
    const availH = Math.max(80, height - padY * 2);
    baselineAllScale = Math.min(3.8, Math.max(0.18, Math.min(availW / Math.max(70, maxX - minX), availH / Math.max(70, maxY - minY))));
  }
  if (autoFitMode === 'all') {
    computeCameraFit(allVisible, false);
  } else if (autoFitMode === 'node' && selectedNode) {
    const nbIds = Array.from(neighborsMap.get(selectedNode.id) || []);
    const cluster = [selectedNode, ...nbIds.map(id => nodeMap.get(id)).filter(n => n && isNodeVisible(n))];
    computeCameraFit(cluster, true);
  } else if (autoFitMode === 'path' && highlightedPathNodes.size > 0) {
    const pathCluster = Array.from(highlightedPathNodes).map(id => nodeMap.get(id)).filter(Boolean);
    computeCameraFit(pathCluster, true);
  }
}
function zoomTo100PercentFill(instant = false) {
  selectedNode = null;
  pathStartNode = null;
  highlightedPathNodes.clear();
  highlightedPathEdges.clear();
  autoFitMode = 'all';
  alpha = Math.max(alpha, 0.35);
  updateDynamicCameraTargets();
  if (instant) {
    camX = targetCamX;
    camY = targetCamY;
    camScale = targetCamScale;
  }
  updateSelectionUI(null);
  updateZoomReadout();
}
function updateZoomReadout() {
  const readout = document.getElementById('zoom-readout');
  const floatingWrap = document.getElementById('floating-zoom-out-wrap');
  const relativePct = Math.round((camScale / (baselineAllScale || 1)) * 100);
  if (autoFitMode === 'all') {
    readout.textContent = '100% Fill';
    floatingWrap.classList.add('hidden');
  } else if (autoFitMode === 'node' && selectedNode) {
    readout.textContent = `Node Fill (${relativePct}%)`;
    floatingWrap.classList.remove('hidden');
  } else {
    readout.textContent = `${relativePct}%`;
    floatingWrap.classList.remove('hidden');
  }
}
function computeShortestPath(startId, endId) {
  highlightedPathNodes.clear();
  highlightedPathEdges.clear();
  if (!startId || !endId || startId === endId) return [];
  const queue = [[startId]];
  const visited = new Set([startId]);
  while (queue.length > 0) {
    const path = queue.shift();
    const curr = path[path.length - 1];
    if (curr === endId) {
      path.forEach(id => highlightedPathNodes.add(id));
      for (let i = 0; i < path.length - 1; i++) {
        const a = path[i], b = path[i + 1];
        edges.forEach((e, idx) => {
          if ((e.source === a && e.target === b) || (e.source === b && e.target === a)) {
            highlightedPathEdges.add(idx);
          }
        });
      }
      return path;
    }
    for (const nb of neighborsMap.get(curr) || []) {
      if (!visited.has(nb)) {
        visited.add(nb);
        queue.push([...path, nb]);
      }
    }
  }
  return [];
}
function stepPhysics() {
  tickCount++;
  updateDynamicCameraTargets();
  if (!isPanning) {
    const ease = 0.16;
    camX += (targetCamX - camX) * ease;
    camY += (targetCamY - camY) * ease;
    camScale += (targetCamScale - camScale) * ease;
    if (tickCount % 4 === 0) updateZoomReadout();
  }
  if (alpha < 0.005 && !draggedNode) return;
  alpha = Math.max(0.004, alpha * 0.992);
  const visibleNodes = GRAPH_DATA.nodes.filter(isNodeVisible);
  if (layoutMode === 'groups') {
    const cols = 5;
    groupNodes.forEach((g, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const tx = (col - 2) * 260;
      const ty = (row - 1) * 250;
      g.vx += (tx - g.x) * 0.08;
      g.vy += (ty - g.y) * 0.08;
    });
    conceptNodes.forEach((c, idx) => {
      const angle = (idx / conceptNodes.length) * Math.PI * 2;
      const tx = Math.cos(angle) * 560;
      const ty = Math.sin(angle) * 420;
      c.vx += (tx - c.x) * 0.05;
      c.vy += (ty - c.y) * 0.05;
    });
    resourceNodes.forEach((r) => {
      const g = nodeMap.get(r.groups[0]);
      if (g) {
        r.vx += (g.x - r.x) * 0.06;
        r.vy += (g.y - r.y) * 0.06;
      }
    });
  } else if (layoutMode === 'concepts') {
    const cols = 5;
    conceptNodes.forEach((c, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const tx = (col - 2) * 260;
      const ty = (row - 0.5) * 280;
      c.vx += (tx - c.x) * 0.08;
      c.vy += (ty - c.y) * 0.08;
    });
    groupNodes.forEach((g, idx) => {
      const angle = (idx / groupNodes.length) * Math.PI * 2;
      const tx = Math.cos(angle) * 580;
      const ty = Math.sin(angle) * 430;
      g.vx += (tx - g.x) * 0.05;
      g.vy += (ty - c.y) * 0.05;
    });
    resourceNodes.forEach(r => {
      if (r.concepts && r.concepts.length > 0) {
        const c = nodeMap.get(r.concepts[0]);
        if (c) {
          r.vx += (c.x - r.x) * 0.065;
          r.vy += (c.y - r.y) * 0.065;
        }
      }
    });
  } else {
    groupNodes.forEach((g, i) => {
      const angle = (i / groupNodes.length) * Math.PI * 2 - Math.PI / 2;
      const tx = Math.cos(angle) * 350;
      const ty = Math.sin(angle) * 350;
      g.vx += (tx - g.x) * 0.015;
      g.vy += (ty - g.y) * 0.015;
    });
    conceptNodes.forEach((c, i) => {
      const angle = (i / conceptNodes.length) * Math.PI * 2;
      const tx = Math.cos(angle) * 140;
      const ty = Math.sin(angle) * 140;
      c.vx += (tx - c.x) * 0.018;
      c.vy += (ty - c.y) * 0.018;
    });
  }
  if (selectedNode && autoFitMode === 'node') {
    const nbIds = Array.from(neighborsMap.get(selectedNode.id) || []);
    const orbitRadius = Math.max(68, Math.min(155, 38 + nbIds.length * 4.2));
    nbIds.forEach((id, i) => {
      const nb = nodeMap.get(id);
      if (!nb || nb === draggedNode) return;
      const angle = (i / Math.max(1, nbIds.length)) * Math.PI * 2 - Math.PI / 2;
      const tx = selectedNode.x + Math.cos(angle) * orbitRadius;
      const ty = selectedNode.y + Math.sin(angle) * orbitRadius;
      nb.vx += (tx - nb.x) * 0.14;
      nb.vy += (ty - nb.y) * 0.14;
    });
  }
  const nLen = visibleNodes.length;
  for (let i = 0; i < nLen; i++) {
    const a = visibleNodes[i];
    for (let j = i + 1; j < nLen; j++) {
      const b = visibleNodes[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1) {
        dx = (Math.random() - 0.5) * 2;
        dy = (Math.random() - 0.5) * 2;
        d2 = dx * dx + dy * dy;
      }
      const minDist = a.radius + b.radius + 14;
      if (d2 < 18000) {
        const d = Math.sqrt(d2);
        const rep = (a.nodeType !== 'resource' && b.nodeType !== 'resource') ? 1600 : 260;
        const force = (rep * alpha) / d2;
        const fx = (dx / d) * force;
        const fy = (dy / d) * force;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
      if (d2 < minDist * minDist) {
        const d = Math.sqrt(d2);
        const overlap = (minDist - d) * 0.25;
        const ox = (dx / d) * overlap;
        const oy = (dy / d) * overlap;
        a.vx -= ox;
        a.vy -= oy;
        b.vx += ox;
        b.vy += oy;
      }
    }
  }
  edges.forEach(e => {
    const s = e.sourceNode;
    const t = e.targetNode;
    if (!isNodeVisible(s) || !isNodeVisible(t)) return;
    if (layoutMode === 'groups' && e.edgeType === 'has-concept') return;
    if (layoutMode === 'concepts' && e.edgeType === 'in-group') return;
    const dx = t.x - s.x;
    const dy = t.y - s.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const targetDist = e.edgeType === 'in-group' ? 78 : 110;
    const k = e.edgeType === 'in-group' ? 0.032 : 0.014;
    const f = (d - targetDist) * k * alpha;
    const fx = (dx / d) * f;
    const fy = (dy / d) * f;
    s.vx += fx;
    s.vy += fy;
    t.vx -= fx;
    t.vy -= fy;
  });
  visibleNodes.forEach(n => {
    if (n === draggedNode || (n === selectedNode && autoFitMode === 'node')) {
      n.vx = 0;
      n.vy = 0;
      return;
    }
    n.vx *= 0.80;
    n.vy *= 0.80;
    n.x += n.vx;
    n.y += n.vy;
  });
}
function screenToWorld(sx, sy) {
  return {
    x: (sx - width / 2) / camScale - camX,
    y: (sy - height / 2) / camScale - camY
  };
}
function drawDiamond(x, y, r) {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
}
function render() {
  ctx.save();
  ctx.clearRect(0, 0, width * dpr, height * dpr);
  ctx.scale(dpr, dpr);
  ctx.translate(width / 2, height / 2);
  ctx.scale(camScale, camScale);
  ctx.translate(camX, camY);
  const focusNode = hoveredNode || selectedNode;
  const focusNeighbors = focusNode ? neighborsMap.get(focusNode.id) : null;
  const hasPath = highlightedPathNodes.size > 0;
  edges.forEach((e, idx) => {
    const s = e.sourceNode;
    const t = e.targetNode;
    if (!isNodeVisible(s) || !isNodeVisible(t)) return;
    const isPathEdge = highlightedPathEdges.has(idx);
    const isHighlighted = isPathEdge || (focusNode && (s.id === focusNode.id || t.id === focusNode.id));
    const searchActive = searchQuery.length > 0;
    const sMatch = matchesSearch(s) && matchesSearch(t);
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(t.x, t.y);
    if (isPathEdge) {
      ctx.strokeStyle = '#F59E0B';
      ctx.lineWidth = 3.2 / camScale;
      ctx.setLineDash([]);
    } else if (isHighlighted) {
      ctx.strokeStyle = e.edgeType === 'in-group' ? s.color : t.color;
      ctx.lineWidth = 2.0 / camScale;
      ctx.setLineDash(e.edgeType === 'has-concept' ? [5, 4] : []);
    } else {
      const baseAlpha = (focusNode || hasPath || (searchActive && !sMatch)) ? 0.05 : (e.edgeType === 'in-group' ? 0.28 : 0.16);
      ctx.strokeStyle = e.edgeType === 'in-group' ? `rgba(148, 163, 184, ${baseAlpha})` : `rgba(167, 139, 250, ${baseAlpha})`;
      ctx.lineWidth = 1.0 / camScale;
      ctx.setLineDash([]);
    }
    ctx.stroke();
    if (isHighlighted) {
      const tPulse = ((tickCount * 0.015 + (idx % 7) * 0.14) % 1);
      const px = s.x + (t.x - s.x) * tPulse;
      const py = s.y + (t.y - s.y) * tPulse;
      ctx.beginPath();
      ctx.arc(px, py, 3 / camScale, 0, Math.PI * 2);
      ctx.fillStyle = isPathEdge ? '#FBBF24' : '#FFFFFF';
      ctx.fill();
    }
  });
  ctx.setLineDash([]);
  const order = { resource: 1, concept: 2, group: 3 };
  const sortedNodes = GRAPH_DATA.nodes.filter(isNodeVisible).sort((a, b) => order[a.nodeType] - order[b.nodeType]);
  sortedNodes.forEach(n => {
    const isFocus = focusNode && focusNode.id === n.id;
    const isNeighbor = focusNeighbors && focusNeighbors.has(n.id);
    const isPathNode = highlightedPathNodes.has(n.id);
    const isMatch = matchesSearch(n);
    let dim = false;
    if (hasPath && !isPathNode) dim = true;
    else if (focusNode && !isFocus && !isNeighbor) dim = true;
    if (searchQuery && !isMatch) dim = true;
    ctx.globalAlpha = dim ? 0.14 : 1.0;
    if (isFocus || isPathNode || (searchQuery && isMatch) || (n.groups && n.groups.length > 1 && !dim)) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.radius + 6, 0, Math.PI * 2);
      ctx.fillStyle = isPathNode ? 'rgba(245, 158, 11, 0.35)' : (n.color + '44');
      ctx.fill();
    }
    if (n.nodeType === 'concept') {
      drawDiamond(n.x, n.y, n.radius);
      ctx.fillStyle = n.color;
      ctx.fill();
      ctx.lineWidth = isFocus ? 3 : 1.8;
      ctx.strokeStyle = '#FFFFFF';
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
      ctx.fillStyle = n.color;
      ctx.fill();
      ctx.lineWidth = isFocus ? 3 : (n.nodeType === 'group' ? 2.2 : (n.groups && n.groups.length > 1 ? 2 : 1));
      ctx.strokeStyle = (n.groups && n.groups.length > 1) ? '#FDE047' : '#0F172A';
      ctx.stroke();
    }
    if (n.nodeType === 'group' || n.nodeType === 'concept') {
      ctx.fillStyle = '#0F172A';
      ctx.font = `bold ${n.nodeType === 'group' ? 11 : 9}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const countVal = n.nodeType === 'group' ? n.tabCount : n.linkCount;
      ctx.fillText(String(countVal), n.x, n.y);
    }
    const showLabel =
      n.nodeType === 'group' ||
      n.nodeType === 'concept' ||
      isFocus ||
      isNeighbor ||
      isPathNode ||
      (searchQuery && isMatch) ||
      camScale > 1.35 ||
      (n.groups && n.groups.length > 1);
    if (showLabel) {
      const fontSize = n.nodeType === 'group' ? 12 : (n.nodeType === 'concept' ? 11 : 10);
      ctx.font = `${n.nodeType === 'resource' && !isFocus ? '500' : '700'} ${fontSize}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const labelY = n.y + n.radius + 4;
      const text = n.label.length > 34 && !isFocus ? n.label.slice(0, 32) + '…' : n.label;
      const metrics = ctx.measureText(text);
      const padX = 5, padY = 2;
      ctx.fillStyle = isFocus ? '#F97316' : 'rgba(15, 23, 42, 0.85)';
      ctx.beginPath();
      ctx.roundRect(n.x - metrics.width / 2 - padX, labelY - padY, metrics.width + padX * 2, fontSize + padY * 2, 4);
      ctx.fill();
      ctx.fillStyle = isFocus ? '#0F172A' : (n.nodeType === 'concept' ? '#E9D5FF' : '#F8FAFC');
      ctx.fillText(text, n.x, labelY);
    }
  });
  ctx.globalAlpha = 1.0;
  ctx.restore();
}
function loop() {
  stepPhysics();
  render();
  requestAnimationFrame(loop);
}
function handleResize() {
  const rect = canvasContainer.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  width = rect.width;
  height = rect.height;
  dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  updateDynamicCameraTargets();
}
const resizeObserver = new ResizeObserver(() => {
  handleResize();
});
resizeObserver.observe(canvasContainer);
window.addEventListener('resize', handleResize);
handleResize();
zoomTo100PercentFill(true);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.getElementById('directory-dialog').open) {
    zoomTo100PercentFill(false);
  }
});
function getNodeAtScreen(sx, sy) {
  const w = screenToWorld(sx, sy);
  const visible = GRAPH_DATA.nodes.filter(isNodeVisible);
  for (let i = visible.length - 1; i >= 0; i--) {
    const n = visible[i];
    const dx = w.x - n.x;
    const dy = w.y - n.y;
    const hitR = n.radius + 5 / camScale;
    if (dx * dx + dy * dy <= hitR * hitR) return n;
  }
  return null;
}
canvas.addEventListener('pointerdown', (e) => {
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  pointerDownPos = { x: sx, y: sy };
  const hit = getNodeAtScreen(sx, sy);
  if (hit) {
    draggedNode = hit;
    alpha = Math.max(alpha, 0.35);
  } else {
    isPanning = true;
    panStartX = sx;
    panStartY = sy;
  }
});
window.addEventListener('pointermove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  if (draggedNode) {
    const w = screenToWorld(sx, sy);
    draggedNode.x = w.x;
    draggedNode.y = w.y;
    alpha = Math.max(alpha, 0.25);
  } else if (isPanning) {
    const dx = sx - panStartX;
    const dy = sy - panStartY;
    if (Math.hypot(dx, dy) > 3) {
      autoFitMode = 'manual';
      camX += dx / camScale;
      camY += dy / camScale;
      targetCamX = camX;
      targetCamY = camY;
      panStartX = sx;
      panStartY = sy;
      updateZoomReadout();
    }
  } else if (e.target === canvas) {
    const hit = getNodeAtScreen(sx, sy);
    hoveredNode = hit;
    canvas.style.cursor = hit ? 'pointer' : 'grab';
  }
});
window.addEventListener('pointerup', (e) => {
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const moved = Math.hypot(sx - pointerDownPos.x, sy - pointerDownPos.y);
  if (moved < 6 && e.target === canvas) {
    const hit = getNodeAtScreen(sx, sy);
    if (pathStartNode && hit && hit.id !== pathStartNode.id) {
      const path = computeShortestPath(pathStartNode.id, hit.id);
      autoFitMode = 'path';
      alpha = Math.max(alpha, 0.4);
      updateDynamicCameraTargets();
      document.getElementById('pathfinder-banner').classList.remove('hidden');
      const labels = path.map(id => nodeMap.get(id).label).join(' → ');
      document.getElementById('pathfinder-text').textContent = path.length
        ? `Path (${path.length - 1} hops): ${labels}`
        : 'No path found';
      pathStartNode = null;
    } else if (hit) {
      selectAndZoomNode(hit);
    } else {
      zoomTo100PercentFill(false);
    }
  }
  draggedNode = null;
  isPanning = false;
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  autoFitMode = 'manual';
  const zoomFactor = e.deltaY < 0 ? 1.12 : 0.89;
  camScale = Math.min(3.8, Math.max(0.18, camScale * zoomFactor));
  targetCamScale = camScale;
  targetCamX = camX;
  targetCamY = camY;
  updateZoomReadout();
}, { passive: false });
function selectAndZoomNode(n) {
  if (!n) {
    zoomTo100PercentFill(false);
    return;
  }
  selectedNode = n;
  autoFitMode = 'node';
  alpha = Math.max(alpha, 0.65);
  updateDynamicCameraTargets();
  updateSelectionUI(n);
  updateZoomReadout();
}
function buildNavigator() {
  const gList = document.getElementById('nav-groups-list');
  const cList = document.getElementById('nav-concepts-list');
  gList.innerHTML = '';
  cList.innerHTML = '';
  groupNodes.forEach(g => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'w-full text-left px-2 py-1.5 rounded-lg text-xs hover:bg-[var(--background)] flex items-center justify-between gap-2 cursor-pointer transition-colors';
    btn.innerHTML = `
      <span class="flex items-center gap-2 truncate">
        <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${g.color}"></span>
        <span class="font-medium truncate">${g.label}</span>
      </span>
      <span class="text-xs px-1.5 py-0.5 rounded bg-[var(--background)] text-[var(--muted-foreground)] font-mono">${g.tabCount}</span>
    `;
    btn.addEventListener('click', () => selectAndZoomNode(g));
    li.appendChild(btn);
    gList.appendChild(li);
  });
  conceptNodes.forEach(c => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'w-full text-left px-2 py-1.5 rounded-lg text-xs hover:bg-[var(--background)] flex items-center justify-between gap-2 cursor-pointer transition-colors';
    btn.innerHTML = `
      <span class="flex items-center gap-2 truncate">
        <span class="w-2.5 h-2.5 rotate-45 shrink-0" style="background:${c.color}"></span>
        <span class="font-medium truncate">${c.label}</span>
      </span>
      <span class="text-xs px-1.5 py-0.5 rounded bg-[var(--background)] text-[var(--muted-foreground)] font-mono">${c.linkCount}</span>
    `;
    btn.addEventListener('click', () => selectAndZoomNode(c));
    li.appendChild(btn);
    cList.appendChild(li);
  });
}
function updateSelectionUI(n) {
  highlightedPathNodes.clear();
  highlightedPathEdges.clear();
  document.getElementById('pathfinder-banner').classList.add('hidden');
  document.getElementById('btn-clear-selection').classList.toggle('hidden', !n);
  document.getElementById('btn-start-path').classList.toggle('hidden', !n);
  const badge = document.getElementById('insp-badge');
  const title = document.getElementById('insp-title');
  const body = document.getElementById('insp-body');
  if (!n) {
    badge.textContent = '100% Whole Picture View';
    badge.style.backgroundColor = 'rgba(16, 185, 129, 0.15)';
    badge.style.color = '#34D399';
    title.textContent = '170 Saved iPhone Tabs Mapped';
    body.innerHTML = `
      <p class="text-[var(--muted-foreground)] leading-relaxed">
        Click any <strong>Tab Group</strong>, <strong>Concept Bridge</strong>, or <strong>Link</strong> node on the canvas and it will automatically zoom to fill 100% of your viewable screen.
      </p>
      <div class="grid grid-cols-3 gap-2 text-center">
        <div class="p-2.5 rounded-xl bg-[var(--background)] border border-[var(--border)]">
          <div class="text-base font-bold text-orange-400">15</div>
          <div class="text-xs text-[var(--muted-foreground)]">Tab Groups</div>
        </div>
        <div class="p-2.5 rounded-xl bg-[var(--background)] border border-[var(--border)]">
          <div class="text-base font-bold text-purple-400">10</div>
          <div class="text-xs text-[var(--muted-foreground)]">Concept Bridges</div>
        </div>
        <div class="p-2.5 rounded-xl bg-[var(--background)] border border-[var(--border)]">
          <div class="text-base font-bold text-emerald-400">161</div>
          <div class="text-xs text-[var(--muted-foreground)]">Unique Links</div>
        </div>
      </div>
      <div class="p-3 rounded-xl bg-[var(--background)] border border-[var(--border)] space-y-2">
        <h3 class="font-semibold text-[var(--foreground)]">Cross-Group Bridge Highlights</h3>
        <p class="text-[var(--muted-foreground)]">4 resources were saved in multiple Tab Groups simultaneously:</p>
        <ul class="space-y-1.5" id="overview-bridges"></ul>
      </div>
    `;
    const bUl = document.getElementById('overview-bridges');
    resourceNodes.filter(r => r.groups.length > 1).forEach(r => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'text-left text-amber-400 hover:underline cursor-pointer font-medium block truncate w-full';
      const gNames = r.groups.map(gid => nodeMap.get(gid).label).join(' + ');
      btn.textContent = `★ ${r.label} (${gNames})`;
      btn.addEventListener('click', () => selectAndZoomNode(r));
      li.appendChild(btn);
      bUl.appendChild(li);
    });
    return;
  }
  if (n.nodeType === 'group') {
    badge.textContent = `Chrome Tab Group · ${n.tabCount} Tabs`;
  } else if (n.nodeType === 'concept') {
    badge.textContent = `Concept Bridge · ${n.linkCount} Links`;
  } else {
    badge.textContent = n.resourceType + (n.groups.length > 1 ? ' · Multi-Group Bridge' : '');
  }
  badge.style.backgroundColor = n.color + '25';
  badge.style.color = n.color;
  title.textContent = n.label;
  const connectedIds = Array.from(neighborsMap.get(n.id) || []);
  const connectedNodes = connectedIds.map(id => nodeMap.get(id));
  let html = `
    <button type="button" id="insp-zoom-100-btn" class="w-full py-1.5 px-3 rounded-lg bg-emerald-500/15 border border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/25 font-semibold text-xs flex items-center justify-center gap-1.5 cursor-pointer transition-colors">
      <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
      Zoom Out to 100% Fill (Whole Picture)
    </button>
    <p class="text-[var(--muted-foreground)] leading-relaxed">${n.description || ''}</p>
  `;
  if (n.url) {
    html += `
      <div class="p-3 rounded-xl bg-[var(--background)] border border-[var(--border)] space-y-2">
        <div class="text-xs font-semibold text-[var(--muted-foreground)]">Original Saved URL (${n.host})</div>
        <p class="font-mono text-xs break-all text-[var(--foreground)] select-all">${n.url}</p>
        <a href="${n.url}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-orange-500 text-slate-950 font-semibold text-xs hover:bg-orange-400 transition-colors">
          Open Link in New Tab
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M7 17 17 7M7 7h10v10"/></svg>
        </a>
      </div>
    `;
  }
  const connGroups = connectedNodes.filter(x => x.nodeType === 'group');
  const connConcepts = connectedNodes.filter(x => x.nodeType === 'concept');
  const connResources = connectedNodes.filter(x => x.nodeType === 'resource');
  if (connGroups.length) {
    html += `<div><h3 class="font-semibold text-[var(--foreground)] mb-1.5">Saved in Tab Group(s)</h3><div class="flex flex-wrap gap-1.5" id="insp-groups"></div></div>`;
  }
  if (connConcepts.length) {
    html += `<div><h3 class="font-semibold text-[var(--foreground)] mb-1.5">Connected Concept Bridges</h3><div class="flex flex-wrap gap-1.5" id="insp-concepts"></div></div>`;
  }
  if (connResources.length) {
    html += `<div><h3 class="font-semibold text-[var(--foreground)] mb-1.5">Connected Links (${connResources.length})</h3><ul class="space-y-1.5 max-h-72 overflow-y-auto pr-1" id="insp-resources"></ul></div>`;
  }
  body.innerHTML = html;
  document.getElementById('insp-zoom-100-btn').addEventListener('click', () => zoomTo100PercentFill(false));
  if (connGroups.length) {
    const wrap = document.getElementById('insp-groups');
    connGroups.forEach(g => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'px-2.5 py-1 rounded-full text-xs font-medium border cursor-pointer transition-colors';
      b.style.borderColor = g.color;
      b.style.color = g.color;
      b.textContent = g.label;
      b.addEventListener('click', () => selectAndZoomNode(g));
      wrap.appendChild(b);
    });
  }
  if (connConcepts.length) {
    const wrap = document.getElementById('insp-concepts');
    connConcepts.forEach(c => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'px-2.5 py-1 rounded-lg text-xs font-medium border cursor-pointer transition-colors';
      b.style.borderColor = c.color;
      b.style.color = c.color;
      b.textContent = '◆ ' + c.label;
      b.addEventListener('click', () => selectAndZoomNode(c));
      wrap.appendChild(b);
    });
  }
  if (connResources.length) {
    const ul = document.getElementById('insp-resources');
    connResources.forEach(r => {
      const li = document.createElement('li');
      li.className = 'p-2 rounded-lg bg-[var(--background)] border border-[var(--border)] flex items-center justify-between gap-2';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'text-left font-medium text-[var(--foreground)] hover:text-orange-400 truncate cursor-pointer flex-1';
      btn.textContent = r.label;
      btn.addEventListener('click', () => selectAndZoomNode(r));
      const link = document.createElement('a');
      link.href = r.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'text-xs text-blue-400 hover:underline shrink-0';
      link.textContent = 'Open ↗';
      li.appendChild(btn);
      li.appendChild(link);
      ul.appendChild(li);
    });
  }
}
document.querySelectorAll('.layout-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    layoutMode = btn.dataset.layout;
    alpha = 0.9;
    if (autoFitMode !== 'node') autoFitMode = 'all';
    document.querySelectorAll('.layout-btn').forEach(b => {
      const active = b === btn;
      b.className = active
        ? 'layout-btn px-2.5 py-1 text-xs font-medium rounded-md bg-orange-500 text-slate-950 cursor-pointer transition-colors'
        : 'layout-btn px-2.5 py-1 text-xs font-medium rounded-md text-[var(--muted-foreground)] hover:text-[var(--foreground)] cursor-pointer transition-colors';
    });
  });
});
document.querySelectorAll('.rtype-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    activeRType = btn.dataset.rtype;
    alpha = 0.5;
    if (autoFitMode === 'all') updateDynamicCameraTargets();
    document.querySelectorAll('.rtype-btn').forEach(b => {
      const active = b === btn;
      b.className = active
        ? 'rtype-btn px-2.5 py-0.5 text-xs rounded-full bg-orange-500 text-slate-950 font-medium cursor-pointer transition-colors'
        : 'rtype-btn px-2.5 py-0.5 text-xs rounded-full border border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] cursor-pointer transition-colors';
    });
  });
});
document.getElementById('btn-toggle-links').addEventListener('click', (e) => {
  showAllLinks = !showAllLinks;
  e.currentTarget.textContent = showAllLinks ? 'View: All Nodes' : 'View: Hubs + Selected';
  alpha = 0.75;
  updateDynamicCameraTargets();
});
document.getElementById('btn-boing').addEventListener('click', () => {
  GRAPH_DATA.nodes.forEach(n => {
    n.vx += (Math.random() - 0.5) * 28;
    n.vy += (Math.random() - 0.5) * 28;
  });
  alpha = 1.0;
});
document.getElementById('btn-fit-100').addEventListener('click', () => zoomTo100PercentFill(false));
document.getElementById('btn-floating-fit-100').addEventListener('click', () => zoomTo100PercentFill(false));
document.getElementById('btn-bottom-fit-100').addEventListener('click', () => zoomTo100PercentFill(false));
document.getElementById('btn-clear-selection').addEventListener('click', () => zoomTo100PercentFill(false));
document.getElementById('btn-start-path').addEventListener('click', () => {
  if (!selectedNode) return;
  pathStartNode = selectedNode;
  const banner = document.getElementById('pathfinder-banner');
  banner.classList.remove('hidden');
  document.getElementById('pathfinder-text').textContent = `Pathfinder active from "${selectedNode.label}" — click any second node on the graph!`;
});
document.getElementById('btn-cancel-path').addEventListener('click', () => {
  pathStartNode = null;
  highlightedPathNodes.clear();
  highlightedPathEdges.clear();
  document.getElementById('pathfinder-banner').classList.add('hidden');
});
document.getElementById('btn-zoom-in').addEventListener('click', () => {
  autoFitMode = 'manual';
  camScale = Math.min(3.8, camScale * 1.25);
  targetCamScale = camScale;
  targetCamX = camX;
  targetCamY = camY;
  updateZoomReadout();
});
document.getElementById('btn-zoom-out').addEventListener('click', () => {
  autoFitMode = 'manual';
  camScale = Math.max(0.18, camScale * 0.8);
  targetCamScale = camScale;
  targetCamX = camX;
  targetCamY = camY;
  updateZoomReadout();
});
document.getElementById('graph-search').addEventListener('input', (e) => {
  searchQuery = e.target.value.trim();
  if (searchQuery) {
    const matches = GRAPH_DATA.nodes.filter(n => isNodeVisible(n) && matchesSearch(n));
    if (matches.length > 0) {
      autoFitMode = 'manual';
      computeCameraFit(matches, matches.length <= 6);
    }
  } else {
    zoomTo100PercentFill(false);
  }
});
const dirDialog = document.getElementById('directory-dialog');
document.getElementById('btn-open-directory').addEventListener('click', () => {
  renderDirectoryModal('');
  dirDialog.showModal();
});
dirDialog.addEventListener('close', () => {
  dirDialog.returnValue = '';
});
document.getElementById('modal-search').addEventListener('input', (e) => {
  renderDirectoryModal(e.target.value.trim());
});
function renderDirectoryModal(filterText) {
  const container = document.getElementById('modal-directory-content');
  const q = filterText.toLowerCase();
  let totalShown = 0;
  let html = '';
  groupNodes.forEach(g => {
    const items = resourceNodes.filter(r => r.groups.includes(g.id) && (
      !q ||
      r.label.toLowerCase().includes(q) ||
      r.url.toLowerCase().includes(q) ||
      g.label.toLowerCase().includes(q) ||
      r.resourceType.toLowerCase().includes(q) ||
      r.concepts.some(cid => nodeMap.get(cid).label.toLowerCase().includes(q))
    ));
    if (!items.length) return;
    totalShown += items.length;
    html += `
      <details open class="rounded-xl border border-[var(--border)] bg-[var(--background)] overflow-hidden">
        <summary class="px-4 py-3 font-bold text-sm cursor-pointer flex items-center justify-between bg-[var(--card)]">
          <span class="flex items-center gap-2">
            <span class="w-3 h-3 rounded-full inline-block" style="background:${g.color}"></span>
            <span>${g.label}</span>
            <span class="text-xs font-normal text-[var(--muted-foreground)]">— ${g.description}</span>
          </span>
          <span class="text-xs font-mono px-2 py-0.5 rounded bg-[var(--background)] border border-[var(--border)]">${items.length} links</span>
        </summary>
        <div class="divide-y divide-[var(--border)]">
          ${items.map(r => {
            const cBadges = r.concepts.map(cid => {
              const c = nodeMap.get(cid);
              return `<span class="px-2 py-0.5 rounded text-xs border" style="border-color:${c.color}66;color:${c.color}">${c.label}</span>`;
            }).join(' ');
            return `
              <div class="p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs hover:bg-[var(--card)]/60">
                <div class="space-y-1 min-w-0 flex-1">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="font-semibold text-[var(--foreground)]">${r.label}</span>
                    <span class="px-1.5 py-0.5 rounded bg-[var(--card)] border border-[var(--border)] text-[var(--muted-foreground)]">${r.resourceType}</span>
                    ${cBadges}
                  </div>
                  <p class="text-[var(--muted-foreground)]">${r.description}</p>
                  <a href="${r.url}" target="_blank" rel="noopener noreferrer" class="text-blue-400 hover:underline font-mono block truncate">${r.url}</a>
                </div>
                <button type="button" data-focus-id="${r.id}" class="modal-focus-btn px-2.5 py-1.5 rounded-lg border border-orange-500/40 text-orange-400 hover:bg-orange-500/15 font-medium shrink-0 cursor-pointer">
                  Zoom &amp; Fill on Graph
                </button>
              </div>
            `;
          }).join('')}
        </div>
      </details>
    `;
  });
  container.innerHTML = html;
  document.getElementById('modal-count').textContent = `Showing ${totalShown} tab entries across matching groups`;
  container.querySelectorAll('.modal-focus-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = nodeMap.get(btn.dataset.focusId);
      dirDialog.close();
      if (target) {
        selectAndZoomNode(target);
      }
    });
  });
}
buildNavigator();
loop();
