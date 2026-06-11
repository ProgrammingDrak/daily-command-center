/**
 * validate(schema) — express middleware validating req.body against a zod
 * schema. On failure: 400 with a compact list of issues. On success the
 * parsed (coerced) body replaces req.body.
 *
 * Schemas live in middleware/schemas.js. They are deliberately permissive
 * (passthrough unknown keys) so adding validation never breaks existing
 * callers — tighten per-field as confidence grows.
 */
module.exports = function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`);
      return res.status(400).json({ error: "Validation failed", issues });
    }
    req.body = result.data;
    next();
  };
};
