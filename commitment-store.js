// A commitment is explicitly shared content, never an implicit projection of a
// private task. One accountable owner; invitations and powers are row scoped.
const crypto = require("node:crypto");

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS accountability_commitments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  definition_done TEXT NOT NULL,
  committed_date DATE NOT NULL,
  time_zone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','blocked','completed')),
  evidence TEXT NOT NULL DEFAULT '',
  check_in_at TIMESTAMPTZ,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS accountability_owner_date ON accountability_commitments(owner_user_id,committed_date);
CREATE TABLE IF NOT EXISTS accountability_members (
  commitment_id TEXT NOT NULL REFERENCES accountability_commitments(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK(role IN ('viewer','helper','coach','manager')),
  state TEXT NOT NULL DEFAULT 'invited' CHECK(state IN ('invited','accepted','declined')),
  PRIMARY KEY(commitment_id,user_id)
);
CREATE INDEX IF NOT EXISTS accountability_member_user ON accountability_members(user_id,state);
CREATE TABLE IF NOT EXISTS accountability_events (
  id BIGSERIAL PRIMARY KEY,
  commitment_id TEXT NOT NULL REFERENCES accountability_commitments(id),
  revision INTEGER NOT NULL,
  actor_user_id INTEGER NOT NULL REFERENCES users(id),
  action_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(actor_user_id,action_id),
  UNIQUE(commitment_id,revision)
);
`;

function error(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}
function text(value, label, max = 2000, required = true) {
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) {
    throw error(`${label} is required and must be at most ${max} characters`);
  }
  return value.trim();
}
function date(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)
      || !Number.isFinite(Date.parse(value + "T12:00:00Z"))
      || new Date(value + "T12:00:00Z").toISOString().slice(0, 10) !== value) throw error("Choose a real commitment date");
  return value;
}
function zone(value) {
  text(value, "Timezone", 100);
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); }
  catch { throw error("Choose a valid timezone"); }
  return value;
}
function instant(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)
      || !Number.isFinite(Date.parse(value))) throw error("Check-in needs a date, time and timezone");
  date(value.slice(0, 10));
  return new Date(value).toISOString();
}
function identity(value) {
  if (!Number.isSafeInteger(Number(value)) || Number(value) < 1) throw error("Sign in first", 401);
  return Number(value);
}
function actionId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) throw error("A stable action ID is required");
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
const hash = value => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const roles = ["viewer", "helper", "coach", "manager"];
function capabilities(role) {
  return {
    comment: ["owner", "helper", "coach", "manager"].includes(role),
    check_in: ["owner", "coach", "manager"].includes(role),
    challenge: ["coach", "manager"].includes(role),
    review: role === "manager",
    manage: role === "owner",
    complete: role === "owner",
    renegotiate: role === "owner",
  };
}

function shape(row, { role, ownerName, invitedRole, events = [], members = [] }) {
  if (role === "invited") return { id: row.id, title: row.title, ownerName, committed_date: row.committed_date,
    revision: row.revision, role, invitedRole, capabilities: {} };
  const withoutGroupingKey = ({ commitment_id: _commitmentId, ...fields }) => fields;
  return { ...row, ownerName, role, capabilities: capabilities(role),
    events: events.map(withoutGroupingKey), members: members.map(withoutGroupingKey) };
}

function createStore({ pool }) {
  async function tx(fn) {
    const client = await pool.connect();
    try { await client.query("BEGIN"); const out = await fn(client); await client.query("COMMIT"); return out; }
    catch (e) { await client.query("ROLLBACK"); throw e; }
    finally { client.release(); }
  }
  async function roleFor(q, row, userId) {
    if (row.owner_user_id === userId) return "owner";
    const { rows } = await q.query(`SELECT m.role,m.state FROM accountability_members m
      WHERE m.commitment_id=$1 AND m.user_id=$2 AND NOT EXISTS (
        SELECT 1 FROM friendships WHERE status='blocked' AND
        ((requester_id=$2 AND addressee_id=$3) OR (requester_id=$3 AND addressee_id=$2)))`,
    [row.id, userId, row.owner_user_id]);
    return rows[0]?.state === "accepted" ? rows[0].role : rows[0]?.state === "invited" ? "invited" : null;
  }
  async function readWith(q, id, userId) {
    const row = (await q.query("SELECT *,to_char(committed_date,'YYYY-MM-DD') AS committed_date FROM accountability_commitments WHERE id=$1 FOR SHARE", [id])).rows[0];
    if (!row) throw error("Commitment unavailable", 404);
    const role = await roleFor(q, row, userId);
    if (!role) throw error("Commitment unavailable", 404);
    const owner = (await q.query("SELECT username FROM users WHERE id=$1", [row.owner_user_id])).rows[0]?.username || "Owner";
    if (role === "invited") {
      const member = (await q.query("SELECT role FROM accountability_members WHERE commitment_id=$1 AND user_id=$2", [id, userId])).rows[0];
      return shape(row, { role, ownerName: owner, invitedRole: member.role });
    }
    const events = (await q.query(`SELECT e.id,e.revision,e.kind,e.detail,e.created_at,u.username AS actor_name
      FROM accountability_events e JOIN users u ON u.id=e.actor_user_id
      WHERE commitment_id=$1 ORDER BY revision`, [id])).rows;
    const members = (await q.query(`SELECT m.user_id,m.role,m.state,u.username
      FROM accountability_members m JOIN users u ON u.id=m.user_id WHERE commitment_id=$1 ORDER BY u.username`, [id])).rows;
    // Permission history names people, but never includes email, personal block
    // IDs, private source references, or any full day-state packet.
    return shape(row, { role, ownerName: owner, events, members });
  }
  async function read(id, user) { return tx(q => readWith(q, id, identity(user))); }
  async function list(user, day) {
    const userId = identity(user);
    if (day) date(day);
    return tx(async q => {
      // This is a complete collection: omission tells the client to remove a
      // cached record. Batch projections rather than truncating daily history.
      const { rows } = await q.query(`SELECT c.*,to_char(c.committed_date,'YYYY-MM-DD') AS committed_date FROM accountability_commitments c
        WHERE ($2::date IS NULL OR c.committed_date=$2::date) AND
        (c.owner_user_id=$1 OR EXISTS (SELECT 1 FROM accountability_members m
          WHERE m.commitment_id=c.id AND m.user_id=$1 AND m.state IN ('invited','accepted')
          AND NOT EXISTS(SELECT 1 FROM friendships f WHERE f.status='blocked' AND
            ((f.requester_id=$1 AND f.addressee_id=c.owner_user_id) OR
             (f.addressee_id=$1 AND f.requester_id=c.owner_user_id)))))
        ORDER BY c.committed_date,c.created_at FOR SHARE OF c`, [userId, day || null]);
      if (!rows.length) return [];
      const ids = rows.map(row => row.id);
      const owners = (await q.query("SELECT id,username FROM users WHERE id=ANY($1::int[])", [Array.from(new Set(rows.map(row => row.owner_user_id)))])).rows;
      const members = (await q.query(`SELECT m.commitment_id,m.user_id,m.role,m.state,u.username FROM accountability_members m
        JOIN users u ON u.id=m.user_id WHERE m.commitment_id=ANY($1::text[]) ORDER BY u.username`, [ids])).rows;
      const events = (await q.query(`SELECT e.commitment_id,e.id,e.revision,e.kind,e.detail,e.created_at,u.username AS actor_name
        FROM accountability_events e JOIN users u ON u.id=e.actor_user_id
        WHERE e.commitment_id=ANY($1::text[]) ORDER BY e.revision`, [ids])).rows;
      const byId = new Map(rows.map(row => [row.id, { members: [], events: [] }]));
      for (const member of members) byId.get(member.commitment_id).members.push(member);
      for (const event of events) byId.get(event.commitment_id).events.push(event);
      const names = new Map(owners.map(owner => [owner.id, owner.username]));
      return rows.map(row => {
        const related = byId.get(row.id), membership = related.members.find(m => m.user_id === userId);
        const role = row.owner_user_id === userId ? "owner" : membership?.state === "accepted" ? membership.role : "invited";
        const ownerName = names.get(row.owner_user_id) || "Owner";
        return shape(row, { ownerName, role, invitedRole: membership?.role, ...related });
      });
    });
  }
  async function append(q, row, userId, input, kind, detail, revision) {
    await q.query(`INSERT INTO accountability_events
      (commitment_id,revision,actor_user_id,action_id,input_hash,kind,detail)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [row.id, revision, userId, input.actionId, hash(input), kind, JSON.stringify(detail)]);
  }
  async function duplicate(q, userId, input, commitmentId) {
    const event = (await q.query("SELECT commitment_id,input_hash FROM accountability_events WHERE actor_user_id=$1 AND action_id=$2", [userId, input.actionId])).rows[0];
    if (!event) return false;
    if (event.commitment_id !== commitmentId || event.input_hash !== hash(input)) throw error("Action ID already used for a different change", 409);
    return true;
  }
  async function create(user, workspaceId, input) {
    const userId = identity(user); actionId(input.actionId); actionId(input.id);
    const fields = { title: text(input.title, "Outcome", 220), definition: text(input.definitionDone, "Definition of done"),
      date: date(input.committedDate), zone: zone(input.timeZone) };
    return tx(async q => {
      // Lock the operation before detecting duplicate creates, including ack loss.
      await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`commitment:${userId}:${input.actionId}`]);
      if (await duplicate(q, userId, input, input.id)) return readWith(q, input.id, userId);
      const ws = (await q.query("SELECT id FROM workspaces WHERE id=$1 AND owner_id=$2", [workspaceId, userId])).rows[0];
      if (!ws) throw error("Owned workspace required", 403);
      if ((await q.query("SELECT id FROM accountability_commitments WHERE id=$1", [input.id])).rows.length) throw error("Commitment ID already used", 409);
      await q.query(`INSERT INTO accountability_commitments(id,workspace_id,owner_user_id,title,definition_done,committed_date,time_zone)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [input.id, workspaceId, userId, fields.title, fields.definition, fields.date, fields.zone]);
      await append(q, { id: input.id }, userId, input, "created", fields, 1);
      return readWith(q, input.id, userId);
    });
  }
  async function act(user, id, input) {
    const userId = identity(user); actionId(input.actionId);
    return tx(async q => {
      await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`commitment:${userId}:${input.actionId}`]);
      const row = (await q.query("SELECT *,to_char(committed_date,'YYYY-MM-DD') AS committed_date FROM accountability_commitments WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!row) throw error("Commitment unavailable", 404);
      const role = await roleFor(q, row, userId);
      if (!role) throw error("Commitment unavailable", 404);
      const cap = capabilities(role);
      // Authorization is re-resolved under the same lock used by revoke. Even
      // receipts are unreadable after revocation; queues never resurrect access.
      if (await duplicate(q, userId, input, id)) return readWith(q, id, userId);
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== row.revision) throw error("This commitment changed. Refresh and review your pending action.", 409);
      const note = () => text(input.note, "Explanation");
      const requireCap = name => { if (!cap[name]) throw error("You do not have permission for that action", 403); };
      let detail;
      switch (input.kind) {
        case "comment": requireCap("comment"); detail = { note: note() }; break;
        case "challenge": requireCap("challenge"); detail = { note: note() }; break;
        case "check_in": {
          requireCap("check_in"); detail = { note: note(), at: instant(input.at) };
          await q.query("UPDATE accountability_commitments SET check_in_at=$2 WHERE id=$1", [id, detail.at]); break;
        }
        case "review": {
          requireCap("review");
          if (!["met", "partial", "missed"].includes(input.verdict)) throw error("Choose met, partial or missed");
          detail = { note: note(), verdict: input.verdict, status: row.status, evidence: row.evidence }; break;
        }
        case "complete": {
          requireCap("complete"); detail = { before: row.status, status: "completed", evidence: text(input.evidence || "", "Evidence", 2000, false) };
          await q.query("UPDATE accountability_commitments SET status='completed',evidence=$2 WHERE id=$1", [id, detail.evidence]); break;
        }
        case "blocked": case "reopen": {
          requireCap("complete"); detail = { before: row.status, status: input.kind === "blocked" ? "blocked" : "open", note: note() };
          await q.query("UPDATE accountability_commitments SET status=$2 WHERE id=$1", [id, detail.status]); break;
        }
        case "renegotiate": {
          requireCap("renegotiate"); detail = { beforeDate: row.committed_date, date: date(input.committedDate), note: note() };
          await q.query("UPDATE accountability_commitments SET committed_date=$2 WHERE id=$1", [id, detail.date]); break;
        }
        case "invite": {
          requireCap("manage"); const grantee = identity(input.userId);
          if (grantee === userId || !roles.includes(input.role)) throw error("Choose another account and a valid role");
          if ((await q.query("SELECT 1 FROM friendships WHERE status='blocked' AND ((requester_id=$1 AND addressee_id=$2) OR (requester_id=$2 AND addressee_id=$1))", [userId, grantee])).rows.length) throw error("Unblock this person first", 403);
          const account = (await q.query("SELECT username FROM users WHERE id=$1", [grantee])).rows[0];
          if (!account) throw error("Account unavailable", 404);
          // A role change requires acceptance again; no silent expansion.
          await q.query(`INSERT INTO accountability_members(commitment_id,user_id,role,state) VALUES($1,$2,$3,'invited')
            ON CONFLICT(commitment_id,user_id) DO UPDATE SET role=EXCLUDED.role,state='invited'`, [id, grantee, input.role]);
          detail = { username: account.username, role: input.role }; break;
        }
        case "accept": case "decline": {
          if (role !== "invited") throw error("There is no invitation to answer", 403);
          await q.query("UPDATE accountability_members SET state=$3 WHERE commitment_id=$1 AND user_id=$2", [id, userId, input.kind === "accept" ? "accepted" : "declined"]);
          detail = {}; break;
        }
        case "revoke": {
          requireCap("manage"); const grantee = identity(input.userId);
          const gone = (await q.query(`DELETE FROM accountability_members m USING users u
            WHERE m.commitment_id=$1 AND m.user_id=$2 AND u.id=m.user_id RETURNING u.username,m.role`, [id, grantee])).rows[0];
          if (!gone) throw error("Participant unavailable", 404);
          detail = gone; break;
        }
        default: throw error("Unknown commitment action");
      }
      await q.query("UPDATE accountability_commitments SET revision=revision+1,updated_at=NOW() WHERE id=$1", [id]);
      await append(q, row, userId, input, input.kind, detail, row.revision + 1);
      if (input.kind === "decline") return { id, declined: true, owner_user_id: row.owner_user_id };
      return readWith(q, id, userId);
    });
  }
  return { create, act, read, list };
}
module.exports = { SCHEMA_SQL, createStore, capabilities };
