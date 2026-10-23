/* Progressive condition editor. State belongs to the caller's scoped composer. */
(function() {
  const C = window.DCC.RewardConditions;
  const esc = window.DCC.esc;
  function at(root, path) { return path ? path.split('.').reduce((n, i) => n.children[Number(i)], root) : root; }
  function nodeCount(root){let count=0;const stack=[root];while(stack.length){const n=stack.pop();count++;if(n.children)stack.push(...n.children);}return count;}
  function render(host, state, tasks, disabled) {
    host.innerHTML = '';
    if (!state.condition) {
      host.innerHTML = '<button type="button" data-condition-start>Group tasks (ALL / ANY)</button>';
    } else {
      const selected = new Set(C.leaves(state.condition).map(n => n.taskId));
      const stack = [{ node: state.condition, path: '', depth: 0 }];
      const fragment = document.createDocumentFragment();
      // Flat DOM with visual depth and a path label stays usable even at depth 100+.
      while (stack.length) {
        const { node, path, depth } = stack.pop();
        if (node.type !== 'group') continue;
        const row = document.createElement('details');
        row.className = 'reward-condition-group'; row.dataset.groupPath = path;
        row.style.setProperty('--condition-depth', Math.min(depth, 3));
        row.open = !state.closedGroups?.[path];
        const number = path ? path.split('.').map(i => Number(i) + 1).join('.') : '1';
        row.innerHTML = '<summary>'+esc(node.op.toUpperCase()+' group '+number)+' · '+node.children.length+' conditions</summary>' +
          '<label>Complete <select data-condition-op aria-label="Operator for group '+esc(number)+'"><option value="all"'+(node.op==='all'?' selected':'')+'>ALL (AND)</option><option value="any"'+(node.op==='any'?' selected':'')+'>ANY (OR)</option></select></label>' +
          '<div class="reward-condition-members">'+node.children.map((child, i) => child.type === 'task'
            ? '<span>'+esc(tasks.find(t => String(t.id) === child.taskId)?.title || 'Unavailable task')+' <button type="button" data-condition-remove="'+i+'" aria-label="Remove '+esc(tasks.find(t => String(t.id) === child.taskId)?.title || 'unavailable task')+'">×</button></span>'
            : '<span>'+esc(child.op.toUpperCase()+' group '+(path ? number+'.' : '')+(i+1))+'</span>').join('')+'</div>' +
          (!node.children.length ? '<p class="reward-condition-error">Choose tasks or remove this empty group.</p>' : '') +
          '<details class="reward-condition-picker"'+(state.pickers?.[path]?' open':'')+'><summary>Select tasks</summary>'+(state.pickers?.[path]?tasks:[]).filter(t => !t.redacted).map(task => {
            const here = node.children.some(n => n.type === 'task' && n.taskId === String(task.id));
            return '<label><input type="checkbox" data-condition-task="'+esc(task.id)+'"'+(here?' checked':'')+(!here && selected.has(String(task.id))?' disabled':'')+'>'+esc(task.title)+(task.status==='done'?' (done)':'')+'</label>';
          }).join('')+'</details>' +
          '<button type="button" data-condition-add>Add nested group</button> '+(path ? '<button type="button" data-condition-delete>Remove group</button>' : '');

        fragment.appendChild(row);
        if (row.open) for (let i = node.children.length - 1; i >= 0; i--) if (node.children[i].type === 'group') stack.push({ node: node.children[i], path: path ? path+'.'+i : String(i), depth: depth+1 });
      }
      host.appendChild(fragment);
      const help = document.createElement('p'); help.className = 'reward-condition-help';
      help.textContent = 'One reward, after owner approval. Tasks refer to this shared day; unavailable tasks do not count. Earned rewards stay earned.';
      host.appendChild(help);
    }
    if (disabled) host.querySelectorAll('button,input,select').forEach(el => el.disabled = true);
  }
  function bind(host, state, tasks, initialTaskId, changed) {
    const redraw = () => { changed(); render(host, state, tasks, state.sending); };
    host.onclick = event => {
      const button = event.target.closest('button');
      if (!button || state.sending) return;
      const path = button.closest('[data-group-path]')?.dataset.groupPath || '';
      const group = state.condition && at(state.condition, path);
      if (button.hasAttribute('data-condition-start')) state.condition = { type: 'group', op: 'all', children: [{ type: 'task', taskId: String(initialTaskId) }] };
      else if (button.hasAttribute('data-condition-add')) {
        if (nodeCount(state.condition) >= C.MAX_NODES) { alert('Use at most 256 conditions per reward'); return; }
        group.children.push({ type: 'group', op: 'any', children: [] });
      } else if (button.hasAttribute('data-condition-remove')) group.children.splice(Number(button.dataset.conditionRemove), 1);
      else if (button.hasAttribute('data-condition-delete')) { const parts = path.split('.'); const index = Number(parts.pop()); at(state.condition, parts.join('.')).children.splice(index, 1); }
      else return;
      state.closedGroups = {}; redraw();
      host.querySelector('[data-condition-op]')?.focus();
    };
    host.onchange = event => {
      if (state.sending) return;
      const path = event.target.closest('[data-group-path]')?.dataset.groupPath || '';
      const group = at(state.condition, path);
      if (event.target.hasAttribute('data-condition-op')) group.op = event.target.value;
      else if (event.target.hasAttribute('data-condition-task')) {
        const id = event.target.dataset.conditionTask;
        if (event.target.checked && nodeCount(state.condition)>=C.MAX_NODES){event.target.checked=false;alert('Use at most 256 conditions per reward');return;}
        if (event.target.checked) group.children.push({ type: 'task', taskId: id });
        else group.children = group.children.filter(n => n.type !== 'task' || n.taskId !== id);
      } else return;
      const pickerOpen = event.target.closest('.reward-condition-picker') != null;
      redraw();
      const row = Array.from(host.querySelectorAll('[data-group-path]')).find(el => el.dataset.groupPath === path);
      if (pickerOpen && row) { row.querySelector('.reward-condition-picker').open = true; row.querySelector('.reward-condition-picker summary').focus(); }
      else row?.querySelector('select')?.focus();
    };
    // Group disclosure also hides/reveals descendants in the flat rendering.
    if(host._conditionToggle)host.removeEventListener('toggle',host._conditionToggle,true);
    host._conditionToggle = event => {
      if(event.target.matches('.reward-condition-picker')){
        const path=event.target.closest('[data-group-path]').dataset.groupPath;
        if(state.pickers?.[path]!==event.target.open){state.pickers=state.pickers||{};state.pickers[path]=event.target.open;redraw();}
      }
      if (event.target.matches('.reward-condition-group')) {
        const path = event.target.dataset.groupPath;
        if (state.closedGroups?.[path] !== !event.target.open) {
          state.closedGroups = state.closedGroups || {}; state.closedGroups[path] = !event.target.open;
          redraw();
        }
      }
    };
    host.addEventListener('toggle',host._conditionToggle,true);
  }
  window.DCC.RewardConditionEditor = { render, bind };
})();
