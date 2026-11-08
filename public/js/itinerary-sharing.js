(() => {
  if (location.pathname.startsWith("/itinerary-share/")) return;
  const guest = location.pathname.startsWith("/shared-itinerary/");
  const list = document.getElementById("list-view");
  if (!list) return;
  let key = guest ? location.pathname.split("/")[2] : null;
  let day = null;
  let generation = 0;
  let guestRows = "";
  let state;
  let busy = false;
  let activeTask = null;
  let activeTrigger = null;
  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-labelledby", "shared-discussion-title");
  dialog.className = "dcc-discussion-sheet";
  const sheetStyle = document.createElement("style");
  sheetStyle.textContent = ".dcc-discussion-sheet[open]{display:flex;flex-direction:column;gap:.7rem}.dcc-discussion-sheet::backdrop{background:#0008}.discussion-head{display:flex;justify-content:space-between;align-items:center;gap:.75rem}.discussion-head h2{margin:0}.discussion-feed{overflow:auto;min-height:4rem;max-height:48dvh;flex:1}.discussion-feed img{display:block;max-width:100%;max-height:15rem}.discussion-comment{display:grid;grid-template-columns:2rem minmax(0,1fr);gap:.6rem;padding:.65rem 0;border-bottom:1px solid var(--border)}.discussion-comment p{margin:.2rem 0;overflow-wrap:anywhere}.discussion-avatar{display:grid;place-items:center;width:2rem;height:2rem;border-radius:50%;background:var(--accent);color:white}.discussion-branch{border-left:1px solid var(--border);padding-left:.65rem;min-width:12rem}.discussion-actions,.discussion-compose form,.discussion-memory{display:flex;flex-wrap:wrap;gap:.4rem}.discussion-compose{border-top:1px solid var(--border);padding-top:.6rem}.discussion-compose form>div,.discussion-compose textarea,.discussion-compose output{width:100%}.discussion-compose input,.discussion-compose textarea,.discussion-memory input,.discussion-memory textarea{color:var(--text);background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:.4rem;font:inherit;max-width:100%}";
    sheetStyle.textContent += ".dcc-discussion-sheet[open]{height:min(38rem,86dvh);gap:.4rem}.discussion-feed{max-height:none;min-height:0}.dcc-discussion-sheet .it-list-ctrl-btn{min-height:28px;height:auto;padding:.25rem .5rem;font-size:.8rem;text-transform:none}.discussion-head>div:first-child{min-width:0}.discussion-head h2{font-size:1.1rem}.discussion-head-actions{display:flex;align-items:center;gap:.35rem}.discussion-more{position:relative}.discussion-more summary{cursor:pointer;list-style:none;padding:.2rem .45rem}.discussion-more .discussion-actions{position:absolute;right:0;top:100%;z-index:1;display:grid;width:max-content;max-width:60vw;background:var(--card);border:1px solid var(--border);border-radius:8px;padding:.3rem}.discussion-compose form{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end}.discussion-compose form>div,.discussion-compose input,.discussion-compose output{grid-column:1/-1}.discussion-compose form>div:empty,.discussion-compose output:empty{display:none}.discussion-compose textarea{width:100%;min-height:0;resize:vertical}.discussion-compose textarea:focus{min-height:2.6rem}";
  sheetStyle.textContent += "html:has(.dcc-discussion-sheet[open]),body:has(.dcc-discussion-sheet[open]){overflow:hidden;overscroll-behavior:none}.dcc-discussion-sheet[open]{overflow:hidden}.discussion-head,.discussion-compose{flex:none}.discussion-feed{flex:1 1 0;min-height:0;overflow:auto;overscroll-behavior:contain;touch-action:pan-y}";
  sheetStyle.textContent += '.discussion-branch{margin:.25rem 0 .45rem .35rem;padding:.1rem .3rem .1rem .65rem;border-radius:0 .45rem .45rem 0;background:var(--card)}.discussion-branch[data-shade="tinted"]{background:color-mix(in srgb,var(--card) 88%,var(--accent,#487bc1))}.discussion-branch > .discussion-comment:last-child{border-bottom:0}';
  sheetStyle.textContent += ".discussion-compose{padding-bottom:env(safe-area-inset-bottom,0px);flex-shrink:0}.discussion-compose form>div:not(:empty){display:flex;align-items:center;gap:.35rem;min-width:0}.discussion-reply-quote{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.discussion-compose textarea{max-height:4rem}.discussion-compose button{white-space:nowrap}";
  document.head.append(sheetStyle);
  dialog.style.cssText = "position:fixed;inset:auto 0 0;margin:0 auto;width:min(36rem,100%);max-height:85dvh;padding:1.25rem;border:1px solid var(--border);border-radius:16px 16px 0 0;background:var(--card);color:var(--text)";
  function fitSheet() {
    const viewport = window.visualViewport;
    const height = viewport?.height || window.innerHeight;
    const bottom = Math.max(0, window.innerHeight - height - (viewport?.offsetTop || 0));
    dialog.style.bottom = bottom + "px";
    dialog.style.height = Math.min(608, height - 8) + "px";
    dialog.style.maxHeight = "none";
  }
  window.visualViewport?.addEventListener("resize",fitSheet);
  window.visualViewport?.addEventListener("scroll",fitSheet);
  window.addEventListener("resize",fitSheet);
  const authorKey = "dcc-itinerary-guest-name";
  const rememberedName = () => localStorage.getItem(authorKey) || sessionStorage.getItem(authorKey) || "";
  const rememberName = name => localStorage.setItem(authorKey, name.trim());
  document.body.append(dialog);
  dialog.addEventListener("close", () => {
    activeTask = null;
    dialog.replaceChildren();
    activeTrigger?.focus({preventScroll:true});
    activeTrigger = null;
  });
  const node = (tag, value, className) => {
    const el = document.createElement(tag);
    if (value) el.textContent = value;
    if (className) el.className = className;
    return el;
  };
  async function api(path, body) {
    const response = await fetch("/api/public/itinerary/" + path, body ? {
      method:"POST", headers:{"Content-Type":"application/json","X-DCC-Itinerary":"1"}, body:JSON.stringify(body)
    } : {cache:"no-store"});
    if (!response.ok) throw Error(response.status === 409 ? "This task has changed. Try again." : "Could not update this itinerary.");
    return response.json();
  }
  function button(label, action) {
    const el = node("button", label, "it-list-ctrl-btn");
    el.type = "button";
    el.onclick = event => {event.stopPropagation(); action(el);};
    return el;
  }
  window.DCC = window.DCC || {};
  DCC.loadItineraryJournalPhotos = async (date, blockId) => {
    if (guest) return [];
    const query = new URLSearchParams(blockId ? {blockId} : {date});
    const response = await fetch("/api/itinerary-journal-photos?" + query,{cache:"no-store"});
    if (!response.ok) throw Error("Could not load shared journal photos.");
    return response.json();
  };
  const openBranches = new Set();
  function addThread(main, task, removed = false) {
    const row = main.closest(".it-list-item");
    const snapshot = JSON.stringify(task);
    if (main.sharedSnapshot === snapshot) return;
    main.sharedSnapshot = snapshot;
    row.querySelector(".shared-itinerary-social")?.remove();
    const bounty = row.querySelector(".btn-bounty");
    if (bounty) bounty.style.setProperty("display", "none", "important");
    const social = button("", () => showSheet());
    social.className = "btn-task-radial shared-itinerary-social";
    social.style.gridColumn = "1";
    social.setAttribute("aria-label", "Social discussion");
    social.setAttribute("aria-haspopup", "dialog");
    social.dataset.tooltip = "Discussion";
    social.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 11a7 7 0 0 1-7 7H5l2-4a7 7 0 1 1 13-3Z"/><path d="M9 11h7"/></svg>';
    if (bounty) bounty.before(social);
    else row.querySelector(".it-list-actions").prepend(social);

    function showSheet() {
      activeTask = task.id;
      activeTrigger = social;
      const scrollTop = dialog.querySelector(".discussion-feed")?.scrollTop || 0;
      const header = node("header", "", "discussion-head");
      const heading = node("h2", task.title);
      heading.id = "shared-discussion-title";
      const title = node("div");
      title.append(node("small", "Discussion · " + task.comments.length), heading);
      header.append(title, button("Close", () => dialog.close()));
      const feed = node("div", "", "discussion-feed");
      const footer = node("footer", "", "discussion-compose");
      const form = node("form");
      const target = node("div");
      const name = node("input");
      name.placeholder = "Your name";
      name.setAttribute("aria-label", "Your name");
      name.value = rememberedName();
      name.required = true; name.hidden = !!name.value;
      name.maxLength = 60;
      const text = node("textarea");
      text.required = true;
      text.rows = 1;
      text.maxLength = 1000;
      text.setAttribute("aria-label", "Comment");
      const post = node("button", "Post", "it-list-ctrl-btn");
      const status = node("output");
      status.setAttribute("aria-live", "polite");
      let replyTo = null;
      const selectReply = comment => {
        replyTo = comment;
        target.replaceChildren();
        text.placeholder = comment ? "Write a reply…" : "Add a comment…";
                if (comment) {
          const quote = node("span", "Replying to " + comment.name + " · " + comment.text, "discussion-reply-quote");
          quote.title = comment.text;
          target.append(quote, button("Cancel reply", () => selectReply(null)));
        }
      };
      selectReply(null);
      text.addEventListener("keydown", event => {
        if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
        event.preventDefault();
        if (!event.repeat && !post.disabled && text.value.trim()) form.requestSubmit(post);
      });
      form.append(target,name,text,post,status);
      if (!removed) footer.append(form);
      async function send(body) {
        state = await api(key + "/contributions",{...body,blockId:task.id});
        paint();
      }
      const comments = new Map(task.comments.map(comment => [comment.id,comment]));
      function commentRow(comment) {
        const line = node("article", "", "discussion-comment");
        const avatar = node("span", comment.name.slice(0,1).toUpperCase(), "discussion-avatar");
        avatar.setAttribute("aria-hidden","true");
        const body = node("div");
        const parent = comments.get(comment.parentId);
        body.append(node("strong", comment.name), node("p",(parent ? "@" + parent.name + " " : "") + comment.text));
        if (!removed) body.append(button("Reply", () => {
          selectReply(comment);
          (name.value ? text : name).focus();
        }));
        line.append(avatar,body);
        return line;
      }
      if (task.memory?.photo) {
        const photo = node("img");
        photo.src = task.memory.photo;
        photo.alt = "Photo from " + task.title;
        feed.append(photo);
      }
      if (task.memory?.text) feed.append(node("p", task.memory.text));
      for (const entry of task.photos || []) {
        const figure = node("figure");
        const image = node("img");
        image.src = entry.src;
        image.alt = entry.caption || "Task photo";
        figure.append(image,node("figcaption",[entry.caption,"Photo by " + entry.author].filter(Boolean).join(" · ")));
        feed.append(figure);
      }
      if (!task.comments.length) feed.append(node("p", "No comments yet."));
      const children = new Map();
      for (const comment of task.comments) {
        const parent = comments.has(comment.parentId) ? comment.parentId : null;
        if (!children.has(parent)) children.set(parent, []);
        children.get(parent).push(comment);
      }
      function appendBranch(container, parentId) {
        // Use a stack so the thread has no JavaScript recursion limit.
        const stack = [{container, parentId, depth:0}];
        while (stack.length) {
          const {container, parentId, depth} = stack.pop();
          for (const comment of children.get(parentId) || []) {
            const line = commentRow(comment);
            container.append(line);
            const replies = children.get(comment.id);
            if (!replies?.length) continue;
            const branch = node("div", "", "discussion-branch");
            branch.dataset.shade = depth % 2 === 0 ? "tinted" : "base";
            branch.hidden = !openBranches.has(comment.id);
            const toggle = button("", () => {
              branch.hidden = !branch.hidden;
              if (branch.hidden) openBranches.delete(comment.id);
              else openBranches.add(comment.id);
              updateToggle();
            });
            function updateToggle() {
              toggle.textContent = branch.hidden ? "View " + replies.length + (replies.length === 1 ? " reply" : " replies") : "Hide replies";
              toggle.setAttribute("aria-expanded", String(!branch.hidden));
            }
            updateToggle();
            line.lastElementChild.append(toggle);
            container.append(branch);
            stack.push({container:branch, parentId:comment.id, depth:depth+1});
          }
        }
      }
      appendBranch(feed, null);

      form.onsubmit = async event => {
        event.preventDefault();
        busy = post.disabled = true;
        try {
          const body = {action:"comment",name:name.value,text:text.value,parentId:replyTo?.id};
          for (let ancestor = replyTo; ancestor; ancestor = comments.get(ancestor.parentId)) {
            openBranches.add(ancestor.id);
          }
          rememberName(name.value);
          await send(body);
        } catch (error) {status.textContent = error.message;}
        finally {busy = post.disabled = false;}
      };
      const actions = node("div", "", "discussion-actions");
      if (!removed) {
        const likedKey = key + task.id;
        const like = button("♡ " + task.likes, async el => {
          el.disabled = true;
          try {sessionStorage.setItem(likedKey,"1"); await send({action:"like"});}
          catch (error) {sessionStorage.removeItem(likedKey); el.disabled = false; status.textContent = error.message;}
        });
        like.setAttribute("aria-label","Love this task");
        like.disabled = !!sessionStorage.getItem(likedKey);
        function contributePhoto(toDay) {
          if (feed.querySelector(".discussion-memory")) return;
          const memory = node("form","","discussion-memory");
          const note = node("textarea");
          note.placeholder = "Optional caption";
          note.setAttribute("aria-label","Memory note");
          const file = node("input");
          file.type = "file"; file.required = true;
          file.accept = "image/png,image/jpeg,image/webp,image/gif";
          file.setAttribute("aria-label","Memory photo");
          const save = node("button",toDay ? "Add to Day Journal" : "Add to Task Journal","it-list-ctrl-btn");
          const credit = node("input");
          credit.placeholder = "Your name";
          credit.setAttribute("aria-label","Photo credit");
          credit.value = rememberedName();
          credit.required = true;
          credit.hidden = !!credit.value;
          memory.append(credit,note,file,save,button("Cancel",()=>memory.remove()));
          feed.prepend(memory);
          note.focus();
          memory.onsubmit = async event => {
            event.preventDefault();
            busy = save.disabled = true;
            try {
              const image = file.files[0];
              if (image?.size > 3800000) throw Error("Choose a photo under 3.8 MB.");
              const photo = await new Promise((resolve,reject)=>{
                const reader = new FileReader();
                reader.onload = ()=>resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(image);
              });
              state = await api(key+"/contributions",{action:"photo",blockId:toDay?null:task.id,name:credit.value,text:note.value,photo});
              paint();
              rememberName(credit.value);
              memory.remove();
              status.textContent = toDay ? "Added to Day Journal." : "Added to Task Journal.";
            } catch(error) {status.textContent = error.message;}
            finally {busy = save.disabled = false;}
          };
        }
        actions.append(like,button("Add task journal photo",()=>contributePhoto(false)),button("Add day journal photo",()=>contributePhoto(true)));
      }
      if (bounty) actions.append(button("Set bounty", () => {
        dialog.close();
        bounty.click();
      }));
      const headerActions = node("div","","discussion-head-actions");
      headerActions.append(header.lastElementChild);
      if (actions.childElementCount) {
        const more = node("details","","discussion-more");
        more.append(node("summary","More"),actions);
        headerActions.prepend(more);
        actions.addEventListener("click",()=>{more.open=false;});
      }
      header.append(headerActions);
      dialog.replaceChildren(header,feed,footer);
      fitSheet();
      if (!dialog.open) dialog.showModal();
      feed.scrollTop = scrollTop;
    }
    if (activeTask === task.id && dialog.open) showSheet();
  }

  function paint() {
    if (!state) return;
    if (guest) {
      const caption = document.getElementById("shared-itinerary-date");
      caption.textContent = state.date + " · Shared day";
      const nextRows = JSON.stringify(state.stops.map(({id,title,time,end,done})=>[id,title,time,end,done]));
      if (nextRows !== guestRows) {
        guestRows = nextRows;
        list.replaceChildren(...state.stops.map(task=>window.renderItineraryListRow(task,{
          done:task.done,barColor:"var(--accent)",metaHtml:[task.time,task.end].filter(Boolean).join(" – ") || "Unscheduled"
        })));
        if (!state.stops.length) list.append(node("p","No public tasks on this day."));
      }
      const gallery = document.getElementById("shared-day-photos");
      const photos = JSON.stringify(state.photos);
      if (gallery.dataset.photos !== photos) {
        gallery.dataset.photos = photos;
        gallery.replaceChildren(...state.photos.map(photo=>{
          const link = node("a");
          const image = node("img");
          image.src = photo.src;
          image.alt = photo.caption || "Photo by " + photo.author;
          image.loading = "lazy";
          image.style.cssText = "width:7rem;height:5rem;object-fit:cover;border-radius:.4rem;margin:.3rem";
          link.append(image);
          link.href = photo.src;
          link.target = "_blank";
          link.rel = "noopener";
          return link;
        }));
      }
    }
    const tasks = new Map(state.stops.flatMap(task => [[task.id,task],[task.localId,task]]));
    for (const row of list.querySelectorAll(".it-list-item[data-id]")) {
      const task = tasks.get(row.dataset.id);
      const main = row.querySelector(".it-list-main");
      if (task && main) addThread(main,task);
    }
    let earlier = list.querySelector(".shared-itinerary-earlier");
    if (!earlier && state.removed.length) {
      earlier = node("section","","it-list-section shared-itinerary-earlier");
      list.append(earlier);
    }
    if (earlier && !dialog.querySelector(".discussion-memory, .discussion-compose textarea:focus") && earlier.dataset.snapshot !== JSON.stringify(state.removed)) {
      earlier.dataset.snapshot = JSON.stringify(state.removed);
      earlier.replaceChildren(node("h3","Earlier discussion"));
      earlier.hidden = !state.removed.length;
      for (const task of state.removed) {
        const row = window.renderItineraryListRow(task,{metaHtml:"Removed from this day"});
        addThread(row.querySelector(".it-list-main"),task,true);
        earlier.append(row);
      }
    }
  }
  async function refresh() {
    if (!key || busy || dialog.querySelector(".discussion-memory, .discussion-compose textarea:focus")) return;
    try {
      const requestKey = key;
      const next = await api(requestKey);
      if (requestKey !== key) return;
      const change = state && JSON.stringify(next.stops.map(({id,title,time})=>[id,title,time])) !== JSON.stringify(state.stops.map(({id,title,time})=>[id,title,time]));
      state = next;
      if (change && window.blockStore?.loadDay && typeof refoldTaskStateFromBlockCache === "function") {
        await window.blockStore.loadDay(state.date);
        refoldTaskStateFromBlockCache(); if (typeof render === "function") render("schedule");
      }
      paint();
    } catch (error) {if (guest && !state) document.getElementById("shared-itinerary-date").textContent = "This itinerary could not be loaded."; console.error(error);}
  }
  async function openDay(date, create = false) {
    if (!create && day === date) return;
    const version = ++generation;
    day = date;
    key = null;
    state = null;
    try {
      const response = await fetch("/api/itinerary-shares/" + encodeURIComponent(date), {
        method:create?"POST":"GET",headers:{"X-DCC-Itinerary":"1"},cache:"no-store"
      });
      if (!response.ok) throw Error("Could not open itinerary sharing.");
      const result = await response.json();
      if (version !== generation) return;
      key = result.key;
      if (key) await refresh();
      return key;
    } catch(error) {
      if (create) throw error;
    }
  }
  DCC.ItineraryShare = {
    openDay,
    async copy(date, button) {
      button.disabled = true;
      try {
        const token = await openDay(date,true);
        if (!token) return;
        const url = new URL("/shared-itinerary/" + token,location.origin).href;
        try {
          await navigator.clipboard.writeText(url);
          button.textContent = "Link copied";
          setTimeout(()=>{button.textContent="Share Itinerary";},1800);
        } catch { window.prompt("Copy the itinerary link",url); }
      } catch(error) {
        button.textContent = "Try sharing again";
        console.error(error);
      } finally {button.disabled = false;}
    }
  };
  new MutationObserver(paint).observe(list,{childList:true,subtree:true});
  if (guest) refresh();
  setInterval(()=>{if(!document.hidden)refresh();},4000);
})();
