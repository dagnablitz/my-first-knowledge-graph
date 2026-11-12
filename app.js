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
    let searchQuery = '';
    let selectedNode = null;
    let hoveredNode = null;
    let sidebarHoveredNode = null;
    let draggedNode = null;
    let pathStartNode = null;
    let highlightedPathNodes = new Set();
    let highlightedPathEdges = new Set();

    // Dynamic Camera & Auto-Fit State
    // autoFitMode: 'all' (100% whole picture) | 'node' (zoomed to fill selected node & neighbors) | 'manual' (user panned/wheeled)
    let autoFitMode = 'all';
    let baselineAllScale = 0.85;
    let camX = 0, camY = 0, camScale = 0.85;
    let targetCamX = 0, targetCamY = 0, targetCamScale = 0.85;

    let isPanning = false;
    let panStartX = 0, panStartY = 0;
    let pointerDownPos = { x: 0, y: 0 };
    let alpha = 0.55;
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

    // Compute dynamic camera target so `nodesToFit` fills 100% of current viewable canvas (width x height)
    function computeCameraFit(nodesToFit, isSingleFocus = false) {
      if (!nodesToFit || nodesToFit.length === 0) return;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      let validCount = 0;
      nodesToFit.forEach(n => {
        if (!n || !Number.isFinite(n.x) || !Number.isFinite(n.y)) return;
        validCount++;
        // Account for node radius + label width/height margins so labels never clip off screen
        const labelPadX = isSingleFocus ? 58 : 42;
        const labelPadBottom = isSingleFocus ? 30 : 24;
        const labelPadTop = isSingleFocus ? 18 : 14;
        minX = Math.min(minX, n.x - n.radius - labelPadX);
        maxX = Math.max(maxX, n.x + n.radius + labelPadX);
        minY = Math.min(minY, n.y - n.radius - labelPadTop);
        maxY = Math.max(maxY, n.y + n.radius + labelPadBottom);
      });
      if (validCount === 0) return;

      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const spanW = Math.max(70, maxX - minX);
      const spanH = Math.max(70, maxY - minY);

      // Dynamic padding proportional to current viewable canvas dimensions
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
      const allVisible = GRAPH_DATA.nodes.filter(n => isNodeVisible(n) && Number.isFinite(n.x) && Number.isFinite(n.y));
      // Always track what "100% Fill" scale is for the current canvas dimensions
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
      sidebarHoveredNode = null;
      pathStartNode = null;
      highlightedPathNodes.clear();
      highlightedPathEdges.clear();
      autoFitMode = 'all';
      alpha = Math.max(alpha, 0.28);
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
      if (!readout) return;
      const relativePct = Math.round((camScale / (baselineAllScale || 1)) * 100);
      if (autoFitMode === 'all') {
        readout.textContent = '100% Fill';
      } else if (autoFitMode === 'node' && selectedNode) {
        readout.textContent = `Node Fill (${relativePct}%)`;
      } else {
        readout.textContent = `${relativePct}%`;
      }
    }

    // BFS Shortest Path between two nodes
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

      // Smoothly interpolate camera toward target (2x faster than previous ultra-slow setting)
      updateDynamicCameraTargets();
      if (!isPanning) {
        const ease = 0.084;
        camX += (targetCamX - camX) * ease;
        camY += (targetCamY - camY) * ease;
        camScale += (targetCamScale - camScale) * ease;
        if (tickCount % 4 === 0) updateZoomReadout();
      }

      if (alpha < 0.001 && !draggedNode) return;
      alpha = alpha * 0.985;
      if (alpha < 0.001) alpha = 0;

      const visibleNodes = GRAPH_DATA.nodes.filter(isNodeVisible);
      const calmFactor = Math.max(0.25, alpha);

      // 1. Gentle layout anchor forces (2x faster)
      if (layoutMode === 'groups') {
        const cols = 5;
        groupNodes.forEach((g, idx) => {
          const col = idx % cols;
          const row = Math.floor(idx / cols);
          const tx = (col - 2) * 260;
          const ty = (row - 1) * 250;
          g.vx += (tx - g.x) * 0.044 * calmFactor;
          g.vy += (ty - g.y) * 0.044 * calmFactor;
        });
        conceptNodes.forEach((c, idx) => {
          const angle = (idx / conceptNodes.length) * Math.PI * 2;
          const tx = Math.cos(angle) * 560;
          const ty = Math.sin(angle) * 420;
          c.vx += (tx - c.x) * 0.030 * calmFactor;
          c.vy += (ty - c.y) * 0.030 * calmFactor;
        });
        resourceNodes.forEach((r) => {
          const g = nodeMap.get(r.groups[0]);
          if (g) {
            r.vx += (g.x - r.x) * 0.036 * calmFactor;
            r.vy += (g.y - r.y) * 0.036 * calmFactor;
          }
        });
      } else if (layoutMode === 'concepts') {
        const cols = 5;
        conceptNodes.forEach((c, idx) => {
          const col = idx % cols;
          const row = Math.floor(idx / cols);
          const tx = (col - 2) * 260;
          const ty = (row - 0.5) * 280;
          c.vx += (tx - c.x) * 0.044 * calmFactor;
          c.vy += (ty - c.y) * 0.044 * calmFactor;
        });
        groupNodes.forEach((g, idx) => {
          const angle = (idx / groupNodes.length) * Math.PI * 2;
          const tx = Math.cos(angle) * 580;
          const ty = Math.sin(angle) * 430;
          g.vx += (tx - g.x) * 0.030 * calmFactor;
          g.vy += (ty - c.y) * 0.030 * calmFactor;
        });
        resourceNodes.forEach(r => {
          if (r.concepts && r.concepts.length > 0) {
            const c = nodeMap.get(r.concepts[0]);
            if (c) {
              r.vx += (c.x - r.x) * 0.036 * calmFactor;
              r.vy += (c.y - r.y) * 0.036 * calmFactor;
            }
          }
        });
      } else {
        groupNodes.forEach((g, i) => {
          const angle = (i / groupNodes.length) * Math.PI * 2 - Math.PI / 2;
          const tx = Math.cos(angle) * 350;
          const ty = Math.sin(angle) * 350;
          g.vx += (tx - g.x) * 0.014 * calmFactor;
          g.vy += (ty - g.y) * 0.014 * calmFactor;
        });
        conceptNodes.forEach((c, i) => {
          const angle = (i / conceptNodes.length) * Math.PI * 2;
          const tx = Math.cos(angle) * 140;
          const ty = Math.sin(angle) * 140;
          c.vx += (tx - c.x) * 0.016 * calmFactor;
          c.vy += (ty - c.y) * 0.016 * calmFactor;
        });
      }

      // Focused satellite orbit: when a Tab Group or Concept Bridge hub is selected, smoothly
      // guide its 1-hop resource links into a readable constellation around it (2x faster).
      if (selectedNode && autoFitMode === 'node' && (selectedNode.nodeType === 'group' || selectedNode.nodeType === 'concept')) {
        const nbIds = Array.from(neighborsMap.get(selectedNode.id) || []);
        const resourceNbIds = nbIds.filter(id => {
          const nb = nodeMap.get(id);
          return nb && nb.nodeType === 'resource';
        });
        const orbitRadius = Math.max(76, Math.min(165, 42 + resourceNbIds.length * 4.2));
        resourceNbIds.forEach((id, i) => {
          const nb = nodeMap.get(id);
          if (!nb || nb === draggedNode) return;
          const angle = (i / Math.max(1, resourceNbIds.length)) * Math.PI * 2 - Math.PI / 2;
          const tx = selectedNode.x + Math.cos(angle) * orbitRadius;
          const ty = selectedNode.y + Math.sin(angle) * orbitRadius;
          nb.vx += (tx - nb.x) * 0.064 * calmFactor;
          nb.vy += (ty - nb.y) * 0.064 * calmFactor;
        });
      }

      // 2. Smooth pairwise repulsion among visible nodes (with singularity guard)
      const nLen = visibleNodes.length;
      for (let i = 0; i < nLen; i++) {
        const a = visibleNodes[i];
        for (let j = i + 1; j < nLen; j++) {
          const b = visibleNodes[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let d2 = dx * dx + dy * dy;
          if (!Number.isFinite(d2) || d2 < 4) {
            const ang = ((i * 31 + j * 17) % 360) * (Math.PI / 180);
            dx = Math.cos(ang) * 2;
            dy = Math.sin(ang) * 2;
            d2 = 4;
          }
          const minDist = a.radius + b.radius + 14;
          if (d2 < 18000) {
            const d = Math.sqrt(d2);
            const rep = (a.nodeType !== 'resource' && b.nodeType !== 'resource') ? 1150 : 190;
            const effD2 = Math.max(260, d2);
            const force = (rep * alpha) / effD2;
            const fx = (dx / d) * force;
            const fy = (dy / d) * force;
            a.vx -= fx;
            a.vy -= fy;
            b.vx += fx;
            b.vy += fy;
          }
          if (d2 < minDist * minDist) {
            const d = Math.sqrt(d2);
            const overlap = (minDist - d) * 0.13 * calmFactor;
            const ox = (dx / d) * overlap;
            const oy = (dy / d) * overlap;
            a.vx -= ox;
            a.vy -= oy;
            b.vx += ox;
            b.vy += oy;
          }
        }
      }

      // 3. Smooth edge spring forces (2x faster)
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
        const k = e.edgeType === 'in-group' ? 0.020 : 0.009;
        const f = (d - targetDist) * k * alpha;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        s.vx += fx;
        s.vy += fy;
        t.vx -= fx;
        t.vy -= fy;
      });

      // 4. Integrate velocity (2x faster peak speed while still smooth and controlled)
      const maxV = 6.4;
      const maxPos = 1200;
      visibleNodes.forEach(n => {
        if (n === draggedNode || (n === selectedNode && autoFitMode === 'node')) {
          n.vx = 0;
          n.vy = 0;
          return;
        }
        n.vx = Math.max(-maxV, Math.min(maxV, (n.vx || 0) * 0.74));
        n.vy = Math.max(-maxV, Math.min(maxV, (n.vy || 0) * 0.74));
        if (Math.abs(n.vx) < 0.012) n.vx = 0;
        if (Math.abs(n.vy) < 0.012) n.vy = 0;
        n.x = Math.max(-maxPos, Math.min(maxPos, (n.x || 0) + n.vx));
        n.y = Math.max(-maxPos, Math.min(maxPos, (n.y || 0) + n.vy));
        if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) {
          n.x = 0;
          n.y = 0;
          n.vx = 0;
          n.vy = 0;
        }
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

    function drawRoundedRectPath(x, y, w, h, r) {
      const rad = Math.max(0, Math.min(r, w / 2, h / 2));
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(x, y, w, h, rad);
      } else {
        ctx.moveTo(x + rad, y);
        ctx.arcTo(x + w, y, x + w, y + h, rad);
        ctx.arcTo(x + w, y + h, x, y + h, rad);
        ctx.arcTo(x, y + h, x, y, rad);
        ctx.arcTo(x, y, x + w, y, rad);
        ctx.closePath();
      }
    }

    function render() {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1.0;
      ctx.setLineDash([]);
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      ctx.save();
      try {
        const timeSec = (typeof performance !== 'undefined' ? performance.now() : Date.now()) * 0.001;
        const safeScale = Number.isFinite(camScale) && camScale > 0.02 ? camScale : 1;
        const safeCamX = Number.isFinite(camX) ? camX : 0;
        const safeCamY = Number.isFinite(camY) ? camY : 0;

        ctx.scale(dpr, dpr);
        ctx.translate(width / 2, height / 2);
        ctx.scale(safeScale, safeScale);
        ctx.translate(safeCamX, safeCamY);

        const focusNode = hoveredNode || selectedNode;
        const focusNeighbors = focusNode ? neighborsMap.get(focusNode.id) : null;
        const hasPath = highlightedPathNodes.size > 0;

        // Draw Edges
        edges.forEach((e, idx) => {
          const s = e.sourceNode;
          const t = e.targetNode;
          if (!isNodeVisible(s) || !isNodeVisible(t)) return;

          const isPathEdge = highlightedPathEdges.has(idx);
          const isSidebarHoverEdge = sidebarHoveredNode && (
            (selectedNode && ((s.id === selectedNode.id && t.id === sidebarHoveredNode.id) || (t.id === selectedNode.id && s.id === sidebarHoveredNode.id))) ||
            (!selectedNode && (s.id === sidebarHoveredNode.id || t.id === sidebarHoveredNode.id))
          );
          const isHighlighted = isPathEdge || isSidebarHoverEdge || (focusNode && (s.id === focusNode.id || t.id === focusNode.id));
          const searchActive = searchQuery.length > 0;
          const sMatch = matchesSearch(s) && matchesSearch(t);

          ctx.beginPath();
          ctx.moveTo(s.x, s.y);
          ctx.lineTo(t.x, t.y);

          if (isSidebarHoverEdge) {
            ctx.strokeStyle = '#22D3EE';
            ctx.lineWidth = 3.6 / safeScale;
            ctx.setLineDash([]);
          } else if (isPathEdge) {
            ctx.strokeStyle = '#F59E0B';
            ctx.lineWidth = 3.2 / safeScale;
            ctx.setLineDash([]);
          } else if (isHighlighted) {
            const dimOtherEdges = sidebarHoveredNode ? 0.35 : 1.0;
            ctx.globalAlpha = dimOtherEdges;
            ctx.strokeStyle = e.edgeType === 'in-group' ? s.color : t.color;
            ctx.lineWidth = 2.0 / safeScale;
            ctx.setLineDash(e.edgeType === 'has-concept' ? [5, 4] : []);
          } else {
            const baseAlpha = (focusNode || hasPath || sidebarHoveredNode || (searchActive && !sMatch)) ? 0.05 : (e.edgeType === 'in-group' ? 0.28 : 0.16);
            ctx.strokeStyle = e.edgeType === 'in-group' ? `rgba(148, 163, 184, ${baseAlpha})` : `rgba(167, 139, 250, ${baseAlpha})`;
            ctx.lineWidth = 1.0 / safeScale;
            ctx.setLineDash([]);
          }
          ctx.stroke();
          ctx.globalAlpha = 1.0;

          if (isSidebarHoverEdge) {
            // Single smooth light particle gliding along the edge (2x faster: ~2.25s per traversal)
            const tPulse = (timeSec * 0.44) % 1;
            const px = s.x + (t.x - s.x) * tPulse;
            const py = s.y + (t.y - s.y) * tPulse;
            ctx.beginPath();
            ctx.arc(px, py, 4.5 / safeScale, 0, Math.PI * 2);
            ctx.fillStyle = '#FDE047';
            ctx.fill();
          } else if (isHighlighted && !sidebarHoveredNode) {
            // Smooth drift along highlighted edges (2x faster: ~3.3s per traversal)
            const tPulse = (timeSec * 0.30 + (idx % 7) * 0.14) % 1;
            const px = s.x + (t.x - s.x) * tPulse;
            const py = s.y + (t.y - s.y) * tPulse;
            ctx.beginPath();
            ctx.arc(px, py, 2.8 / safeScale, 0, Math.PI * 2);
            ctx.fillStyle = isPathEdge ? '#FBBF24' : 'rgba(255, 255, 255, 0.85)';
            ctx.fill();
          }
        });
        ctx.setLineDash([]);

        const order = { resource: 1, concept: 2, group: 3 };
        const sortedNodes = GRAPH_DATA.nodes.filter(isNodeVisible).sort((a, b) => order[a.nodeType] - order[b.nodeType]);

        sortedNodes.forEach(n => {
          const isSidebarTarget = sidebarHoveredNode && sidebarHoveredNode.id === n.id;
          const isFocus = focusNode && focusNode.id === n.id;
          const isNeighbor = focusNeighbors && focusNeighbors.has(n.id);
          const isPathNode = highlightedPathNodes.has(n.id);
          const isMatch = matchesSearch(n);

          let dim = false;
          if (hasPath && !isPathNode) dim = true;
          else if (focusNode && !isFocus && !isNeighbor) dim = true;
          if (searchQuery && !isMatch) dim = true;

          // When hovering over a link in the right panel, dim all other sibling link nodes so the hovered node pops out immediately
          if (sidebarHoveredNode && !isSidebarTarget && !isFocus) {
            ctx.globalAlpha = dim ? 0.08 : 0.28;
          } else {
            ctx.globalAlpha = dim ? 0.14 : 1.0;
          }

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
            !isSidebarTarget && (
              n.nodeType === 'group' ||
              n.nodeType === 'concept' ||
              isFocus ||
              isNeighbor ||
              isPathNode ||
              (searchQuery && isMatch) ||
              safeScale > 1.35 ||
              (n.groups && n.groups.length > 1)
            );

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
            drawRoundedRectPath(n.x - metrics.width / 2 - padX, labelY - padY, metrics.width + padX * 2, fontSize + padY * 2, 4);
            ctx.fill();

            ctx.fillStyle = isFocus ? '#0F172A' : (n.nodeType === 'concept' ? '#E9D5FF' : '#F8FAFC');
            ctx.fillText(text, n.x, labelY);
          }
        });

        // Draw Attention Beacon on top of everything when hovering a link/node in the right panel
        if (sidebarHoveredNode && isNodeVisible(sidebarHoveredNode)) {
          const sn = sidebarHoveredNode;
          ctx.globalAlpha = 1.0;

          // 1. Smooth dual ripples (2x faster: ~2.75-second cycle with sine fade-in/out)
          for (let ring = 0; ring < 2; ring++) {
            const phase = (timeSec * 0.36 + ring * 0.5) % 1;
            const easedPhase = Math.sin(phase * Math.PI * 0.5);
            const ringR = sn.radius * 1.6 + easedPhase * 26;
            const ringAlpha = Math.sin(phase * Math.PI) * 0.76;
            ctx.beginPath();
            ctx.arc(sn.x, sn.y, ringR, 0, Math.PI * 2);
            ctx.strokeStyle = ring === 0
              ? `rgba(34, 211, 238, ${ringAlpha})`
              : `rgba(250, 204, 21, ${ringAlpha})`;
            ctx.lineWidth = 2.5 / safeScale;
            ctx.stroke();
          }

          // 2. Smooth breathing glow aura (2x faster: ~2.5-second breath cycle)
          const glowR = sn.radius * 2.8 + Math.sin(timeSec * 2.5) * 2.4;
          const grad = ctx.createRadialGradient(sn.x, sn.y, sn.radius * 0.4, sn.x, sn.y, glowR);
          grad.addColorStop(0, 'rgba(250, 204, 21, 0.90)');
          grad.addColorStop(0.55, 'rgba(34, 211, 238, 0.48)');
          grad.addColorStop(1, 'rgba(34, 211, 238, 0)');
          ctx.beginPath();
          ctx.arc(sn.x, sn.y, glowR, 0, Math.PI * 2);
          ctx.fillStyle = grad;
          ctx.fill();

          // 3. Enlarged high-contrast node body (color-shifted to electric yellow + cyan ring + white core)
          const beaconR = Math.max(13, sn.radius * 1.9);
          if (sn.nodeType === 'concept') {
            drawDiamond(sn.x, sn.y, beaconR);
          } else {
            ctx.beginPath();
            ctx.arc(sn.x, sn.y, beaconR, 0, Math.PI * 2);
          }
          ctx.fillStyle = '#FACC15';
          ctx.fill();
          ctx.lineWidth = 3.2 / safeScale;
          ctx.strokeStyle = '#22D3EE';
          ctx.stroke();

          ctx.beginPath();
          ctx.arc(sn.x, sn.y, beaconR * 0.42, 0, Math.PI * 2);
          ctx.fillStyle = '#FFFFFF';
          ctx.fill();

          // 4. High-contrast callout pill badge below the glowing node
          const fontSize = 13;
          ctx.font = `800 ${fontSize}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          const labelText = `★ ${sn.label}`;
          const metrics = ctx.measureText(labelText);
          const padX = 8, padY = 4;
          const labelY = sn.y + beaconR + 7;

          ctx.fillStyle = '#FACC15';
          ctx.strokeStyle = '#FFFFFF';
          ctx.lineWidth = 2 / safeScale;
          drawRoundedRectPath(sn.x - metrics.width / 2 - padX, labelY - padY, metrics.width + padX * 2, fontSize + padY * 2, 6);
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = '#0F172A';
          ctx.fillText(labelText, sn.x, labelY);
        }
      } finally {
        ctx.globalAlpha = 1.0;
        ctx.restore();
      }
    }

    function loop() {
      requestAnimationFrame(loop);
      try {
        stepPhysics();
        render();
      } catch (err) {
        console.error('Graph loop error:', err);
      }
    }

    // Dynamic ResizeObserver so any change in viewable screen size automatically refits the graph!
    function handleResize() {
      const rect = canvasContainer.getBoundingClientRect();
      const w = rect.width || canvasContainer.clientWidth || Math.max(320, window.innerWidth - 360);
      const h = rect.height || canvasContainer.clientHeight || Math.max(420, window.innerHeight - 60);
      width = Math.max(200, w);
      height = Math.max(200, h);
      dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      updateDynamicCameraTargets();
      if (tickCount > 0) render();
    }

    if (typeof ResizeObserver !== 'undefined') {
      const resizeObserver = new ResizeObserver(() => {
        handleResize();
      });
      resizeObserver.observe(canvasContainer);
    }
    window.addEventListener('resize', handleResize);
    handleResize();
    zoomTo100PercentFill(true);
    render();

    // Keyboard shortcut: Esc zooms out to 100% Fill when not inside modal
    window.addEventListener('keydown', (e) => {
      const dirOpen = document.getElementById('directory-dialog')?.open;
      const statsOpen = document.getElementById('stats-table-dialog')?.open;
      if (e.key === 'Escape' && !dirOpen && !statsOpen) {
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
        alpha = Math.max(alpha, 0.18);
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
        alpha = Math.max(alpha, 0.16);
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
          alpha = Math.max(alpha, 0.22);
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
      const zoomFactor = e.deltaY < 0 ? 1.07 : 0.93;
      targetCamScale = Math.min(3.8, Math.max(0.18, targetCamScale * zoomFactor));
      targetCamX = camX;
      targetCamY = camY;
      updateZoomReadout();
    }, { passive: false });

    function bindSidebarHover(el, targetNode) {
      if (!el || !targetNode) return;
      el.addEventListener('pointerenter', () => {
        sidebarHoveredNode = targetNode;
      });
      el.addEventListener('pointerleave', () => {
        if (sidebarHoveredNode === targetNode) sidebarHoveredNode = null;
      });
      el.addEventListener('focus', () => {
        sidebarHoveredNode = targetNode;
      });
      el.addEventListener('blur', () => {
        if (sidebarHoveredNode === targetNode) sidebarHoveredNode = null;
      });
    }

    function selectAndZoomNode(n) {
      sidebarHoveredNode = null;
      if (!n) {
        zoomTo100PercentFill(false);
        return;
      }
      selectedNode = n;
      autoFitMode = 'node';
      alpha = Math.max(alpha, 0.45);
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
        bindSidebarHover(btn, g);
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
        bindSidebarHover(btn, c);
        li.appendChild(btn);
        cList.appendChild(li);
      });
    }

    function updateSelectionUI(n) {
      sidebarHoveredNode = null;
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
          <div class="grid grid-cols-3 gap-2 text-center" role="group" aria-label="Open popup table views by node category">
            <button
              type="button"
              data-open-stat-table="groups"
              aria-label="Open popup table view of all 15 Tab Groups"
              class="p-2.5 rounded-xl bg-[var(--background)] border border-[var(--border)] hover:border-orange-500/80 hover:bg-orange-500/10 focus:outline-none focus:ring-2 focus:ring-orange-500 cursor-pointer transition-all group flex flex-col items-center justify-center"
            >
              <span class="text-base font-bold text-orange-400 group-hover:scale-105 transition-transform">15</span>
              <span class="text-xs text-[var(--muted-foreground)] group-hover:text-[var(--foreground)] font-medium">Tab Groups</span>
              <span class="text-[10px] text-orange-400/80 mt-0.5 font-semibold">Table View ↗</span>
            </button>
            <button
              type="button"
              data-open-stat-table="concepts"
              aria-label="Open popup table view of all 10 Concept Bridges"
              class="p-2.5 rounded-xl bg-[var(--background)] border border-[var(--border)] hover:border-purple-500/80 hover:bg-purple-500/10 focus:outline-none focus:ring-2 focus:ring-purple-500 cursor-pointer transition-all group flex flex-col items-center justify-center"
            >
              <span class="text-base font-bold text-purple-400 group-hover:scale-105 transition-transform">10</span>
              <span class="text-xs text-[var(--muted-foreground)] group-hover:text-[var(--foreground)] font-medium">Concept Bridges</span>
              <span class="text-[10px] text-purple-400/80 mt-0.5 font-semibold">Table View ↗</span>
            </button>
            <button
              type="button"
              data-open-stat-table="links"
              aria-label="Open popup table view of all 161 Unique Links"
              class="p-2.5 rounded-xl bg-[var(--background)] border border-[var(--border)] hover:border-emerald-500/80 hover:bg-emerald-500/10 focus:outline-none focus:ring-2 focus:ring-emerald-500 cursor-pointer transition-all group flex flex-col items-center justify-center"
            >
              <span class="text-base font-bold text-emerald-400 group-hover:scale-105 transition-transform">161</span>
              <span class="text-xs text-[var(--muted-foreground)] group-hover:text-[var(--foreground)] font-medium">Unique Links</span>
              <span class="text-[10px] text-emerald-400/80 mt-0.5 font-semibold">Table View ↗</span>
            </button>
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
          btn.className = 'text-left text-amber-400 hover:text-yellow-300 hover:underline cursor-pointer font-medium block truncate w-full';
          const gNames = r.groups.map(gid => nodeMap.get(gid).label).join(' + ');
          btn.textContent = `★ ${r.label} (${gNames})`;
          btn.addEventListener('click', () => selectAndZoomNode(r));
          bindSidebarHover(btn, r);
          li.appendChild(btn);
          bUl.appendChild(li);
        });
        body.querySelectorAll('[data-open-stat-table]').forEach(btn => {
          btn.addEventListener('click', () => openStatsTableModal(btn.dataset.openStatTable));
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

      html += `
        <div class="pt-2 border-t border-[var(--border)]">
          <div class="text-[11px] font-semibold text-[var(--muted-foreground)] mb-1.5">Quick Table Views</div>
          <div class="grid grid-cols-3 gap-2 text-center" role="group" aria-label="Open popup table views by node category">
            <button
              type="button"
              data-open-stat-table="groups"
              aria-label="Open popup table view of all 15 Tab Groups"
              class="p-2 rounded-xl bg-[var(--background)] border border-[var(--border)] hover:border-orange-500/80 hover:bg-orange-500/10 cursor-pointer transition-all group flex flex-col items-center justify-center"
            >
              <span class="text-sm font-bold text-orange-400">15</span>
              <span class="text-[11px] text-[var(--muted-foreground)] group-hover:text-[var(--foreground)]">Tab Groups</span>
            </button>
            <button
              type="button"
              data-open-stat-table="concepts"
              aria-label="Open popup table view of all 10 Concept Bridges"
              class="p-2 rounded-xl bg-[var(--background)] border border-[var(--border)] hover:border-purple-500/80 hover:bg-purple-500/10 cursor-pointer transition-all group flex flex-col items-center justify-center"
            >
              <span class="text-sm font-bold text-purple-400">10</span>
              <span class="text-[11px] text-[var(--muted-foreground)] group-hover:text-[var(--foreground)]">Concepts</span>
            </button>
            <button
              type="button"
              data-open-stat-table="links"
              aria-label="Open popup table view of all 161 Unique Links"
              class="p-2 rounded-xl bg-[var(--background)] border border-[var(--border)] hover:border-emerald-500/80 hover:bg-emerald-500/10 cursor-pointer transition-all group flex flex-col items-center justify-center"
            >
              <span class="text-sm font-bold text-emerald-400">161</span>
              <span class="text-[11px] text-[var(--muted-foreground)] group-hover:text-[var(--foreground)]">Unique Links</span>
            </button>
          </div>
        </div>
      `;

      body.innerHTML = html;

      document.getElementById('insp-zoom-100-btn').addEventListener('click', () => zoomTo100PercentFill(false));
      body.querySelectorAll('[data-open-stat-table]').forEach(btn => {
        btn.addEventListener('click', () => openStatsTableModal(btn.dataset.openStatTable));
      });

      if (connGroups.length) {
        const wrap = document.getElementById('insp-groups');
        connGroups.forEach(g => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'px-2.5 py-1 rounded-full text-xs font-medium border cursor-pointer transition-colors hover:bg-yellow-500/15';
          b.style.borderColor = g.color;
          b.style.color = g.color;
          b.textContent = g.label;
          b.addEventListener('click', () => selectAndZoomNode(g));
          bindSidebarHover(b, g);
          wrap.appendChild(b);
        });
      }

      if (connConcepts.length) {
        const wrap = document.getElementById('insp-concepts');
        connConcepts.forEach(c => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'px-2.5 py-1 rounded-lg text-xs font-medium border cursor-pointer transition-colors hover:bg-yellow-500/15';
          b.style.borderColor = c.color;
          b.style.color = c.color;
          b.textContent = '◆ ' + c.label;
          b.addEventListener('click', () => selectAndZoomNode(c));
          bindSidebarHover(b, c);
          wrap.appendChild(b);
        });
      }

      if (connResources.length) {
        const ul = document.getElementById('insp-resources');
        connResources.forEach(r => {
          const li = document.createElement('li');
          li.className = 'p-2 rounded-lg bg-[var(--background)] border border-[var(--border)] hover:border-yellow-400 hover:bg-yellow-500/10 flex items-center justify-between gap-2 transition-colors group';
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'text-left font-medium text-[var(--foreground)] group-hover:text-yellow-300 truncate cursor-pointer flex-1 flex items-center gap-2';
          btn.innerHTML = `<span class="w-2 h-2 rounded-full shrink-0 transition-transform group-hover:scale-150" style="background:${r.color}"></span><span class="truncate">${r.label}</span>`;
          btn.addEventListener('click', () => selectAndZoomNode(r));
          bindSidebarHover(li, r);
          bindSidebarHover(btn, r);

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
        alpha = 0.70;
        if (autoFitMode !== 'node') autoFitMode = 'all';
        document.querySelectorAll('.layout-btn').forEach(b => {
          const active = b === btn;
          b.className = active
            ? 'layout-btn px-2.5 py-1 text-xs font-medium rounded-md bg-orange-500 text-slate-950 cursor-pointer transition-colors'
            : 'layout-btn px-2.5 py-1 text-xs font-medium rounded-md text-[var(--muted-foreground)] hover:text-[var(--foreground)] cursor-pointer transition-colors';
        });
      });
    });

    document.getElementById('btn-toggle-links').addEventListener('click', (e) => {
      showAllLinks = !showAllLinks;
      e.currentTarget.textContent = showAllLinks ? 'View: All Nodes' : 'View: Hubs + Selected';
      alpha = 0.55;
      updateDynamicCameraTargets();
    });

    document.getElementById('btn-boing').addEventListener('click', () => {
      GRAPH_DATA.nodes.forEach(n => {
        n.vx += (Math.random() - 0.5) * 7.0;
        n.vy += (Math.random() - 0.5) * 7.0;
      });
      alpha = 0.65;
    });

    document.getElementById('btn-fit-100').addEventListener('click', () => zoomTo100PercentFill(false));
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
      targetCamScale = Math.min(3.8, targetCamScale * 1.18);
      targetCamX = camX;
      targetCamY = camY;
      updateZoomReadout();
    });

    document.getElementById('btn-zoom-out').addEventListener('click', () => {
      autoFitMode = 'manual';
      targetCamScale = Math.max(0.18, targetCamScale * 0.84);
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

    // Popup Table View Modal for the 3 Overview Stat Cards (15 Tab Groups, 10 Concept Bridges, 161 Unique Links)
    const statsTableDialog = document.getElementById('stats-table-dialog');
    const statsTableSearch = document.getElementById('stats-table-search');
    let activeStatCategory = 'groups';

    if (statsTableDialog) {
      statsTableDialog.addEventListener('close', () => {
        statsTableDialog.returnValue = '';
      });
    }

    document.querySelectorAll('.stat-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        activeStatCategory = btn.dataset.statTab;
        if (statsTableSearch) statsTableSearch.value = '';
        renderStatsPopupTable(activeStatCategory, '');
      });
    });

    if (statsTableSearch) {
      statsTableSearch.addEventListener('input', (e) => {
        renderStatsPopupTable(activeStatCategory, e.target.value.trim());
      });
    }

    function openStatsTableModal(category) {
      activeStatCategory = category || 'groups';
      if (statsTableSearch) statsTableSearch.value = '';
      renderStatsPopupTable(activeStatCategory, '');
      if (statsTableDialog) statsTableDialog.showModal();
    }

    function renderStatsPopupTable(category, filterText) {
      const q = (filterText || '').toLowerCase();
      const badge = document.getElementById('stats-table-badge');
      const title = document.getElementById('stats-table-dialog-title');
      const subtitle = document.getElementById('stats-table-subtitle');
      const countEl = document.getElementById('stats-table-count');
      const tableEl = document.getElementById('stats-popup-table');
      const thead = document.getElementById('stats-table-head');
      const tbody = document.getElementById('stats-table-body');
      const caption = document.getElementById('stats-table-caption');

      // Highlight active category tab button
      document.querySelectorAll('.stat-tab-btn').forEach(btn => {
        const isActive = btn.dataset.statTab === category;
        if (isActive) {
          const activeColors = {
            groups: 'bg-orange-500 text-slate-950',
            concepts: 'bg-purple-500 text-slate-950',
            links: 'bg-emerald-500 text-slate-950'
          };
          btn.className = `stat-tab-btn px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer transition-colors ${activeColors[category]}`;
        } else {
          btn.className = 'stat-tab-btn px-3 py-1.5 rounded-lg text-xs font-semibold text-[var(--muted-foreground)] hover:text-[var(--foreground)] cursor-pointer transition-colors';
        }
      });

      if (category === 'groups') {
        badge.textContent = '15 Tab Groups';
        badge.className = 'px-2.5 py-1 rounded-full text-xs font-bold shrink-0 bg-orange-500/20 text-orange-400 border border-orange-500/40';
        title.textContent = '15 Chrome Tab Groups — Table View';
        subtitle.textContent = 'All 15 tab groups from your iPhone Chrome snapshot, their tab counts, bridged concepts, and links.';
        caption.textContent = '15 Chrome Tab Groups and their connected concepts and links';

        tableEl.style.setProperty('--label-2', '"Saved Tabs"');
        tableEl.style.setProperty('--label-3', '"Concept Bridges"');
        tableEl.style.setProperty('--label-4', '"Summary & Sample Links"');
        tableEl.style.setProperty('--label-5', '"Action"');

        thead.innerHTML = `
          <tr>
            <th scope="col" class="px-4 py-3 font-semibold bg-[var(--card)] border-b border-[var(--border)]">Tab Group</th>
            <th scope="col" class="px-4 py-3 font-semibold bg-[var(--card)] border-b border-[var(--border)]">Saved Tabs</th>
            <th scope="col" class="px-4 py-3 font-semibold bg-[var(--card)] border-b border-[var(--border)]">Concept Bridges</th>
            <th scope="col" class="px-4 py-3 font-semibold bg-[var(--card)] border-b border-[var(--border)]">Summary &amp; Sample Links</th>
            <th scope="col" class="px-4 py-3 font-semibold bg-[var(--card)] border-b border-[var(--border)] text-right">Action</th>
          </tr>
        `;

        const rows = groupNodes.filter(g => {
          const groupLinks = resourceNodes.filter(r => r.groups.includes(g.id));
          if (!q) return true;
          return (
            g.label.toLowerCase().includes(q) ||
            (g.description && g.description.toLowerCase().includes(q)) ||
            groupLinks.some(r => r.label.toLowerCase().includes(q) || r.url.toLowerCase().includes(q))
          );
        });

        countEl.textContent = `${rows.length} of ${groupNodes.length} groups`;

        tbody.innerHTML = rows.map(g => {
          const groupLinks = resourceNodes.filter(r => r.groups.includes(g.id));
          const conceptIdSet = new Set();
          groupLinks.forEach(r => (r.concepts || []).forEach(cid => conceptIdSet.add(cid)));
          const groupConcepts = Array.from(conceptIdSet).map(cid => nodeMap.get(cid)).filter(Boolean);

          const conceptPills = groupConcepts.map(c =>
            `<button type="button" data-popup-zoom="${c.id}" class="px-2 py-0.5 rounded text-[11px] font-medium border hover:opacity-80 cursor-pointer" style="border-color:${c.color}66;color:${c.color}">◆ ${c.label}</button>`
          ).join(' ');

          const previewLinks = groupLinks.slice(0, 3).map(r =>
            `<a href="${r.url}" target="_blank" rel="noopener noreferrer" class="text-blue-400 hover:underline inline-block mr-2">${r.label} ↗</a>`
          ).join('');

          return `
            <tr class="hover:bg-[var(--card)]/70 transition-colors">
              <th scope="row" class="px-4 py-3 font-bold text-[var(--foreground)] align-top whitespace-nowrap">
                <div class="flex items-center gap-2">
                  <span class="w-3 h-3 rounded-full shrink-0" style="background:${g.color}"></span>
                  <span>${g.label}</span>
                </div>
              </th>
              <td class="px-4 py-3 align-top whitespace-nowrap">
                <span class="font-mono font-bold text-orange-400">${g.tabCount}</span>
                <span class="text-[var(--muted-foreground)]"> tabs (${groupLinks.length} unique)</span>
              </td>
              <td class="px-4 py-3 align-top">
                <div class="flex flex-wrap gap-1">${conceptPills || '<span class="text-[var(--muted-foreground)]">—</span>'}</div>
              </td>
              <td class="px-4 py-3 align-top max-w-md">
                <p class="text-[var(--foreground)] font-medium mb-1">${g.description || ''}</p>
                <div class="text-[11px] text-[var(--muted-foreground)]">${previewLinks}${groupLinks.length > 3 ? `<span>+${groupLinks.length - 3} more</span>` : ''}</div>
              </td>
              <td class="px-4 py-3 align-top text-right whitespace-nowrap">
                <button type="button" data-popup-zoom="${g.id}" class="px-3 py-1.5 rounded-lg bg-orange-500/15 border border-orange-500/40 text-orange-400 hover:bg-orange-500 hover:text-slate-950 font-semibold cursor-pointer transition-colors">
                  Zoom &amp; Fill ↗
                </button>
              </td>
            </tr>
          `;
        }).join('');

      } else if (category === 'concepts') {
        badge.textContent = '10 Concept Bridges';
        badge.className = 'px-2.5 py-1 rounded-full text-xs font-bold shrink-0 bg-purple-500/20 text-purple-300 border border-purple-500/40';
        title.textContent = '10 Cross-Cutting Concept Bridges — Table View';
        subtitle.textContent = 'Semantic concept hubs that connect related tools, repos, and docs across different Chrome Tab Groups.';
        caption.textContent = '10 Cross-Cutting Concept Bridges and the Tab Groups they connect';

        tableEl.style.setProperty('--label-2', '"Connected Links"');
        tableEl.style.setProperty('--label-3', '"Tab Groups Bridged"');
        tableEl.style.setProperty('--label-4', '"Description & Top Resources"');
        tableEl.style.setProperty('--label-5', '"Action"');

        thead.innerHTML = `
          <tr>
            <th scope="col" class="px-4 py-3 font-semibold bg-[var(--card)] border-b border-[var(--border)]">Concept Bridge</th>
            <th scope="col" class="px-4 py-3 font-semibold bg-[var(--card)] border-b border-[var(--border)]">Connected Links</th>
            <th scope="col" class="px-4 py-3 font-semibold bg-[var(--card)] border-b border-[var(--border)]">Tab Groups Bridged</th>
            <th scope="col" class="px-4 py-3 font-semibold bg-[var(--card)] border-b border-[var(--border)]">Description &amp; Key Links</th>
            <th scope="col" class="px-4 py-3 font-semibold bg-[var(--card)] border-b border-[var(--border)] text-right">Action</th>
          </tr>
        `;

        const rows = conceptNodes.filter(c => {
          const cLinks = resourceNodes.filter(r => (r.concepts || []).includes(c.id));
          if (!q) return true;
          return (
            c.label.toLowerCase().includes(q) ||
            (c.description && c.description.toLowerCase().includes(q)) ||
            cLinks.some(r => r.label.toLowerCase().includes(q) || r.url.toLowerCase().includes(q))
          );
        });

        countEl.textContent = `${rows.length} of ${conceptNodes.length} concepts`;

        tbody.innerHTML = rows.map(c => {
          const cLinks = resourceNodes.filter(r => (r.concepts || []).includes(c.id));
          const groupIdSet = new Set();
          cLinks.forEach(r => (r.groups || []).forEach(gid => groupIdSet.add(gid)));
          const bridgedGroups = Array.from(groupIdSet).map(gid => nodeMap.get(gid)).filter(Boolean);

          const groupPills = bridgedGroups.map(g =>
            `<button type="button" data-popup-zoom="${g.id}" class="px-2 py-0.5 rounded-full text-[11px] font-medium border hover:opacity-80 cursor-pointer" style="border-color:${g.color};color:${g.color}">${g.label}</button>`
          ).join(' ');

          const sampleLinks = cLinks.slice(0, 3).map(r =>
            `<a href="${r.url}" target="_blank" rel="noopener noreferrer" class="text-blue-400 hover:underline inline-block mr-2">${r.label} ↗</a>`
          ).join('');

          return `
            <tr class="hover:bg-[var(--card)]/70 transition-colors">
              <th scope="row" class="px-4 py-3 font-bold text-[var(--foreground)] align-top whitespace-nowrap">
                <div class="flex items-center gap-2">
                  <span class="w-3 h-3 rotate-45 shrink-0 inline-block" style="background:${c.color}"></span>
                  <span>${c.label}</span>
                </div>
              </th>
              <td class="px-4 py-3 align-top whitespace-nowrap">
                <span class="font-mono font-bold text-purple-400">${c.linkCount}</span>
                <span class="text-[var(--muted-foreground)]"> links across ${bridgedGroups.length} groups</span>
              </td>
              <td class="px-4 py-3 align-top">
                <div class="flex flex-wrap gap-1">${groupPills}</div>
              </td>
              <td class="px-4 py-3 align-top max-w-md">
                <p class="text-[var(--foreground)] font-medium mb-1">${c.description || ''}</p>
                <div class="text-[11px] text-[var(--muted-foreground)]">${sampleLinks}${cLinks.length > 3 ? `<span>+${cLinks.length - 3} more</span>` : ''}</div>
              </td>
              <td class="px-4 py-3 align-top text-right whitespace-nowrap">
                <button type="button" data-popup-zoom="${c.id}" class="px-3 py-1.5 rounded-lg bg-purple-500/15 border border-purple-500/40 text-purple-300 hover:bg-purple-500 hover:text-slate-950 font-semibold cursor-pointer transition-colors">
                  Zoom &amp; Fill ↗
                </button>
              </td>
            </tr>
          `;
        }).join('');

      } else {
        badge.textContent = '161 Unique Links';
        badge.className = 'px-2.5 py-1 rounded-full text-xs font-bold shrink-0 bg-emerald-500/20 text-emerald-400 border border-emerald-500/40';
        title.textContent = '161 Unique Saved Links — Table View';
        subtitle.textContent = 'Every unique website, GitHub repo, course, Google search, and doc extracted from your 170 iPhone tabs.';
        caption.textContent = '161 Unique Saved Links with their resource type, tab groups, concepts, and URLs';

        tableEl.style.setProperty('--label-2', '"Type"');
        tableEl.style.setProperty('--label-3', '"Tab Group(s)"');
        tableEl.style.setProperty('--label-4', '"Concept Bridge(s)"');
        tableEl.style.setProperty('--label-5', '"Actions"');

        thead.innerHTML = `
          <tr>
            <th scope="col" class="px-4 py-3 font-semibold bg-[var(--card)] border-b border-[var(--border)]">Saved Resource &amp; URL</th>
            <th scope="col" class="px-4 py-3 font-semibold bg-[var(--card)] border-b border-[var(--border)]">Type</th>
            <th scope="col" class="px-4 py-3 font-semibold bg-[var(--card)] border-b border-[var(--border)]">Tab Group(s)</th>
            <th scope="col" class="px-4 py-3 font-semibold bg-[var(--card)] border-b border-[var(--border)]">Concept Bridge(s)</th>
            <th scope="col" class="px-4 py-3 font-semibold bg-[var(--card)] border-b border-[var(--border)] text-right">Actions</th>
          </tr>
        `;

        const rows = resourceNodes.filter(r => {
          if (!q) return true;
          const gMatch = (r.groups || []).some(gid => nodeMap.get(gid)?.label.toLowerCase().includes(q));
          const cMatch = (r.concepts || []).some(cid => nodeMap.get(cid)?.label.toLowerCase().includes(q));
          return (
            r.label.toLowerCase().includes(q) ||
            (r.description && r.description.toLowerCase().includes(q)) ||
            (r.url && r.url.toLowerCase().includes(q)) ||
            (r.resourceType && r.resourceType.toLowerCase().includes(q)) ||
            gMatch ||
            cMatch
          );
        });

        countEl.textContent = `${rows.length} of ${resourceNodes.length} links`;

        tbody.innerHTML = rows.map(r => {
          const gPills = (r.groups || []).map(gid => {
            const g = nodeMap.get(gid);
            if (!g) return '';
            return `<button type="button" data-popup-zoom="${g.id}" class="px-2 py-0.5 rounded-full text-[11px] font-medium border hover:opacity-80 cursor-pointer" style="border-color:${g.color};color:${g.color}">${g.label}</button>`;
          }).join(' ');

          const cPills = (r.concepts || []).map(cid => {
            const c = nodeMap.get(cid);
            if (!c) return '';
            return `<button type="button" data-popup-zoom="${c.id}" class="px-2 py-0.5 rounded text-[11px] font-medium border hover:opacity-80 cursor-pointer" style="border-color:${c.color}66;color:${c.color}">◆ ${c.label}</button>`;
          }).join(' ');

          const multiBadge = (r.groups && r.groups.length > 1)
            ? `<span class="ml-1.5 px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[10px] font-semibold">★ Bridge</span>`
            : '';

          return `
            <tr class="hover:bg-[var(--card)]/70 transition-colors">
              <th scope="row" class="px-4 py-3 font-semibold text-[var(--foreground)] align-top max-w-sm">
                <div class="font-bold text-[var(--foreground)]">${r.label}${multiBadge}</div>
                <p class="text-[11px] font-normal text-[var(--muted-foreground)] mt-0.5">${r.description || ''}</p>
                <a href="${r.url}" target="_blank" rel="noopener noreferrer" class="text-[11px] font-mono font-normal text-blue-400 hover:underline block truncate mt-1">${r.url}</a>
              </th>
              <td class="px-4 py-3 align-top whitespace-nowrap">
                <span class="px-2 py-0.5 rounded bg-[var(--card)] border border-[var(--border)] text-[var(--muted-foreground)]">${r.resourceType}</span>
              </td>
              <td class="px-4 py-3 align-top">
                <div class="flex flex-wrap gap-1">${gPills}</div>
              </td>
              <td class="px-4 py-3 align-top">
                <div class="flex flex-wrap gap-1">${cPills}</div>
              </td>
              <td class="px-4 py-3 align-top text-right whitespace-nowrap">
                <div class="inline-flex items-center gap-1.5">
                  <a href="${r.url}" target="_blank" rel="noopener noreferrer" class="px-2.5 py-1.5 rounded-lg bg-[var(--card)] border border-[var(--border)] text-blue-400 hover:border-blue-400 font-semibold transition-colors">
                    Open ↗
                  </a>
                  <button type="button" data-popup-zoom="${r.id}" class="px-2.5 py-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/40 text-emerald-400 hover:bg-emerald-500 hover:text-slate-950 font-semibold cursor-pointer transition-colors">
                    Graph ↗
                  </button>
                </div>
              </td>
            </tr>
          `;
        }).join('');
      }

      tbody.querySelectorAll('[data-popup-zoom]').forEach(btn => {
        btn.addEventListener('click', () => {
          const target = nodeMap.get(btn.dataset.popupZoom);
          if (statsTableDialog) statsTableDialog.close();
          if (target) selectAndZoomNode(target);
        });
      });
    }

    // Re-bind the initial overview stat cards now that openStatsTableModal is initialized
    updateSelectionUI(selectedNode);

    buildNavigator();
    loop();
