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

// ── Category (root tag) color for a task ──
// Walks the first tag up to its root and returns the root tag's color, or null
// if the task is untagged or the tag index isn't loaded yet. Callers fall back
// to the legacy type color (cfg(ev.type).color) when this returns null.
function taskTagColor(ev){
  const tags=(ev&&ev.tags)||[];
  if(!tags.length)return null;
  const idx=window.__TAGS__;
  if(!idx||!idx.byId||!idx.getAncestors)return null;
  const ancestors=idx.getAncestors(tags[0]);
  const rootId=ancestors[ancestors.length-1];
  const rootTag=idx.byId.get(rootId);
  return rootTag?((rootTag.properties||{}).color||null):null;
}

// ── Per-card tag-row collapse state ──
// localStorage key: cardTagsExpanded:<taskId> ('1' = expanded, absent = collapsed).
// Default collapsed so cards stay compact; users opt in per-card.
function isTagsExpanded(taskId){
  try{return localStorage.getItem('cardTagsExpanded:'+taskId)==='1'}catch(e){return false}
}
function toggleTagsExpanded(taskId){
  try{
    if(isTagsExpanded(taskId))localStorage.removeItem('cardTagsExpanded:'+taskId);
    else localStorage.setItem('cardTagsExpanded:'+taskId,'1');
  }catch(e){}
}

// ── Tag chip row HTML for a task card ──
// When collapsed: small toggle pill showing the tag count.
// When expanded: same toggle followed by one chip per tag (using the existing
// .tag-chip CSS for visual consistency with the picker).
function taskTagChipsHtml(ev){
  const tags=(ev&&ev.tags)||[];
  if(!tags.length)return'';
  const idx=window.__TAGS__;
  if(!idx||!idx.byId)return'';
  const expanded=isTagsExpanded(ev.id);
  const tagIcon='<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20.59 13.41L13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.83z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>';
  const toggleBtn='<button class="card-tags-toggle'+(expanded?' expanded':'')+'" data-tags-toggle-id="'+ev.id+'" title="'+(expanded?'Hide tags':'Show '+tags.length+' tag'+(tags.length>1?'s':''))+'">'+tagIcon+(expanded?'':'<span class="card-tags-count">'+tags.length+'</span>')+'</button>';
  if(!expanded)return toggleBtn;
  const chips=tags.map(id=>{
    const tag=idx.byId.get(id);
    if(!tag)return'';
    const props=tag.properties||{};
    const color=props.color||'var(--accent)';
    const name=props.name||'';
    return'<span class="tag-chip card-tag-chip" style="--chip-color:'+color+'">'+(typeof escHtml==='function'?escHtml(name):name)+'</span>';
  }).filter(Boolean).join('');
  return toggleBtn+chips;
}

// ======== DATA (fetched from API at boot) ========
// The Express server at /api/* provides all state data.
// The async boot loader below fetches everything before init.
window.__PA_STATE__ = null;
window.__PA_UPCOMING__ = [];

// These globals are populated by the async boot loader from the API.
window.__PA_TOMORROW__ = null;
window.__PA_ARCHIVES__ = {};
window.__PA_LOCAL__ = null;
window.__SECOND_BRAIN__ = {};
window.__SECOND_BRAIN_GLOBALS__ = {};

function calendarStateDedupeKey(item) {
  const start = item.start || "";
  const end = item.end || "";
  const title = String(item.title || item.label || "Untitled").trim().toLowerCase().replace(/\s+/g, " ");
  return (item.dedupeKey || "title:" + title + "|" + start + "|" + end);
}

function dedupeCalendarStateTimeline(timeline) {
  const seen = new Set();
  return (timeline || []).filter(item => {
    if (item.source !== "calendar" && item.source !== "gcal") return true;
    const key = calendarStateDedupeKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function transformState(state) {
  if (!state) return { sched: [], consider: [], bklog: [], triageItems: [], notifications: [] };
  const sched = [], consider = [], bklog = [], triageItems = [], notifications = [];

  // Timeline -> INIT_SCHED
  if (state.schedule && state.schedule.timeline) {
    dedupeCalendarStateTimeline(state.schedule.timeline).forEach(item => {
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
        meetingBlockId: item.block_id || item.blockId || "",
        title: item.label || "Untitled",
        start: startStr, end: endStr,
        type: typeMap[item.type] || "task",
        meta: (item.priority ? item.priority + " priority" : "") +
              (item.estimated_minutes ? " \u00b7 " + item.estimated_minutes + " min" : ""),
        detail: item.description || "", source: item.source || "manual",
        gcal_calendar_id: item.gcal_calendar_id || "",
        gcal_calendar_name: item.gcal_calendar_name || "",
        gcal_account_key: item.gcal_account_key || "",
        notionUrl: item.source === "notion" && item.source_id ?
          "https://www.notion.so/" + item.source_id.replace(/-/g,"") : "",
        calUrl: item.source === "calendar" ? item.calendar_link || "" : "",
        priority: item.priority || "",
        completed: item.completed || false,
        nested: false,
        prep: prep,
        prepStatus: matchedMeeting ? (matchedMeeting.prep_status || null) : null
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
