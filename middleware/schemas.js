// Zod schemas for write endpoints. Permissive by design: unknown keys pass
// through, formats are checked only where a bad value would corrupt data or
// produce a confusing downstream error.
const { z } = require("zod");

const HHMM = /^\d{1,2}:\d{2}$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

const login = z.object({
  username: z.string().min(1, "username required"),
  password: z.string().min(1, "password required"),
}).passthrough();

const register = z.object({
  username: z.string().min(1, "username required"),
  password: z.string().min(1, "password required"),
}).passthrough();

const quickTask = z.object({
  title: z.string().trim().min(1, "title required"),
  date: z.string().regex(YMD, "date must be YYYY-MM-DD").optional(),
  start: z.string().regex(HHMM, "start must be HH:MM").optional(),
  durationMinutes: z.coerce.number().int().positive().optional(),
  duration: z.coerce.number().int().positive().optional(),
  priority: z.string().optional(),
  detail: z.string().optional(),
  tags: z.array(z.string()).optional(),
}).passthrough();

const blockItem = z.object({
  type: z.string().min(1, "type required"),
  date: z.string().regex(YMD, "date must be YYYY-MM-DD").nullish(),
  parent_id: z.string().nullish(),
  properties: z.union([z.record(z.any()), z.string()]).optional(),
  sort_order: z.coerce.number().optional(),
}).passthrough();

const blockCreate = z.union([blockItem, z.array(blockItem).min(1)]);

const tokenCreate = z.object({
  name: z.string().trim().min(1, "name required"),
  scope: z.enum(["dcc", "sweep", "all"]).optional(),
  ttlDays: z.coerce.number().int().positive().max(3650).optional(),
}).passthrough();

module.exports = { login, register, quickTask, blockCreate, tokenCreate };
