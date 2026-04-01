// ======== TYPE CONFIG ========
const TC={
  triage: {tag:"Triage",cls:"tag-triage",color:"#a78bfa"},
  task:   {tag:"Task",cls:"tag-task",color:"#a78bfa"},
  focus:  {tag:"Focus",cls:"tag-focus",color:"#22d3ee"},
  meeting:{tag:"Meeting",cls:"tag-meeting",color:"#f97316"},
  oneone: {tag:"1:1",cls:"tag-oneone",color:"#f59e0b"},
  break:  {tag:"Break",cls:"tag-break",color:"#22c55e"},
  ooo:    {tag:"OOO",cls:"tag-ooo",color:"#64748b"}
};
function cfg(t){return TC[t]||TC.task}
function priCls(p){return p==="High"?"pri-hi":p==="Medium"?"pri-med":"pri-lo"}
function colorMeta(ev){
  if(!ev.meta)return'';
  if(!ev.priority)return'<span>'+ev.meta+'</span>';
  return ev.meta.replace(ev.priority+' priority','<span class="'+priCls(ev.priority)+'">'+ev.priority+' priority</span>');
}

// ======== DATA (fetched from API at boot) ========
// The Express server at /api/* provides all state data.
// The async boot loader below fetches everything before init.
window.__PA_STATE__ = null;
window.__PA_UPCOMING__ = [];

// These globals are populated by the async boot loader from the API.
window.__PA_TAGS__ = {};
window.__PA_TOMORROW__ = null;
window.__PA_ARCHIVES__ = {};
window.__PA_LOCAL__ = null;
window.__SECOND_BRAIN__ = {};
window.__SECOND_BRAIN_GLOBALS__ = {};
window.__ENGRAM_INDEX__ = {};
window.__ENGRAM_TAXONOMY__ = {};
window.__ENGRAM_COOCCURRENCE__ = {};

function transformState(state) {
  if (!state) return { sched: [], consider: [], bklog: [], triageItems: [], notifications: [] };
  const sched = [], consider = [], bklog = [], triageItems = [], notifications = [];

  // Timeline -> INIT_SCHED
  if (state.schedule && state.schedule.timeline) {
    state.schedule.timeline.forEach(item => {
      const typeMap = {meeting:"meeting", task:"task", prep:"task", time_block:"triage",
        focus_time:"focus", free_time:"break", ooo:"ooo"};
      const start = item.start ? new Date(item.start) : null;
      const end = item.end ? new Date(item.end) : null;
      if (!start || !end) return;
      const startStr = String(start.getHours()).padStart(2,"0") + ":" + String(start.getMinutes()).padStart(2,"0");
      const endStr = String(end.getHours()).padStart(2,"0") + ":" + String(end.getMinutes()).padStart(2,"0");
      // Match meeting prep data from state.meetings[]
      const meetings = (state.meetings || []);
      const matchedMeeting = item.source === "calendar" && item.source_id ?
        meetings.find(m => m.event_id === item.source_id) : null;

      // Build prep array from matched meeting data
      const prep = [];
      if (matchedMeeting) {
        if (matchedMeeting.briefing_path) {
          prep.push({type:"doc", title:"Meeting Prep Briefing", href: matchedMeeting.briefing_path, status:"ready"});
        }
        if (matchedMeeting.prep_task_url) {
          prep.push({type:"task", title:"Prep Task (Notion)", href: matchedMeeting.prep_task_url, status:""});
        }
        if (matchedMeeting.calendar_link) {
          prep.push({type:"doc", title:"Calendar Event", href: matchedMeeting.calendar_link, status:""});
        }
      }

      // Merge calendar attachments into prep array
      if (item.attachments && item.attachments.length) {
        item.attachments.forEach(att => {
          if (!prep.some(p => p.href === att.href)) {
            prep.push({type:"doc", title: att.title || "Attached Document", href: att.href, status:"ref"});
          }
        });
      }

      sched.push({
        id: item.id || "tl-" + sched.length,
        title: item.label || "Untitled",
        start: startStr, end: endStr,
        type: typeMap[item.type] || "task",
        meta: (item.priority ? item.priority + " priority" : "") +
              (item.estimated_minutes ? " \u00b7 " + item.estimated_minutes + " min" : ""),
        detail: item.description || "", source: item.source || "manual",
        notionUrl: item.source === "notion" && item.source_id ?
          "https://www.notion.so/" + item.source_id.replace(/-/g,"") : "",
        calUrl: item.source === "calendar" ? item.calendar_link || "" : "",
        priority: item.priority || "",
        completed: item.completed || false,
        nested: false,
        prep: prep
      });
    });
  }

  // tasks_couldnt_fit -> INIT_CONSIDER
  if (state.schedule && state.schedule.tasks_couldnt_fit) {
    state.schedule.tasks_couldnt_fit.forEach(task => {
      consider.push({
        id: task.task_id || "cf-" + consider.length,
        title: task.title, type: "task",
        durMin: task.estimated_minutes || 30,
        meta: (task.priority || "Medium") + " \u00b7 " + (task.reason || ""),
        detail: "", source: "notion",
        notionUrl: task.url || "", priority: task.priority || "Medium"
      });
    });
  }

  // Triage open items
  if (state.triage && state.triage.open_items) {
    state.triage.open_items.forEach(item => {
      triageItems.push({
        id: item.id,
        type: item.type,
        title: item.title,
        summary: item.summary || "",
        link: item.link || "",
        priority: item.priority || "medium",
        escalation: item.escalation_level || "normal",
        cycleCount: item.cycle_count || 1,
        notes: item.notes || "",
        firstSeen: item.first_seen_at || "",
        lastSeen: item.last_seen_at || ""
      });
    });
  }

  // Notifications (approval prompts, stakeholder drafts, etc.)
  if (state.notifications) {
    state.notifications.forEach(n => notifications.push(n));
  }

  return { sched, consider, bklog, triageItems, notifications };
}

let __state = window.__PA_STATE__ || null;
let __data = transformState(__state);
let INIT_SCHED = __data.sched;
let INIT_CONSIDER = __data.consider;
let INIT_BACKLOG = __data.bklog;
let INIT_TRIAGE = __data.triageItems;
let INIT_NOTIFICATIONS = __data.notifications;
