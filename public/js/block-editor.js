// ======== NOTION-STYLE BLOCK EDITOR ========
// Vanilla JS block editor: each paragraph is an independent contenteditable block.
// Enter creates new blocks, Backspace merges, markdown shortcuts auto-convert,
// blocks are draggable, and slash commands open a type menu.

(function(){
"use strict";

let _uid=0;
function uid(){return 'nb-'+Date.now().toString(36)+'-'+(++_uid)}

const BLOCK_TYPES=[
  {type:'paragraph',label:'Text',icon:'¶',shortcut:null},
  {type:'heading',label:'Heading 1',icon:'H1',shortcut:'# ',level:1},
  {type:'heading',label:'Heading 2',icon:'H2',shortcut:'## ',level:2},
  {type:'heading',label:'Heading 3',icon:'H3',shortcut:'### ',level:3},
  {type:'bullet',label:'Bullet List',icon:'•',shortcut:'- '},
  {type:'numbered',label:'Numbered List',icon:'1.',shortcut:'1. '},
  {type:'checkbox',label:'To-do',icon:'☑',shortcut:'[] '},
];

// Markdown shortcut patterns (tested at block start on Space keyup)
const MD_SHORTCUTS=[
  {re:/^# $/,type:'heading',level:1},
  {re:/^## $/,type:'heading',level:2},
  {re:/^### $/,type:'heading',level:3},
  {re:/^[-*] $/,type:'bullet'},
  {re:/^\d+\. $/,type:'numbered'},
  {re:/^\[[ x]?\] $/,type:'checkbox',checked:false},
  {re:/^\[x\] $/,type:'checkbox',checked:true},
];

// ======== Block rendering ========

function renderPrefix(block){
  if(block.type==='bullet') return '<span class="nb-bullet">•</span>';
  if(block.type==='numbered'){
    return '<span class="nb-number">'+(block._num||'1')+'.</span>';
  }
  if(block.type==='checkbox'){
    return '<label class="nb-check-label"><input type="checkbox" class="nb-check"'+(block.checked?' checked':'')+' /></label>';
  }
  return '';
}

function blockClass(block){
  let cls='nb-block';
  if(block.type==='heading') cls+=' nb-h nb-h'+((block.level)||1);
  if(block.type==='checkbox' && block.checked) cls+=' nb-checked';
  return cls;
}

function createBlockEl(block){
  if(block.type==='image'){
    const el=document.createElement('div');
    el.className='nb-attachment';
    el.dataset.blockId=block.id;
    el.dataset.blockType=block.type;

    const img=document.createElement('img');
    img.src=block.src||'';
    img.alt=block.alt||block.name||'Attached image';
    img.loading='lazy';

    const del=document.createElement('button');
    del.className='nb-attachment-remove';
    del.type='button';
    del.title='Remove image';
    del.setAttribute('aria-label','Remove image');
    del.innerHTML='&times;';

    el.appendChild(img);
    el.appendChild(del);
    return el;
  }

  const el=document.createElement('div');
  el.className=blockClass(block);
  el.dataset.blockId=block.id;
  el.dataset.blockType=block.type;
  if(block.level) el.dataset.level=block.level;

  el.innerHTML=
    '<div class="nb-handle" draggable="true" title="Drag to reorder">\u2807</div>'+
    '<div class="nb-prefix">'+renderPrefix(block)+'</div>'+
    '<div class="nb-content" contenteditable="true" data-placeholder="Type \'/\' for commands..."></div>';

  const content=el.querySelector('.nb-content');
  content.innerHTML=block.content||'';

  return el;
}

// ======== Numbered list renumbering ========

function renumber(container){
  let n=0;
  container.querySelectorAll('.nb-block').forEach(el=>{
    if(el.dataset.blockType==='numbered'){
      n++;
      const num=el.querySelector('.nb-number');
      if(num) num.textContent=n+'.';
      // store for serialization
      el._nbNum=n;
    } else {
      n=0;
    }
  });
}

// ======== Cursor utilities ========

function setCursorToEnd(el){
  el.focus();
  const range=document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel=window.getSelection();
  sel.removeAllRanges();sel.addRange(range);
}

function setCursorToStart(el){
  el.focus();
  const range=document.createRange();
  range.selectNodeContents(el);
  range.collapse(true);
  const sel=window.getSelection();
  sel.removeAllRanges();sel.addRange(range);
}

function isCursorAtStart(el){
  const sel=window.getSelection();
  if(!sel.rangeCount) return false;
  const range=sel.getRangeAt(0);
  if(range.startOffset!==0) return false;
  // Check if we're at the very beginning
  let node=range.startContainer;
  while(node && node!==el){
    if(node.previousSibling) return false;
    node=node.parentNode;
  }
  return true;
}

function getCursorOffset(el){
  const sel=window.getSelection();
  if(!sel.rangeCount) return 0;
  const range=sel.getRangeAt(0).cloneRange();
  range.selectNodeContents(el);
  range.setEnd(sel.getRangeAt(0).startContainer,sel.getRangeAt(0).startOffset);
  return range.toString().length;
}

// ======== Split HTML at cursor ========

function splitAtCursor(contentEl){
  const sel=window.getSelection();
  if(!sel.rangeCount) return {before:contentEl.innerHTML, after:''};
  const range=sel.getRangeAt(0);

  // Before cursor
  const beforeRange=document.createRange();
  beforeRange.selectNodeContents(contentEl);
  beforeRange.setEnd(range.startContainer,range.startOffset);
  const beforeFrag=beforeRange.cloneContents();
  const beforeDiv=document.createElement('div');
  beforeDiv.appendChild(beforeFrag);

  // After cursor
  const afterRange=document.createRange();
  afterRange.selectNodeContents(contentEl);
  afterRange.setStart(range.endContainer,range.endOffset);
  const afterFrag=afterRange.cloneContents();
  const afterDiv=document.createElement('div');
  afterDiv.appendChild(afterFrag);

  return {before:beforeDiv.innerHTML, after:afterDiv.innerHTML};
}

// ======== Slash menu ========

function createSlashMenu(){
  const menu=document.createElement('div');
  menu.className='nb-slash-menu';
  menu.style.display='none';
  menu.innerHTML='<div class="nb-slash-title">Turn into</div>'+
    BLOCK_TYPES.map((bt,i)=>
      '<button class="nb-slash-item" data-idx="'+i+'">'+
        '<span class="nb-slash-icon">'+bt.icon+'</span>'+
        '<span class="nb-slash-label">'+bt.label+'</span>'+
      '</button>'
    ).join('');
  return menu;
}

// ======== Main editor factory ========

window.createBlockEditor=function(containerEl, initialBlocks){
  const editor={};
  const container=document.createElement('div');
  container.className='nb-editor';
  containerEl.innerHTML='';
  containerEl.appendChild(container);

  const attachmentRail=document.createElement('div');
  attachmentRail.className='nb-attachments';
  container.appendChild(attachmentRail);

  const slashMenu=createSlashMenu();
  container.appendChild(slashMenu);
  let slashBlockId=null;
  let slashFilter='';

  // State
  let blocks=[];

  function blockElById(id){
    return container.querySelector('[data-block-id="'+id+'"]');
  }
  function contentElById(id){
    const b=blockElById(id);
    return b?b.querySelector('.nb-content'):null;
  }
  function allBlockEls(){
    return Array.from(container.querySelectorAll('.nb-block'));
  }
  function blockDataById(id){
    return blocks.find(b=>b.id===id);
  }
  function blockIndex(id){
    return blocks.findIndex(b=>b.id===id);
  }

  function addBlock(data, afterId){
    const block={id:uid(), type:'paragraph', content:'', ...data};
    if(afterId!==undefined){
      const idx=blockIndex(afterId);
      blocks.splice(idx+1,0,block);
    } else {
      blocks.push(block);
    }
    const el=createBlockEl(block);
    if(block.type==='image'){
      attachmentRail.appendChild(el);
      updateAttachmentRail();
    } else if(afterId!==undefined){
      const afterEl=blockElById(afterId);
      afterEl.after(el);
    } else {
      container.insertBefore(el,slashMenu);
    }
    wireBlock(el, block);
    renumber(container);
    return block;
  }

  function removeBlock(id){
    const idx=blockIndex(id);
    if(idx===-1) return;
    blocks.splice(idx,1);
    const el=blockElById(id);
    if(el) el.remove();
    updateAttachmentRail();
    renumber(container);
  }

  function updateAttachmentRail(){
    attachmentRail.hidden=!attachmentRail.querySelector('.nb-attachment');
  }

  function changeBlockType(id, type, extra){
    const bd=blockDataById(id);
    if(!bd) return;
    bd.type=type;
    if(extra) Object.assign(bd, extra);
    if(type!=='heading') delete bd.level;
    if(type!=='checkbox') delete bd.checked;

    const el=blockElById(id);
    el.className=blockClass(bd);
    el.dataset.blockType=type;
    if(bd.level) el.dataset.level=bd.level; else delete el.dataset.level;
    el.querySelector('.nb-prefix').innerHTML=renderPrefix(bd);
    renumber(container);

    // Re-wire checkbox
    const chk=el.querySelector('.nb-check');
    if(chk){
      chk.addEventListener('change',function(){
        bd.checked=this.checked;
        el.classList.toggle('nb-checked',bd.checked);
      });
    }
  }

  // ======== Event wiring per block ========

  function wireBlock(el, block){
    if(block.type==='image'){
      const del=el.querySelector('.nb-attachment-remove');
      if(del){
        del.addEventListener('click',function(e){
          e.preventDefault();
          e.stopPropagation();
          removeBlock(block.id);
        });
      }
      return;
    }

    const content=el.querySelector('.nb-content');
    const handle=el.querySelector('.nb-handle');

    // --- Keyboard ---
    content.addEventListener('keydown',function(e){
      const id=el.dataset.blockId;

      // Enter → new block
      if(e.key==='Enter' && !e.shiftKey){
        e.preventDefault();
        closeSlashMenu();
        const {before, after}=splitAtCursor(content);
        content.innerHTML=before;
        syncContent(id);
        const nb=addBlock({content:after}, id);
        const newContent=contentElById(nb.id);
        if(newContent) setCursorToStart(newContent);
        return;
      }

      // Backspace at start
      if(e.key==='Backspace' && isCursorAtStart(content) && window.getSelection().isCollapsed){
        const idx=blockIndex(id);
        // If non-paragraph type, convert back to paragraph first
        const bd=blockDataById(id);
        if(bd.type!=='paragraph'){
          e.preventDefault();
          changeBlockType(id,'paragraph');
          return;
        }
        // Merge with previous block
        if(idx>0){
          e.preventDefault();
          const prevBlock=blocks[idx-1];
          const prevContent=contentElById(prevBlock.id);
          const curHtml=content.innerHTML;
          // Set cursor at end of previous content before appending
          setCursorToEnd(prevContent);
          const savedSel=window.getSelection().getRangeAt(0);
          prevContent.innerHTML+=curHtml;
          // Restore cursor position
          try{
            const sel=window.getSelection();
            sel.removeAllRanges();sel.addRange(savedSel);
          }catch(ex){setCursorToEnd(prevContent)}
          syncContent(prevBlock.id);
          removeBlock(id);
        }
        return;
      }

      // Tab → indent (future), for now prevent leaving
      if(e.key==='Tab'){
        e.preventDefault();
        return;
      }

      // Arrow up at start → focus previous block end
      if(e.key==='ArrowUp' && isCursorAtStart(content)){
        const idx=blockIndex(id);
        if(idx>0){
          e.preventDefault();
          setCursorToEnd(contentElById(blocks[idx-1].id));
        }
      }

      // Arrow down at end → focus next block start
      if(e.key==='ArrowDown'){
        const sel=window.getSelection();
        if(sel.rangeCount){
          const range=sel.getRangeAt(0);
          const atEnd=range.endOffset===range.endContainer.textContent.length;
          if(atEnd){
            const idx=blockIndex(id);
            if(idx<blocks.length-1){
              e.preventDefault();
              setCursorToStart(contentElById(blocks[idx+1].id));
            }
          }
        }
      }

      // Inline formatting shortcuts
      if((e.metaKey||e.ctrlKey) && !e.shiftKey){
        if(e.key==='b'){e.preventDefault();document.execCommand('bold');return}
        if(e.key==='i'){e.preventDefault();document.execCommand('italic');return}
        if(e.key==='u'){e.preventDefault();document.execCommand('underline');return}
      }
      if((e.metaKey||e.ctrlKey) && e.shiftKey && (e.key==='x'||e.key==='X')){
        e.preventDefault();document.execCommand('strikeThrough');return;
      }
    });

    // --- Input / markdown shortcuts ---
    content.addEventListener('input',function(){
      syncContent(el.dataset.blockId);
      hoistInlineImages(el.dataset.blockId);

      // Check markdown shortcuts
      const text=content.textContent;
      for(const sc of MD_SHORTCUTS){
        if(sc.re.test(text)){
          content.innerHTML='';
          const extra={};
          if(sc.level) extra.level=sc.level;
          if(sc.type==='checkbox') extra.checked=!!sc.checked;
          changeBlockType(el.dataset.blockId, sc.type, extra);
          setCursorToStart(content);
          syncContent(el.dataset.blockId);
          return;
        }
      }

      // Slash menu
      if(text==='/' && blocks.length>0){
        openSlashMenu(el.dataset.blockId, content);
      } else if(slashBlockId===el.dataset.blockId){
        if(text.startsWith('/')){
          slashFilter=text.slice(1).toLowerCase();
          filterSlashMenu();
        } else {
          closeSlashMenu();
        }
      }
    });

    content.addEventListener('paste',function(e){
      if(!e.clipboardData) return;
      const imageFiles=Array.from(e.clipboardData.files||[]).filter(file=>file.type && file.type.indexOf('image/')===0);
      const html=e.clipboardData.getData('text/html')||'';
      const htmlData=extractImagesFromHtml(html);
      if(!imageFiles.length && !htmlData.images.length) return;

      e.preventDefault();
      if(htmlData.html){
        document.execCommand('insertHTML',false,htmlData.html);
        syncContent(el.dataset.blockId);
      } else {
        const text=e.clipboardData.getData('text/plain')||'';
        if(text) document.execCommand('insertText',false,text);
      }

      htmlData.images.forEach(img=>addImageBlock(img.src,img.alt));
      imageFiles.forEach(file=>readImageFile(file,function(src){
        addImageBlock(src,file.name||'');
      }));
    });

    // --- Drag & drop ---
    handle.addEventListener('dragstart',function(e){
      e.dataTransfer.setData('text/plain',el.dataset.blockId);
      e.dataTransfer.effectAllowed='move';
      el.classList.add('nb-dragging');
    });
    handle.addEventListener('dragend',function(){
      el.classList.remove('nb-dragging');
      container.querySelectorAll('.nb-drag-over').forEach(x=>x.classList.remove('nb-drag-over'));
    });

    el.addEventListener('dragover',function(e){
      e.preventDefault();
      e.dataTransfer.dropEffect='move';
      container.querySelectorAll('.nb-drag-over').forEach(x=>x.classList.remove('nb-drag-over'));
      el.classList.add('nb-drag-over');
    });
    el.addEventListener('dragleave',function(){
      el.classList.remove('nb-drag-over');
    });
    el.addEventListener('drop',function(e){
      e.preventDefault();
      el.classList.remove('nb-drag-over');
      const dragId=e.dataTransfer.getData('text/plain');
      if(!dragId || dragId===el.dataset.blockId) return;
      const dragIdx=blockIndex(dragId);
      const dropIdx=blockIndex(el.dataset.blockId);
      if(dragIdx===-1||dropIdx===-1) return;

      // Move in data
      const [moved]=blocks.splice(dragIdx,1);
      const newIdx=dropIdx>(dragIdx?dropIdx:dropIdx);
      blocks.splice(dropIdx,0,moved);

      // Move in DOM
      const dragEl=blockElById(dragId);
      if(dragIdx<dropIdx) el.after(dragEl);
      else el.before(dragEl);

      renumber(container);
    });

    // --- Checkbox ---
    const chk=el.querySelector('.nb-check');
    if(chk){
      chk.addEventListener('change',function(){
        block.checked=this.checked;
        el.classList.toggle('nb-checked',block.checked);
      });
    }
  }

  function syncContent(id){
    const bd=blockDataById(id);
    const cel=contentElById(id);
    if(bd && cel) bd.content=cel.innerHTML;
  }

  function addImageBlock(src, alt){
    if(!src) return null;
    const existing=blocks.find(b=>b.type==='image' && b.src===src);
    if(existing) return existing;
    return addBlock({type:'image', src:src, alt:alt||'', content:''});
  }

  function readImageFile(file, done){
    const reader=new FileReader();
    reader.onload=function(){ done(reader.result); };
    reader.readAsDataURL(file);
  }

  function extractImagesFromHtml(html){
    const out={images:[], html:''};
    if(!html || html.indexOf('<img')===-1){
      out.html=html||'';
      return out;
    }
    const div=document.createElement('div');
    div.innerHTML=html;
    div.querySelectorAll('img').forEach(function(img){
      const src=img.getAttribute('src');
      if(src) out.images.push({src:src, alt:img.getAttribute('alt')||''});
      img.remove();
    });
    out.html=div.innerHTML.trim();
    return out;
  }

  function hoistInlineImages(blockId){
    const bd=blockDataById(blockId);
    const cel=contentElById(blockId);
    if(!bd || !cel) return;
    const imgs=Array.from(cel.querySelectorAll('img'));
    if(!imgs.length) return;
    imgs.forEach(function(img){
      addImageBlock(img.getAttribute('src'), img.getAttribute('alt')||'');
      img.remove();
    });
    bd.content=cel.innerHTML;
  }

  function normalizeBlocks(newBlocks){
    const normalized=[];
    (newBlocks||[]).forEach(function(block){
      const b={...block};
      if(b.type==='image'){
        b.id=b.id||uid();
        normalized.push(b);
        return;
      }
      const extracted=extractImagesFromHtml(b.content||'');
      extracted.images.forEach(function(img){
        normalized.push({id:uid(), type:'image', src:img.src, alt:img.alt, content:''});
      });
      b.content=extracted.html;
      if((b.content||'').trim() || b.type!=='paragraph'){
        normalized.push(b);
      }
    });
    if(!normalized.some(function(b){return b.type!=='image';})){
      normalized.push({id:uid(), type:'paragraph', content:''});
    }
    return normalized;
  }

  function firstEditableBlock(){
    return blocks.find(function(b){return b.type!=='image';});
  }

  function lastEditableBlock(){
    for(let i=blocks.length-1;i>=0;i--){
      if(blocks[i].type!=='image') return blocks[i];
    }
    return null;
  }

  // ======== Slash menu ========

  function openSlashMenu(blockId, contentEl){
    slashBlockId=blockId;
    slashFilter='';
    const rect=contentEl.getBoundingClientRect();
    const contRect=container.getBoundingClientRect();
    slashMenu.style.top=(rect.bottom-contRect.top+4)+'px';
    slashMenu.style.left=(rect.left-contRect.left)+'px';
    slashMenu.style.display='block';
    filterSlashMenu();
  }

  function closeSlashMenu(){
    slashMenu.style.display='none';
    slashBlockId=null;
    slashFilter='';
  }

  function filterSlashMenu(){
    const items=slashMenu.querySelectorAll('.nb-slash-item');
    items.forEach((item,i)=>{
      const bt=BLOCK_TYPES[i];
      const show=!slashFilter||bt.label.toLowerCase().includes(slashFilter)||bt.type.includes(slashFilter);
      item.style.display=show?'':'none';
    });
  }

  slashMenu.addEventListener('mousedown',function(e){
    e.preventDefault();// prevent blur
  });
  slashMenu.addEventListener('click',function(e){
    const item=e.target.closest('.nb-slash-item');
    if(!item) return;
    const bt=BLOCK_TYPES[parseInt(item.dataset.idx)];
    if(!slashBlockId) return;
    // Clear the slash text
    const cel=contentElById(slashBlockId);
    if(cel) cel.innerHTML='';
    const extra={};
    if(bt.level) extra.level=bt.level;
    if(bt.type==='checkbox') extra.checked=false;
    changeBlockType(slashBlockId, bt.type, extra);
    syncContent(slashBlockId);
    closeSlashMenu();
    if(cel) setCursorToStart(cel);
  });

  // Close slash menu on click outside
  document.addEventListener('click',function(e){
    if(slashMenu.style.display==='block' && !slashMenu.contains(e.target)){
      closeSlashMenu();
    }
  });

  // ======== Public API ========

  editor.getBlocks=function(){
    // Sync all content from DOM first
    blocks.forEach(b=>{
      const cel=contentElById(b.id);
      if(cel) b.content=cel.innerHTML;
    });
    return blocks.map(b=>{
      const out={id:b.id, type:b.type, content:b.content};
      if(b.type==='image'){
        out.src=b.src||'';
        if(b.alt) out.alt=b.alt;
        if(b.name) out.name=b.name;
      }
      if(b.level) out.level=b.level;
      if(b.type==='checkbox') out.checked=!!b.checked;
      return out;
    });
  };

  editor.setBlocks=function(newBlocks){
    // Clear existing
    container.querySelectorAll('.nb-block,.nb-attachment').forEach(el=>el.remove());
    blocks=[];
    if(!newBlocks || !newBlocks.length){
      newBlocks=[{id:uid(), type:'paragraph', content:''}];
    }
    newBlocks=normalizeBlocks(newBlocks);
    newBlocks.forEach(b=>{
      b.id=b.id||uid();
      addBlock(b);
    });
    updateAttachmentRail();
  };

  editor.focus=function(){
    const block=firstEditableBlock();
    if(block){
      const cel=contentElById(block.id);
      if(cel) setCursorToStart(cel);
    }
  };

  editor.focusEnd=function(){
    const block=lastEditableBlock();
    if(block){
      const cel=contentElById(block.id);
      if(cel) setCursorToEnd(cel);
    }
  };

  editor.toHtml=function(){
    return blocks.map(b=>{
      if(b.type==='image'){
        return '<p><img src="'+escapeAttr(b.src||'')+'" alt="'+escapeAttr(b.alt||'Attached image')+'" /></p>';
      }
      const tag=b.type==='heading'?'h'+(b.level||1):
                b.type==='bullet'||b.type==='numbered'?'li':
                b.type==='checkbox'?'div':'p';
      const inner=b.content||'';
      if(b.type==='checkbox'){
        return '<div><label><input type="checkbox"'+(b.checked?' checked':'')+' /> '+inner+'</label></div>';
      }
      return '<'+tag+'>'+inner+'</'+tag+'>';
    }).join('\n');
  };

  editor.toMarkdown=function(){
    return blocks.map((b,i)=>{
      if(b.type==='image') return '[Attached image]';
      const text=_stripHtml(b.content);
      if(b.type==='heading') return '#'.repeat(b.level||1)+' '+text;
      if(b.type==='bullet') return '- '+text;
      if(b.type==='numbered') return (b._num||(i+1))+'. '+text;
      if(b.type==='checkbox') return '['+(b.checked?'x':' ')+'] '+text;
      return text;
    }).join('\n');
  };

  editor.destroy=function(){
    container.innerHTML='';
    blocks=[];
  };

  editor.isEmpty=function(){
    return blocks.length===0||blocks.every(function(b){
      if(b.type==='image') return !(b.src||'').trim();
      return !(b.content||'').trim();
    });
  };

  // ======== Initialize ========
  editor.setBlocks(initialBlocks);
  return editor;
};

// ======== Migration: HTML → blocks ========

window.migrateHtmlToBlocks=function(html){
  if(!html || !html.trim()) return [{id:uid(), type:'paragraph', content:''}];

  const div=document.createElement('div');
  div.innerHTML=html;

  const blocks=[];
  function push(type, content, extra){
    blocks.push({id:uid(), type, content:content||'', ...extra});
  }

  function processNode(node){
    if(node.nodeType===3){ // text node
      const t=node.textContent.trim();
      if(t) push('paragraph', t);
      return;
    }
    if(node.nodeType!==1) return;
    const tag=node.tagName.toLowerCase();

    if(tag==='h1') push('heading', node.innerHTML, {level:1});
    else if(tag==='h2') push('heading', node.innerHTML, {level:2});
    else if(tag==='h3') push('heading', node.innerHTML, {level:3});
    else if(tag==='li'){
      // Check if it's a checkbox
      const chk=node.querySelector('input[type="checkbox"]');
      if(chk){
        push('checkbox', node.innerHTML.replace(/<label[^>]*>.*?<\/label>/i,'').replace(/<input[^>]*>/i,'').trim(), {checked:chk.checked});
      } else {
        const parent=node.parentElement;
        const type=(parent && parent.tagName.toLowerCase()==='ol')?'numbered':'bullet';
        push(type, node.innerHTML);
      }
    }
    else if(tag==='ul'||tag==='ol'){
      Array.from(node.children).forEach(processNode);
    }
    else if(tag==='p'||tag==='div'){
      const directImages=Array.from(node.querySelectorAll('img'));
      directImages.forEach(function(img){
        const src=img.getAttribute('src');
        if(src) push('image','',{src:src,alt:img.getAttribute('alt')||''});
        img.remove();
      });
      // Check for checkbox pattern
      const chk=node.querySelector('input[type="checkbox"]');
      if(chk){
        push('checkbox', node.innerHTML.replace(/<label[^>]*>.*?<\/label>/i,'').replace(/<input[^>]*>/i,'').trim(), {checked:chk.checked});
      } else {
        const inner=node.innerHTML.trim();
        if(inner) push('paragraph', inner);
      }
    }
    else if(tag==='br'){
      // skip standalone br
    }
    else if(tag==='img'){
      const src=node.getAttribute('src');
      if(src) push('image','',{src:src,alt:node.getAttribute('alt')||''});
    }
    else {
      push('paragraph', node.outerHTML);
    }
  }

  Array.from(div.childNodes).forEach(processNode);

  // Handle case where HTML had no block elements (just inline text)
  if(!blocks.length){
    push('paragraph', html);
  }

  return blocks;
};

// Strip HTML tags for plaintext
function _stripHtml(html){
  const d=document.createElement('div');
  d.innerHTML=html||'';
  return d.textContent||'';
}

function escapeAttr(value){
  return String(value||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

})();
