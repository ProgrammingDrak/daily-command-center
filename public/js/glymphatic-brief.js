// Glymphatic Brief: visual daily review packet + scheduleable recommendations.
(function(){
  var LOCAL_PREFIX = "dcc-glymphatic-brief:";
  var gbRefreshing = false;
  var gbActivePage = null;

  function gbDate(){
    return (__state && __state.date) || new Date().toISOString().slice(0,10);
  }

  function gbKey(){
    return LOCAL_PREFIX + gbDate();
  }

  function gbEsc(value){
    return String(value == null ? "" : value)
      .replace(/&/g,"&amp;")
      .replace(/</g,"&lt;")
      .replace(/>/g,"&gt;")
      .replace(/"/g,"&quot;")
      .replace(/'/g,"&#39;");
  }

  // Scheme-allowlist a URL before it becomes an href. gbEsc only HTML-escapes;
  // it does not stop a javascript:/data: URI. Day-review evidence refs are
  // reconstructed from comms, so restrict to safe schemes (empty -> no link).
  function gbSafeUrl(value){
    var u = String(value == null ? "" : value).trim();
    return /^(https?:|mailto:)/i.test(u) ? u : "";
  }

  function gbLoadUi(){
    try{
      return JSON.parse(localStorage.getItem(gbKey()) || "{}");
    }catch(e){
      return {};
    }
  }

  function gbSaveUi(ui){
    try{ localStorage.setItem(gbKey(), JSON.stringify(ui || {})); }catch(e){}
  }

  function gbBrief(){
    var source = (__state && (__state.glymphatic_brief || __state.glymphaticBrief)) || {};
    var current = source.current || source;
    if(!current || !current.suggested_tasks){
      current = {
        id: "brief-" + gbDate(),
        date: gbDate(),
        title: "Glymphatic Brief",
        generated_at: new Date().toISOString(),
        summary: "No generated brief is attached to this day yet.",
        retro: null,
        triage: null,
        lessons: [],
        disregarded: [],
        suggested_tasks: []
      };
    }
    return {
      current: current,
      history: (source.history || []).slice(0,2)
    };
  }

  function gbApplyState(nextState){
    if(!nextState)return;
    window.__DCC_STATE__ = nextState;
    __state = nextState;
    if(typeof transformState === "function"){
      __data = transformState(__state);
      INIT_SCHED = __data.sched;
      INIT_CONSIDER = __data.consider;
      INIT_BACKLOG = __data.bklog;
      INIT_TRIAGE = __data.triageItems;
      INIT_NOTIFICATIONS = __data.notifications;
    }
    if(typeof buildTriage === "function")buildTriage();
    if(typeof buildNotifications === "function")buildNotifications();
    if(typeof updateStats === "function")updateStats();
  }

  async function gbRefresh(){
    if(gbRefreshing)return;
    gbRefreshing = true;
    buildGlymphaticBrief();
    try{
      var res = await fetch("/api/dcc/refresh", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({date: gbDate()})
      });
      var payload = await res.json().catch(function(){ return {}; });
      if(!res.ok)throw new Error(payload.error || "DCC refresh failed");
      gbApplyState(payload.state);
      if(typeof showToast === "function")showToast("DCC brief refreshed", "success");
    }catch(e){
      if(typeof showToast === "function")showToast(e.message || "Refresh failed", "error");
      console.error("[Glymphatic Brief] refresh failed:", e);
    }finally{
      gbRefreshing = false;
      buildGlymphaticBrief();
    }
  }

  function gbMinutes(value){
    if(!value)return 0;
    if(String(value).indexOf("T") !== -1){
      var d = new Date(value);
      if(!isNaN(d.getTime()))return d.getHours()*60 + d.getMinutes();
    }
    var parts = String(value).slice(0,5).split(":").map(Number);
    return (parts[0] || 0)*60 + (parts[1] || 0);
  }

  function gbFmt(mins){
    mins = Math.max(0, Math.round(mins));
    return String(Math.floor(mins/60)).padStart(2,"0") + ":" + String(mins%60).padStart(2,"0");
  }

  function gbRound15(mins){
    return Math.ceil(mins / 15) * 15;
  }

  function gbNow(){
    var d = new Date();
    return d.getHours()*60 + d.getMinutes();
  }

  function gbTaskDuration(task, ui){
    var override = ui.durations && ui.durations[task.id];
    return parseInt(override || task.duration_minutes || task.durMin || 30, 10) || 30;
  }

  function gbDayEnd(){
    var wh = __state && __state.schedule && __state.schedule.working_hours;
    if(wh && wh.end)return gbMinutes(wh.end);
    if(typeof EOD !== "undefined")return EOD;
    return 17*60 + 30;
  }

  function gbBlockers(){
    var list = (typeof scheduled !== "undefined" ? scheduled : [])
      .filter(function(ev){
        if(typeof isDeleted === "function" && isDeleted(ev))return false;
        if(typeof isPushed === "function" && isPushed(ev))return false;
        if(typeof isDone === "function" && isDone(ev))return false;
        if(ev.source === "codex" && ev.type !== "ooo")return false;
        if(ev.source === "manual" && ev.type === "break")return false;
        return ev.start && ev.end;
      })
      .map(function(ev){ return { s: gbMinutes(ev.start), e: gbMinutes(ev.end), title: ev.title || "" }; })
      .filter(function(b){ return b.e > b.s; })
      .sort(function(a,b){ return a.s - b.s; });
    return list;
  }

  function gbFindSlot(earliest, durMin, blockers, endMin){
    var cursor = earliest;
    for(var i=0;i<blockers.length;i++){
      var b = blockers[i];
      if(cursor + durMin <= b.s)return cursor;
      if(cursor < b.e)cursor = b.e;
    }
    if(cursor + durMin <= endMin)return cursor;
    return cursor;
  }

  function gbOrderedTasks(tasks, ui){
    var byId = {};
    tasks.forEach(function(t){ byId[t.id] = t; });
    var ids = Array.isArray(ui.order) ? ui.order.filter(function(id){ return byId[id]; }) : [];
    tasks.forEach(function(t){ if(ids.indexOf(t.id) === -1)ids.push(t.id); });
    return ids.map(function(id){ return byId[id]; });
  }

  function gbPlanTasks(tasks, ui){
    var ordered = gbOrderedTasks(tasks, ui);
    var blockers = gbBlockers();
    var endMin = gbDayEnd();
    var cursor = gbRound15(gbNow());
    var starts = ui.starts || {};
    return ordered.map(function(task){
      var durMin = gbTaskDuration(task, ui);
      var preferred = starts[task.id]
        ? gbMinutes(starts[task.id])
        : Math.max(cursor, gbMinutes(task.recommended_start || task.start || "00:00"));
      preferred = gbRound15(preferred);
      var start = gbFindSlot(preferred, durMin, blockers, endMin);
      var item = { task: task, start: gbFmt(start), end: gbFmt(start + durMin), duration: durMin };
      blockers.push({ s: start, e: start + durMin, title: task.title || "" });
      blockers.sort(function(a,b){ return a.s - b.s; });
      cursor = start + durMin;
      return item;
    });
  }

  function gbMoved(taskId, direction){
    var brief = gbBrief().current;
    var tasks = brief.suggested_tasks || [];
    var ui = gbLoadUi();
    var order = gbOrderedTasks(tasks, ui).map(function(t){ return t.id; });
    var idx = order.indexOf(taskId);
    var next = idx + direction;
    if(idx < 0 || next < 0 || next >= order.length)return;
    var tmp = order[idx];
    order[idx] = order[next];
    order[next] = tmp;
    ui.order = order;
    ui.starts = {};
    gbSaveUi(ui);
    buildGlymphaticBrief();
  }

  function gbSetStart(taskId, value){
    var ui = gbLoadUi();
    ui.starts = ui.starts || {};
    if(value)ui.starts[taskId] = value;
    else delete ui.starts[taskId];
    gbSaveUi(ui);
    buildGlymphaticBrief();
  }

  function gbSetDuration(taskId, value){
    var ui = gbLoadUi();
    ui.durations = ui.durations || {};
    ui.durations[taskId] = parseInt(value, 10) || 30;
    ui.starts = {};
    gbSaveUi(ui);
    buildGlymphaticBrief();
  }

  function gbMarkPushed(taskId){
    var ui = gbLoadUi();
    ui.pushed = ui.pushed || {};
    ui.pushed[taskId] = new Date().toISOString();
    gbSaveUi(ui);
  }

  function gbIsPushed(task, ui){
    if(ui.pushed && ui.pushed[task.id])return true;
    return (typeof scheduled !== "undefined") && scheduled.some(function(ev){
      return ev.source === "glymphatic" && (ev.glymphatic_task_id === task.id || ev.title === task.title);
    });
  }

  function gbPushTask(taskId){
    var brief = gbBrief().current;
    var ui = gbLoadUi();
    var plan = gbPlanTasks(brief.suggested_tasks || [], ui);
    var item = plan.find(function(p){ return p.task.id === taskId; });
    if(!item)return;
    var task = item.task;
    if(gbIsPushed(task, ui)){
      if(typeof showToast === "function")showToast("Already added to the itinerary","info");
      return;
    }
    var id = "gb-" + task.id + "-" + Date.now();
    var startMin = gbMinutes(item.start);
    var newItem = {
      id: id,
      title: task.title,
      type: "task",
      start: item.start,
      end: gbFmt(startMin + item.duration),
      meta: "Glymphatic - " + (typeof ms === "function" ? ms(item.duration) : item.duration + "m"),
      detail: task.reason || task.detail || "",
      source: "glymphatic",
      priority: task.priority || "Medium",
      tags: task.tags || [],
      glymphatic_task_id: task.id,
      _pinnedStart: item.start
    };
    var insertAt = scheduled.findIndex(function(ev){ return gbMinutes(ev.start) >= startMin; });
    if(insertAt === -1)insertAt = scheduled.length;
    scheduled.splice(insertAt, 0, newItem);
    if(typeof loadPinnedStarts === "function" && typeof savePinnedStarts === "function"){
      var pins = loadPinnedStarts();
      pins[id] = item.start;
      savePinnedStarts(pins);
    }
    if(typeof recalcTimes === "function")recalcTimes();
    if(typeof persistAddedTask === "function")persistAddedTask(newItem);
    gbMarkPushed(task.id);
    if(typeof log === "function")log("scheduled", id, "Glymphatic: " + task.title);
    if(typeof render === "function")render();
    buildGlymphaticBrief();
    if(typeof showToast === "function")showToast("Added to itinerary at " + (typeof f12 === "function" ? f12(item.start) : item.start), "success");
  }

  function gbSection(title, items, className){
    var list = (items || []).slice(0,4);
    return '<section class="gb-section '+className+'">'+
      '<div class="gb-section-title">'+gbEsc(title)+'</div>'+
      (list.length ? list.map(function(item){
        var text = typeof item === "string" ? item : (item.text || item.title || "");
        var dest = item.destination ? '<span class="gb-dest">'+gbEsc(item.destination)+'</span>' : "";
        return '<div class="gb-note"><span>'+gbEsc(text)+'</span>'+dest+'</div>';
      }).join("") : '<div class="gb-empty">Nothing here yet.</div>')+
    '</section>';
  }

  function gbRetroLane(title, items, emptyText){
    var list = (items || []).slice(0,4);
    return '<div class="gb-retro-lane">'+
      '<div class="gb-retro-lane-title">'+gbEsc(title)+'</div>'+
      (list.length ? list.map(function(item){
        var label = item.title || item.question || item.subject || item.project || item.name || "";
        var summary = item.summary || item.answer || item.progress || item.detail || "";
        var meta = [
          item.when || item.date || "",
          item.source || "",
          item.status || ""
        ].filter(Boolean).join(" · ");
        return '<article class="gb-retro-item">'+
          (meta ? '<div class="gb-retro-meta">'+gbEsc(meta)+'</div>' : '')+
          '<div class="gb-retro-title">'+gbEsc(label)+'</div>'+
          (summary ? '<div class="gb-retro-summary">'+gbEsc(summary)+'</div>' : '')+
        '</article>';
      }).join("") : '<div class="gb-retro-empty">'+gbEsc(emptyText || "No signal captured.")+'</div>')+
    '</div>';
  }

  function gbRetro(retro){
    if(!retro)return "";
    var windowLabel = retro.window_label || (retro.window_hours ? "Past " + retro.window_hours + " hours" : "Recent");
    var stats = [
      ((retro.conversations || []).length) + " conversations",
      ((retro.questions || []).length) + " questions",
      ((retro.project_progress || []).length) + " project updates",
      ((retro.communications || []).length) + " comms",
      ((retro.meetings || []).length) + " meetings"
    ];
    return '<section class="gb-retro">'+
      '<div class="gb-retro-head">'+
        '<div>'+
          '<div class="gb-section-title">Retro</div>'+
          '<h3>'+gbEsc(windowLabel)+'</h3>'+
          '<p>'+gbEsc(retro.summary || "Recent work, questions, communication, and meeting signal.")+'</p>'+
        '</div>'+
        '<div class="gb-retro-stats">'+stats.map(function(s){return '<span>'+gbEsc(s)+'</span>';}).join("")+'</div>'+
      '</div>'+
      '<div class="gb-retro-grid">'+
        gbRetroLane("Conversations", retro.conversations, "No conversations captured.")+
        gbRetroLane("Questions", retro.questions, "No explicit questions captured.")+
        gbRetroLane("Project Progress", retro.project_progress, "No project movement captured.")+
        gbRetroLane("Communications", retro.communications, "No outbound communication captured.")+
        gbRetroLane("Meeting Summaries", retro.meetings, "No transcript summaries captured.")+
      '</div>'+
    '</section>';
  }

  function gbTriageItems(current, opts){
    var all = !!(opts && opts.all);
    var open = (__state && __state.triage && __state.triage.open_items) || [];
    var briefItems = current.triage && Array.isArray(current.triage.items) ? current.triage.items : null;
    // The brief payload caps triage.items; the dedicated Triage page wants the
    // full open list when the live state has more than the brief carried.
    if(briefItems && !(all && open.length > briefItems.length))return briefItems;
    return (all ? open : open.slice(0,6)).map(function(item){
      return {
        id: item.id,
        channel: item.type && item.type.indexOf("email") !== -1 ? "email" : item.type && item.type.indexOf("slack") !== -1 ? "slack" : item.type || "triage",
        title: item.title,
        summary: item.summary || item.notes || "",
        priority: item.priority || item.escalation_level || "normal",
        source_link: item.link || item.source_ref || "",
        draft_status: item.draft_id || item.draft_link ? "drafted" : "needs_draft",
        draft_link: item.draft_link || item.draft_url || "",
        draft_preview: item.draft_preview || item.draft_body || ""
      };
    });
  }

  function gbPriorityRank(p){
    p = String(p || "").toLowerCase();
    if(/high|urgent|stale/.test(p))return 0;
    if(/med|normal/.test(p))return 1;
    return 2;
  }

  function gbTriage(current, opts){
    var triage = current.triage || {};
    var items = gbTriageItems(current, opts);
    if(opts && opts.sort){
      items = items.slice().sort(function(a, b){
        var drafted = (b.draft_status === "drafted" ? 1 : 0) - (a.draft_status === "drafted" ? 1 : 0);
        return drafted || gbPriorityRank(a.priority) - gbPriorityRank(b.priority);
      });
    }
    var summary = triage.summary || "Reader sweeps should surface conversations needing attention, then writer skills create reviewable drafts in place.";
    var counts = [
      items.length + " items",
      items.filter(function(i){return i.draft_status === "drafted";}).length + " drafted",
      items.filter(function(i){return i.draft_status !== "drafted";}).length + " need drafts"
    ];
    return '<section class="gb-triage">'+
      '<div class="gb-triage-head">'+
        '<div>'+
          '<div class="gb-section-title">Triage</div>'+
          '<h3>Reviewable replies</h3>'+
          '<p>'+gbEsc(summary)+'</p>'+
        '</div>'+
        '<div class="gb-retro-stats">'+counts.map(function(c){return '<span>'+gbEsc(c)+'</span>';}).join("")+'</div>'+
      '</div>'+
      (items.length ? '<div class="gb-triage-list">'+items.map(gbTriageCard).join("")+'</div>' :
        '<div class="gb-triage-empty">No triage drafts are ready in this brief. Run the Gmail/Slack/Discord readers, then the triage drafting pass, and drafts will appear here with source links.</div>')+
    '</section>';
  }

  function gbTriageCard(item){
    var channel = String(item.channel || "triage").toLowerCase();
    var icon = /mail/.test(channel) ? "Email" : /slack/.test(channel) ? "Slack" : /discord/.test(channel) ? "Discord" : "Triage";
    var drafted = item.draft_status === "drafted";
    var source = item.source_link ? '<a class="gb-triage-link" href="'+gbEsc(item.source_link)+'" target="_blank" onclick="event.stopPropagation()">Source</a>' : "";
    var draft = item.draft_link ? '<a class="gb-triage-link primary" href="'+gbEsc(item.draft_link)+'" target="_blank" onclick="event.stopPropagation()">Review draft</a>' : "";
    var preview = item.draft_preview ? '<div class="gb-triage-draft">'+gbEsc(item.draft_preview)+'</div>' : "";
    return '<article class="gb-triage-card">'+
      '<div class="gb-triage-top">'+
        '<span class="gb-triage-channel">'+gbEsc(icon)+'</span>'+
        '<span class="gb-triage-priority">'+gbEsc(item.priority || "normal")+'</span>'+
        '<span class="gb-triage-status '+(drafted?'ready':'pending')+'">'+(drafted?'draft ready':'needs draft')+'</span>'+
      '</div>'+
      '<div class="gb-triage-title">'+gbEsc(item.title || "Untitled triage item")+'</div>'+
      (item.summary ? '<div class="gb-triage-summary">'+gbEsc(item.summary)+'</div>' : '')+
      preview+
      '<div class="gb-triage-actions">'+source+draft+'</div>'+
    '</article>';
  }

  function gbSourceHealth(current){
    var sources = (current.source_health || (current.sweep && current.sweep.source_health) || (__state && __state.sweep && __state.sweep.source_health) || []).slice();
    if(!sources.length)return "";
    return '<section class="gb-source-health">'+
      '<div class="gb-section-title">Reader health</div>'+
      '<div class="gb-source-grid">'+sources.map(function(source){
        var status = source.status || "unknown";
        return '<article class="gb-source-card '+gbEsc(status)+'">'+
          '<div class="gb-source-top">'+
            '<strong>'+gbEsc(source.label || source.id || "Source")+'</strong>'+
            '<span>'+gbEsc(status)+'</span>'+
          '</div>'+
          '<div class="gb-source-detail">'+gbEsc(source.detail || "")+'</div>'+
          '<div class="gb-source-count">'+gbEsc(source.count || 0)+' items</div>'+
        '</article>';
      }).join("")+'</div>'+
    '</section>';
  }

  function gbTaskCard(planItem, idx, total, ui){
    var task = planItem.task;
    var pushed = gbIsPushed(task, ui);
    var confidence = task.confidence ? '<span class="gb-pill">'+gbEsc(task.confidence)+'</span>' : "";
    var reason = task.reason ? '<div class="gb-task-reason">'+gbEsc(task.reason)+'</div>' : "";
    return '<article class="gb-task-card'+(pushed?' gb-pushed':'')+'" data-gb-task="'+gbEsc(task.id)+'">'+
      '<div class="gb-task-top">'+
        '<div class="gb-task-rank">'+(idx+1)+'</div>'+
        '<div class="gb-task-main">'+
          '<div class="gb-task-title">'+gbEsc(task.title)+'</div>'+
          '<div class="gb-task-meta">'+
            '<span>'+gbEsc(task.priority || "Medium")+'</span>'+
            '<span>'+gbEsc(planItem.start)+' - '+gbEsc(planItem.end)+'</span>'+
            confidence+
          '</div>'+
        '</div>'+
        '<div class="gb-task-actions">'+
          '<button class="gb-icon-btn" data-gb-move="'+gbEsc(task.id)+'" data-dir="-1" '+(idx===0?'disabled':'')+' title="Move earlier">Up</button>'+
          '<button class="gb-icon-btn" data-gb-move="'+gbEsc(task.id)+'" data-dir="1" '+(idx===total-1?'disabled':'')+' title="Move later">Down</button>'+
          '<button class="gb-add-btn" data-gb-push="'+gbEsc(task.id)+'" '+(pushed?'disabled':'')+' title="Add to itinerary">'+(pushed?'Added':'+')+'</button>'+
        '</div>'+
      '</div>'+
      reason+
      '<div class="gb-controls">'+
        '<label>Time <input type="time" value="'+gbEsc(planItem.start)+'" data-gb-start="'+gbEsc(task.id)+'"></label>'+
        '<label>Length <select data-gb-duration="'+gbEsc(task.id)+'">'+
          [15,30,45,60,90,120].map(function(m){
            return '<option value="'+m+'" '+(planItem.duration===m?'selected':'')+'>'+(typeof ms === "function" ? ms(m) : m + "m")+'</option>';
          }).join("")+
        '</select></label>'+
      '</div>'+
    '</article>';
  }

  function gbHistory(history){
    if(!history || !history.length)return "";
    return '<div class="gb-history">'+
      '<div class="gb-history-title">Recent briefs</div>'+
      history.slice(0,2).map(function(h){
        var counts = [
          ((h.lessons || []).length) + " lessons",
          ((h.disregarded || []).length) + " disregarded",
          ((h.suggested_tasks || []).length) + " tasks"
        ].join(" / ");
        return '<details class="gb-history-card">'+
          '<summary><span>'+gbEsc(h.date || "Previous")+'</span><span>'+gbEsc(counts)+'</span></summary>'+
          '<div class="gb-history-body">'+gbEsc(h.summary || h.title || "Historical brief")+'</div>'+
        '</details>';
      }).join("")+
    '</div>';
  }

  // --- Four-page brief ------------------------------------------------------

  function gbPages(current){
    if(!(current && Array.isArray(current.pages) && current.pages.length))return null;
    var pages = current.pages.slice();
    // Briefs authored before the Triage page existed don't list it; inject it
    // client-side so every brief gets the tab. Drafted count rides as a pill.
    if(!pages.some(function(p){ return p.id === "triage"; })){
      var drafted = gbTriageItems(current, {all:true}).filter(function(i){ return i.draft_status === "drafted"; }).length;
      var at = pages[0] && pages[0].id === "front" ? 1 : 0;
      pages.splice(at, 0, {id:"triage", label:"Triage", count: drafted || null});
    }
    return pages;
  }

  function gbGeneratedLabel(current){
    var ts = current && current.generated_at;
    if(!ts)return "";
    var d = new Date(ts);
    if(isNaN(d.getTime()))return "";
    var date = d.toLocaleDateString([], {weekday:"short", month:"short", day:"numeric"});
    var time = d.toLocaleTimeString([], {hour:"numeric", minute:"2-digit"});
    return "Generated " + date + ", " + time;
  }

  function gbPageNav(pages, activeId){
    return '<nav class="gb-pagenav">'+pages.map(function(p){
      var count = p.count ? '<span class="gb-count">'+gbEsc(p.count)+'</span>' : '';
      return '<button class="gb-pagebtn'+(p.id===activeId?' active':'')+'" data-gb-page="'+gbEsc(p.id)+'">'+gbEsc(p.label||p.id)+count+'</button>';
    }).join("")+'</nav>';
  }

  function gbMetricRow(metrics){
    if(!metrics || !metrics.length)return "";
    return '<div class="gb-metric-row">'+metrics.map(function(m){
      return '<div class="gb-metric"><span class="gb-metric-val">'+gbEsc(m.value)+'</span><span class="gb-metric-label">'+gbEsc(m.label)+'</span></div>';
    }).join("")+'</div>';
  }

  function gbPageActualVsPlanned(page, current, ui){
    var plan = gbPlanTasks(current.suggested_tasks || [], ui);
    var rows = page.rows || [];
    var rowsHtml = rows.length ? '<div class="gb-list">'+rows.map(function(r){
      return '<div class="gb-row gb-status-'+gbEsc(r.status)+'"><span class="gb-row-dot"></span><span class="gb-row-title">'+gbEsc(r.title)+'</span><span class="gb-row-meta">'+gbEsc(r.meta||"")+'</span><span class="gb-row-status">'+gbEsc(r.status)+'</span></div>';
    }).join("")+'</div>' : '<div class="gb-empty">No DCC task plan for today.</div>';
    return '<p class="gb-page-summary">'+gbEsc(page.summary||"")+'</p>'+
      gbMetricRow(page.metrics)+
      '<section class="gb-section"><div class="gb-section-title">Planned vs done</div>'+rowsHtml+'</section>'+
      gbTriageTeaser(current)+
      '<section class="gb-section gb-tasks"><div class="gb-section-title">Suggested tasks</div><div class="gb-task-list">'+
        (plan.length ? plan.map(function(item, idx){ return gbTaskCard(item, idx, plan.length, ui); }).join("") : '<div class="gb-empty">No task suggestions yet.</div>')+
      '</div></section>';
  }

  function gbPageStepBack(page){
    function lane(title, items, render, empty){
      return '<section class="gb-section"><div class="gb-section-title">'+gbEsc(title)+'</div>'+
        (items && items.length ? items.map(render).join("") : '<div class="gb-empty">'+gbEsc(empty)+'</div>')+'</section>';
    }
    return (page.note ? '<p class="gb-page-summary">'+gbEsc(page.note)+'</p>' : '')+
      '<div class="gb-stepback-grid">'+
      lane("Habits", page.habits, function(h){
        return '<div class="gb-row"><span class="gb-row-title">'+gbEsc(h.habit)+'</span><span class="gb-row-meta">'+gbEsc(h.cadence||"")+'</span><span class="gb-row-status">'+gbEsc(h.status||"")+'</span></div>';
      }, "No habits tracked yet -- add them in personal/habits.md.")+
      lane("Current projects", page.projects, function(p){
        return '<div class="gb-row gb-row-stack"><div class="gb-row-line"><span class="gb-row-title">'+gbEsc(p.name)+'</span><span class="gb-row-status">'+gbEsc(p.status||"")+'</span></div>'+(p.milestone?'<div class="gb-row-sub">'+gbEsc(p.milestone)+'</div>':'')+'</div>';
      }, "No active projects found.")+
      lane("Upcoming", page.upcoming, function(u){
        return '<div class="gb-row"><span class="gb-row-meta">'+gbEsc(u.when||"")+'</span><span class="gb-row-title">'+gbEsc(u.title)+'</span></div>';
      }, "No upcoming events.")+
      '</div>';
  }

  function gbPageBible(page){
    var sections = page.sections || [];
    var q = page.question ? '<section class="gb-bible-section gb-bible-q"><h3>Open question</h3><p>'+gbEsc(page.question)+'</p><div class="gb-row-sub">Answer it in personal/personal-bible.md; the next run files it and asks a new one.</div></section>' : "";
    return (page.source ? '<p class="gb-page-summary">Source: '+gbEsc(page.source)+' &mdash; autonomously maintained, correct anytime</p>' : '')+
      q+
      sections.map(function(s){
        return '<section class="gb-bible-section"><h3>'+gbEsc(s.heading)+'</h3><p>'+gbEsc(s.body||"").replace(/\n/g,"<br>")+'</p></section>';
      }).join("");
  }

  function gbPageProcess(page, current){
    var pow = (page.proof_of_work||[]).map(function(x){
      return '<div class="gb-kv"><span class="gb-kv-label">'+gbEsc(x.label)+'</span><span class="gb-kv-val">'+gbEsc(x.value)+'</span></div>';
    }).join("");
    var notes = page.notes || [];
    var notesHtml = notes.length ? '<section class="gb-section"><div class="gb-section-title">Integrity findings</div>'+notes.map(function(n){return '<div class="gb-note"><span>'+gbEsc(n)+'</span></div>';}).join("")+'</section>' : "";
    return '<p class="gb-page-summary">'+gbEsc(page.summary||"")+'</p>'+
      gbMetricRow(page.metrics)+
      '<section class="gb-section"><div class="gb-section-title">Proof of work</div>'+(pow||'<div class="gb-empty">No proof-of-work recorded.</div>')+'</section>'+
      gbSection("Lessons to file", current.lessons, "gb-lessons")+
      gbSection("Disregarded", current.disregarded, "gb-disregarded")+
      notesHtml;
  }

  // --- Front page: done today + tomorrow itinerary --------------------------

  function gbDecisions(ui){
    return (ui && ui.decisions) || {};
  }

  function gbRecordDecision(taskId, action, time){
    var ui = gbLoadUi();
    ui.decisions = ui.decisions || {};
    if(action === "reset")delete ui.decisions[taskId];
    else ui.decisions[taskId] = { action: action, time: time || null, at: new Date().toISOString() };
    gbSaveUi(ui);
    fetch("/api/dcc/brief/decision", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ date: gbDate(), task_id: taskId, action: action, time: time || null })
    }).catch(function(e){ console.error("[Glymphatic Brief] decision save failed:", e); });
    buildGlymphaticBrief();
  }

  function gbDecisionBadge(decision){
    if(!decision)return "";
    var label = decision.action === "accept" ? "Accepted " + (decision.time || "")
      : decision.action === "schedule" ? "Scheduled " + (decision.time || "")
      : decision.action === "backlog" ? "Backlogged"
      : decision.action === "drop" ? "Dropped" : decision.action;
    return '<span class="gb-pill gb-decision-'+gbEsc(decision.action)+'">'+gbEsc(label)+'</span>';
  }

  function gbFrontTaskRow(task, ui){
    var decision = gbDecisions(ui)[task.id];
    var decided = !!decision;
    var timeRow = '<div class="gb-controls" data-gb-decide-controls="'+gbEsc(task.id)+'" style="display:none">'+
      '<label>Time <input type="time" value="'+gbEsc(task.suggested_start || "09:00")+'" data-gb-decide-time="'+gbEsc(task.id)+'"></label>'+
      '<button class="gb-add-btn" data-gb-decide="'+gbEsc(task.id)+'" data-gb-action="schedule-confirm">Set</button>'+
    '</div>';
    return '<article class="gb-task-card'+(decided && (decision.action==="backlog"||decision.action==="drop")?' gb-pushed':'')+'" data-gb-front-task="'+gbEsc(task.id)+'">'+
      '<div class="gb-task-top">'+
        '<div class="gb-task-main">'+
          '<div class="gb-task-title">'+gbEsc(task.title)+'</div>'+
          '<div class="gb-task-meta">'+
            '<span>'+gbEsc(task.suggested_start || "anytime")+(task.duration?' &middot; '+gbEsc(task.duration)+'m':'')+'</span>'+
            '<span>'+gbEsc(task.priority || "Medium")+'</span>'+
            (task.project ? '<span class="gb-pill">'+gbEsc(task.project)+'</span>' : "")+
            gbDecisionBadge(decision)+
          '</div>'+
          (task.reason ? '<div class="gb-task-reason">'+gbEsc(task.reason)+'</div>' : "")+
        '</div>'+
        '<div class="gb-task-actions">'+
          (decided
            ? '<button class="gb-icon-btn" data-gb-decide="'+gbEsc(task.id)+'" data-gb-action="reset" title="Undo decision">Undo</button>'
            : '<button class="gb-add-btn" data-gb-decide="'+gbEsc(task.id)+'" data-gb-action="accept" title="Accept at suggested time">Accept</button>'+
              '<button class="gb-icon-btn" data-gb-decide="'+gbEsc(task.id)+'" data-gb-action="schedule" title="Pick a different time">Move</button>'+
              '<button class="gb-icon-btn" data-gb-decide="'+gbEsc(task.id)+'" data-gb-action="backlog" title="Send to backlog">Backlog</button>'+
              '<button class="gb-icon-btn" data-gb-decide="'+gbEsc(task.id)+'" data-gb-action="drop" title="Drop entirely">Drop</button>')+
        '</div>'+
      '</div>'+
      timeRow+
    '</article>';
  }

  function gbPageFront(page, current, ui){
    var groups = page.done_today || [];
    var doneHtml = groups.length ? groups.map(function(g){
      return '<div class="gb-row-stack">'+
        '<div class="gb-section-title" style="margin-top:10px">'+gbEsc(g.project || "Other")+'</div>'+
        (g.items || []).map(function(it){
          return '<div class="gb-row gb-status-done"><span class="gb-row-dot"></span><span class="gb-row-title">'+gbEsc(it.title)+'</span><span class="gb-row-meta">'+gbEsc(it.detail || "")+'</span></div>';
        }).join("")+
      '</div>';
    }).join("") : '<div class="gb-empty">No completed work detected today yet.</div>';
    var tomorrow = page.tomorrow || [];
    var pendingCount = tomorrow.filter(function(t){ return !gbDecisions(ui)[t.id]; }).length;
    var tomorrowHtml = tomorrow.length
      ? tomorrow.map(function(t){ return gbFrontTaskRow(t, ui); }).join("")
      : '<div class="gb-empty">No proposed itinerary for tomorrow yet.</div>';
    return '<p class="gb-page-summary">'+gbEsc(page.summary || "")+'</p>'+
      '<section class="gb-section"><div class="gb-section-title">Done today</div>'+doneHtml+'</section>'+
      '<section class="gb-section gb-tasks"><div class="gb-section-title">Tomorrow ('+pendingCount+' to review)</div>'+
        '<div class="gb-row-sub" style="margin-bottom:8px">Accept at the suggested time, move it, send it to the backlog, or drop it. Every choice is recorded.</div>'+
        '<div class="gb-task-list">'+tomorrowHtml+'</div>'+
      '</section>';
  }

  // --- Day in Review: confirm what I actually did today --------------------
  // The night run reconstructs the day from Claude/Codex sessions, shipped code,
  // and comms into did-items. Unlike the read-only canvas, this page WRITES on
  // confirm: Approve logs an item as a completed task (banking points via
  // /api/dcc/brief/log-done); a follow-up's "Push to tomorrow" mints a new open
  // task for the next day (/api/dcc/brief/push-next). Time + duration are editable
  // before approving, and both the local UI and the server calls are idempotent.

  function gbDidItems(page, current){
    if(page && Array.isArray(page.items))return page.items;
    if(current && Array.isArray(current.did_today))return current.did_today;
    return [];
  }

  function gbDidStart(item, ui){
    var o = ui.did_starts && ui.did_starts[item.id];
    return o || item.start || item.suggested_start || "";
  }

  function gbDidDuration(item, ui){
    var o = ui.did_durations && ui.did_durations[item.id];
    return parseInt(o || item.duration || item.duration_minutes || item.durMin || 30, 10) || 30;
  }

  function gbSetDidStart(id, value){
    var ui = gbLoadUi();
    ui.did_starts = ui.did_starts || {};
    if(value)ui.did_starts[id] = value;
    else delete ui.did_starts[id];
    gbSaveUi(ui);
    buildGlymphaticBrief();
  }

  function gbSetDidDuration(id, value){
    var ui = gbLoadUi();
    ui.did_durations = ui.did_durations || {};
    ui.did_durations[id] = parseInt(value, 10) || 30;
    gbSaveUi(ui);
    buildGlymphaticBrief();
  }

  function gbDidApproved(item, ui){
    return !!(ui.did_approved && ui.did_approved[item.id]);
  }

  function gbMarkDidApproved(id){
    var ui = gbLoadUi();
    ui.did_approved = ui.did_approved || {};
    ui.did_approved[id] = new Date().toISOString();
    gbSaveUi(ui);
  }

  function gbDidFollowPushed(followId, ui){
    return !!(ui.did_pushed && ui.did_pushed[followId]);
  }

  function gbMarkDidFollowPushed(followId){
    var ui = gbLoadUi();
    ui.did_pushed = ui.did_pushed || {};
    ui.did_pushed[followId] = new Date().toISOString();
    gbSaveUi(ui);
  }

  function gbDayReviewPage(){
    var current = gbBrief().current;
    var pages = gbPages(current) || [];
    return pages.filter(function(p){ return p.id === "day-review"; })[0] || null;
  }

  function gbTomorrowStr(){
    var d = new Date(gbDate() + "T12:00:00");
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0,10);
  }

  async function gbApproveDid(id){
    var current = gbBrief().current;
    var items = gbDidItems(gbDayReviewPage(), current);
    var item = items.filter(function(it){ return it.id === id; })[0];
    if(!item)return;
    var ui = gbLoadUi();
    if(gbDidApproved(item, ui)){
      if(typeof showToast === "function")showToast("Already logged","info");
      return;
    }
    var start = gbDidStart(item, ui);
    var duration = gbDidDuration(item, ui);
    var btn = document.querySelector('[data-gb-approve="'+id+'"]');
    if(btn){ btn.disabled = true; btn.textContent = "Logging..."; }
    try{
      var res = await fetch("/api/dcc/brief/log-done", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({
          date: gbDate(),
          title: item.title,
          tags: item.tags || [],
          start: start || null,
          duration: duration,
          type: item.type || "task",
          notes: item.reason || item.notes || "",
          evidence: item.evidence || [],
          idempotency_key: item.idempotency_key || ("day-review:" + gbDate() + ":" + id)
        })
      });
      var payload = await res.json().catch(function(){ return {}; });
      if(!res.ok)throw new Error(payload.error || "Log failed");
      gbMarkDidApproved(id);
      var banked = payload.credit && payload.credit.credits ? " (+" + payload.credit.credits + " pts)" : "";
      if(typeof showToast === "function")showToast("Logged: " + item.title + banked, "success");
      gbRefresh();
    }catch(e){
      if(typeof showToast === "function")showToast(e.message || "Log failed", "error");
      console.error("[Glymphatic Brief] log-done failed:", e);
      if(btn){ btn.disabled = false; btn.textContent = "Approve"; }
    }
  }

  async function gbPushDidNext(followId){
    var current = gbBrief().current;
    var items = gbDidItems(gbDayReviewPage(), current);
    var follow = null;
    items.forEach(function(it){
      (it.followups || []).forEach(function(f){ if(f.id === followId)follow = f; });
    });
    if(!follow)return;
    var ui = gbLoadUi();
    if(gbDidFollowPushed(followId, ui)){
      if(typeof showToast === "function")showToast("Already pushed to tomorrow","info");
      return;
    }
    var btn = document.querySelector('[data-gb-push-next="'+followId+'"]');
    if(btn){ btn.disabled = true; btn.textContent = "Pushing..."; }
    try{
      var res = await fetch("/api/dcc/brief/push-next", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({
          date: gbTomorrowStr(),
          title: follow.title,
          tags: follow.tags || [],
          duration: follow.duration || follow.duration_minutes || 30,
          type: follow.type || "task",
          notes: follow.notes || "",
          idempotency_key: follow.idempotency_key || ("day-review-followup:" + gbDate() + ":" + followId)
        })
      });
      var payload = await res.json().catch(function(){ return {}; });
      if(!res.ok)throw new Error(payload.error || "Push failed");
      gbMarkDidFollowPushed(followId);
      if(typeof showToast === "function")showToast("Pushed to tomorrow: " + follow.title, "success");
      buildGlymphaticBrief();
    }catch(e){
      if(typeof showToast === "function")showToast(e.message || "Push failed", "error");
      console.error("[Glymphatic Brief] push-next failed:", e);
      if(btn){ btn.disabled = false; btn.textContent = "Push to tomorrow"; }
    }
  }

  function gbDidCard(item, ui){
    var approvable = item.approvable !== false;
    var approved = approvable && gbDidApproved(item, ui);
    var start = gbDidStart(item, ui);
    var duration = gbDidDuration(item, ui);
    var tags = (item.tags || []).map(function(t){ return '<span class="gb-pill">'+gbEsc(t)+'</span>'; }).join("");
    var confidence = item.confidence ? '<span class="gb-pill">'+gbEsc(item.confidence)+'</span>' : "";
    var reason = item.reason ? '<div class="gb-task-reason">'+gbEsc(item.reason)+'</div>' : "";
    var evidence = (item.evidence || []).slice(0,3).map(function(ev){
      var ref = gbSafeUrl(ev.ref || ev.url || ev.link || "");
      var label = ev.label || ev.type || "evidence";
      return ref ? '<a class="gb-triage-link" href="'+gbEsc(ref)+'" target="_blank" rel="noreferrer" onclick="event.stopPropagation()">'+gbEsc(label)+'</a>' : '<span class="gb-row-meta">'+gbEsc(label)+'</span>';
    }).join("");
    var durOpts = [5,10,15,30,45,60,90,120,180];
    if(durOpts.indexOf(duration) === -1)durOpts.push(duration);
    durOpts.sort(function(a,b){ return a-b; });
    var follows = (item.followups || []).map(function(f){
      var pushed = gbDidFollowPushed(f.id, ui);
      return '<div class="gb-row"><span class="gb-row-title">'+gbEsc(f.title)+'</span>'+
        '<button class="gb-icon-btn" data-gb-push-next="'+gbEsc(f.id)+'" '+(pushed?'disabled':'')+' title="Push to tomorrow">'+(pushed?'Pushed':'Push to tomorrow')+'</button>'+
      '</div>';
    }).join("");
    var followsBlock = follows ? '<div class="gb-row-stack" style="margin-top:8px"><div class="gb-row-sub">Not finished &mdash; push to tomorrow:</div>'+follows+'</div>' : "";
    return '<article class="gb-task-card'+(approved?' gb-pushed':'')+'" data-gb-did-item="'+gbEsc(item.id)+'">'+
      '<div class="gb-task-top">'+
        '<div class="gb-task-main">'+
          '<div class="gb-task-title">'+gbEsc(item.title)+'</div>'+
          '<div class="gb-task-meta">'+
            (approvable ? '<span>'+gbEsc(start || "anytime")+' &middot; '+gbEsc(typeof ms === "function" ? ms(duration) : duration + "m")+'</span>' : "")+
            tags+confidence+
            (approved ? '<span class="gb-pill gb-decision-accept">Logged</span>' : "")+
          '</div>'+
          reason+
          (evidence ? '<div class="gb-task-meta">'+evidence+'</div>' : "")+
        '</div>'+
        '<div class="gb-task-actions">'+
          (!approvable ? ''
            : approved
              ? '<button class="gb-icon-btn" disabled title="Already logged">Logged</button>'
              : '<button class="gb-add-btn" data-gb-approve="'+gbEsc(item.id)+'" title="Log as done and bank points">Approve</button>')+
        '</div>'+
      '</div>'+
      (approved || !approvable ? "" :
        '<div class="gb-controls">'+
          '<label>Done at <input type="time" value="'+gbEsc(start)+'" data-gb-did-start="'+gbEsc(item.id)+'"></label>'+
          '<label>Length <select data-gb-did-duration="'+gbEsc(item.id)+'">'+
            durOpts.map(function(m){
              return '<option value="'+m+'" '+(duration===m?'selected':'')+'>'+(typeof ms === "function" ? ms(m) : m + "m")+'</option>';
            }).join("")+
          '</select></label>'+
        '</div>')+
      followsBlock+
    '</article>';
  }

  // Journal entry — local-only for now. FUTURE: wire gbSaveJournal to the
  // Mycelium vault (vault_append to today's journal node). Kept per-date in the
  // brief's localStorage (ui.journal) so it survives the 60s auto-refresh.
  function gbSetJournal(value){
    var ui = gbLoadUi();
    ui.journal = value;
    gbSaveUi(ui);
  }

  function gbSaveJournal(){
    var el = document.querySelector("[data-gb-journal]");
    var ui = gbLoadUi();
    ui.journal = el ? el.value : (ui.journal || "");
    ui.journal_saved_at = new Date().toISOString();
    gbSaveUi(ui);
    var status = document.querySelector("[data-gb-journal-status]");
    if(status)status.textContent = "Saved " + new Date(ui.journal_saved_at).toLocaleTimeString([], {hour:"numeric", minute:"2-digit"});
    if(typeof showToast === "function")showToast("Journal saved locally (vault wiring pending)", "success");
    // FUTURE: POST the entry to the Mycelium vault here.
  }

  // --- Daylio-style mood + activity tagging ---------------------------------
  // One mood per entry on a 5-level scale, plus activities grouped into editable
  // categories (multi-select). Taxonomy (moods + groups) is global across dates
  // in its own localStorage key; the per-day selection (mood + activity ids)
  // rides in the per-date brief ui. All local for now — same future Mycelium hook.

  var GB_TAXO_KEY = "dcc-daylio-taxonomy:v1";

  function gbDefaultTaxonomy(){
    return {
      moods: [
        {id:"rad",   name:"rad",   level:5, emoji:"😄", color:"#43A047"},
        {id:"good",  name:"good",  level:4, emoji:"🙂", color:"#7CB342"},
        {id:"meh",   name:"meh",   level:3, emoji:"😐", color:"#00ACC1"},
        {id:"bad",   name:"bad",   level:2, emoji:"😕", color:"#FB8C00"},
        {id:"awful", name:"awful", level:1, emoji:"😢", color:"#E53935"}
      ],
      groups: [
        {id:"emotions", name:"Emotions", activities:[
          {id:"happy",name:"happy",emoji:"😊"},{id:"excited",name:"excited",emoji:"🤩"},
          {id:"grateful",name:"grateful",emoji:"🙏"},{id:"relaxed",name:"relaxed",emoji:"😌"},
          {id:"tired",name:"tired",emoji:"🥱"},{id:"anxious",name:"anxious",emoji:"😰"},
          {id:"stressed",name:"stressed",emoji:"😫"},{id:"sad",name:"sad",emoji:"😢"},
          {id:"angry",name:"angry",emoji:"😠"},{id:"bored",name:"bored",emoji:"😑"}
        ]},
        {id:"sleep", name:"Sleep", activities:[
          {id:"good-sleep",name:"good sleep",emoji:"😴"},{id:"medium-sleep",name:"medium sleep",emoji:"🛌"},
          {id:"bad-sleep",name:"bad sleep",emoji:"🥴"}
        ]},
        {id:"social", name:"Social", activities:[
          {id:"family",name:"family",emoji:"👨‍👩‍👧"},{id:"friends",name:"friends",emoji:"🧑‍🤝‍🧑"},
          {id:"date",name:"date",emoji:"❤️"},{id:"party",name:"party",emoji:"🎉"},
          {id:"call",name:"call",emoji:"📞"}
        ]},
        {id:"hobbies", name:"Hobbies", activities:[
          {id:"movies",name:"movies & tv",emoji:"🎬"},{id:"reading",name:"reading",emoji:"📖"},
          {id:"gaming",name:"gaming",emoji:"🎮"},{id:"music",name:"music",emoji:"🎵"},
          {id:"sport",name:"sport",emoji:"🏃"}
        ]},
        {id:"health", name:"Health", activities:[
          {id:"exercise",name:"exercise",emoji:"💪"},{id:"walk",name:"walk",emoji:"🚶"},
          {id:"water",name:"drink water",emoji:"💧"},{id:"eat-healthy",name:"eat healthy",emoji:"🥗"},
          {id:"meditation",name:"meditation",emoji:"🧘"}
        ]},
        {id:"chores", name:"Chores", activities:[
          {id:"shopping",name:"shopping",emoji:"🛒"},{id:"cleaning",name:"cleaning",emoji:"🧹"},
          {id:"cooking",name:"cooking",emoji:"🍳"},{id:"laundry",name:"laundry",emoji:"🧺"}
        ]},
        {id:"work", name:"Work", activities:[
          {id:"shipped",name:"shipped",emoji:"🚀"},{id:"meetings",name:"meetings",emoji:"👥"},
          {id:"deep-work",name:"deep work",emoji:"🎯"},{id:"email",name:"email",emoji:"✉️"}
        ]}
      ]
    };
  }

  function gbLoadTaxo(){
    try{
      var t = JSON.parse(localStorage.getItem(GB_TAXO_KEY) || "null");
      if(t && Array.isArray(t.moods) && Array.isArray(t.groups))return t;
    }catch(e){}
    return gbDefaultTaxonomy();
  }
  function gbSaveTaxo(t){ try{ localStorage.setItem(GB_TAXO_KEY, JSON.stringify(t)); }catch(e){} }

  function gbSlug(s){
    return String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"") || "item";
  }
  function gbNewId(name){ return gbSlug(name) + "-" + Date.now().toString(36); }

  function gbFindMood(taxo, id){
    return (taxo.moods || []).filter(function(m){ return m.id === id; })[0] || null;
  }
  function gbFindActivity(taxo, id){
    for(var i=0;i<(taxo.groups||[]).length;i++){
      var a = (taxo.groups[i].activities || []).filter(function(x){ return x.id === id; })[0];
      if(a)return a;
    }
    return null;
  }
  function gbToggleActivity(id){
    var ui = gbLoadUi();
    var list = Array.isArray(ui.activities) ? ui.activities.slice() : [];
    var i = list.indexOf(id);
    if(i === -1)list.push(id); else list.splice(i,1);
    ui.activities = list;
    gbSaveUi(ui);
  }
  function gbSetMood(id){
    var ui = gbLoadUi();
    ui.mood = (ui.mood === id) ? null : id;
    gbSaveUi(ui);
  }

  function gbEnsureDaylioStyles(){
    if(document.getElementById("gb-daylio-style"))return;
    var css = ''+
      '.gb-modal-overlay{position:fixed;inset:0;background:rgba(6,10,16,.62);display:flex;align-items:flex-start;justify-content:center;z-index:9999;padding:5vh 16px;overflow:auto}'+
      '.gb-modal{width:100%;max-width:560px;background:var(--surface,#161d29);color:var(--text,#e8edf3);border:1px solid rgba(255,255,255,.10);border-radius:16px;padding:18px 18px 20px;box-shadow:0 20px 60px rgba(0,0,0,.5)}'+
      '.gb-modal-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:14px}'+
      '.gb-mood-row{display:flex;gap:8px;justify-content:space-between;flex-wrap:wrap}'+
      '.gb-mood{position:relative;flex:1 1 0;min-width:62px;display:flex;flex-direction:column;align-items:center;gap:4px;padding:10px 6px;border:2px solid transparent;border-radius:14px;cursor:pointer;background:rgba(255,255,255,.03);transition:transform .08s,border-color .12s,background .12s}'+
      '.gb-mood:hover{transform:translateY(-1px)}'+
      '.gb-mood.on{background:color-mix(in srgb, var(--mc,#43A047) 20%, transparent)}'+
      '.gb-mood-emoji{font-size:30px;line-height:1}'+
      '.gb-mood-name{font-size:11px;text-transform:capitalize;color:var(--text-muted,#9fb0c3)}'+
      '.gb-group{margin-top:16px}'+
      '.gb-group-title{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted,#9fb0c3);margin-bottom:8px}'+
      '.gb-act-grid{display:flex;flex-wrap:wrap;gap:8px}'+
      '.gb-act{position:relative;display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border:1px solid rgba(255,255,255,.12);border-radius:999px;cursor:pointer;font-size:13px;background:rgba(255,255,255,.03);transition:border-color .1s,background .1s}'+
      '.gb-act:hover{border-color:rgba(255,255,255,.28)}'+
      '.gb-act.on{background:rgba(90,150,255,.22);border-color:rgba(120,170,255,.7)}'+
      '.gb-act-emoji{font-size:15px}'+
      '.gb-mini-del{position:absolute;top:-7px;right:-7px;width:18px;height:18px;line-height:16px;text-align:center;border-radius:50%;border:none;background:#e2564d;color:#fff;font-size:12px;cursor:pointer;padding:0}'+
      '.gb-group-title .gb-mini-del{position:static;width:18px;height:18px;line-height:16px}'+
      '.gb-add-row{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;align-items:center}'+
      '.gb-inp{padding:7px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.04);color:inherit;font:inherit}'+
      '.gb-daylio-summary{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px}'+
      '.gb-chip{display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border-radius:999px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.04);font-size:13px}'+
      '.gb-mood-chip{border-width:2px}'+
      '.gb-icon-btn.on{background:rgba(90,150,255,.22);border-color:rgba(120,170,255,.7)}';
    var el = document.createElement("style");
    el.id = "gb-daylio-style";
    el.textContent = css;
    document.head.appendChild(el);
  }

  var GB_MOOD_LEVELS = {5:"Rad", 4:"Good", 3:"Meh", 2:"Bad", 1:"Awful"};

  function gbMoodModalHtml(editMode){
    var taxo = gbLoadTaxo();
    var ui = gbLoadUi();
    var selMood = ui.mood;
    var selActs = ui.activities || [];
    var moods = (taxo.moods || []).slice().sort(function(a,b){ return (b.level||0) - (a.level||0); });
    var moodRow = moods.map(function(m){
      var on = m.id === selMood;
      return '<div class="gb-mood'+(on?' on':'')+'" data-gb-mood="'+gbEsc(m.id)+'"'+(on?' style="--mc:'+gbEsc(m.color)+';border-color:'+gbEsc(m.color)+'"':'')+'>'+
        (editMode?'<button class="gb-mini-del" data-gb-del-mood="'+gbEsc(m.id)+'" title="Delete mood">&times;</button>':'')+
        '<div class="gb-mood-emoji">'+gbEsc(m.emoji)+'</div><div class="gb-mood-name">'+gbEsc(m.name)+'</div>'+
      '</div>';
    }).join("");
    var addMoodRow = editMode ?
      '<div class="gb-add-row">'+
        '<input class="gb-inp" data-gb-new-mood-emoji placeholder="🙂" maxlength="4" style="width:52px;text-align:center">'+
        '<input class="gb-inp" data-gb-new-mood-name placeholder="new mood" style="flex:1;min-width:120px">'+
        '<select class="gb-inp" data-gb-new-mood-level>'+[5,4,3,2,1].map(function(l){ return '<option value="'+l+'">'+GB_MOOD_LEVELS[l]+'</option>'; }).join("")+'</select>'+
        '<button class="gb-add-btn" data-gb-add-mood>Add mood</button>'+
      '</div>' : "";
    var groupsHtml = (taxo.groups || []).map(function(g){
      var acts = (g.activities || []).map(function(a){
        var on = selActs.indexOf(a.id) !== -1;
        return '<div class="gb-act'+(on?' on':'')+'" data-gb-activity="'+gbEsc(a.id)+'">'+
          (editMode?'<button class="gb-mini-del" data-gb-del-activity="'+gbEsc(g.id)+':'+gbEsc(a.id)+'" title="Delete">&times;</button>':'')+
          '<span class="gb-act-emoji">'+gbEsc(a.emoji)+'</span><span>'+gbEsc(a.name)+'</span>'+
        '</div>';
      }).join("");
      var addAct = editMode ?
        '<div class="gb-add-row">'+
          '<input class="gb-inp" data-gb-new-act-emoji="'+gbEsc(g.id)+'" placeholder="🏷️" maxlength="4" style="width:52px;text-align:center">'+
          '<input class="gb-inp" data-gb-new-act-name="'+gbEsc(g.id)+'" placeholder="new activity" style="flex:1;min-width:120px">'+
          '<button class="gb-add-btn" data-gb-add-activity="'+gbEsc(g.id)+'">Add</button>'+
        '</div>' : "";
      return '<div class="gb-group"><div class="gb-group-title"><span>'+gbEsc(g.name)+'</span>'+
        (editMode?'<button class="gb-mini-del" data-gb-del-group="'+gbEsc(g.id)+'" title="Delete category">&times;</button>':'')+'</div>'+
        '<div class="gb-act-grid">'+(acts || '<div class="gb-empty">No activities yet.</div>')+'</div>'+addAct+'</div>';
    }).join("");
    var addGroup = editMode ?
      '<div class="gb-group"><div class="gb-add-row">'+
        '<input class="gb-inp" data-gb-new-group-name placeholder="new category" style="flex:1;min-width:140px">'+
        '<button class="gb-add-btn" data-gb-add-group>Add category</button>'+
      '</div></div>' : "";
    return '<div class="gb-modal" role="dialog" aria-modal="true">'+
      '<div class="gb-modal-head">'+
        '<div class="gb-section-title">How was your day?</div>'+
        '<div style="display:flex;gap:8px;align-items:center">'+
          '<button class="gb-icon-btn'+(editMode?' on':'')+'" data-gb-modal-edit>'+(editMode?'Done editing':'Edit categories')+'</button>'+
          '<button class="gb-icon-btn" data-gb-modal-close title="Close">Close</button>'+
        '</div>'+
      '</div>'+
      '<div class="gb-mood-row">'+moodRow+'</div>'+addMoodRow+
      groupsHtml+addGroup+
      '<div class="gb-task-actions" style="justify-content:flex-end;margin-top:16px"><button class="gb-add-btn" data-gb-modal-close>Done</button></div>'+
    '</div>';
  }

  function gbCloseMoodModal(){
    var el = document.getElementById("gb-mood-modal");
    if(el)el.remove();
    buildGlymphaticBrief();
  }

  function gbOpenMoodModal(){
    gbEnsureDaylioStyles();
    var prev = document.getElementById("gb-mood-modal");
    if(prev)prev.remove();
    var overlay = document.createElement("div");
    overlay.id = "gb-mood-modal";
    overlay.className = "gb-modal-overlay";
    var editMode = false;
    function rerender(){ overlay.innerHTML = gbMoodModalHtml(editMode); }
    overlay.addEventListener("click", function(e){
      if(e.target === overlay || e.target.closest("[data-gb-modal-close]")){ gbCloseMoodModal(); return; }
      if(e.target.closest("[data-gb-modal-edit]")){ editMode = !editMode; rerender(); return; }

      var delMood = e.target.closest("[data-gb-del-mood]");
      if(delMood){
        var mid = delMood.dataset.gbDelMood;
        var t = gbLoadTaxo(); t.moods = (t.moods||[]).filter(function(m){ return m.id !== mid; }); gbSaveTaxo(t);
        var ui = gbLoadUi(); if(ui.mood === mid){ ui.mood = null; gbSaveUi(ui); }
        rerender(); return;
      }
      var moodBtn = e.target.closest("[data-gb-mood]");
      if(moodBtn && !editMode){ gbSetMood(moodBtn.dataset.gbMood); rerender(); return; }

      var delAct = e.target.closest("[data-gb-del-activity]");
      if(delAct){
        var parts = delAct.dataset.gbDelActivity.split(":");
        var t2 = gbLoadTaxo();
        (t2.groups||[]).forEach(function(g){ if(g.id === parts[0])g.activities = (g.activities||[]).filter(function(a){ return a.id !== parts[1]; }); });
        gbSaveTaxo(t2); rerender(); return;
      }
      var actBtn = e.target.closest("[data-gb-activity]");
      if(actBtn && !editMode){ gbToggleActivity(actBtn.dataset.gbActivity); rerender(); return; }

      var addAct = e.target.closest("[data-gb-add-activity]");
      if(addAct){
        var gid = addAct.dataset.gbAddActivity;
        var nameEl = overlay.querySelector('[data-gb-new-act-name="'+gid+'"]');
        var emEl = overlay.querySelector('[data-gb-new-act-emoji="'+gid+'"]');
        var name = nameEl ? nameEl.value.trim() : "";
        if(!name)return;
        var t3 = gbLoadTaxo();
        (t3.groups||[]).forEach(function(g){ if(g.id === gid)g.activities = (g.activities||[]).concat([{id:gbNewId(name), name:name, emoji:(emEl && emEl.value.trim()) || "🏷️"}]); });
        gbSaveTaxo(t3); rerender(); return;
      }
      var delGroup = e.target.closest("[data-gb-del-group]");
      if(delGroup){
        var t4 = gbLoadTaxo(); t4.groups = (t4.groups||[]).filter(function(g){ return g.id !== delGroup.dataset.gbDelGroup; }); gbSaveTaxo(t4); rerender(); return;
      }
      var addGroup = e.target.closest("[data-gb-add-group]");
      if(addGroup){
        var gEl = overlay.querySelector("[data-gb-new-group-name]");
        var gName = gEl ? gEl.value.trim() : "";
        if(!gName)return;
        var t5 = gbLoadTaxo(); t5.groups = (t5.groups||[]).concat([{id:gbNewId(gName), name:gName, activities:[]}]); gbSaveTaxo(t5); rerender(); return;
      }
      var addMood = e.target.closest("[data-gb-add-mood]");
      if(addMood){
        var mnEl = overlay.querySelector("[data-gb-new-mood-name]");
        var meEl = overlay.querySelector("[data-gb-new-mood-emoji]");
        var mlEl = overlay.querySelector("[data-gb-new-mood-level]");
        var mName = mnEl ? mnEl.value.trim() : "";
        if(!mName)return;
        var t6 = gbLoadTaxo();
        t6.moods = (t6.moods||[]).concat([{id:gbNewId(mName), name:mName, emoji:(meEl && meEl.value.trim()) || "🙂", level:(mlEl ? parseInt(mlEl.value,10) : 3), color:"#9E9E9E"}]);
        gbSaveTaxo(t6); rerender(); return;
      }
    });
    overlay.addEventListener("keydown", function(e){ if(e.key === "Escape")gbCloseMoodModal(); });
    document.body.appendChild(overlay);
    rerender();
  }

  function gbDaylioSummary(ui){
    var taxo = gbLoadTaxo();
    var mood = gbFindMood(taxo, ui.mood);
    var acts = (ui.activities || []).map(function(id){ return gbFindActivity(taxo, id); }).filter(Boolean);
    var chips = (mood ? '<span class="gb-chip gb-mood-chip" style="border-color:'+gbEsc(mood.color)+'"><span>'+gbEsc(mood.emoji)+'</span> '+gbEsc(mood.name)+'</span>' : "")+
      acts.map(function(a){ return '<span class="gb-chip"><span>'+gbEsc(a.emoji)+'</span> '+gbEsc(a.name)+'</span>'; }).join("");
    var label = (mood || acts.length) ? "Edit mood &amp; activities" : "How was your day?";
    return '<div class="gb-daylio-summary">'+chips+
      '<button class="gb-add-btn" data-gb-open-mood>'+label+'</button>'+
    '</div>';
  }

  function gbJournalSection(ui){
    var val = (ui && typeof ui.journal === "string") ? ui.journal : "";
    var saved = (ui && ui.journal_saved_at)
      ? "Saved " + new Date(ui.journal_saved_at).toLocaleTimeString([], {hour:"numeric", minute:"2-digit"})
      : "";
    return '<section class="gb-section gb-journal"><div class="gb-section-title">Journal</div>'+
      gbDaylioSummary(ui)+
      '<div class="gb-row-sub" style="margin-bottom:8px">A note on today. Saved locally for now; wiring to the vault comes later.</div>'+
      '<textarea data-gb-journal placeholder="How did today actually go?" '+
        'style="width:100%;min-height:120px;resize:vertical;padding:10px;border-radius:10px;'+
        'border:1px solid var(--border,rgba(255,255,255,.14));background:var(--surface-2,rgba(255,255,255,.03));'+
        'color:inherit;font:inherit;line-height:1.5;box-sizing:border-box">'+gbEsc(val)+'</textarea>'+
      '<div class="gb-task-actions" style="margin-top:8px;justify-content:flex-end;align-items:center;gap:10px">'+
        '<span class="gb-row-meta" data-gb-journal-status>'+gbEsc(saved)+'</span>'+
        '<button class="gb-add-btn" data-gb-journal-save title="Save this entry">Save</button>'+
      '</div>'+
    '</section>';
  }

  function gbPageDayReview(page, current, ui){
    var items = gbDidItems(page, current);
    var pending = items.filter(function(it){ return it.approvable !== false && !gbDidApproved(it, ui); }).length;
    var body = items.length
      ? items.map(function(it){ return gbDidCard(it, ui); }).join("")
      : '<div class="gb-empty">No activity reconstructed for today yet. The night run fills this in from your Claude/Codex sessions, shipped code, and comms.</div>';
    return '<p class="gb-page-summary">'+gbEsc(page.summary || "What the day-review reconstructed you did today. Fix the time or duration, then Approve to log it as done and bank points.")+'</p>'+
      '<section class="gb-section gb-tasks"><div class="gb-section-title">Day in Review ('+pending+' to confirm)</div>'+
        '<div class="gb-row-sub" style="margin-bottom:8px">Each item is inferred from what you actually touched. Approve logs it as completed; unfinished parts push to tomorrow.</div>'+
        '<div class="gb-task-list">'+body+'</div>'+
      '</section>'+
      gbJournalSection(ui);
  }

  // Agent-authored expressive layer. The HTML is generated fresh each morning
  // and treated as untrusted: it renders ONLY inside a sandboxed iframe with no
  // same-origin access, so its scripts cannot read the session, the parent DOM,
  // or call DCC APIs as the user. The canvas is display-only — the actionable
  // itinerary controls live on the structured "front" page.
  function gbPageCanvas(page){
    var html = page.canvas_html || page.html || "";
    if(!html)return '<div class="gb-empty">No canvas generated for today.</div>';
    var h = parseInt(page.height, 10) || 1180;
    return (page.summary ? '<p class="gb-page-summary">'+gbEsc(page.summary)+'</p>' : '')+
      '<iframe class="gb-canvas-frame" sandbox="allow-scripts" referrerpolicy="no-referrer" '+
        'style="width:100%;height:'+h+'px;border:0;border-radius:12px;background:#F5F5F5;display:block" '+
        'srcdoc="'+gbEsc(html)+'"></iframe>';
  }

  // The eye INTO the brain: health trend, per-machine backup recency, what's
  // going stale, the full skill toolbox, and the how-it-works glossary. All
  // data is collected deterministically by claude-brain's build_brief_packet.py;
  // this page is display-only.
  function gbPageBrainHealth(page){
    function pill(status){
      var s = status == null ? "" : String(status);
      var cls = s.toLowerCase().replace(/[^a-z0-9-]/g, "") || "unknown";
      return '<span class="gb-pill gb-health-'+cls+'">'+gbEsc(s ? s.toUpperCase() : "?")+'</span>';
    }
    var trend = page.trend || [];
    var trendHtml = trend.length
      ? '<div class="gb-list">'+
          '<div class="gb-row" style="opacity:.65"><span class="gb-row-meta" style="min-width:86px">Date</span><span class="gb-row-meta">Link integrity</span><span class="gb-row-meta">Drift</span><span class="gb-row-meta">Staleness</span><span class="gb-row-meta">Duplication</span></div>'+
          trend.map(function(t){
            return '<div class="gb-row"><span class="gb-row-meta" style="min-width:86px">'+gbEsc(t.date)+'</span><span class="gb-row-meta">'+gbEsc(t.link_integrity)+'</span><span class="gb-row-meta">'+gbEsc(t.drift)+'</span><span class="gb-row-meta">'+gbEsc(t.staleness)+'</span><span class="gb-row-meta">'+gbEsc(t.duplication)+'</span></div>';
          }).join("")+'</div>'
      : '<div class="gb-empty">No health-metrics history yet.</div>';
    var machines = page.machines || [];
    var machinesHtml = machines.length
      ? machines.map(function(m){
          return '<div class="gb-row"><span class="gb-row-title">'+gbEsc(m.machine)+'</span>'+
            '<span class="gb-row-meta">sync '+gbEsc(m.last_sync)+'</span>'+
            '<span class="gb-row-meta">evidence '+gbEsc(m.last_evidence)+'</span>'+pill(m.status)+'</div>';
        }).join("")
      : '<div class="gb-empty">No machine activity detected.</div>';
    var stale = page.stale || [];
    var staleHtml = stale.length
      ? stale.map(function(s){ return '<div class="gb-note"><span><strong>'+gbEsc(s.kind)+':</strong> '+gbEsc(s.detail)+'</span></div>'; }).join("")
      : '<div class="gb-empty">Nothing out of date. Clean cabinet.</div>';
    var toolboxHtml = (page.toolbox || []).map(function(g){
      return '<div class="gb-row-stack">'+
        '<div class="gb-section-title" style="margin-top:10px">'+gbEsc(g.plugin)+'</div>'+
        (g.description ? '<div class="gb-row-sub">'+gbEsc(g.description)+'</div>' : '')+
        (g.skills || []).map(function(s){
          return '<details class="gb-row gb-row-stack" style="display:block">'+
            '<summary style="cursor:pointer"><span class="gb-row-title">/'+gbEsc(g.plugin)+':'+gbEsc(s.name)+'</span> <span class="gb-row-meta">'+gbEsc(s.what)+'</span></summary>'+
            (s.when ? '<div class="gb-row-sub" style="margin:6px 0 2px 14px">'+gbEsc(s.when)+'</div>' : '')+
          '</details>';
        }).join("")+
      '</div>';
    }).join("") || '<div class="gb-empty">No skills discovered.</div>';
    var glossaryHtml = (page.glossary || []).map(function(t){
      return '<section class="gb-bible-section"><h3>'+gbEsc(t.term)+'</h3><p>'+gbEsc(t.def)+'</p></section>';
    }).join("");
    return '<p class="gb-page-summary">'+gbEsc(page.summary || "")+'</p>'+
      '<section class="gb-section"><div class="gb-section-title">Machine backups</div>'+machinesHtml+'</section>'+
      '<section class="gb-section"><div class="gb-section-title">Health trend (last '+trend.length+' runs)</div>'+trendHtml+'</section>'+
      '<section class="gb-section"><div class="gb-section-title">Going stale</div>'+staleHtml+'</section>'+
      '<section class="gb-section"><div class="gb-section-title">Toolbox — every skill, what it does, when to call it</div>'+toolboxHtml+'</section>'+
      (glossaryHtml ? '<section class="gb-section"><div class="gb-section-title">How the brain works</div>'+glossaryHtml+'</section>' : '');
  }

  function gbTriageTeaser(current){
    var items = gbTriageItems(current, {all:true});
    var drafted = items.filter(function(i){ return i.draft_status === "drafted"; }).length;
    var label = drafted ? drafted + (drafted === 1 ? " reply drafted and waiting for review" : " replies drafted and waiting for review")
      : items.length ? items.length + " open triage items, none drafted yet"
      : "No open triage items";
    return '<section class="gb-section">'+
      '<div class="gb-section-title">Triage</div>'+
      '<div class="gb-row"><span class="gb-row-title">'+gbEsc(label)+'</span>'+
        '<button class="gb-pagebtn" data-gb-page="triage" style="margin-left:auto">Open Triage</button>'+
      '</div>'+
    '</section>';
  }

  function gbPageTriage(page, current){
    return (page && page.summary ? '<p class="gb-page-summary">'+gbEsc(page.summary)+'</p>' : '')+
      gbTriage(current, {all:true, sort:true});
  }

  function gbRenderPage(page, current, ui){
    if(page.id==="triage")return gbPageTriage(page, current);
    if(page.id==="canvas")return gbPageCanvas(page);
    if(page.id==="day-review")return gbPageDayReview(page, current, ui);
    if(page.id==="front")return gbPageFront(page, current, ui);
    if(page.id==="actual-vs-planned")return gbPageActualVsPlanned(page, current, ui);
    if(page.id==="step-back")return gbPageStepBack(page);
    if(page.id==="personal-bible")return gbPageBible(page);
    if(page.id==="process")return gbPageProcess(page, current);
    if(page.id==="brain-health")return gbPageBrainHealth(page);
    return gbMetricRow(page.metrics)+'<pre class="gb-empty">'+gbEsc(JSON.stringify(page,null,2))+'</pre>';
  }

  function buildGlymphaticBrief(){
    var root = document.getElementById("glymphatic-brief-root");
    if(!root)return;
    gbEnsureDaylioStyles();
    var briefData = gbBrief();
    var current = briefData.current;
    var ui = gbLoadUi();
    var tasks = current.suggested_tasks || [];
    var plan = gbPlanTasks(tasks, ui);
    var nextTask = plan.find(function(item){ return !gbIsPushed(item.task, ui); });
    var badge = document.getElementById("glymphatic-count");
    if(badge){
      var count = plan.filter(function(item){ return !gbIsPushed(item.task, ui); }).length;
      badge.textContent = count;
      badge.style.display = count ? "" : "none";
    }

    var pages = gbPages(current);
    if(pages){
      if(!gbActivePage || !pages.some(function(p){ return p.id===gbActivePage; }))gbActivePage = pages[0].id;
      var active = pages.filter(function(p){ return p.id===gbActivePage; })[0] || pages[0];
      root.innerHTML =
        '<div class="gb-shell">'+
          '<header class="gb-hero">'+
            '<div>'+
              '<div class="gb-kicker">Glymphatic Brief</div>'+
              '<h2>'+gbEsc(current.title || "Today")+'</h2>'+
              '<p>'+gbEsc(current.summary || "")+'</p>'+
            '</div>'+
            '<div class="gb-hero-side">'+
              '<button class="gb-refresh-btn" data-gb-refresh '+(gbRefreshing?'disabled':'')+' title="Refresh DCC brief">'+(gbRefreshing?'Refreshing':'Refresh')+'</button>'+
            '</div>'+
          '</header>'+
          '<div class="gb-pagenav-row" style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">'+
            gbPageNav(pages, gbActivePage)+
            '<div class="gb-generated" style="font-size:11px;color:var(--text-muted);white-space:nowrap" title="When this brief was generated">'+gbEsc(gbGeneratedLabel(current))+'</div>'+
          '</div>'+
          '<div class="gb-page" data-gb-page-panel="'+gbEsc(active.id)+'">'+gbRenderPage(active, current, ui)+'</div>'+
          gbHistory(briefData.history)+
        '</div>';
      return;
    }

    root.innerHTML =
      '<div class="gb-shell">'+
        '<header class="gb-hero">'+
          '<div>'+
            '<div class="gb-kicker">Glymphatic Brief</div>'+
            '<h2>'+gbEsc(current.title || "Today")+'</h2>'+
            '<p>'+gbEsc(current.summary || "")+'</p>'+
          '</div>'+
          '<div class="gb-hero-side">'+
            '<button class="gb-refresh-btn" data-gb-refresh '+(gbRefreshing?'disabled':'')+' title="Refresh DCC brief">'+(gbRefreshing?'Refreshing':'Refresh')+'</button>'+
            '<div class="gb-now">'+
              '<span>Next fit</span>'+
              '<strong>'+gbEsc(nextTask ? nextTask.task.title : "All suggestions added")+'</strong>'+
              '<em>'+gbEsc(nextTask ? nextTask.start + " - " + nextTask.end : "Clear")+'</em>'+
            '</div>'+
          '</div>'+
        '</header>'+
        gbSourceHealth(current)+
        gbRetro(current.retro)+
        gbTriage(current)+
        '<div class="gb-grid">'+
          gbSection("Lessons to file", current.lessons, "gb-lessons")+
          gbSection("Disregarded", current.disregarded, "gb-disregarded")+
          '<section class="gb-section gb-tasks">'+
            '<div class="gb-section-title">Suggested tasks</div>'+
            '<div class="gb-task-list">'+
              (plan.length ? plan.map(function(item, idx){ return gbTaskCard(item, idx, plan.length, ui); }).join("") : '<div class="gb-empty">No task suggestions yet.</div>')+
            '</div>'+
          '</section>'+
        '</div>'+
        gbHistory(briefData.history)+
      '</div>';
  }

  document.addEventListener("click", function(e){
    var pageBtn = e.target.closest("[data-gb-page]");
    if(pageBtn){ gbActivePage = pageBtn.dataset.gbPage; buildGlymphaticBrief(); return; }
    var refresh = e.target.closest("[data-gb-refresh]");
    if(refresh){ gbRefresh(); return; }
    var decide = e.target.closest("[data-gb-decide]");
    if(decide){
      var taskId = decide.dataset.gbDecide;
      var action = decide.dataset.gbAction;
      if(action === "schedule"){
        var controls = document.querySelector('[data-gb-decide-controls="'+taskId+'"]');
        if(controls)controls.style.display = controls.style.display === "none" ? "" : "none";
        return;
      }
      if(action === "schedule-confirm"){
        var input = document.querySelector('[data-gb-decide-time="'+taskId+'"]');
        gbRecordDecision(taskId, "schedule", input ? input.value : null);
        return;
      }
      if(action === "accept"){
        var card = decide.closest("[data-gb-front-task]");
        var brief = gbBrief().current;
        var pages = gbPages(brief) || [];
        var front = pages.filter(function(p){ return p.id === "front"; })[0];
        var task = front && (front.tomorrow || []).filter(function(t){ return t.id === taskId; })[0];
        gbRecordDecision(taskId, "accept", task ? task.suggested_start : null);
        return;
      }
      gbRecordDecision(taskId, action, null);
      return;
    }
    var push = e.target.closest("[data-gb-push]");
    if(push){ gbPushTask(push.dataset.gbPush); return; }
    var approve = e.target.closest("[data-gb-approve]");
    if(approve){ gbApproveDid(approve.dataset.gbApprove); return; }
    var pushNext = e.target.closest("[data-gb-push-next]");
    if(pushNext){ gbPushDidNext(pushNext.dataset.gbPushNext); return; }
    var journalSave = e.target.closest("[data-gb-journal-save]");
    if(journalSave){ gbSaveJournal(); return; }
    var openMood = e.target.closest("[data-gb-open-mood]");
    if(openMood){ gbOpenMoodModal(); return; }
    var move = e.target.closest("[data-gb-move]");
    if(move){ gbMoved(move.dataset.gbMove, parseInt(move.dataset.dir, 10)); }
  });

  document.addEventListener("change", function(e){
    if(e.target.matches("[data-gb-start]"))gbSetStart(e.target.dataset.gbStart, e.target.value);
    if(e.target.matches("[data-gb-duration]"))gbSetDuration(e.target.dataset.gbDuration, e.target.value);
    if(e.target.matches("[data-gb-did-start]"))gbSetDidStart(e.target.dataset.gbDidStart, e.target.value);
    if(e.target.matches("[data-gb-did-duration]"))gbSetDidDuration(e.target.dataset.gbDidDuration, e.target.value);
  });

  // Autosave the journal on every keystroke (localStorage only, no re-render) so
  // the 60s refresh below never eats an in-progress entry.
  document.addEventListener("input", function(e){
    if(e.target.matches("[data-gb-journal]"))gbSetJournal(e.target.value);
  });

  setInterval(function(){
    var tab = document.getElementById("tab-glymphatic");
    if(!tab || !tab.classList.contains("active"))return;
    // Don't clobber the journal (or lose the cursor) while Drake is typing in it.
    var ae = document.activeElement;
    if(ae && ae.matches && ae.matches("[data-gb-journal]"))return;
    buildGlymphaticBrief();
  }, 60000);

  window.buildGlymphaticBrief = buildGlymphaticBrief;
})();
