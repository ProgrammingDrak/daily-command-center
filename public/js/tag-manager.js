// ======== TAG MANAGER ========
// Hierarchical tag system for block-task matching.
// Tags are stored as type="tag" blocks with parent_id for nesting (infinitely deep).
// Blocks declare which tags they accept via acceptedTags: [id, ...].
// Tasks declare their tags via tags: [id, ...].
// Tag matching is ancestor-aware: a task tagged "Coding" matches a block accepting
// "Deep Work" (parent) or "Work" (grandparent).

// ── Tag Index ──
// Returns an object with:
//   byId:        Map<id, tagBlock>
//   roots:       tagBlock[]            (tags with no parent)
//   getAncestors(id) → [id, ...]      (self + all ancestors up the tree)
//   getDescendants(id) → [id, ...]    (self + all descendants)
function buildTagIndex(tagBlocks) {
  const byId = new Map();
  tagBlocks.forEach(t => byId.set(t.id, t));

  const roots = tagBlocks.filter(t => !t.parent_id || !byId.has(t.parent_id));

  function getAncestors(id) {
    const chain = [];
    let cur = id;
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      chain.push(cur);
      seen.add(cur);
      const block = byId.get(cur);
      cur = block ? block.parent_id : null;
    }
    return chain;
  }

  function getDescendants(id) {
    const result = [id];
    const queue = [id];
    while (queue.length) {
      const pid = queue.shift();
      tagBlocks.forEach(t => {
        if (t.parent_id === pid) {
          result.push(t.id);
          queue.push(t.id);
        }
      });
    }
    return result;
  }

  return { byId, roots, getAncestors, getDescendants };
}

// ── Refresh tag index from blockStore ──
function refreshTagIndex() {
  if (window.blockStore && typeof buildTagIndex === 'function') {
    window.__TAGS__ = buildTagIndex(window.blockStore.getByType('tag'));
  }
}

// ── Tag Manager Modal ──
let _tmOpen = false;

function openTagManager() {
  refreshTagIndex();
  renderTagTree();
  document.getElementById('tag-manager-overlay').classList.add('open');
  _tmOpen = true;
}

function closeTagManager() {
  document.getElementById('tag-manager-overlay').classList.remove('open');
  _tmOpen = false;
}

function renderTagTree() {
  const body = document.getElementById('tag-manager-body');
  if (!body) return;
  const idx = window.__TAGS__;
  if (!idx || idx.byId.size === 0) {
    body.innerHTML = '<div style="color:var(--text-muted);padding:16px 0;font-size:13px">No tags yet. Click "+ New Tag" to create one.</div>';
    return;
  }
  body.innerHTML = '';
  const ul = document.createElement('ul');
  ul.className = 'tg-tree';
  idx.roots.forEach(root => ul.appendChild(buildTagNode(root, idx, 0)));
  body.appendChild(ul);
}

function buildTagNode(tag, idx, depth) {
  const props = tag.properties || {};
  const name = props.name || '(unnamed)';
  const color = props.color || 'var(--accent)';

  const li = document.createElement('li');
  li.className = 'tg-tree-node';
  li.style.paddingLeft = (depth * 18) + 'px';

  li.innerHTML =
    '<span class="tg-color-swatch" style="background:' + color + '"></span>' +
    '<span class="tg-node-name" data-tagid="' + tag.id + '">' + escHtml(name) + '</span>' +
    '<span class="tg-node-actions">' +
      '<button class="tg-btn-addsub" onclick="tmAddChild(\'' + tag.id + '\')" title="Add sub-tag">+ Sub</button>' +
      '<button class="tg-btn-edit" onclick="tmEditTag(\'' + tag.id + '\')" title="Edit">✎</button>' +
      '<button class="tg-btn-del" onclick="tmDeleteTag(\'' + tag.id + '\')" title="Delete">✕</button>' +
    '</span>';

  // Children
  const children = [...idx.byId.values()].filter(t => t.parent_id === tag.id);
  children.forEach(child => {
    li.appendChild(buildTagNode(child, idx, depth + 1));
  });

  return li;
}

// ── Tag CRUD ──

function tmAddRoot() {
  tmOpenEditor(null, null);
}

function tmAddChild(parentId) {
  tmOpenEditor(null, parentId);
}

function tmEditTag(tagId) {
  const idx = window.__TAGS__;
  if (!idx) return;
  const tag = idx.byId.get(tagId);
  if (!tag) return;
  const props = tag.properties || {};
  tmOpenEditor(tagId, tag.parent_id || null, props.name, props.color, props.description);
}

async function tmDeleteTag(tagId) {
  const idx = window.__TAGS__;
  if (!idx) return;
  const tag = idx.byId.get(tagId);
  if (!tag) return;
  const name = (tag.properties || {}).name || 'this tag';

  // Warn if tag has children
  const hasChildren = [...idx.byId.values()].some(t => t.parent_id === tagId);
  const msg = hasChildren
    ? 'Delete "' + name + '" and all its sub-tags?'
    : 'Delete tag "' + name + '"?';
  if (!confirm(msg)) return;

  // Delete descendants first (deepest first)
  const descendants = idx.getDescendants(tagId);
  for (let i = descendants.length - 1; i >= 0; i--) {
    await window.blockStore.deleteBlock(descendants[i]);
  }

  refreshTagIndex();
  renderTagTree();
  // Refresh any open tag pickers
  document.querySelectorAll('[data-tag-picker]').forEach(el => {
    const cb = el._tagPickerOnChange;
    const sel = el._tagPickerSelected || [];
    const filtered = sel.filter(id => window.__TAGS__ && window.__TAGS__.byId.has(id));
    if (cb) cb(filtered);
    mountTagPickerInto(el, filtered, cb);
  });
  if (typeof showToast === 'function') showToast('Tag deleted', 'success');
}

// ── Inline editor (within the modal body) ──
let _tmEditState = null; // { tagId: string|null, parentId: string|null }

function tmOpenEditor(tagId, parentId, name = '', color = '#4A90D9', description = '') {
  _tmEditState = { tagId, parentId };
  const body = document.getElementById('tag-manager-body');
  if (!body) return;

  const existing = document.getElementById('tm-editor-row');
  if (existing) existing.remove();

  const row = document.createElement('div');
  row.id = 'tm-editor-row';
  row.className = 'tm-editor-row';
  row.innerHTML =
    '<input id="tm-name" class="tm-input" type="text" placeholder="Tag name" value="' + escHtml(name) + '" maxlength="50" />' +
    '<input id="tm-color" class="tm-color-input" type="color" value="' + color + '" title="Tag color" />' +
    '<input id="tm-desc" class="tm-input" type="text" placeholder="Description (optional)" value="' + escHtml(description) + '" maxlength="200" />' +
    '<div class="tm-editor-btns">' +
      '<button class="secondary" onclick="tmCancelEditor()">Cancel</button>' +
      '<button class="primary" onclick="tmSaveEditor()">Save</button>' +
    '</div>';

  body.insertBefore(row, body.firstChild);
  document.getElementById('tm-name').focus();
}

function tmCancelEditor() {
  const row = document.getElementById('tm-editor-row');
  if (row) row.remove();
  _tmEditState = null;
}

async function tmSaveEditor() {
  if (!_tmEditState) return;
  const nameEl = document.getElementById('tm-name');
  const colorEl = document.getElementById('tm-color');
  const descEl = document.getElementById('tm-desc');
  const name = nameEl ? nameEl.value.trim() : '';
  if (!name) { if (typeof showToast === 'function') showToast('Tag name is required', 'error'); return; }

  const props = {
    name,
    color: colorEl ? colorEl.value : '#4A90D9',
    description: descEl ? descEl.value.trim() : ''
  };

  if (_tmEditState.tagId) {
    // Update existing
    await window.blockStore.updateBlock(_tmEditState.tagId, props);
  } else {
    // Create new
    await window.blockStore.createBlock('tag', props, {
      parentId: _tmEditState.parentId || null,
      date: null
    });
  }

  refreshTagIndex();
  tmCancelEditor();
  renderTagTree();
  if (typeof showToast === 'function') showToast('Tag saved', 'success');
}

// ── Tag Chip Picker Widget ──
// containerEl: DOM element to render into
// selectedTagIds: string[]
// onChange: (ids: string[]) => void
// Returns the selected IDs array (live reference).
function createTagPicker(containerEl, selectedTagIds, onChange) {
  if (!containerEl) return;
  containerEl.setAttribute('data-tag-picker', '1');
  containerEl._tagPickerSelected = selectedTagIds ? [...selectedTagIds] : [];
  containerEl._tagPickerOnChange = onChange;
  mountTagPickerInto(containerEl, containerEl._tagPickerSelected, onChange);
}

function mountTagPickerInto(containerEl, selected, onChange) {
  containerEl._tagPickerSelected = [...selected];
  containerEl.innerHTML = '';

  // Render selected chips
  const chipsRow = document.createElement('div');
  chipsRow.className = 'tag-chips-row';

  selected.forEach(id => {
    const idx = window.__TAGS__;
    const tag = idx && idx.byId.get(id);
    const name = tag ? (tag.properties || {}).name : id.slice(0, 8) + '…';
    const color = tag ? ((tag.properties || {}).color || 'var(--accent)') : 'var(--accent)';

    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.style.setProperty('--chip-color', color);
    chip.innerHTML = escHtml(name) + '<button class="tag-chip-remove" data-id="' + id + '" title="Remove">&times;</button>';
    chip.querySelector('.tag-chip-remove').addEventListener('click', e => {
      e.stopPropagation();
      const newSel = containerEl._tagPickerSelected.filter(x => x !== id);
      if (onChange) onChange(newSel);
      mountTagPickerInto(containerEl, newSel, onChange);
    });
    chipsRow.appendChild(chip);
  });

  // Add-tag button
  const addBtn = document.createElement('button');
  addBtn.className = 'tag-add-btn';
  addBtn.textContent = '+ Tag';
  addBtn.addEventListener('click', e => {
    e.stopPropagation();
    toggleTagDropdown(containerEl, selected, onChange);
  });
  chipsRow.appendChild(addBtn);
  containerEl.appendChild(chipsRow);
}

function toggleTagDropdown(containerEl, selected, onChange) {
  // Close any other open dropdowns
  document.querySelectorAll('.tag-picker-dropdown').forEach(d => d.remove());

  const dropdown = document.createElement('div');
  dropdown.className = 'tag-picker-dropdown';

  const search = document.createElement('input');
  search.className = 'tag-picker-search';
  search.placeholder = 'Search or create tags\u2026';
  dropdown.appendChild(search);

  const list = document.createElement('ul');
  list.className = 'tag-picker-list';
  dropdown.appendChild(list);

  // Helper: update chips without destroying dropdown
  function syncChips(newSel) {
    if (onChange) onChange(newSel);
    dropdown.remove();                               // detach from DOM
    mountTagPickerInto(containerEl, newSel, onChange); // re-render chips
    containerEl.appendChild(dropdown);               // re-attach dropdown
  }

  function renderList(filter) {
    list.innerHTML = '';
    const idx = window.__TAGS__;
    const all = idx ? [...idx.byId.values()] : [];
    const filterLower = (filter || '').trim().toLowerCase();
    const filtered = filterLower
      ? all.filter(t => ((t.properties || {}).name || '').toLowerCase().includes(filterLower))
      : all;

    // Sort: selected first, then alphabetical
    filtered.sort((a, b) => {
      const aSelected = containerEl._tagPickerSelected.includes(a.id);
      const bSelected = containerEl._tagPickerSelected.includes(b.id);
      if (aSelected !== bSelected) return aSelected ? -1 : 1;
      const an = (a.properties || {}).name || '';
      const bn = (b.properties || {}).name || '';
      return an.localeCompare(bn);
    });

    filtered.forEach(tag => {
      const props = tag.properties || {};
      const isSelected = containerEl._tagPickerSelected.includes(tag.id);
      const color = props.color || 'var(--accent)';
      const depth = idx ? idx.getAncestors(tag.id).length - 1 : 0;

      const li = document.createElement('li');
      li.className = 'tag-picker-item' + (isSelected ? ' selected' : '');
      li.style.paddingLeft = (8 + depth * 14) + 'px';
      li.innerHTML =
        '<span class="tg-color-swatch" style="background:' + color + '"></span>' +
        escHtml(props.name || '') +
        (isSelected ? ' <span class="tag-picker-check">\u2713</span>' : '');

      li.addEventListener('click', () => {
        let newSel;
        if (isSelected) {
          newSel = containerEl._tagPickerSelected.filter(x => x !== tag.id);
        } else {
          newSel = [...containerEl._tagPickerSelected, tag.id];
        }
        syncChips(newSel);
        renderList(search.value);
        search.focus();
      });
      list.appendChild(li);
    });

    // "Create" option when filter has no exact match
    if (filterLower) {
      const exactMatch = all.some(t => ((t.properties || {}).name || '').toLowerCase() === filterLower);
      if (!exactMatch) {
        const createLi = document.createElement('li');
        createLi.className = 'tag-picker-create';
        createLi.innerHTML = '+ Create \u201c' + escHtml(filter.trim()) + '\u201d';
        createLi.addEventListener('click', async () => {
          const name = filter.trim();
          if (!name) return;
          // Create the tag via blockStore
          await window.blockStore.createBlock('tag', { name: name, color: '#4A90D9', description: '' }, { parentId: null, date: null });
          refreshTagIndex();
          // Find the newly created tag
          const newIdx = window.__TAGS__;
          let newTagId = null;
          if (newIdx) {
            for (const [id, t] of newIdx.byId) {
              if ((t.properties || {}).name === name) { newTagId = id; break; }
            }
          }
          if (newTagId) {
            const newSel = [...containerEl._tagPickerSelected, newTagId];
            syncChips(newSel);
          }
          search.value = '';
          renderList('');
          search.focus();
        });
        list.appendChild(createLi);
      }
    }

    // Empty state (no tags exist and no filter)
    if (filtered.length === 0 && !filterLower) {
      list.innerHTML = '<li class="tag-picker-empty">Type to create your first tag</li>';
    }
  }

  renderList('');
  search.addEventListener('input', () => renderList(search.value));

  // Position dropdown below the container
  containerEl.appendChild(dropdown);
  search.focus();

  // Close on outside click
  function onOutsideClick(e) {
    if (!dropdown.contains(e.target) && !containerEl.contains(e.target)) {
      dropdown.remove();
      document.removeEventListener('mousedown', onOutsideClick, true);
    }
  }
  setTimeout(() => document.addEventListener('mousedown', onOutsideClick, true), 0);
}

// ── Escape HTML helper (may already exist globally, keep safe) ──
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Wire up modal close buttons after DOM is ready ──
document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('tag-manager-close')?.addEventListener('click', closeTagManager);
  document.getElementById('tag-manager-cancel')?.addEventListener('click', closeTagManager);
  document.getElementById('tag-manager-add-root')?.addEventListener('click', tmAddRoot);
  document.getElementById('tag-manager-overlay')?.addEventListener('click', function (e) {
    if (e.target === this) closeTagManager();
  });
});
