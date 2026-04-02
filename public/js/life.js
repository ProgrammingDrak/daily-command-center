// ======== LIFE TAB + QUICK CAPTURE ========

function getLifeCaptures(){return JSON.parse(localStorage.getItem("pa-life-captures")||"[]")}
function saveLifeCapture(entry){
  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.lifeCaptures&&window.blockStore){
    window.blockStore.createBlock("life_capture",{text:entry.text||"",category:entry.category||"",mood:entry.mood||0,context:entry.context||"",timestamp:entry.timestamp||new Date().toISOString()});
    return;
  }
  const c=getLifeCaptures();c.push(entry);localStorage.setItem("pa-life-captures",JSON.stringify(c));scheduleIDBSave();
}

function moodColor(score){
  if(score>=9)return"var(--accent)";if(score>=7)return"var(--green)";
  if(score>=5)return"var(--amber)";if(score>=3)return"var(--orange)";return"var(--red)";
}

function buildLife(){
  const life=__state&&__state.life;
  // Mood chart
  const chartEl=document.getElementById("mood-chart");
  if(chartEl&&life&&life.mood_history&&life.mood_history.length>0){
    const maxScore=10;
    chartEl.innerHTML=life.mood_history.map(function(d){
      const pct=Math.round((d.avgScore/maxScore)*100);
      const day=new Date(d.date+"T12:00:00").toLocaleDateString("en-US",{weekday:"short"});
      return'<div class="mood-bar-wrap"><div class="mood-bar-score" style="color:'+moodColor(d.avgScore)+'">'+d.avgScore.toFixed(1)+'</div>'+
        '<div class="mood-bar" style="height:'+pct+'%;background:'+moodColor(d.avgScore)+'"></div>'+
        '<div class="mood-bar-label">'+day+'</div></div>';
    }).join("");
  }
  // Streak
  var streakEl=document.getElementById("life-streak");
  var streakCount=document.getElementById("streak-count");
  if(streakEl&&life&&life.streak&&life.streak.days>0){
    streakEl.style.display="inline-flex";streakCount.textContent=life.streak.days;
  }
  // Food
  var foodEl=document.getElementById("life-food");
  if(foodEl&&life&&life.today_food&&life.today_food.length>0){
    foodEl.innerHTML=life.today_food.map(function(f){
      var icon=f.mealType==="breakfast"?"🌅":f.mealType==="lunch"?"☀️":f.mealType==="dinner"?"🌙":f.mealType==="snack"?"🍿":f.mealType==="drink"?"☕":"🍽️";
      return'<li><span class="li-icon">'+icon+'</span>'+f.description+(f.mealType?' <span style="color:var(--text-muted);font-size:10px">('+f.mealType+')</span>':'')+'</li>';
    }).join("");
  }
  // Habits
  var habEl=document.getElementById("life-habits");
  if(habEl&&life&&life.today_habits&&life.today_habits.length>0){
    habEl.innerHTML=life.today_habits.map(function(h){
      return'<div class="life-habit-row"><span class="life-habit-check'+(h.completed?" done":"")+'">✓</span>'+h.name+(h.detail?' <span style="color:var(--text-muted);font-size:10px">'+h.detail+'</span>':'')+'</div>';
    }).join("");
  }
  // Health
  var healEl=document.getElementById("life-health");
  if(healEl&&life&&life.today_health&&life.today_health.length>0){
    healEl.innerHTML=life.today_health.map(function(h){
      var icon=h.type==="energy"?"⚡":h.type==="sleep"?"😴":h.type==="medication"?"💊":h.type==="symptom"?"🤒":"🏥";
      return'<li><span class="li-icon">'+icon+'</span>'+h.description+(h.value!=null?' <strong>'+h.value+'</strong>':'')+'</li>';
    }).join("");
  }
  // Journal
  var jourEl=document.getElementById("life-journal");
  if(jourEl&&life&&life.today_journal&&life.today_journal.length>0){
    jourEl.innerHTML=life.today_journal.map(function(j){
      var tags=j.tags&&j.tags.length?'<div style="margin-top:3px">'+j.tags.map(function(t){return'<span class="life-tag active">'+t+'</span>'}).join(" ")+'</div>':"";
      return'<li style="flex-direction:column;align-items:flex-start"><span>'+j.content.substring(0,120)+(j.content.length>120?"...":"")+'</span>'+(j.mood?'<span style="font-size:10px;color:var(--text-muted)">Mood: '+j.mood+'/10</span>':"")+tags+'</li>';
    }).join("");
  }
  // Today's tags (from journal entries)
  var tagsCard=document.getElementById("life-tags-card");
  var tagsDisplay=document.getElementById("life-tags-display");
  if(tagsCard&&tagsDisplay&&life&&life.today_journal){
    var allTags={};
    life.today_journal.forEach(function(j){if(j.tags)j.tags.forEach(function(t){allTags[t]=true})});
    var tagNames=Object.keys(allTags);
    if(tagNames.length>0){
      tagsCard.style.display="block";
      tagsDisplay.innerHTML='<div class="life-tag-pills">'+tagNames.map(function(t){return'<span class="life-tag active">'+t+'</span>'}).join("")+'</div>';
    }
  }
  // Insights / correlations
  var insCard=document.getElementById("life-insights-card");
  var insEl=document.getElementById("life-insights");
  if(insCard&&insEl&&life&&life.correlations&&life.correlations.length>0){
    insCard.style.display="block";
    insEl.innerHTML=life.correlations.slice(0,8).map(function(c){
      var cls=c.delta>=0?"delta-pos":"delta-neg";
      var sign=c.delta>=0?"+":"";
      return'<div class="life-insight"><span class="'+cls+'">'+sign+c.delta.toFixed(1)+'</span> <span>'+c.tag+' ('+c.count+' days)</span></div>';
    }).join("");
  }
}

// ======== QUICK-CAPTURE HANDLERS ========
(function(){
  var selectedMood=null;
  // Mood emoji buttons in strip
  document.querySelectorAll(".qc-mood").forEach(function(btn){
    btn.addEventListener("click",function(){
      var score=parseInt(btn.dataset.score);
      // If clicking same mood again, deselect
      if(selectedMood===score){
        selectedMood=null;btn.classList.remove("qc-sel");return;
      }
      selectedMood=score;
      document.querySelectorAll(".qc-mood").forEach(function(b){b.classList.remove("qc-sel")});
      btn.classList.add("qc-sel");
      // Immediately save mood capture
      saveLifeCapture({type:"mood",score:score,timestamp:new Date().toISOString()});
      showQcStatus();
      // Deselect after flash
      setTimeout(function(){btn.classList.remove("qc-sel");selectedMood=null},800);
    });
  });
  // Shorthand text input
  var qcInput=document.getElementById("qc-input");
  var qcSend=document.getElementById("qc-send");
  function sendShorthand(){
    var raw=qcInput.value.trim();if(!raw)return;
    saveLifeCapture({type:"shorthand",raw:raw,timestamp:new Date().toISOString()});
    qcInput.value="";showQcStatus();
  }
  qcSend.addEventListener("click",sendShorthand);
  qcInput.addEventListener("keydown",function(e){if(e.key==="Enter")sendShorthand()});
  function showQcStatus(){
    var s=document.getElementById("qc-status");s.classList.add("show");
    setTimeout(function(){s.classList.remove("show")},1500);
  }
})();

// ======== JOURNAL MODAL (DAYLIO-STYLE) ========
(function(){
  var overlay=document.getElementById("jm-overlay");
  var openBtn=document.getElementById("qc-journal-btn");
  var closeBtn=document.getElementById("jm-close");
  var cancelBtn=document.getElementById("jm-cancel");
  var saveBtn=document.getElementById("jm-save");
  var noteEl=document.getElementById("jm-note");
  var tagsContainer=document.getElementById("jm-tags-container");
  var jmMoodScore=null;
  var selectedTags={};
  var selectedEntryType=null;

  // Build tag sections from __PA_TAGS__ (read live from window to pick up API boot data)
  var CAT_LABELS={entry_type:"Entry Type",love_language:"Love Language",hobbies:"Hobbies",food:"Food",social:"Social",bad_habits:"Bad Habits",negative_emotions:"Negative Emotions",positive_emotions:"Positive Emotions"};
  function buildTagSections(){
    var TAGS=window.__PA_TAGS__||{};
    var html="";
    Object.keys(TAGS).forEach(function(cat){
      var items=TAGS[cat];if(!items||!items.length)return;
      html+='<div class="jm-section jm-tag-cat-'+cat+'">';
      html+='<div class="jm-section-title">'+(CAT_LABELS[cat]||cat)+'</div>';
      html+='<div class="jm-tags">';
      items.forEach(function(tag){
        html+='<button class="jm-tag" data-cat="'+cat+'" data-tag="'+tag+'">'+tag+'</button>';
      });
      html+='</div></div>';
    });
    tagsContainer.innerHTML=html;
    // Wire tag click handlers
    tagsContainer.querySelectorAll(".jm-tag").forEach(function(btn){
      btn.addEventListener("click",function(){
        var tag=btn.dataset.tag;var cat=btn.dataset.cat;
        if(cat==="entry_type"){
          // Entry type is single-select
          tagsContainer.querySelectorAll('.jm-tag[data-cat="entry_type"]').forEach(function(b){b.classList.remove("jm-on")});
          if(selectedEntryType===tag){selectedEntryType=null;return;}
          selectedEntryType=tag;btn.classList.add("jm-on");
        }else{
          btn.classList.toggle("jm-on");
          if(btn.classList.contains("jm-on")){selectedTags[tag]=cat}else{delete selectedTags[tag]}
        }
      });
    });
  }
  buildTagSections();

  // Journal mood buttons
  document.querySelectorAll(".jm-mood").forEach(function(btn){
    btn.addEventListener("click",function(){
      jmMoodScore=parseInt(btn.dataset.score);
      document.querySelectorAll(".jm-mood").forEach(function(b){b.classList.remove("jm-sel")});
      btn.classList.add("jm-sel");
    });
  });

  function openModal(){
    jmMoodScore=null;selectedTags={};selectedEntryType=null;
    document.querySelectorAll(".jm-mood").forEach(function(b){b.classList.remove("jm-sel")});
    tagsContainer.querySelectorAll(".jm-tag").forEach(function(b){b.classList.remove("jm-on")});
    noteEl.value="";
    overlay.classList.add("open");
  }
  function closeModal(){overlay.classList.remove("open")}

  openBtn.addEventListener("click",openModal);
  closeBtn.addEventListener("click",closeModal);
  cancelBtn.addEventListener("click",closeModal);
  overlay.addEventListener("click",function(e){if(e.target===overlay)closeModal()});

  saveBtn.addEventListener("click",function(){
    var tags=Object.keys(selectedTags);
    var note=noteEl.value.trim();
    if(!jmMoodScore&&!tags.length&&!note&&!selectedEntryType){closeModal();return;}
    var capture={
      type:"journal",
      mood:jmMoodScore||null,
      tags:tags,
      entry_type:selectedEntryType||null,
      note:note||((selectedEntryType||"Journal entry")),
      timestamp:new Date().toISOString()
    };
    saveLifeCapture(capture);
    // Also save mood if selected (so mood chart picks it up)
    if(jmMoodScore){
      saveLifeCapture({type:"mood",score:jmMoodScore,context:(selectedEntryType||"journal entry"),timestamp:new Date().toISOString()});
    }
    closeModal();
    var s=document.getElementById("qc-status");s.classList.add("show");
    setTimeout(function(){s.classList.remove("show")},1500);
  });
})();

