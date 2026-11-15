const { z } = require("zod");

const stages = ["Idea", "Researching", "Comparing", "Ready to Decide", "Decided", "On Hold"];
const uuid = z.uuidv4().refine((value) => value === value.toLowerCase(), "Use a lowercase UUID");
const text = z.string().trim().max(8000);
const title = z.string().trim().min(1).max(300);
const date = z.iso.date();
const currency = z.string().regex(/^[A-Z]{3}$/);
const money = z.string().regex(/^\d{1,15}(\.\d{1,6})?$/);
const link = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return !url.username && !url.password;
  }, "Use an HTTP or HTTPS link without credentials");

function fields(required, optional) {
  return z.strictObject({
    ...required,
    ...Object.fromEntries(Object.entries(optional).map(([key, schema]) => [key, schema.nullable().optional()]))
  });
}

const overview = fields(
  { title },
  {
    stage: z.enum(stages),
    want: text,
    why: text,
    problem: text,
    category: text,
    useCases: text,
    budget: money,
    currency,
    targetPrice: money,
    maximum: money,
    neededBy: date,
    reviewOn: date,
    favoriteId: uuid,
    questions: text,
    nextAction: text,
    coverId: uuid,
    rationale: text,
    alternatives: text,
    compromises: text,
    uncertainties: text,
    decisionOn: date,
    outcome: z.enum(["Purchased", "Built", "Kept what I have", "Decided against it"])
  }
);

const records = {
  criteria: fields(
    { title, importance: z.enum(["Must-have", "Important", "Nice-to-have"]) },
    {
      description: text,
      desired: text,
      units: text,
      notes: text,
      scope: text
    }
  ),
  options: fields(
    { title, kind: z.enum(["Product", "Service", "Prototype", "Concept", "DIY", "Inspiration"]) },
    {
      maker: text,
      model: text,
      version: text,
      variant: text,
      description: text,
      specifications: text,
      url: link,
      pros: text,
      cons: text,
      concerns: text,
      questions: text,
      reason: text,
      status: z.enum(["Considering", "Shortlisted", "Rejected", "Selected"])
    }
  ),
  assessments: fields(
    { optionId: uuid, criterionId: uuid },
    {
      actual: text,
      verdict: z.enum(["Meets", "Partly meets", "Fails", "Unverified", "Not applicable"]),
      url: link,
      checkedOn: date,
      notes: text
    }
  ),
  offers: fields(
    { optionId: uuid, title },
    {
      url: link,
      variant: text,
      condition: text,
      availability: text,
      location: text,
      price: money,
      currency,
      shipping: money,
      taxes: money,
      discount: money,
      extras: money,
      estimated: z.boolean(),
      returns: text,
      warranty: text,
      delivery: text,
      checkedOn: date
    }
  ),
  research: fields(
    { title },
    {
      kind: z.enum(["Manufacturer claim", "Independent review", "My observation", "Inference"]),
      source: text,
      url: link,
      checkedOn: date,
      notes: text,
      criterionId: uuid,
      optionId: uuid,
      offerId: uuid,
      assessmentId: uuid,
      attachmentId: uuid
    }
  ),
  tasks: fields({ taskId: z.string().min(1).max(255) }, { notes: text })
};
const envelope = z.strictObject({
  mutationId: uuid,
  revision: z.int().nonnegative(),
  data: z.record(z.string(), z.unknown())
});
const create = z
  .strictObject({ id: uuid, title: title.optional(), taskId: z.string().min(1).max(255).optional() })
  .refine((value) => Boolean(value.title) !== Boolean(value.taskId), "Provide a title or a task to convert");

function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw fail([issue.path.join("."), issue.message].filter(Boolean).join(": "));
  }
  return result.data;
}

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

const linkNewTask = fields({ id: uuid, title }, { notes: text });
module.exports = { stages, uuid, overview, records, envelope, create, linkNewTask, parse, fail };
