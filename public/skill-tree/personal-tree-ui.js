import { skillIcons as icons } from "./skill-icons.js";
export function renderPersonalTree(root, plan, goals = []) {
  const wrap = document.createElement("section");
  wrap.className = "personal-tree";
  const viewport = document.createElement("div");
  viewport.className = "tree-viewport";
  viewport.setAttribute(
    "aria-label",
    "个人技能树，身心左上、认知右上、实践向下",
  );
  const controls = document.createElement("div");
  controls.className = "tree-controls";
  const details = document.createElement("div");
  details.className = "node-detail";
  details.setAttribute("aria-live", "polite");
  const nodes = new Map(plan.skills.map((n) => [n.id, n])),
    expanded = new Set(["self"]);
  let selected = "self",
    zoom = 1,
    px = 0,
    py = 0;
  const children = (id) => plan.skills.filter((n) => n.parentId === id),
    positions = new Map([
      ["self", [0, 0]],
      ["body", [-75, -65]],
      ["mind", [75, -65]],
      ["practice", [0, 90]],
    ]);
  const branches = ["body", "mind", "practice"];
  let activeBranch = null;
  const currentSkills = new Set([
      ...plan.targetSkillIds,
      ...plan.tasks.flatMap((t) => t.skillIds),
    ]),
    goalSkills = new Set(goals.flatMap((g) => g.targetSkillIds)),
    scores = new Map();
  function importance(id) {
    if (scores.has(id)) return scores.get(id);
    const n = nodes.get(id),
      score = Math.max(
        currentSkills.has(id) ? 100 : 0,
        goalSkills.has(id) ? 60 : 0,
        n.baseline?.status === "lit" ? 30 : 0,
        ...children(id).map((c) => importance(c.id)),
      );
    scores.set(id, score);
    return score;
  }
  const highlights = (id) =>
    children(id)
      .map((n, index) => ({ n, index, score: importance(n.id) }))
      .filter((v) => v.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, 2)
      .map((v) => v.n);
  const weight = (id) =>
    Math.max(
      1,
      children(id).reduce((sum, n) => sum + weight(n.id), 0),
    );
  function assign(id, start, end, depth, parentRadius = 90) {
    const list = children(id),
      total = list.reduce((sum, n) => sum + weight(n.id), 0);
    let cursor = start;
    const r = Math.max(parentRadius + 140, (list.length * 70) / (end - start));
    list.forEach((n) => {
      const span = ((end - start) * weight(n.id)) / total,
        angle = cursor + span / 2;
      positions.set(n.id, [Math.cos(angle) * r, Math.sin(angle) * r]);
      assign(n.id, cursor, cursor + span, depth + 1, r);
      cursor += span;
    });
  }
  assign("body", Math.PI, Math.PI * 1.5, 1);
  assign("mind", Math.PI * 1.5, Math.PI * 2, 1);
  assign("practice", Math.PI * 0.16, Math.PI * 0.84, 1);
  function visibleIds() {
    const visible = [];
    function visit(id) {
      visible.push(id);
      if (branches.includes(id) && id !== activeBranch) return;
      (expanded.has(id) ? children(id) : highlights(id)).forEach((n) =>
        visit(n.id),
      );
    }
    visit("self");
    return visible;
  }
  function focus(id) {
    const points = visibleIds().map((key) => positions.get(key));
    const xs = points.map((p) => p[0]),
      ys = points.map((p) => p[1]),
      left = Math.min(...xs),
      right = Math.max(...xs),
      top = Math.min(...ys),
      bottom = Math.max(...ys);
    zoom = Math.min(
      1,
      (viewport.clientWidth - 64) / Math.max(1, right - left),
      ((viewport.clientHeight || 420) - 64) / Math.max(1, bottom - top),
    );
    px = (-(left + right) / 2) * zoom;
    py = (-(top + bottom) / 2) * zoom;
  }
  function draw() {
    const width = viewport.clientWidth || 360,
      height = viewport.clientHeight || 420,
      ns = "http://www.w3.org/2000/svg",
      svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.classList.add("tree-lines");
    svg.setAttribute("aria-hidden", "true");
    viewport.replaceChildren(svg);
    const visible = visibleIds();
    const sizeOf = (id) =>
      Math.max(24, (nodes.get(id).kind === "core" ? 56 : 44) * zoom);
    // Reserve the fixed entrances first, then place other nodes at the nearest
    // free screen-space position. Account for minimum hit sizes even when zoomed out.
    const placed = [],
      screen = new Map(),
      entrances = ["self", "body", "mind", "practice"];
    for (const id of [
      ...entrances.filter((id) => visible.includes(id)),
      ...visible.filter((id) => !entrances.includes(id)),
    ]) {
      const p = positions.get(id) || [0, 0],
        base = [width / 2 + p[0] * zoom + px, height / 2 + p[1] * zoom + py],
        size = sizeOf(id);
      const clear = ([x, y]) =>
        placed.every(
          (n) =>
            Math.abs(x - n.x) >= (size + n.size) / 2 + 10 ||
            Math.abs(y - n.y) >= (size + n.size) / 2 + 10,
        );
      let candidate = base;
      if (!entrances.includes(id) && !clear(candidate)) {
        const tangent = Math.atan2(p[1], p[0]) + Math.PI / 2;
        search: for (let radius = 8; ; radius += 8)
          for (let step = 0; step < 24; step++) {
            const angle = tangent + (step * Math.PI) / 12,
              next = [
                base[0] + Math.cos(angle) * radius,
                base[1] + Math.sin(angle) * radius,
              ];
            if (clear(next)) {
              candidate = next;
              break search;
            }
          }
      }
      screen.set(id, candidate);
      placed.push({ x: candidate[0], y: candidate[1], size });
    }
    const point = (id) => screen.get(id);
    for (const id of visible) {
      const n = nodes.get(id),
        [x, y] = point(id);
      if (n.parentId) {
        const [a, b] = point(n.parentId),
          line = document.createElementNS(ns, "line");
        for (const [k, v] of Object.entries({ x1: a, y1: b, x2: x, y2: y }))
          line.setAttribute(k, v);
        svg.append(line);
      }
      const button = document.createElement("button");
      button.className =
        "personal-node " +
        n.kind +
        (n.baseline?.status === "lit" ? " lit" : "");
      button.style.left = x + "px";
      button.style.top = y + "px";
      button.setAttribute("aria-label", n.name);
      button.setAttribute("aria-pressed", id === selected);
      if (children(id).length)
        button.setAttribute("aria-expanded", expanded.has(id));
      const size = sizeOf(id);
      button.style.width = size + "px";
      button.style.height = size + "px";
      if (children(id).length && !expanded.has(id))
        button.title = "点击完整展开下一层";
      const icon = document.createElement("i");
      icon.dataset.lucide = icons[n.icon] || "circle";
      icon.setAttribute("aria-hidden", "true");
      button.append(icon);
      button.onclick = () => {
        selected = id;
        if (branches.includes(id) && activeBranch !== id) {
          activeBranch = id;
          expanded.clear();
          expanded.add("self");
        }
        if (id !== "self" && children(id).length && !expanded.has(id)) {
          expanded.add(id);
          focus(id);
        }
        draw();
      };
      viewport.append(button);
    }
    const n = nodes.get(selected),
      path = [];
    let ancestor = n;
    while (ancestor) {
      path.unshift(ancestor.name);
      ancestor = nodes.get(ancestor.parentId);
    }
    details.replaceChildren();
    for (const [tag, value] of [
      ["small", path.join(" / ")],
      ["h3", n.name],
      ["p", n.description],
      [
        "small",
        n.kind === "core" || ["body", "mind", "practice"].includes(n.id)
          ? "固定入口"
          : n.baseline?.status === "lit"
            ? "已点亮 · 用户自述"
            : "基础未知 · 不代表不会",
      ],
    ]) {
      const e = document.createElement(tag);
      e.textContent = value;
      details.append(e);
    }
    const linked = goals.filter((g) => g.targetSkillIds.includes(selected));
    if (linked.length) {
      const p = document.createElement("p");
      p.textContent = "关联目标：" + linked.map((g) => g.title).join(" · ");
      details.append(p);
    }
    if (n.baseline?.quote) {
      const p = document.createElement("p");
      p.textContent = "自述依据：" + n.baseline.quote;
      details.append(p);
    }
    globalThis.lucide?.createIcons({ attrs: { width: 19, height: 19 } });
  }
  for (const [label, action] of [
    ["缩小", () => (zoom = Math.max(0.35, zoom - 0.15))],
    [
      "回到中心",
      () => {
        zoom = 1;
        px = py = 0;
      },
    ],
    ["放大", () => (zoom = Math.min(1.5, zoom + 0.15))],
  ]) {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => {
      action();
      draw();
    };
    controls.append(b);
  }
  viewport.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (!e.deltaY) return;
      const rect = viewport.getBoundingClientRect(),
        delta =
          e.deltaY *
          (e.deltaMode === 1
            ? 16
            : e.deltaMode === 2
              ? viewport.clientHeight
              : 1);
      const next = Math.max(
        0.35,
        Math.min(
          1.5,
          zoom * Math.exp(-Math.max(-160, Math.min(160, delta)) * 0.002),
        ),
      );
      if (next === zoom) return;
      const x =
          e.clientX -
          rect.left -
          viewport.clientLeft -
          viewport.clientWidth / 2,
        y = e.clientY - rect.top - viewport.clientTop - 210,
        ratio = next / zoom;
      px = x - (x - px) * ratio;
      py = y - (y - py) * ratio;
      zoom = next;
      draw();
    },
    { passive: false },
  );
  viewport.title = "滚轮缩放 · 拖动平移 · 点击节点展开并查看";
  let drag = null,
    moved = false;
  viewport.onpointerdown = (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, px, py, id: e.pointerId };
    moved = false;
  };
  viewport.onpointermove = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x,
      dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > 5) moved = true;
    if (moved) {
      viewport.setPointerCapture(e.pointerId);
      px = drag.px + dx;
      py = drag.py + dy;
      draw();
    }
  };
  viewport.onpointerup = viewport.onpointercancel = () => {
    drag = null;
  };
  viewport.addEventListener(
    "click",
    (e) => {
      if (moved) {
        e.stopPropagation();
        moved = false;
      }
    },
    true,
  );
  wrap.append(viewport, controls, details);
  root.append(wrap);
  draw();
  let lastWidth = viewport.clientWidth;
  const resize = new ResizeObserver(() => {
    if (!wrap.isConnected) {
      resize.disconnect();
      return;
    }
    if (viewport.clientWidth !== lastWidth) {
      lastWidth = viewport.clientWidth;
      draw();
    }
  });
  resize.observe(viewport);
}
