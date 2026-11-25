// Editable ink lives in the journal Markdown, so its normal save, conflict
// detection, export and access controls apply to drawings as well as text.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.JournalNotebook = api;
})(typeof window === "undefined" ? null : window, function () {
  "use strict";
  const MARKER = "\n\n<!-- dcc-journal-ink:v1\n";
  const WIDTH = 1000,
    HEIGHT = 1200;
  const PAPER_TYPES = Object.freeze([
    { id: "blank", label: "Blank / sketchbook" },
    { id: "college-ruled", label: "College ruled" },
    { id: "wide-ruled", label: "Wide ruled" },
    { id: "standard-ruled", label: "Standard ruled" },
    { id: "narrow-ruled", label: "Narrow ruled" },
    { id: "dotted", label: "Dotted / bullet journal" },
    { id: "graph", label: "Square grid / graph" },
    { id: "isometric", label: "Isometric grid" },
    { id: "cornell", label: "Cornell notes" },
    { id: "music", label: "Music staff" }
  ]);
  const paperName = (id) => PAPER_TYPES.find((type) => type.id === id)?.label;
  function pageTemplates(pages, templates) {
    if (
      templates !== undefined &&
      (!Array.isArray(templates) || templates.length !== pages.length || templates.some((id) => !paperName(id)))
    )
      throw new Error("Invalid journal paper templates");
    return templates ? templates.slice() : pages.map(() => "dotted");
  }
  const WRITING_TOOLS = [
    "ballpoint",
    "fineliner",
    "fountain",
    "pencil",
    "mechanical",
    "marker",
    "brush",
    "calligraphy",
    "pen",
    "highlighter"
  ];
  function pageObjects(pages, objects) {
    if (objects === undefined) return pages.map(() => []);
    if (
      !Array.isArray(objects) ||
      objects.length !== pages.length ||
      objects.some((page) => !Array.isArray(page) || page.length > 1000)
    )
      throw new Error("Invalid journal objects");
    const coordinate = (n) => Number.isFinite(n) && n >= -2000 && n <= 4000;
    const color = (value) => /^#[a-f0-9]{6}$/i.test(value);
    for (const page of objects)
      for (const object of page) {
        if (!object || !coordinate(object.x) || !coordinate(object.y))
          throw new Error("Invalid journal object position");
        if (object.kind === "shape") {
          if (
            !["arrow", "line", "rectangle", "ellipse"].includes(object.shapeType) ||
            !coordinate(object.endX) ||
            !coordinate(object.endY) ||
            !color(object.color) ||
            !Number.isFinite(object.size) ||
            object.size <= 0 ||
            object.size > 128
          )
            throw new Error("Invalid journal shape");
        } else {
          if (
            !["image", "text", "sticky", "tape", "star", "checkbox"].includes(object.kind) ||
            !Number.isFinite(object.w) ||
            !Number.isFinite(object.h) ||
            object.w <= 0 ||
            object.h <= 0 ||
            object.w > 4000 ||
            object.h > 4000
          )
            throw new Error("Invalid journal object");
          if (object.kind === "image") {
            if (!/^!\[Sketchbook image\]\(media:sha256:[a-f0-9]{64}\)$/.test(object.media))
              throw new Error("Invalid journal image reference");
          } else if (object.kind !== "tape" && !color(object.color)) throw new Error("Invalid journal object color");
          if (
            ["text", "sticky"].includes(object.kind) &&
            (typeof object.text !== "string" || object.text.length > 2000)
          )
            throw new Error("Invalid journal text");
        }
      }
    return objects.map((page) =>
      page.map((object) => {
        const keys =
          object.kind === "shape"
            ? ["kind", "v", "shapeType", "x", "y", "endX", "endY", "color", "size"]
            : object.kind === "image"
              ? ["kind", "x", "y", "w", "h", "media"]
              : ["kind", "x", "y", "w", "h", "color", "text", "revealed"];
        return Object.fromEntries(keys.filter((key) => Object.hasOwn(object, key)).map((key) => [key, object[key]]));
      })
    );
  }
  function pageSettings(pages, settings) {
    if (settings === undefined) return undefined;
    if (!Array.isArray(settings) || settings.length !== pages.length) throw new Error("Invalid journal paper settings");
    const types = ["blank", "ruled-narrow", "ruled", "ruled-wide", "dots", "grid", "engineering", "cornell", "music", "checklist", "daily", "weekly", "monthly", "handwriting", "isometric"];
    return settings.map(p => {
      if (p === null) return null;
      if (!p || !types.includes(p.type) || !["white", "cream", "gray"].includes(p.tint) ||
          !Number.isFinite(p.spacing) || p.spacing < 4 || p.spacing > 12 || typeof p.margin !== "boolean")
        throw new Error("Invalid journal paper settings");
      return { type:p.type, tint:p.tint, spacing:p.spacing, margin:p.margin };
    });
  }
  function unpack(markdown) {
    const start = markdown.lastIndexOf(MARKER);
    if (start < 0 || !markdown.endsWith("\n-->"))
      return { text: markdown, pages: [[]], templates: ["dotted"], objects: [[]] };
    const data = JSON.parse(markdown.slice(start + MARKER.length, -4));
    if (!Array.isArray(data.pages) || !data.pages.length || data.pages.length > 100)
      throw new Error("Invalid journal drawing pages");
    for (const page of data.pages) {
      if (!Array.isArray(page)) throw new Error("Invalid journal drawing page");
      for (const stroke of page) {
        if (stroke.style !== undefined && (!stroke.style || stroke.style.v !== 2 ||
          !Number.isFinite(stroke.style.angle) || stroke.style.angle < 0 || stroke.style.angle > 170))
          throw new Error("Invalid journal nib settings");
        if (
          !/^#[a-f0-9]{6}$/i.test(stroke.color) ||
          !Number.isFinite(stroke.size) ||
          stroke.size < 0.6 ||
          stroke.size > 128 ||
          (stroke.tool && !WRITING_TOOLS.includes(stroke.tool)) ||
          !Array.isArray(stroke.points) ||
          !stroke.points.length
        )
          throw new Error("Invalid journal stroke");
        for (const point of stroke.points) {
          if (
            !Array.isArray(point) ||
            ![2, 3].includes(point.length) ||
            point.some((n) => !Number.isFinite(n)) ||
            point[0] < -2000 ||
            point[0] > 4000 ||
            point[1] < -2000 ||
            point[1] > 4000 ||
            (point.length === 3 && (point[2] < 0 || point[2] > 1))
          )
            throw new Error("Invalid journal stroke point");
        }
      }
    }
    return {
      text: markdown.slice(0, start),
      pages: data.pages,
      templates: pageTemplates(data.pages, data.templates),
      objects: pageObjects(data.pages, data.objects),
      ...(data.papers !== undefined ? { papers: pageSettings(data.pages, data.papers) } : {})
    };
  }
  function pack(text, pages, templates, objects, papers) {
    const settings = pageSettings(pages, papers);
    const paper = pageTemplates(pages, templates);
    const content = pageObjects(pages, objects);
    const customPaper = paper.some((id) => id !== "dotted");
    const hasObjects = content.some((page) => page.length);
    const hasSettings = settings?.some(Boolean);
    const data = { pages, ...(hasSettings ? { papers: settings } : {}), ...(customPaper ? { templates: paper } : {}), ...(hasObjects ? { objects: content } : {}) };
    // Text annotations may contain HTML comment delimiters; escape them in the
    // serialized payload so they cannot escape the hidden Markdown block.
    return pages.some((page) => page.length) || pages.length > 1 || customPaper || hasObjects || hasSettings
      ? text +
          MARKER +
          JSON.stringify(data).replace(/[<>&]/g, (char) => ({ "<": "\\u003c", ">": "\\u003e", "&": "\\u0026" })[char]) +
          "\n-->"
      : text;
  }
  // Patterns share the ink's document coordinates, so lines stay aligned with
  // handwriting when the notebook resizes or a neighboring page is previewed.
  function drawPaper(context, template) {
    context.save();
    context.strokeStyle = "#b4a38580";
    context.fillStyle = "#b4a385b0";
    context.lineWidth = 1.3;
    const line = (x, y, endX, endY) => {
      context.moveTo(x, y);
      context.lineTo(endX, endY);
    };
    context.beginPath();
    const gap = { "college-ruled": 34, "wide-ruled": 52, "standard-ruled": 42, "narrow-ruled": 26 }[template];
    if (gap) {
      for (let y = 120; y < HEIGHT - 35; y += gap) line(30, y, WIDTH - 30, y);
      context.stroke();
      context.beginPath();
      context.strokeStyle = "#b76f6f70";
      line(110, 45, 110, HEIGHT - 25);
    } else if (template === "dotted") {
      for (let y = 40; y < HEIGHT; y += 40)
        for (let x = 40; x < WIDTH; x += 40) {
          context.moveTo(x + 1.6, y);
          context.arc(x, y, 1.6, 0, Math.PI * 2);
        }
      context.fill();
      context.beginPath();
    } else if (template === "graph") {
      for (let x = 0; x < WIDTH; x += 36) line(x, 0, x, HEIGHT);
      for (let y = 0; y < HEIGHT; y += 36) line(0, y, WIDTH, y);
    } else if (template === "isometric") {
      const offset = HEIGHT / Math.sqrt(3);
      for (let x = -offset; x < WIDTH + offset; x += 48) {
        line(x, 0, x + offset, HEIGHT);
        line(x, 0, x - offset, HEIGHT);
      }
      for (let y = 0; y < HEIGHT; y += 24 * Math.sqrt(3)) line(0, y, WIDTH, y);
    } else if (template === "cornell") {
      line(45, 145, WIDTH - 45, 145);
      line(260, 145, 260, HEIGHT - 230);
      line(45, HEIGHT - 230, WIDTH - 45, HEIGHT - 230);
      context.font = "22px sans-serif";
      context.fillStyle = "#8a7b62";
      context.fillText("Cues", 65, 185);
      context.fillText("Notes", 285, 185);
      context.fillText("Summary", 65, HEIGHT - 185);
    } else if (template === "music") {
      for (let y = 150; y < HEIGHT - 100; y += 155)
        for (let n = 0; n < 5; n++) line(65, y + n * 14, WIDTH - 65, y + n * 14);
    }
    context.stroke();
    context.restore();
  }
  function drawStrokes(context, strokes) {
    context.lineCap = "round";
    context.lineJoin = "round";
    for (const stroke of strokes) {
      context.strokeStyle = stroke.color;
      context.fillStyle = stroke.color;
      context.lineWidth = stroke.size;
      const [first, ...rest] = stroke.points;
      if (!rest.length) {
        context.beginPath();
        context.arc(first[0], first[1], stroke.size / 2, 0, Math.PI * 2);
        context.fill();
      } else {
        context.beginPath();
        context.moveTo(...first);
        for (const point of rest) context.lineTo(...point);
        context.stroke();
      }
    }
  }
  function mount(host, pages, options = {}) {
    if (!window.JournalSketchbook) throw new Error("Journal sketchbook tools are unavailable. Reload DCC and retry.");
    return window.JournalSketchbook.mount(host, pages, options);
  }
  return { PAPER_TYPES, drawPaper, drawLegacy: drawStrokes, unpack, pack, mount };
});
