const { z } = require("zod");
const M = require("./wishlist-model");
const { createStore } = require("../wishlist-store");

const tools = [
  {
    name: "dcc_read_wishlist",
    description:
      "List private Wishlists, or read one Wishlist with criteria, options, assessments, offers, price history, research, and linked tasks.",
    inputSchema: z.toJSONSchema(z.strictObject({ wishlistId: M.uuid.optional() })),
    annotations: { readOnlyHint: true }
  },
  {
    name: "dcc_create_wishlist",
    description: "Create an unscheduled Wishlist. Supply a fresh UUID and a title. Reuse the UUID on retry.",
    inputSchema: z.toJSONSchema(z.strictObject({ id: M.uuid, title: M.overview.shape.title })),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  ...Object.entries({ overview: M.overview, ...M.records }).map(([kind, schema]) => ({
    name: "dcc_save_wishlist_" + kind,
    description:
      "Update Wishlist " +
      kind +
      ". Read the Wishlist first. Use revision 0 and a fresh record UUID to add a record. For updates send the current revision and only changed fields. Null clears optional fields. Reuse the same mutation ID and arguments on retry.",
    inputSchema: z.toJSONSchema(
      z.strictObject({
        wishlistId: M.uuid,
        ...(kind === "overview" ? {} : { recordId: M.uuid }),
        ...M.envelope.shape,
        data: schema.partial()
      })
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  }))
];
const names = new Set(tools.map((tool) => tool.name));
const scopeFor = (name) =>
  names.has(name) ? (name === "dcc_read_wishlist" ? "dcc.wishlist.read" : "dcc.wishlist.write") : null;

async function run(ctx, name, args, identity) {
  const store = createStore(ctx);
  if (name === "dcc_read_wishlist")
    return args.wishlistId === undefined
      ? { wishlists: await store.list(identity) }
      : store.get(identity, args.wishlistId);
  let result;
  if (name === "dcc_create_wishlist") {
    const { id, title } = args;
    result = await store.create(identity, { id, title });
  } else {
    const { wishlistId, recordId, ...body } = args;
    const kind = name.slice("dcc_save_wishlist_".length);
    result = await store.save(identity, wishlistId, kind, kind === "overview" ? null : recordId, body);
  }
  return identity.scopes?.includes("dcc.wishlist.read")
    ? result
    : { id: result.id, revision: result.revision, duplicate: result.duplicate === true };
}

module.exports = { tools, scopeFor, run };
