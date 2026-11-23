const { z } = require("zod");
const { randomUUID, createHash } = require("node:crypto");
const Zones = require("../public/js/schedule-zones");
const { placement, occupied } = require("./itinerary-schedule");

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const uuid = z.uuid();
const text = (size, min = 0) => z.string().trim().min(min).max(size);
const note = text(3000).default("");
const labels = z.array(text(80, 1)).max(50).default([]);
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const point = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const zone = text(64, 1).refine(Zones.validZone, "Use an IANA timezone");
const date = z.string().refine(value => Zones.validDate(value) && value >= "1900-01-01" && value <= "9998-12-01", "Use a valid date");
const modes = ["Walking", "Cycling", "Driving", "Public transit"];
const statuses = ["Idea", "Researching", "Planning", "Ready to Schedule", "Confirmed", "In Progress", "Completed", "Archived"];
const strategies = ["duplicate", "relaxed", "shorter", "nearby", "budget", "outdoors", "food"];
const categories = ["Outdoors", "Culture", "Food & drink", "Transport", "Stay", "City or region", "Event", "Shop", "Other"];
const url = text(2048, 1).refine(value => {
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}, "Use an HTTP or HTTPS URL");
const source = z.object({
  url, label: text(120).default(""), kind: z.enum(["discovery", "official", "evidence"]).default("discovery"),
  observedAt: date.optional()
});
const geo = z.discriminatedUnion("type", [
  z.object({ type: z.literal("Point"), coordinates: point }),
  z.object({ type: z.literal("LineString"), coordinates: z.array(point).min(2).max(1000) }),
  z.object({ type: z.literal("MultiPoint"), coordinates: z.array(point).min(2).max(100) }),
  z.object({ type: z.literal("Polygon"), coordinates: z.array(z.array(point).min(4).max(1000).refine(ring =>
    ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1], "Close each polygon ring")).min(1).max(8) })
]);
const geometry = z.object({
  kind: z.enum(["exact", "approximate", "area", "route", "multi-location"]),
  shape: geo, source: url.optional()
}).refine(({ kind, shape }) => ({
  exact: "Point", approximate: "Point", area: "Polygon", route: "LineString", "multi-location": "MultiPoint"
})[kind] === shape.type, "Geometry does not match its representation");
const links = z.array(z.object({ type: z.enum(["task", "research", "wishlist"]), id: text(255, 1) })).max(60).default([]);
const money = z.number().min(0).max(100000000);
const currency = z.enum(["JPY", "USD", "COP", "EUR", "GBP", "CAD", "AUD", "MXN", "KRW", "NZD", "THB"]);
const evidence = z.object({
  field: z.enum(["name", "location", "hours", "season", "duration", "cost", "accessibility"]),
  status: z.enum(["supplied", "verified", "inferred"]),
  source: url.optional(),
  observedAt: date.optional()
}).refine(entry => entry.status !== "verified" || (entry.source && entry.observedAt), "Verified facts require a source and observation date");
const place = z.object({
  name: text(160, 1), category: z.enum(categories).default("Other"),
  region: text(160).default(""), group: text(100).default(""), address: text(240).default(""),
  geometries: z.array(geometry).max(12).default([]),
  description: note, notes: note, sources: z.array(source).max(100).default([]),
  originalText: text(5000).default(""), season: text(160).default(""), hours: text(300).default(""),
  accessibility: text(300).default(""),
  availability: z.array(z.discriminatedUnion("kind", [
    z.object({ date, kind: z.literal("closed") }),
    z.object({ date, kind: z.literal("window"), open: clock, close: clock })
  ])).max(100).default([]).refine(items => items.every(entry => entry.kind === "closed" || entry.open < entry.close) &&
    new Set(items.map(entry => entry.date)).size === items.length, "Enter one availability record per date with ascending local times"),
  duration: z.number().int().min(1).max(1440).nullable().default(null),
  cost: money.nullable().default(null), currency: currency.default("USD"),
  priority: z.enum(["Low", "Normal", "High"]).default("Normal"),
  tags: labels, companions: labels, collections: labels,
  favorite: z.boolean().default(false), archived: z.boolean().default(false),
  parents: z.array(uuid).max(20).default([]),
  visits: z.array(z.object({ date, notes: note })).max(200).default([]),
  evidence: z.array(evidence).max(80).default([]), links,
});
const stop = z.object({
  id: uuid, placeId: uuid.nullable().default(null), title: text(160).default(""),
  period: z.enum(["Morning", "Afternoon", "Evening"]).default("Morning"),
  time: z.union([clock, z.literal("")]).default(""),
  startOffset: z.string().regex(/^[+-](?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
  endOffset: z.string().regex(/^[+-](?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
  zone: zone.optional(), duration: z.number().int().min(1).max(1440).nullable().default(null),
  transferMinutes: z.number().int().min(0).max(1440).nullable().default(null),
  transferEvidence: z.object({ provider: z.literal("openrouteservice"), mode: z.enum(modes), observedAt: z.iso.datetime() }).optional(),
  cost: money.nullable().default(null), notes: note, optional: z.boolean().default(false), locked: z.boolean().default(false)
}).refine(item => item.placeId || item.title, "Enter an activity title or choose a place");
const trip = z.object({
  name: text(160, 1), version: text(80, 1).default("Original"),
  mode: z.enum(["Hypothetical", "Scheduled"]).default("Hypothetical"),
  status: z.enum(statuses).default("Planning"),
  start: z.union([date, z.literal("")]).default(""), zone,
  season: text(120).default(""), notes: note, destination: text(160).default(""),
  companions: labels, links, transport: z.enum(modes).default("Walking"),
  buffer: z.number().int().min(0).max(100).default(30),
  budget: money.nullable().default(null), currency: currency.default("USD"),
  days: z.array(z.object({ id: uuid, notes: note, stops: z.array(stop).max(50).default([]) })).min(1).max(62)
}).superRefine((value, ctx) => {
  const ids = value.days.flatMap(day => [day.id, ...day.stops.map(item => item.id)]);
  if (ids.length !== new Set(ids).size || ids.length > 512) ctx.addIssue({ code: "custom", message: "Days and stops must have unique IDs and fit within 512 rows" });
  if (Boolean(value.start) !== (value.mode === "Scheduled")) ctx.addIssue({ code: "custom", message: "Only a scheduled trip has an actual start date" });
});
const mutation = z.discriminatedUnion("action", [
  z.object({ action: z.literal("place-create"), id: uuid, value: place }),
  z.object({ action: z.literal("place-save"), id: uuid, revision: z.number().int().positive(), value: place }),
  z.object({ action: z.literal("place-collect"), collection: text(80, 1), items: z.array(z.object({ id: uuid, revision: z.number().int().positive() })).min(1).max(100) }),
  z.object({ action: z.literal("place-merge"), id: uuid, revision: z.number().int().positive(), sourceId: uuid, sourceRevision: z.number().int().positive() }),
  z.object({ action: z.literal("trip-create"), id: uuid, value: trip }),
  z.object({ action: z.literal("trip-save"), id: uuid, revision: z.number().int().positive(), value: trip }),
  z.object({ action: z.literal("trip-copy"), id: uuid, revision: z.number().int().positive(), version: text(80, 1), strategy: z.enum(strategies).default("duplicate") }),
  z.object({ action: z.literal("trip-date"), id: uuid, revision: z.number().int().positive(), date, asCopy: z.boolean() }),
  z.object({ action: z.literal("trip-publish"), id: uuid, revision: z.number().int().positive(), approval: text(64, 64), stopIds: z.array(uuid).min(1).max(450) }),
  z.object({ action: z.literal("trip-unpublish"), id: uuid, revision: z.number().int().positive(), approval: text(64, 64), stopIds: z.array(uuid).min(1).max(450) }),
  z.object({ action: z.literal("linked-task"), id: uuid, revision: z.number().int().positive(), kind: z.enum(["place", "trip"]), title: text(160, 1), date: date.optional() })
]);

function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw fail(result.error.issues.map(issue => issue.message).slice(0, 4).join(". "));
  return result.data;
}

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + stable(value[key])).join(",") + "}";
}

function hash(value) {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function anchor(p) {
  const shape = p?.geometries?.[0]?.shape;
  if (shape?.type === "Point") return shape.coordinates;
  if (shape?.type === "Polygon") return shape.coordinates[0][0];
  return shape?.coordinates[0] || null;
}

function distance(a, b) {
  const angle = Math.PI / 180;
  const latitude = (b[1] - a[1]) * angle;
  const longitude = (b[0] - a[0]) * angle;
  const h = Math.sin(latitude / 2) ** 2 + Math.cos(a[1] * angle) * Math.cos(b[1] * angle) * Math.sin(longitude / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(Math.min(1, h)));
}

function copy(value, version, strategy, places) {
  const result = structuredClone(value);
  if (strategy === "shorter") {
    const last = result.days.at(-1);
    if (result.days.length < 2 || last.stops.some(s => !s.optional || s.locked) || last.notes)
      throw fail("The last day has notes or required stops. Move them before shortening the trip.", 409);
    result.days.pop();
  }
  for (const day of result.days) {
    day.id = randomUUID();
    if (strategy === "relaxed") day.stops = day.stops.filter(stop => !stop.optional || stop.locked);
    if (strategy === "budget") {
      day.stops = day.stops.filter(stop => {
        const place = places.get(stop.placeId);
        const expense = stop.cost ?? (place?.currency === result.currency ? place.cost : null);
        return !stop.optional || stop.locked || !expense;
      });
    }
    if (strategy === "outdoors" || strategy === "food") {
      const category = strategy === "food" ? "Food & drink" : "Outdoors";
      day.stops = day.stops.filter(stop => !stop.optional || stop.locked || !stop.placeId || places.get(stop.placeId)?.category === category);
    }
    if (strategy === "nearby") {
      const points = stop => anchor(places.get(stop.placeId));
      for (let i = 1; i < day.stops.length; i++) {
        const from = points(day.stops[i - 1]);
        if (!from || day.stops[i].locked || day.stops[i].time || !points(day.stops[i])) continue;
        let nearest = i;
        for (let j = i + 1; j < day.stops.length; j++) {
          const other = day.stops[j];
          if (other.locked || other.time || !points(other) || other.period !== day.stops[i].period) break;
          if (distance(from, points(other)) < distance(from, points(day.stops[nearest]))) nearest = j;
        }
        day.stops.splice(i, 0, ...day.stops.splice(nearest, 1));
      }
    }
    for (const item of day.stops) {
      item.id = randomUUID();
      if (strategy === "relaxed" && !item.locked) item.time = "";
    }
  }
  if (strategy === "relaxed") result.buffer = Math.max(30, result.buffer);
  return { ...result, version };
}

function endTime(date, time, duration) {
  const end = new Date(Date.parse(date + "T" + time + ":00Z") + duration * 60000).toISOString();
  return { end: end.slice(11, 16), endDate: end.slice(0, 10) };
}

function preview(trip, places, blocks, appZone, projectedByStop = new Map()) {
  const days = trip.days.map((day, index) => {
    const date = Zones.shiftDate(trip.start, index);
    return { date, stops: day.stops.map(item => {
      const place = places.get(item.placeId);
      const title = item.title || place?.name || "Saved place";
      const duration = item.duration ?? place?.duration;
      const issues = [];
      let plan = null;
      if (!item.time) issues.push("Choose a start time to publish this activity.");
      if (!duration) issues.push("Enter an activity duration to publish this activity.");
      if (item.time && duration) {
        try {
          plan = placement({ date, timeZone: item.zone || trip.zone, start: item.time, startOffset: item.startOffset, endOffset: item.endOffset,
            ...endTime(date, item.time, duration) }, appZone);
        } catch (error) { issues.push(error.message); }
      }
      const checks = [];
      const availability = place?.availability?.find(entry => entry.date === date);
      if (availability?.kind === "closed") issues.push("Saved availability marks this place closed on " + date + ".");
      else if (availability && item.time && duration) {
        const finish = endTime(date, item.time, duration);
        if (item.time < availability.open || finish.endDate !== date || finish.end > availability.close)
          issues.push("Outside the saved opening window " + availability.open + "–" + availability.close + ".");
        checks.push("Opening window from saved place data");
      } else if (place?.hours) checks.push("Check venue hours for this date: " + place.hours);
      else if (place) checks.push("Opening hours unverified");
      if (place?.season) checks.push("Confirm seasonal access: " + place.season);
      if (place?.category === "Transport") checks.push("Confirm the timetable for this date");
      return { ...item, title, issues, checks, plan };
    }) };
  });
  const stops = days.flatMap(day => day.stops);
  const windows = blocks.filter(block => block.properties && block.type !== "day_root")
    .map(block => ({ block, time: occupied(block, appZone) })).filter(item => item.time?.end);
  for (const item of stops) {
    if (item.plan) {
      const ownedId = projectedByStop.get(item.id);
      for (const { block, time } of windows) {
        if (block.id !== ownedId && time.start < item.plan.endMs && time.end > item.plan.startMs)
          item.issues.push("Overlaps DCC activity: " + (block.properties.title || "Busy block"));
      }
      for (const other of stops) {
        if (item !== other && other.plan && other.plan.startMs < item.plan.endMs && other.plan.endMs > item.plan.startMs)
          item.issues.push("Overlaps trip activity: " + other.title);
      }
    }
  }
  for (const day of days) {
    for (let i = 1; i < day.stops.length; i++) {
      const item = day.stops[i], previous = day.stops[i - 1];
      if (item.transferMinutes == null) item.checks.push("Transfer time unavailable");
      if (item.transferEvidence) item.checks.push("Transfer estimate: " + item.transferEvidence.provider + " · " + item.transferEvidence.mode +
        " · " + item.transferEvidence.observedAt.slice(0, 10));
      if (item.transferMinutes != null && item.plan && previous.plan) {
        const minutes = Math.ceil(item.transferMinutes * (1 + trip.buffer / 100));
        if (item.plan.startMs - previous.plan.endMs < minutes * 60000)
          item.issues.push("Allow " + minutes + " minutes for the entered transfer and buffer.");
      }
    }
  }
  return days;
}

module.exports = { uuid, categories, modes, statuses, strategies, date, place, trip, mutation, parse, fail, hash, copy, preview, anchor, distance };
