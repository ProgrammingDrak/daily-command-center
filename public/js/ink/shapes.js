// Geometric shapes are semantic objects. Never send their vertices through
// the handwriting renderer: its midpoint smoothing rounds corners and heads.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.InkShapes = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const TYPES = Object.freeze(["line", "arrow", "rectangle", "ellipse"]);

  function valid(shape) {
    return shape && shape.kind === "shape" && TYPES.includes(shape.shapeType)
      && [shape.x, shape.y, shape.endX, shape.endY, shape.size].every(Number.isFinite)
      && shape.size > 0 && /^#[a-f0-9]{6}$/i.test(shape.color);
  }

  function create(type, start, end, options = {}) {
    const shape = { kind: "shape", v: 1, shapeType: type, x: start.x, y: start.y,
      endX: end.x, endY: end.y, color: options.color || "#292722", size: options.size || 4 };
    if (!valid(shape)) throw new TypeError("Invalid geometric shape");
    return shape;
  }

  function geometry(shape) {
    if (!valid(shape)) return null;
    const { x, y, endX, endY } = shape;
    const left = Math.min(x, endX), top = Math.min(y, endY);
    const width = Math.abs(endX - x), height = Math.abs(endY - y);
    if (shape.shapeType === "ellipse") return { ellipse: { x: left + width / 2, y: top + height / 2, rx: width / 2, ry: height / 2 }, paths: [] };
    if (shape.shapeType === "rectangle") return { paths: [[[left, top], [left + width, top], [left + width, top + height], [left, top + height], [left, top]]] };
    const paths = [[[x, y], [endX, endY]]];
    if (shape.shapeType === "arrow") {
      const dx = endX - x, dy = endY - y, length = Math.hypot(dx, dy);
      if (length > 0) {
        const ux = dx / length, uy = dy / length;
        // A short arrow's head must fit on its shaft instead of turning back
        // past the start. The head consists of two independent straight legs.
        const head = Math.min(Math.max(24, shape.size * 5), 55, length * 0.4);
        const back = head * Math.cos(Math.PI / 6), side = head * Math.sin(Math.PI / 6);
        paths.push([[endX - ux * back - uy * side, endY - uy * back + ux * side], [endX, endY]]);
        paths.push([[endX - ux * back + uy * side, endY - uy * back - ux * side], [endX, endY]]);
      }
    }
    return { paths };
  }

  function draw(context, shape) {
    const data = geometry(shape);
    if (!data) return false;
    context.save();
    context.strokeStyle = shape.color; context.lineWidth = shape.size;
    context.lineJoin = "miter"; context.lineCap = "round";
    context.beginPath();
    if (data.ellipse) {
      const e = data.ellipse;
      if (!e.rx || !e.ry) { context.restore(); return false; }
      context.ellipse(e.x, e.y, e.rx, e.ry, 0, 0, Math.PI * 2);
      context.closePath();
    } else for (const path of data.paths) {
      context.moveTo(...path[0]);
      for (let n = 1; n < path.length; n++) context.lineTo(...path[n]);
      if (shape.shapeType === "rectangle") context.closePath();
    }
    context.stroke(); context.restore();
    return true;
  }

  function bounds(shape) {
    const data = geometry(shape);
    if (!data) return null;
    if (data.ellipse) {
      const e = data.ellipse;
      return { x: e.x - e.rx, y: e.y - e.ry, w: e.rx * 2, h: e.ry * 2 };
    }
    const points = data.paths.flat();
    const x = Math.min(...points.map(p => p[0])), y = Math.min(...points.map(p => p[1]));
    return { x, y, w: Math.max(...points.map(p => p[0])) - x, h: Math.max(...points.map(p => p[1])) - y };
  }

  function translate(shape, dx, dy) {
    return { ...shape, x: shape.x + dx, y: shape.y + dy, endX: shape.endX + dx, endY: shape.endY + dy };
  }

  function hit(shape, x, y, radius = 0) {
    const data = geometry(shape);
    if (!data) return false;
    let paths = data.paths;
    if (data.ellipse) {
      const e = data.ellipse, path = [];
      for (let n = 0; n <= 96; n++) { const t = n * Math.PI / 48; path.push([e.x + Math.cos(t) * e.rx, e.y + Math.sin(t) * e.ry]); }
      paths = [path];
    }
    for (const path of paths) for (let n = 1; n < path.length; n++) {
      const a = path[n - 1], b = path[n], dx = b[0] - a[0], dy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
      if (Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy) <= radius + shape.size / 2) return true;
    }
    return false;
  }
  return { TYPES, create, valid, geometry, draw, bounds, translate, hit };
});
