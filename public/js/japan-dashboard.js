(function () {
  "use strict";

  const ORDER_KEY = "dcc-japan-card-order-v1";
  const PRACTICE_KEY = "dcc-japan-practice-v1";
  const defaultOrder = ["phrase", "itinerary", "conversation", "mycelium"];
  const phrases = [
    { category:"Getting around", jp:"駅はどこですか？", romaji:"Eki wa doko desu ka?", en:"Where is the train station?" },
    { category:"Getting around", jp:"この電車は東京駅に行きますか？", romaji:"Kono densha wa Tōkyō-eki ni ikimasu ka?", en:"Does this train go to Tokyo Station?" },
    { category:"Getting around", jp:"次の電車は何時ですか？", romaji:"Tsugi no densha wa nanji desu ka?", en:"What time is the next train?" },
    { category:"Restaurants", jp:"おすすめは何ですか？", romaji:"Osusume wa nan desu ka?", en:"What do you recommend?" },
    { category:"Restaurants", jp:"何を食べるのがおすすめですか？", romaji:"Nani o taberu no ga osusume desu ka?", en:"What would you recommend we eat?" },
    { category:"Restaurants", jp:"二人です。", romaji:"Futari desu.", en:"A table for two, please." },
    { category:"Restaurants", jp:"これは辛いですか？", romaji:"Kore wa karai desu ka?", en:"Is this spicy?" },
    { category:"Restaurants", jp:"お会計をお願いします。", romaji:"Okaikei o onegaishimasu.", en:"The check, please." },
    { category:"Language help", jp:"これは日本語で何と言いますか？", romaji:"Kore wa Nihongo de nan to iimasu ka?", en:"How do you say this in Japanese?" },
    { category:"Language help", jp:"もう一度お願いします。", romaji:"Mō ichido onegaishimasu.", en:"One more time, please." },
    { category:"Language help", jp:"もう少しゆっくり話してください。", romaji:"Mō sukoshi yukkuri hanashite kudasai.", en:"Please speak a little more slowly." },
    { category:"Shopping", jp:"これはいくらですか？", romaji:"Kore wa ikura desu ka?", en:"How much is this?" },
    { category:"Shopping", jp:"カードは使えますか？", romaji:"Kādo wa tsukaemasu ka?", en:"Can I use a credit card?" },
    { category:"Everyday", jp:"写真を撮ってもらえますか？", romaji:"Shashin o totte moraemasu ka?", en:"Could you take a photo for us?" },
    { category:"Everyday", jp:"トイレはどこですか？", romaji:"Toire wa doko desu ka?", en:"Where is the restroom?" },
    { category:"Emergencies", jp:"助けてください。", romaji:"Tasukete kudasai.", en:"Please help me." },
    { category:"Emergencies", jp:"道に迷いました。", romaji:"Michi ni mayoimashita.", en:"I am lost." },
    { category:"Connection", jp:"今日はとても楽しかったです。", romaji:"Kyō wa totemo tanoshikatta desu.", en:"Today was a lot of fun." }
  ];

  function esc(value) { const div=document.createElement("div"); div.textContent=String(value == null ? "" : value); return div.innerHTML; }
  function daySeed() { const d=(window.blockStore&&window.blockStore.getCurrentDate&&window.blockStore.getCurrentDate()) || window.__todayDate || new Date().toISOString().slice(0,10); return String(d).split("").reduce((n,c)=>((n*31)+c.charCodeAt(0))>>>0,2166136261); }
  function phraseAt(offset) { return phrases[(daySeed()+offset)%phrases.length]; }
  function loadOrder() { try { const saved=JSON.parse(localStorage.getItem(ORDER_KEY)); return Array.isArray(saved)&&saved.length===defaultOrder.length ? saved : defaultOrder.slice(); } catch (_) { return defaultOrder.slice(); } }
  function scheduledItems() { const pool=typeof scheduled!=="undefined"&&Array.isArray(scheduled)?scheduled:[]; return pool.filter(x=>x&&window.DCC&&DCC.TaskModel&&!DCC.TaskModel.isNested(x)).slice().sort((a,b)=>String(a.start||"").localeCompare(String(b.start||""))).slice(0,6); }

  function itineraryCard() {
    const items=scheduledItems();
    const body=items.length?'<div class="japan-itinerary">'+items.map(x=>'<div class="japan-itinerary-row"><span class="japan-time">'+esc(x.start||"Anytime")+'</span><span class="japan-event">'+esc(x.title||"Untitled")+'</span><span class="japan-type">'+esc(x.type||"plan")+'</span></div>').join("")+'</div>':'<div class="japan-empty">Nothing is on this day\'s itinerary yet. Your travel plans will appear here automatically.</div>';
    return card("itinerary","🗺️","Today in Japan","From the active itinerary",body);
  }
  function phraseCard() {
    const p=phraseAt(window.JapanDashboard.offset||0);
    return card("phrase","あ","Phrase of the day","Tap reveal, then say it out loud",'<span class="japan-category">'+esc(p.category)+'</span><div class="japan-phrase-main">'+esc(p.jp)+'</div><div class="japan-romaji">'+esc(p.romaji)+'</div><div class="japan-translation" id="japan-translation">'+esc(p.en)+'</div><div class="japan-actions"><button class="japan-btn primary" data-japan-action="reveal" aria-expanded="false">Reveal English</button><button class="japan-btn" data-japan-action="next">Another phrase</button><button class="japan-btn" data-japan-action="practiced">✓ Practiced</button></div>');
  }
  function conversationCard() {
    const a=phraseAt(2), b=phraseAt(7), c=phraseAt(12);
    const lines=[{who:"You",text:a.jp+" ("+a.en+")"},{who:"Partner",text:"いいですね。行きましょう。 (Sounds good. Let’s go.)",partner:true},{who:"You",text:b.jp+" ("+b.en+")"},{who:"Partner",text:c.jp+" ("+c.en+")",partner:true}];
    return card("conversation","💬","Tonight’s conversation","Take turns, then improvise one extra line",'<div class="japan-dialogue">'+lines.map(l=>'<div class="japan-line'+(l.partner?' partner':'')+'"><span class="japan-speaker">'+l.who+'</span>'+esc(l.text)+'</div>').join("")+'</div><div class="japan-actions"><button class="japan-btn" data-japan-action="refresh-conversation">New conversation</button></div>');
  }
  function myceliumCard() { return card("mycelium","🍄","Trip notes","Recent Japan-related Mycelium notes",'<div id="japan-vault-content"><div class="japan-empty">Loading related notes…</div></div>'); }
  function card(id,icon,title,sub,body){return '<section class="japan-card" draggable="true" data-card="'+id+'"><header class="japan-card-head"><span class="japan-card-icon">'+icon+'</span><div><h3>'+title+'</h3><small>'+sub+'</small></div><span class="japan-drag" title="Drag to arrange">⠿</span></header><div class="japan-card-body">'+body+'</div></section>';}

  async function loadMycelium() {
    const target=document.getElementById("japan-vault-content"); if(!target)return;
    try { const res=await fetch("/api/vault/nodes"); if(!res.ok)throw new Error("unavailable"); const nodes=await res.json();
      const matched=(Array.isArray(nodes)?nodes:[]).filter(n=>{const f=n.frontmatter||{};return /japan|tokyo|kyoto|osaka|旅|日本/i.test([n.slug,f.title,(f.tags||[]).join(" ")].join(" "));}).slice(0,5);
      target.innerHTML=matched.length?'<div class="japan-vault-list">'+matched.map(n=>{const f=n.frontmatter||{};return '<div class="japan-vault-node"><strong>'+esc(f.title||String(n.slug||"").split("/").pop())+'</strong><span>'+esc(f.type||"note")+' · Mycelium</span></div>';}).join("")+'</div>':'<div class="japan-empty">No Japan-tagged notes yet. Add “japan” to a Mycelium title, path, or tag and it will surface here.</div>';
    } catch (_) { target.innerHTML='<div class="japan-empty">Mycelium is not available right now.</div>'; }
  }
  function practiceCount(){try{return Number(localStorage.getItem(PRACTICE_KEY)||0)}catch(_){return 0}}
  function render(){const root=document.getElementById("japan-dashboard-root");if(!root)return;const cards={phrase:phraseCard(),itinerary:itineraryCard(),conversation:conversationCard(),mycelium:myceliumCard()};root.innerHTML='<main class="japan-dashboard"><header class="japan-hero"><div><p class="japan-eyebrow">日本旅行 · Japan trip</p><h2>Daily travel companion</h2><p>Your plans, trip knowledge, and a little Japanese practice in one place.</p></div><div class="japan-streak">'+practiceCount()+' phrases practiced</div></header><div class="japan-grid" id="japan-grid">'+loadOrder().map(id=>cards[id]).join("")+'</div></main>';wire();loadMycelium();}
  function wire(){const grid=document.getElementById("japan-grid");if(!grid)return;let dragged=null;grid.addEventListener("dragstart",e=>{dragged=e.target.closest(".japan-card");if(dragged)dragged.classList.add("dragging")});grid.addEventListener("dragend",()=>{grid.querySelectorAll(".japan-card").forEach(x=>x.classList.remove("dragging","drag-over"));dragged=null;localStorage.setItem(ORDER_KEY,JSON.stringify([...grid.querySelectorAll(".japan-card")].map(x=>x.dataset.card)))});grid.addEventListener("dragover",e=>{const over=e.target.closest(".japan-card");if(!dragged||!over||over===dragged)return;e.preventDefault();grid.querySelectorAll(".japan-card").forEach(x=>x.classList.remove("drag-over"));over.classList.add("drag-over");const rect=over.getBoundingClientRect();grid.insertBefore(dragged,(e.clientY<rect.top+rect.height/2)?over:over.nextSibling)});
    grid.addEventListener("click",e=>{const action=e.target.closest("[data-japan-action]");if(!action)return;const type=action.dataset.japanAction;if(type==="reveal"){const t=document.getElementById("japan-translation");t&&t.classList.toggle("visible");const visible=!!(t&&t.classList.contains("visible"));action.textContent=visible?"Hide English":"Reveal English";action.setAttribute("aria-expanded",String(visible));}else if(type==="next"||type==="refresh-conversation"){window.JapanDashboard.offset=(window.JapanDashboard.offset||0)+(type==="next"?1:3);render();}else if(type==="practiced"){localStorage.setItem(PRACTICE_KEY,String(practiceCount()+1));render();}});}
  window.JapanDashboard={offset:0,render};
  if(window.DCC&&DCC.tabs)DCC.tabs.register("japan",render);
})();
