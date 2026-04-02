// ======== CLAUDE'S REPORT CARD ========
// Renders the Report Card tab from state.report_card, state.clean_tidy,
// state.orchestrator, and the PA activity log.

function buildReportCard() {
  const container = document.getElementById("rc-content");
  if (!container) return;
  const state = window.__PA_STATE__;
  if (!state) {
    container.innerHTML = '<div class="rc-empty">No state data loaded. The Report Card populates after the first scheduled run.</div>';
    return;
  }

  const rc = state.report_card || null;
  const orch = state.orchestrator || {};
  const ct = state.clean_tidy || null;
  const assessment = state.assessment || null;
  const sweepStats = state.sweep_stats || null;
  const schedule = state.schedule || null;
  const mutations = state.mutations || [];

  let html = '';

  // ── Orchestrator Health ──
  html += renderOrchestratorHealth(orch);

  // ── Report Card sections (from review-learn) ──
  if (rc) {
    html += renderAssessmentSection(rc);
    html += renderBatchReviewSection(rc);
    html += renderKnowledgeSection(rc);
    html += renderRetroSection(rc);
    html += renderSoulSection(rc);
  } else if (assessment) {
    // Fallback: render from top-level assessment if report_card doesn't exist yet
    html += renderLegacyAssessment(assessment);
  }

  // ── Sweep Stats ──
  html += renderSweepStats(sweepStats, mutations);

  // ── Schedule Stats ──
  html += renderScheduleStats(schedule);

  // ── Clean and Tidy (when present) ──
  if (ct) {
    html += renderCleanTidy(ct);
  }

  // ── Activity Log (last 5 entries) ──
  html += renderActivityLog();

  container.innerHTML = html;

  // Wire up approval buttons
  wireApprovalButtons();
}

// ── Orchestrator Health ──
function renderOrchestratorHealth(orch) {
  const lastRan = orch.last_ran || {};
  const ops = [
    { key: 'sweep', label: 'The Sweep', icon: '🔍' },
    { key: 'plan_day', label: 'Plan the Day', icon: '📋' },
    { key: 'review_and_learn', label: 'Review and Learn', icon: '📊' },
    { key: 'meeting_prep', label: 'Meeting Prep', icon: '📝' },
    { key: 'clean_and_tidy', label: 'Clean and Tidy', icon: '🧹' },
  ];

  let rows = ops.map(op => {
    const ts = lastRan[op.key];
    let timeStr = '<span class="rc-muted">never</span>';
    let freshness = 'rc-stale';
    if (ts) {
      const d = new Date(ts);
      const ago = Math.floor((Date.now() - d.getTime()) / 60000);
      timeStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      if (ago < 180) freshness = 'rc-fresh';
      else if (ago < 720) freshness = 'rc-aging';
      const agoStr = ago < 60 ? ago + 'm ago' : Math.floor(ago / 60) + 'h ago';
      timeStr += ' <span class="rc-muted">(' + agoStr + ')</span>';
    }
    return '<div class="rc-orch-row">' +
      '<span class="rc-orch-icon">' + op.icon + '</span>' +
      '<span class="rc-orch-label">' + op.label + '</span>' +
      '<span class="rc-orch-time ' + freshness + '">' + timeStr + '</span>' +
    '</div>';
  }).join('');

  return '<div class="rc-section">' +
    '<div class="rc-section-header">' +
      '<h3>Orchestrator Health</h3>' +
    '</div>' +
    '<div class="rc-orch-grid">' + rows + '</div>' +
  '</div>';
}

// ── Assessment ──
function renderAssessmentSection(rc) {
  const a = rc.assessment;
  if (!a) return '';

  let html = '<div class="rc-section">';
  html += '<div class="rc-section-header"><h3>Assessment</h3>';
  html += '<span class="rc-meta">' + (rc.review_type || '') + ' review of ' + (rc.review_date || '') + '</span></div>';

  // Adherence
  const adh = a.schedule_adherence || {};
  if (adh.tasks_planned) {
    html += '<div class="rc-kpi-row">' +
      rcKpi(adh.completion_rate || '0%', 'Completion', adh.tasks_completed + '/' + adh.tasks_planned + ' tasks') +
      rcKpi(String((a.wins || []).length), 'Wins', '') +
      rcKpi(String((a.dropped_balls || []).length), 'Dropped', '', (a.dropped_balls || []).length > 0 ? 'rc-kpi-warn' : '') +
    '</div>';
  }

  // Wins
  if (a.wins && a.wins.length) {
    html += '<div class="rc-list-header">Wins</div><div class="rc-list">';
    a.wins.forEach(w => {
      html += '<div class="rc-list-item rc-win"><span class="rc-dot" style="background:var(--green)"></span>' + esc(w.title || w.summary || '') + '</div>';
    });
    html += '</div>';
  }

  // Dropped balls
  if (a.dropped_balls && a.dropped_balls.length) {
    html += '<div class="rc-list-header">Dropped Balls</div><div class="rc-list">';
    a.dropped_balls.forEach(d => {
      html += '<div class="rc-list-item rc-drop"><span class="rc-dot" style="background:var(--red)"></span>' + esc(d.title || '') +
        (d.due_date ? ' <span class="rc-muted">due ' + d.due_date + '</span>' : '') + '</div>';
    });
    html += '</div>';
  }

  // Triage health
  const th = a.triage_health || {};
  if (th.open_count !== undefined) {
    html += '<div class="rc-list-header">Triage Health</div>';
    html += '<div class="rc-mini-stats">' +
      '<span>' + th.open_count + ' open</span>' +
      '<span>' + (th.high_priority_count || 0) + ' high priority</span>' +
      (th.stale_items && th.stale_items.length ? '<span class="rc-warn">' + th.stale_items.length + ' stale</span>' : '') +
    '</div>';
  }

  html += '</div>';
  return html;
}

// ── Batch Review ──
function renderBatchReviewSection(rc) {
  const br = rc.batch_review;
  if (!br || !br.meetings_reviewed) return '';

  let html = '<div class="rc-section">';
  html += '<div class="rc-section-header"><h3>Batch Review</h3></div>';
  html += '<div class="rc-kpi-row">' +
    rcKpi(String(br.meetings_reviewed), 'Meetings Reviewed', '') +
    rcKpi(String(br.action_items_extracted || 0), 'Action Items', '') +
    rcKpi(String(br.tasks_created || 0), 'Tasks Created', '') +
  '</div>';

  if (br.board_health_warnings && br.board_health_warnings.length) {
    html += '<div class="rc-list-header">Board Health Warnings</div><div class="rc-list">';
    br.board_health_warnings.forEach(w => {
      html += '<div class="rc-list-item"><span class="rc-dot" style="background:var(--amber)"></span>' + esc(w.type || w) + (w.count ? ' (' + w.count + ')' : '') + '</div>';
    });
    html += '</div>';
  }

  html += '</div>';
  return html;
}

// ── Knowledge Updates ──
function renderKnowledgeSection(rc) {
  const ku = rc.knowledge_updates;
  if (!ku || !ku.length) return '';

  let html = '<div class="rc-section">';
  html += '<div class="rc-section-header"><h3>Knowledge Updates</h3></div>';
  html += '<div class="rc-list">';
  ku.forEach(u => {
    const badge = u.change_type === 'added' ? 'rc-badge-green' : 'rc-badge-blue';
    html += '<div class="rc-list-item"><span class="rc-badge ' + badge + '">' + (u.change_type || 'updated') + '</span> ' +
      '<span class="rc-file">' + esc(u.file || '') + '</span> ' +
      '<span class="rc-muted">' + esc(u.summary || '') + '</span></div>';
  });
  html += '</div></div>';
  return html;
}

// ── Retrospective ──
function renderRetroSection(rc) {
  const retro = rc.retrospective;
  if (!retro || (!retro.recommended_changes?.length && !retro.observations?.length)) return '';

  let html = '<div class="rc-section">';
  html += '<div class="rc-section-header"><h3>Retrospective</h3>';
  html += '<span class="rc-meta">' + (retro.patterns_found || 0) + ' patterns found</span></div>';

  if (retro.recommended_changes && retro.recommended_changes.length) {
    html += '<div class="rc-list-header">Recommended Changes <span class="rc-badge rc-badge-amber">high confidence</span></div><div class="rc-list">';
    retro.recommended_changes.forEach(c => {
      html += '<div class="rc-list-item"><span class="rc-dot" style="background:var(--green)"></span>' +
        '<span class="rc-badge rc-badge-purple">' + esc(c.action || '') + '</span> ' +
        esc(c.proposal || '') +
        (c.evidence ? '<div class="rc-evidence">' + esc(c.evidence) + '</div>' : '') +
      '</div>';
    });
    html += '</div>';
  }

  if (retro.observations && retro.observations.length) {
    html += '<details class="rc-details"><summary>Observations Worth Watching (' + retro.observations.length + ')</summary><div class="rc-list">';
    retro.observations.forEach(o => {
      html += '<div class="rc-list-item"><span class="rc-dot" style="background:var(--text-muted)"></span>' + esc(o.pattern || '') + '</div>';
    });
    html += '</div></details>';
  }

  html += '</div>';
  return html;
}

// ── Soul.md Reflection ──
function renderSoulSection(rc) {
  const soul = rc.soul_reflection;
  if (!soul || !soul.updated) return '';

  let html = '<div class="rc-section">';
  html += '<div class="rc-section-header"><h3>Soul.md Reflection</h3>';
  html += '<span class="rc-badge rc-badge-purple">auto-applied</span></div>';

  if (soul.changes && soul.changes.length) {
    html += '<div class="rc-list">';
    soul.changes.forEach(c => {
      html += '<div class="rc-list-item"><span class="rc-dot" style="background:var(--purple)"></span>' +
        '<strong>' + esc(c.section || '') + '</strong>: ' + esc(c.diff_summary || '') + '</div>';
    });
    html += '</div>';
  }

  html += '</div>';
  return html;
}

// ── Sweep Stats ──
function renderSweepStats(sweepStats, mutations) {
  // Try to pull sweep info from mutations if no sweep_stats
  const sweepMutations = mutations.filter(m => m.skill === 'sweep' || m.skill === 'the-sweep');
  if (!sweepStats && !sweepMutations.length) return '';

  let html = '<div class="rc-section">';
  html += '<div class="rc-section-header"><h3>The Sweep</h3></div>';

  if (sweepStats) {
    html += '<div class="rc-kpi-row">' +
      rcKpi(String(sweepStats.sources_checked || 0), 'Sources', '') +
      rcKpi(String(sweepStats.new_items || 0), 'New Items', '') +
      rcKpi(String(sweepStats.auto_created || 0), 'Auto-Created', '') +
    '</div>';
    if (sweepStats.escalations_flagged) {
      html += '<div class="rc-mini-stats"><span class="rc-warn">' + sweepStats.escalations_flagged + ' escalated</span></div>';
    }
  }

  if (sweepMutations.length) {
    html += '<details class="rc-details"><summary>Sweep Log (' + sweepMutations.length + ' runs)</summary><div class="rc-list">';
    sweepMutations.forEach(m => {
      const t = m.timestamp ? new Date(m.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
      html += '<div class="rc-list-item"><span class="rc-muted">' + t + '</span> ' + esc(m.summary || m.action || '') + '</div>';
    });
    html += '</div></details>';
  }

  html += '</div>';
  return html;
}

// ── Schedule Stats ──
function renderScheduleStats(schedule) {
  if (!schedule || !schedule.stats) return '';
  const s = schedule.stats;

  let html = '<div class="rc-section">';
  html += '<div class="rc-section-header"><h3>Plan the Day</h3>';
  if (schedule.adopted_from_preplan) {
    html += '<span class="rc-badge rc-badge-green">adopted from pre-plan</span>';
  }
  html += '</div>';
  html += '<div class="rc-kpi-row">' +
    rcKpi(String(s.total_tasks_scheduled || 0), 'Tasks', (s.total_estimated_hours || 0) + 'h estimated') +
    rcKpi(String(s.total_meetings || 0), 'Meetings', '') +
    rcKpi(String(s.free_time_minutes || 0) + 'm', 'Free Time', '') +
  '</div>';

  // Prep status summary
  const state = window.__PA_STATE__;
  if (state && state.meetings && state.meetings.length) {
    const ready = state.meetings.filter(m => m.prep_status === 'ready').length;
    const pending = state.meetings.filter(m => m.prep_status === 'pending').length;
    const skipped = state.meetings.filter(m => m.prep_status === 'skipped').length;
    if (ready || pending) {
      html += '<div class="rc-mini-stats">' +
        (ready ? '<span class="rc-ok">' + ready + ' prep ready</span>' : '') +
        (pending ? '<span class="rc-warn">' + pending + ' prep pending</span>' : '') +
        (skipped ? '<span class="rc-muted">' + skipped + ' skipped</span>' : '') +
      '</div>';
    }
  }

  html += '</div>';
  return html;
}

// ── Clean and Tidy ──
function renderCleanTidy(ct) {
  let html = '<div class="rc-section">';
  html += '<div class="rc-section-header"><h3>Clean and Tidy</h3>';
  if (ct.last_run) html += '<span class="rc-meta">Last run: ' + new Date(ct.last_run).toLocaleDateString() + '</span>';
  html += '</div>';

  // File audit
  const fa = ct.file_audit || {};
  if (fa.files_scanned) {
    html += '<div class="rc-list-header">File Audit</div>';
    html += '<div class="rc-kpi-row">' +
      rcKpi(String(fa.files_scanned), 'Scanned', '') +
      rcKpi(String(fa.candidates_found || 0), 'Candidates', '') +
      rcKpi(String(fa.copied_to_proposed || 0), 'Proposed', '') +
      rcKpi(String(fa.protected_skipped || 0), 'Protected', '') +
    '</div>';
  }

  // Board audit
  const ba = ct.board_audit || {};
  if (ba.done_archived !== undefined) {
    html += '<div class="rc-list-header">Board Audit</div>';
    html += '<div class="rc-mini-stats">' +
      '<span>' + (ba.done_archived || 0) + ' done archived</span>' +
      '<span>' + (ba.backlog_flagged || 0) + ' backlog flagged</span>' +
    '</div>';
    if (ba.health_warnings && ba.health_warnings.length) {
      html += '<div class="rc-list">';
      ba.health_warnings.forEach(w => {
        html += '<div class="rc-list-item"><span class="rc-dot" style="background:var(--amber)"></span>' + esc(w.type) + ': ' + w.count + '</div>';
      });
      html += '</div>';
    }
  }

  // Instruction review proposals
  const ir = ct.instruction_review || {};
  const allProposals = [
    ...(ir.claude_md_proposals || []).map(p => ({ ...p, source: 'CLAUDE.md' })),
    ...(ir.claude_school_proposals || []).map(p => ({ ...p, source: p.file })),
  ];
  if (allProposals.length) {
    html += '<div class="rc-list-header">Instruction Proposals <span class="rc-badge rc-badge-amber">requires approval</span></div>';
    html += '<div class="rc-list">';
    allProposals.forEach(p => {
      html += '<div class="rc-list-item">' +
        '<span class="rc-badge rc-badge-blue">' + esc(p.change_type || 'update') + '</span> ' +
        '<span class="rc-file">' + esc(p.source || '') + '</span> ' +
        esc(p.summary || '') +
        (p.diff ? '<details class="rc-diff-details"><summary>View diff</summary><pre class="rc-diff">' + esc(p.diff) + '</pre></details>' : '') +
      '</div>';
    });
    html += '</div>';
  }

  // Soul.md proposals (auto-applied)
  if (ir.soul_md_proposals && ir.soul_md_proposals.length) {
    html += '<div class="rc-list-header">Soul.md Changes <span class="rc-badge rc-badge-purple">auto-applied</span></div>';
    html += '<div class="rc-list">';
    ir.soul_md_proposals.forEach(p => {
      html += '<div class="rc-list-item"><span class="rc-dot" style="background:var(--purple)"></span>' + esc(p.summary || '') + '</div>';
    });
    html += '</div>';
  }

  // Pending approvals (file deletions)
  const pending = (ct.pending_approvals || []).filter(a => a.status === 'pending');
  if (pending.length) {
    html += '<div class="rc-list-header">Pending File Deletions <span class="rc-badge rc-badge-red">' + pending.length + ' pending</span></div>';
    html += '<div class="rc-approvals">';
    html += '<div class="rc-approval-controls">' +
      '<label class="rc-check-all"><input type="checkbox" id="rc-select-all" onchange="rcToggleAll(this.checked)"> Select all</label>' +
      '<button class="rc-approve-btn" onclick="rcBatchApprove()">Approve Selected</button>' +
      '<button class="rc-deny-btn" onclick="rcBatchDeny()">Deny Selected</button>' +
    '</div>';
    pending.forEach(item => {
      const sizeMb = item.size_bytes ? (item.size_bytes / 1048576).toFixed(2) + ' MB' : '';
      html += '<div class="rc-approval-item">' +
        '<input type="checkbox" class="rc-approval-check" data-id="' + esc(item.id) + '">' +
        '<div class="rc-approval-body">' +
          '<div class="rc-approval-path">' + esc(item.original_path || '') + '</div>' +
          '<div class="rc-approval-reason">' + esc(item.reason || '') +
            (sizeMb ? ' <span class="rc-muted">(' + sizeMb + ')</span>' : '') +
            (item.last_modified ? ' <span class="rc-muted">Last modified: ' + new Date(item.last_modified).toLocaleDateString() + '</span>' : '') +
          '</div>' +
        '</div>' +
      '</div>';
    });
    html += '</div>';
  }

  // Protected files (collapsible)
  const pf = ct.protected_files || [];
  if (pf.length) {
    html += '<details class="rc-details"><summary>Protected Files (' + pf.length + ')</summary>';
    html += '<div class="rc-protected-list">';
    pf.forEach(f => { html += '<div class="rc-protected-item">' + esc(f) + '</div>'; });
    html += '</div></details>';
  }

  // Workspace health
  const wh = ct.workspace_health || {};
  if (wh.total_files) {
    html += '<div class="rc-list-header">Workspace Health</div>';
    html += '<div class="rc-mini-stats">' +
      '<span>' + wh.total_files + ' files</span>' +
      '<span>' + (wh.total_size_mb || 0).toFixed(1) + ' MB</span>' +
      '<span>Max depth: ' + (wh.max_folder_depth || 0) + '</span>' +
      (wh.empty_folders ? '<span class="rc-warn">' + wh.empty_folders + ' empty folders</span>' : '') +
    '</div>';
  }

  html += '</div>';
  return html;
}

// ── Legacy Assessment (fallback when report_card doesn't exist) ──
function renderLegacyAssessment(assessment) {
  let html = '<div class="rc-section">';
  html += '<div class="rc-section-header"><h3>Assessment</h3><span class="rc-meta">from state.assessment</span></div>';
  html += '<pre class="rc-pre">' + esc(JSON.stringify(assessment, null, 2)) + '</pre>';
  html += '</div>';
  return html;
}

// ── Activity Log ──
function renderActivityLog() {
  const el = document.getElementById('pa-log-content');
  const logHtml = el ? el.innerHTML : '';
  if (!logHtml || logHtml.includes('Loading overnight')) return '';

  return '<div class="rc-section">' +
    '<div class="rc-section-header"><h3>Activity Log</h3></div>' +
    '<div class="rc-activity-log">' + logHtml + '</div>' +
  '</div>';
}

// ── Helpers ──
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function rcKpi(value, label, sub, extraCls) {
  return '<div class="rc-kpi ' + (extraCls || '') + '">' +
    '<div class="rc-kpi-val">' + value + '</div>' +
    '<div class="rc-kpi-label">' + label + '</div>' +
    (sub ? '<div class="rc-kpi-sub">' + sub + '</div>' : '') +
  '</div>';
}

// ── Approval Actions ──
function rcToggleAll(checked) {
  document.querySelectorAll('.rc-approval-check').forEach(cb => { cb.checked = checked; });
}

function rcGetSelected() {
  return Array.from(document.querySelectorAll('.rc-approval-check:checked')).map(cb => cb.dataset.id);
}

async function rcBatchApprove() {
  const ids = rcGetSelected();
  if (!ids.length) return;
  try {
    const res = await fetch('/api/clean-tidy/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, action: 'approve' })
    });
    if (res.ok) buildReportCard();
  } catch (e) { console.error('[RC] Approval failed:', e); }
}

async function rcBatchDeny() {
  const ids = rcGetSelected();
  if (!ids.length) return;
  try {
    const res = await fetch('/api/clean-tidy/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, action: 'deny' })
    });
    if (res.ok) buildReportCard();
  } catch (e) { console.error('[RC] Denial failed:', e); }
}

function wireApprovalButtons() {
  // Buttons are wired via inline onclick attributes -- nothing extra needed
}
