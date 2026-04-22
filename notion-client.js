const { Client } = require("@notionhq/client");

const NOTION_TOKEN = process.env.NOTION_TOKEN || null;
let client = null;
if (NOTION_TOKEN) client = new Client({ auth: NOTION_TOKEN });

function isEnabled() { return client !== null; }

function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function completeTask(pageId) {
  if (!client) throw new Error("Notion not configured (set NOTION_TOKEN)");
  return client.pages.update({
    page_id: pageId,
    properties: {
      Status: { status: { name: "Done" } },
      Stage: { select: { name: "Done" } },
      "Date Completed": { date: { start: todayISO() } }
    }
  });
}

async function uncompleteTask(pageId) {
  if (!client) throw new Error("Notion not configured (set NOTION_TOKEN)");
  return client.pages.update({
    page_id: pageId,
    properties: {
      Status: { status: { name: "Tasks for Today" } },
      Stage: { select: { name: "Tasks for Today" } },
      "Date Completed": { date: null }
    }
  });
}

module.exports = { isEnabled, completeTask, uncompleteTask };
