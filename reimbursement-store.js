const crypto = require("crypto");
const pool = require("./pg-pool");

const SPLIT_MODES = new Set(["equal", "percentage", "amount"]);
const DIRECTIONS = new Set(["owed_to_me", "i_owe"]);
const PAYMENT_METHODS = new Set([
  "bank_transfer", "credit_card", "debit_card", "cash", "venmo", "zelle",
  "paypal", "cash_app", "apple_cash", "other",
]);

function clientError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function cents(value, field = "amount") {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw clientError(`${field} must be whole cents.`);
  return number;
}

function text(value, max = 240) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

function email(value) {
  const normalized = text(value, 320).toLowerCase();
  if (normalized && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw clientError("Enter a valid participant email.");
  }
  return normalized || null;
}

function paymentMethod(value, field) {
  const method = text(value, 40) || "other";
  if (!PAYMENT_METHODS.has(method)) throw clientError(`${field} is not supported.`);
  return method;
}

function splitShares({ totalCents, splitMode, includeSelf, selfValue, participants = [] }) {
  const total = cents(totalCents, "totalCents");
  if (total <= 0) throw clientError("The total must be greater than zero.");
  if (!SPLIT_MODES.has(splitMode)) throw clientError("Choose equal, percentage, or amount splits.");
  if (!Array.isArray(participants) || participants.length > 25) {
    throw clientError("Add between one and 25 people.");
  }

  const people = participants.map((person, index) => {
    const name = text(person && person.name, 120);
    if (!name) throw clientError(`Person ${index + 1} needs a name.`);
    return {
      name,
      email: email(person.email),
      isSelf: false,
      value: person.value,
    };
  });
  if (!people.length) throw clientError("Add at least one person who owes you.");

  const seenEmails = new Set();
  for (const person of people) {
    if (!person.email) continue;
    if (seenEmails.has(person.email)) throw clientError("Each participant email must be unique.");
    seenEmails.add(person.email);
  }

  const subjects = includeSelf
    ? [{ name: "You", email: null, isSelf: true, value: selfValue }, ...people]
    : people;

  if (splitMode === "equal") {
    const base = Math.floor(total / subjects.length);
    let remainder = total - (base * subjects.length);
    return subjects.map((person) => ({
      ...person,
      shareCents: base + (remainder-- > 0 ? 1 : 0),
      sharePercentBp: null,
    }));
  }

  if (splitMode === "amount") {
    const shares = subjects.map((person, index) => ({
      ...person,
      shareCents: cents(person.value, `split amount ${index + 1}`),
      sharePercentBp: null,
    }));
    const sum = shares.reduce((value, person) => value + person.shareCents, 0);
    if (sum !== total) throw clientError("Custom amounts must add up to the expense total.");
    return shares;
  }

  const shares = subjects.map((person, index) => {
    const percent = Number(person.value);
    if (!Number.isFinite(percent) || percent < 0) {
      throw clientError(`split percentage ${index + 1} must be zero or greater.`);
    }
    return { ...person, sharePercentBp: Math.round(percent * 100) };
  });
  const basisPoints = shares.reduce((value, person) => value + person.sharePercentBp, 0);
  if (basisPoints !== 10000) throw clientError("Custom percentages must add up to 100%.");

  let assigned = 0;
  return shares.map((person, index) => {
    const shareCents = index === shares.length - 1
      ? total - assigned
      : Math.floor((total * person.sharePercentBp) / 10000);
    assigned += shareCents;
    return { ...person, shareCents };
  });
}

function totalsFor(reimbursement, participants, payments) {
  const paidByParticipant = new Map();
  const paymentsByParticipant = new Map();
  for (const payment of payments) {
    paidByParticipant.set(
      payment.participant_id,
      (paidByParticipant.get(payment.participant_id) || 0) + Number(payment.amount_cents || 0)
    );
    if (!paymentsByParticipant.has(payment.participant_id)) paymentsByParticipant.set(payment.participant_id, []);
    paymentsByParticipant.get(payment.participant_id).push({
      id: payment.id,
      amountCents: Number(payment.amount_cents),
      method: payment.method,
      methodDetail: payment.method_detail || "",
      note: payment.note || "",
      createdAt: payment.created_at,
    });
  }

  const shapedParticipants = participants.map((person) => {
    const paidCents = paidByParticipant.get(person.id) || 0;
    const notDue = reimbursement.direction === "owed_to_me" && person.is_self;
    const outstandingCents = notDue ? 0 : Math.max(0, Number(person.share_cents) - paidCents);
    return {
      id: person.id,
      name: person.name,
      email: person.email || null,
      userId: person.user_id || null,
      isSelf: !!person.is_self,
      shareCents: Number(person.share_cents),
      sharePercentBp: person.share_percent_bp == null ? null : Number(person.share_percent_bp),
      paidCents,
      outstandingCents,
      status: notDue ? "included" : (outstandingCents === 0 ? "paid" : (paidCents > 0 ? "partial" : "outstanding")),
      paidAt: person.paid_at || null,
      payments: paymentsByParticipant.get(person.id) || [],
    };
  });

  const due = shapedParticipants.filter((person) => !(reimbursement.direction === "owed_to_me" && person.isSelf));
  const dueCents = due.reduce((value, person) => value + person.shareCents, 0);
  const paidCents = due.reduce((value, person) => value + person.paidCents, 0);
  const outstandingCents = due.reduce((value, person) => value + person.outstandingCents, 0);
  return {
    participants: shapedParticipants,
    dueCents,
    paidCents,
    outstandingCents,
    status: outstandingCents === 0 ? "settled" : (paidCents > 0 ? "partial" : "outstanding"),
  };
}

function publicRow(row, participants, payments, viewerUserId = null) {
  const totals = totalsFor(row, participants, payments);
  return {
    id: row.id,
    title: row.title,
    detail: row.detail || "",
    direction: row.direction,
    totalCents: Number(row.total_cents),
    purchaseDate: row.purchase_date,
    ownerName: row.owner_name || row.owner_username || "Someone",
    paidViaMethod: row.paid_via_method,
    paidViaDetail: row.paid_via_detail || "",
    repayToMethod: row.repay_to_method,
    repayToDetail: row.repay_to_detail || "",
    counterpartyName: row.counterparty_name || null,
    splitMode: row.split_mode,
    shareActive: !!row.share_active,
    ...totals,
    viewerParticipantId: totals.participants.find((person) => String(person.userId || "") === String(viewerUserId || ""))?.id || null,
  };
}

function reimbursementStore(db = pool) {
  async function loadChildren(client, ids) {
    if (!ids.length) return { participants: [], payments: [] };
    const [{ rows: participants }, { rows: payments }] = await Promise.all([
      client.query(
        `SELECT * FROM reimbursement_participants
          WHERE reimbursement_id = ANY($1::text[])
          ORDER BY created_at, id`,
        [ids]
      ),
      client.query(
        `SELECT * FROM reimbursement_payments
          WHERE reimbursement_id = ANY($1::text[])
          ORDER BY created_at, id`,
        [ids]
      ),
    ]);
    return { participants, payments };
  }

  function groupChildren(rows, key) {
    const grouped = new Map();
    for (const row of rows) {
      const id = row[key];
      if (!grouped.has(id)) grouped.set(id, []);
      grouped.get(id).push(row);
    }
    return grouped;
  }

  async function listForUser(userId) {
    const { rows } = await db.query(
      `SELECT r.*, u.username AS owner_username, COALESCE(u.display_name, u.username) AS owner_name,
              CASE WHEN r.owner_user_id = $1 THEN 'owner'
                   WHEN r.counterparty_user_id = $1 THEN 'counterparty'
                   ELSE 'participant' END AS viewer_role
         FROM reimbursements r
         JOIN users u ON u.id = r.owner_user_id
        WHERE r.archived_at IS NULL
          AND (r.owner_user_id = $1 OR r.counterparty_user_id = $1 OR EXISTS (
            SELECT 1 FROM reimbursement_participants p
             WHERE p.reimbursement_id = r.id AND p.user_id = $1
          ))
        ORDER BY r.created_at DESC`,
      [userId]
    );
    const children = await loadChildren(db, rows.map((row) => row.id));
    const participantMap = groupChildren(children.participants, "reimbursement_id");
    const paymentMap = groupChildren(children.payments, "reimbursement_id");

    return rows.map((row) => {
      const shaped = publicRow(row, participantMap.get(row.id) || [], paymentMap.get(row.id) || [], userId);
      const viewerParticipant = shaped.participants.find((person) => person.userId === userId) || null;
      const balanceKind = row.viewer_role === "owner"
        ? (row.direction === "owed_to_me" ? "receivable" : "payable")
        : (row.viewer_role === "counterparty" ? "receivable" : "payable");
      if (row.viewer_role === "participant") {
        shaped.participants = viewerParticipant ? [viewerParticipant] : [];
        shaped.dueCents = viewerParticipant ? viewerParticipant.shareCents : 0;
        shaped.paidCents = viewerParticipant ? viewerParticipant.paidCents : 0;
        shaped.outstandingCents = viewerParticipant ? viewerParticipant.outstandingCents : 0;
        shaped.status = shaped.outstandingCents === 0 ? "settled" : (shaped.paidCents ? "partial" : "outstanding");
      }
      return {
        ...shaped,
        viewerRole: row.viewer_role,
        balanceKind,
        shareUrl: row.share_active ? `/reimburse/${row.share_token}` : null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  }

  async function create({ ownerUserId, workspaceId, body }) {
    const direction = text(body.direction, 30);
    if (!DIRECTIONS.has(direction)) throw clientError("Choose who paid for the expense.");
    const title = text(body.title, 160);
    if (!title) throw clientError("Add a title for the expense.");
    const totalCents = cents(body.totalCents, "totalCents");
    if (totalCents <= 0) throw clientError("The total must be greater than zero.");
    const purchaseDate = /^\d{4}-\d{2}-\d{2}$/.test(text(body.purchaseDate, 10))
      ? text(body.purchaseDate, 10)
      : null;
    const paidViaMethod = paymentMethod(body.paidViaMethod, "Paid with");
    const repayToMethod = paymentMethod(body.repayToMethod, "Repay with");
    const id = `reim_${crypto.randomUUID()}`;
    const token = crypto.randomBytes(18).toString("base64url");

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const { rows: ownerRows } = await client.query(
        "SELECT id, username, display_name, email FROM users WHERE id = $1",
        [ownerUserId]
      );
      const owner = ownerRows[0];
      if (!owner) throw clientError("Account not found.", 404);

      let counterpartyName = null;
      let counterpartyEmail = null;
      let counterpartyUserId = null;
      let splits;
      let splitMode = text(body.splitMode, 30) || "equal";

      if (direction === "owed_to_me") {
        splits = splitShares({
          totalCents,
          splitMode,
          includeSelf: body.includeSelf !== false,
          selfValue: body.selfValue,
          participants: body.participants,
        });
      } else {
        counterpartyName = text(body.counterpartyName, 120);
        counterpartyEmail = email(body.counterpartyEmail);
        if (!counterpartyName) throw clientError("Add the name of the person who paid.");
        const owedCents = cents(body.owedCents, "owedCents");
        if (owedCents <= 0 || owedCents > totalCents) {
          throw clientError("Your share must be greater than zero and no more than the total.");
        }
        splitMode = "amount";
        splits = [{
          name: owner.display_name || owner.username,
          email: owner.email || null,
          isSelf: true,
          shareCents: owedCents,
          sharePercentBp: null,
          userId: ownerUserId,
        }];
      }

      const lookupEmails = [counterpartyEmail, ...splits.map((person) => person.email)].filter(Boolean);
      const accountByEmail = new Map();
      if (lookupEmails.length) {
        const { rows: accountRows } = await client.query(
          "SELECT id, lower(email) AS email FROM users WHERE lower(email) = ANY($1::text[])",
          [lookupEmails]
        );
        accountRows.forEach((account) => accountByEmail.set(account.email, account.id));
      }
      if (counterpartyEmail) counterpartyUserId = accountByEmail.get(counterpartyEmail) || null;
      if (direction === "i_owe" && counterpartyUserId === ownerUserId) {
        throw clientError("The person who paid cannot be your own account.");
      }
      if (direction === "owed_to_me" && splits.some((person) => !person.isSelf && accountByEmail.get(person.email) === ownerUserId)) {
        throw clientError("Do not add your own account as another participant.");
      }

      await client.query(
        `INSERT INTO reimbursements
           (id, workspace_id, owner_user_id, direction, title, detail, total_cents,
            purchase_date, split_mode, paid_via_method, paid_via_detail,
            repay_to_method, repay_to_detail, counterparty_name, counterparty_email,
            counterparty_user_id, share_token, share_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,TRUE)`,
        [
          id, workspaceId, ownerUserId, direction, title, text(body.detail, 2000), totalCents,
          purchaseDate, splitMode, paidViaMethod, text(body.paidViaDetail, 160),
          repayToMethod, text(body.repayToDetail, 160), counterpartyName, counterpartyEmail,
          counterpartyUserId, token,
        ]
      );

      for (const person of splits) {
        const participantId = `rp_${crypto.randomUUID()}`;
        const isSelf = !!person.isSelf;
        const participantUserId = isSelf
          ? ownerUserId
          : (person.email ? accountByEmail.get(person.email) || null : null);
        await client.query(
          `INSERT INTO reimbursement_participants
             (id, reimbursement_id, name, email, user_id, is_self, share_cents, share_percent_bp)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            participantId, id,
            isSelf ? (owner.display_name || owner.username) : person.name,
            isSelf ? (owner.email || null) : person.email,
            participantUserId, isSelf, person.shareCents, person.sharePercentBp,
          ]
        );
      }

      await client.query("COMMIT");
      return { id, shareToken: token };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function loadForUpdate(client, reimbursementId, participantId) {
    const { rows: reimbursementRows } = await client.query(
      "SELECT * FROM reimbursements WHERE id = $1 AND archived_at IS NULL FOR UPDATE",
      [reimbursementId]
    );
    const reimbursement = reimbursementRows[0];
    if (!reimbursement) throw clientError("Reimbursement not found.", 404);
    const { rows: participantRows } = await client.query(
      "SELECT * FROM reimbursement_participants WHERE id = $1 AND reimbursement_id = $2 FOR UPDATE",
      [participantId, reimbursementId]
    );
    const participant = participantRows[0];
    if (!participant) throw clientError("Participant not found.", 404);
    return { reimbursement, participant };
  }

  async function insertPayment(client, reimbursement, participant, body, recordedByUserId) {
    if (reimbursement.direction === "owed_to_me" && participant.is_self) {
      throw clientError("Your own share does not need repayment.");
    }
    const { rows } = await client.query(
      "SELECT COALESCE(SUM(amount_cents), 0)::int AS paid FROM reimbursement_payments WHERE participant_id = $1",
      [participant.id]
    );
    const remaining = Math.max(0, Number(participant.share_cents) - Number(rows[0].paid));
    const amountCents = cents(body.amountCents, "amountCents");
    if (amountCents <= 0 || amountCents > remaining) {
      throw clientError(`Payment must be between 1 and ${remaining} cents.`);
    }
    const id = `rpay_${crypto.randomUUID()}`;
    const method = paymentMethod(body.method, "Payment method");
    await client.query(
      `INSERT INTO reimbursement_payments
         (id, reimbursement_id, participant_id, amount_cents, method, method_detail,
          note, recorded_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id, reimbursement.id, participant.id, amountCents, method,
        text(body.methodDetail, 160), text(body.note, 500), recordedByUserId || null,
      ]
    );
    if (amountCents === remaining) {
      await client.query(
        "UPDATE reimbursement_participants SET paid_at = NOW(), updated_at = NOW() WHERE id = $1",
        [participant.id]
      );
    }
    await client.query("UPDATE reimbursements SET updated_at = NOW() WHERE id = $1", [reimbursement.id]);
    return { id, remainingCents: remaining - amountCents };
  }

  async function addPaymentForUser(reimbursementId, userId, body) {
    const participantId = text(body.participantId, 80);
    if (!participantId) throw clientError("Choose who made the payment.");
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const { reimbursement, participant } = await loadForUpdate(client, reimbursementId, participantId);
      const allowed = reimbursement.owner_user_id === userId
        || reimbursement.counterparty_user_id === userId
        || participant.user_id === userId;
      if (!allowed) throw clientError("Reimbursement not found.", 404);
      const result = await insertPayment(client, reimbursement, participant, body, userId);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function archive(reimbursementId, userId) {
    const { rows } = await db.query(
      `UPDATE reimbursements SET archived_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND owner_user_id = $2 AND archived_at IS NULL RETURNING id`,
      [reimbursementId, userId]
    );
    if (!rows[0]) throw clientError("Reimbursement not found.", 404);
    return { archived: true };
  }

  async function rotateShare(reimbursementId, userId) {
    const token = crypto.randomBytes(18).toString("base64url");
    const { rows } = await db.query(
      `UPDATE reimbursements
          SET share_token = $3, share_active = TRUE, updated_at = NOW()
        WHERE id = $1 AND owner_user_id = $2 AND archived_at IS NULL
        RETURNING share_token`,
      [reimbursementId, userId, token]
    );
    if (!rows[0]) throw clientError("Reimbursement not found.", 404);
    return { token };
  }

  async function disableShare(reimbursementId, userId) {
    const { rows } = await db.query(
      `UPDATE reimbursements SET share_active = FALSE, updated_at = NOW()
        WHERE id = $1 AND owner_user_id = $2 AND archived_at IS NULL RETURNING id`,
      [reimbursementId, userId]
    );
    if (!rows[0]) throw clientError("Reimbursement not found.", 404);
    return { disabled: true };
  }

  async function getPublic(token, viewerUserId = null) {
    if (!token || String(token).length < 20) throw clientError("Not found.", 404);
    const { rows } = await db.query(
      `SELECT r.*, u.username AS owner_username, COALESCE(u.display_name, u.username) AS owner_name
         FROM reimbursements r JOIN users u ON u.id = r.owner_user_id
        WHERE r.share_token = $1 AND r.share_active = TRUE AND r.archived_at IS NULL`,
      [String(token)]
    );
    const row = rows[0];
    if (!row) throw clientError("Not found.", 404);
    const children = await loadChildren(db, [row.id]);
    const shaped = publicRow(row, children.participants, children.payments, viewerUserId);
    shaped.participants = shaped.participants.map((person) => ({
      id: person.id,
      name: person.name,
      shareCents: person.shareCents,
      paidCents: person.paidCents,
      outstandingCents: person.outstandingCents,
      status: person.status,
      isSelf: person.isSelf,
      accountBound: !!person.userId,
      available: !person.userId || String(person.userId) === String(viewerUserId || ""),
    }));
    shaped.viewerIsCounterparty = !!viewerUserId
      && String(row.counterparty_user_id || "") === String(viewerUserId);
    shaped.counterpartyAccountBound = !!row.counterparty_user_id;
    shaped.counterpartyAvailable = !row.counterparty_user_id
      || String(row.counterparty_user_id) === String(viewerUserId || "");
    return shaped;
  }

  async function claimPublic(token, userId, participantId) {
    if (!userId) throw clientError("Sign in to link this share to your account.", 401);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      if (participantId === "counterparty") {
        const { rows } = await client.query(
          `SELECT * FROM reimbursements
            WHERE share_token = $1 AND share_active = TRUE AND archived_at IS NULL
              AND direction = 'i_owe'
            FOR UPDATE`,
          [String(token)]
        );
        const reimbursement = rows[0];
        if (!reimbursement || reimbursement.owner_user_id === userId
            || (reimbursement.counterparty_user_id && reimbursement.counterparty_user_id !== userId)) {
          throw clientError("Not found.", 404);
        }
        await client.query(
          "UPDATE reimbursements SET counterparty_user_id = $2, updated_at = NOW() WHERE id = $1",
          [reimbursement.id, userId]
        );
        await client.query("COMMIT");
        return { linked: true };
      }
      const { rows } = await client.query(
        `SELECT r.*, p.id AS participant_id, p.user_id AS participant_user_id
           FROM reimbursements r
           JOIN reimbursement_participants p ON p.reimbursement_id = r.id
          WHERE r.share_token = $1 AND r.share_active = TRUE AND r.archived_at IS NULL
            AND p.id = $2
          FOR UPDATE OF r, p`,
        [String(token), participantId]
      );
      const row = rows[0];
      if (!row || row.owner_user_id === userId
          || (row.participant_user_id && row.participant_user_id !== userId)) {
        throw clientError("Not found.", 404);
      }
      await client.query(
        "UPDATE reimbursement_participants SET user_id = $2, claimed_at = NOW(), updated_at = NOW() WHERE id = $1",
        [participantId, userId]
      );
      await client.query("COMMIT");
      return { linked: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function addPublicPayment(token, viewerUserId, body) {
    const participantId = text(body.participantId, 80);
    if (!participantId) throw clientError("Choose your name first.");
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `SELECT r.id
           FROM reimbursements r
          WHERE r.share_token = $1 AND r.share_active = TRUE AND r.archived_at IS NULL
          FOR UPDATE`,
        [String(token)]
      );
      if (!rows[0]) throw clientError("Not found.", 404);
      const { reimbursement, participant } = await loadForUpdate(client, rows[0].id, participantId);
      if (reimbursement.direction === "i_owe") {
        if (viewerUserId && reimbursement.owner_user_id === viewerUserId) {
          throw clientError("This reimbursement already belongs to your account.", 400);
        }
        if (reimbursement.counterparty_user_id
            && String(reimbursement.counterparty_user_id) !== String(viewerUserId || "")) {
          throw clientError("Sign in with the account linked to this reimbursement.", viewerUserId ? 404 : 401);
        }
        if (viewerUserId && !reimbursement.counterparty_user_id) {
          await client.query(
            "UPDATE reimbursements SET counterparty_user_id = $2, updated_at = NOW() WHERE id = $1",
            [reimbursement.id, viewerUserId]
          );
        }
      } else {
        if (participant.user_id && String(participant.user_id) !== String(viewerUserId || "")) {
          throw clientError("Sign in with the account linked to this share.", viewerUserId ? 404 : 401);
        }
        if (viewerUserId && !participant.user_id) {
          await client.query(
            "UPDATE reimbursement_participants SET user_id = $2, claimed_at = NOW(), updated_at = NOW() WHERE id = $1",
            [participant.id, viewerUserId]
          );
        }
      }
      const result = await insertPayment(client, reimbursement, participant, body, viewerUserId);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    listForUser,
    create,
    addPaymentForUser,
    archive,
    rotateShare,
    disableShare,
    getPublic,
    claimPublic,
    addPublicPayment,
  };
}

const store = reimbursementStore();

module.exports = {
  ...store,
  reimbursementStore,
  splitShares,
  totalsFor,
  PAYMENT_METHODS,
};
