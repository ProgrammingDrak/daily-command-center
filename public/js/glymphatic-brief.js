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

  function gbTriageItems(current){
    var briefItems = current.triage && Array.isArray(current.triage.items) ? current.triage.items : null;
    if(briefItems)return briefItems;
    var open = (__state && __state.triage && __state.triage.open_items) || [];
    return open.slice(0,6).map(function(item){
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

  function gbTriage(current){
    var triage = current.triage || {};
    var items = gbTriageItems(current);
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
    var channel = item.channel || "triage";
    var icon = channel === "email" ? "Email" : channel === "slack" ? "Slack" : channel === "discord" ? "Discord" : "Triage";
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
    return (current && Array.isArray(current.pages) && current.pages.length) ? current.pages : null;
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
      return '<button class="gb-pagebtn'+(p.id===activeId?' active':'')+'" data-gb-page="'+gbEsc(p.id)+'">'+gbEsc(p.label||p.id)+'</button>';
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
      gbTriage(current)+
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

  function gbRenderPage(page, current, ui){
    if(page.id==="canvas")return gbPageCanvas(page);
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
    var move = e.target.closest("[data-gb-move]");
    if(move){ gbMoved(move.dataset.gbMove, parseInt(move.dataset.dir, 10)); }
  });

  document.addEventListener("change", function(e){
    if(e.target.matches("[data-gb-start]"))gbSetStart(e.target.dataset.gbStart, e.target.value);
    if(e.target.matches("[data-gb-duration]"))gbSetDuration(e.target.dataset.gbDuration, e.target.value);
  });

  setInterval(function(){
    var tab = document.getElementById("tab-glymphatic");
    if(tab && tab.classList.contains("active"))buildGlymphaticBrief();
  }, 60000);

  window.buildGlymphaticBrief = buildGlymphaticBrief;
})();
