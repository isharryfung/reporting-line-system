(() => {
'use strict';

let bootstrap = null;
let seedData = null;
let selectedNode = null;
let currentDiagramDept = null;
let currentPage = 'dashboard';
let currentRole = 'POC Tester/System Admin';
let diagramData = null;
let loadingCount = 0;
let currentHighlightedRouteNames = [];
let currentDeptUsersForRender = [];
let selectedCaseId = null;
let fixedTeamOrderByDept = {};
let fixedTeamWidthByKey = {};
let fixedDeptStartXByCode = {};
let fixedNodeOffsetByKey = {};
let fixedNodeAbsoluteXByKey = {};

const ADMIN_ROLE = 'POC Tester/System Admin';
const OVERLAY_TYPE_LABELS = {
  acting: 'Acting',
  coverage: 'Coverage',
  delegation: 'Delegation',
  handover: 'Handover',
  peer_coverage: 'Peer Coverage',
};

const byId = (id) => document.getElementById(id);
const qsa = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function isAdminRole() {
  return currentRole === ADMIN_ROLE;
}

function escHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function createOption(value, label, selected = false) {
  const option = document.createElement('option');
  option.value = String(value ?? '');
  option.textContent = label;
  option.selected = !!selected;
  return option;
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString();
}

function apiDate(value) {
  return value ? `${value}T00:00:00+00:00` : null;
}

function showLoading() {
  loadingCount += 1;
  const overlay = byId('loading-overlay');
  if (overlay) overlay.style.display = 'flex';
}

function hideLoading() {
  loadingCount = Math.max(0, loadingCount - 1);
  const overlay = byId('loading-overlay');
  if (overlay && loadingCount === 0) overlay.style.display = 'none';
}

function showToast(message, type = 'success') {
  const container = byId('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

async function api(url, options = {}) {
  const settings = { method: 'GET', ...options };
  const headers = { ...(settings.headers || {}) };
  if (settings.body && typeof settings.body !== 'string') {
    headers['Content-Type'] = 'application/json';
    settings.body = JSON.stringify(settings.body);
  }
  settings.headers = headers;
  if (!options.silent) showLoading();
  try {
    const response = await fetch(url, settings);
    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch (_error) {
      payload = { raw: text };
    }
    if (!response.ok) {
      throw new Error(payload.error || payload.message || `Request failed (${response.status})`);
    }
    return payload;
  } finally {
    if (!options.silent) hideLoading();
  }
}

function setSelectOptions(select, options, preferredValue = undefined) {
  if (!select) return;
  const currentValue = preferredValue !== undefined ? String(preferredValue) : String(select.value || '');
  select.replaceChildren(...options);
  if (options.some((option) => option.value === currentValue)) {
    select.value = currentValue;
  }
}

function allUsers() {
  return bootstrap?.users || [];
}

function allDepartments() {
  return bootstrap?.departments || [];
}

function allActions() {
  return bootstrap?.actions || [];
}

function departmentById(id) {
  return allDepartments().find((dept) => String(dept.id) === String(id)) || null;
}

function departmentCodeFromId(id) {
  return departmentById(id)?.code || '';
}

function levelById(id) {
  return seedData?.dept_levels?.find((level) => String(level.id) === String(id)) || null;
}

function isUserTopLevel(user) {
  return !!levelById(user?.dept_level_id)?.is_top_level;
}

function normalizeUsersForDiagram(users, orgUnits = []) {
  const orgUnitNameById = new Map((orgUnits || []).map((unit) => [String(unit.id), unit.name]));
  return (users || []).map((user) => ({
    ...user,
    org_unit:
      user.org_unit ||
      user.org_units?.[0] ||
      (user.org_unit_ids?.length ? orgUnitNameById.get(String(user.org_unit_ids[0])) || null : null),
    is_top_level: typeof user.is_top_level === 'boolean' ? user.is_top_level : isUserTopLevel(user),
    department_code: user.department_code || departmentCodeFromId(user.department_id),
  }));
}

function userLabel(user) {
  return `${user.name} — ${user.department_code} / ${user.level_name}`;
}

function userOptions(includeBlank = false, blankLabel = '— Select —') {
  const options = [];
  if (includeBlank) options.push(createOption('', blankLabel));
  allUsers().forEach((user) => options.push(createOption(user.id, userLabel(user))));
  return options;
}

function roleNoticeText() {
  return isAdminRole()
    ? ''
    : `Viewing as ${currentRole}. This page is read-only for non-admin roles.`;
}

function openModal(id) {
  const modal = byId(id);
  if (modal) modal.style.display = 'flex';
}

function closeModal(id) {
  const modal = byId(id);
  if (modal) modal.style.display = 'none';
}

function requireAdmin(actionLabel = 'perform this action') {
  if (isAdminRole()) return true;
  showToast(`You must be in ${ADMIN_ROLE} view to ${actionLabel}.`, 'error');
  return false;
}

function setPageActive(pageName) {
  currentPage = pageName;
  qsa('.nav-tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.page === pageName);
  });
  qsa('.page').forEach((page) => {
    const active = page.id === `page-${pageName}`;
    page.classList.toggle('active', active);
    page.style.display = active ? '' : 'none';
  });
}

async function showPage(pageName) {
  setPageActive(pageName);
  await loadPageData(pageName);
}

function setSeedTabActive(tabName) {
  qsa('.seed-tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === tabName);
  });
  qsa('.seed-tab-content').forEach((panel) => {
    const active = panel.id === `seed-${tabName}`;
    panel.classList.toggle('active', active);
    panel.style.display = active ? '' : 'none';
  });
}

function setSidebarTabActive(tabName) {
  qsa('.sidebar-tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === tabName);
  });
  qsa('.sidebar-tab-content').forEach((panel) => {
    const active = panel.id === `tab-${tabName}`;
    panel.classList.toggle('active', active);
    panel.style.display = active ? '' : 'none';
  });
}

function bindNavigation() {
  qsa('.nav-tab').forEach((button) => {
    button.addEventListener('click', () => showPage(button.dataset.page));
  });
  qsa('.seed-tab').forEach((button) => {
    button.addEventListener('click', () => setSeedTabActive(button.dataset.tab));
  });
  qsa('.sidebar-tab').forEach((button) => {
    button.addEventListener('click', () => setSidebarTabActive(button.dataset.tab));
  });
}

function bindGlobalUi() {
  const roleSelect = byId('role-select');
  if (roleSelect) {
    roleSelect.addEventListener('change', () => {
      currentRole = roleSelect.value;
      updateRoleUi();
    });
  }

  const overlayToggle = byId('test-enable-overlays');
  if (overlayToggle) {
    overlayToggle.addEventListener('change', () => {
      byId('overlay-form-section').style.display = overlayToggle.checked ? 'block' : 'none';
    });
  }

  const userDeptSelect = byId('user-dept');
  if (userDeptSelect) userDeptSelect.addEventListener('change', syncUserModalDeptFields);

  window.addEventListener('click', (event) => {
    if (event.target.classList?.contains('modal')) closeModal(event.target.id);
  });
}

function updateRoleUi() {
  const readOnly = !isAdminRole();
  const actionNotice = byId('action-role-notice');
  const templateNotice = byId('template-role-notice');
  if (actionNotice) {
    actionNotice.textContent = roleNoticeText();
    actionNotice.style.display = readOnly ? 'block' : 'none';
  }
  if (templateNotice) {
    templateNotice.textContent = roleNoticeText();
    templateNotice.style.display = readOnly ? 'block' : 'none';
  }

  const adminOnlyButtons = [
    byId('add-action-btn'),
    byId('add-template-btn'),
    byId('add-user-btn'),
    byId('sidebar-save-btn'),
    byId('page-overlay-management')?.querySelector('.page-header .btn'),
    byId('page-seed-data')?.querySelector('.page-actions .btn-danger'),
  ].filter(Boolean);
  adminOnlyButtons.forEach((button) => {
    button.disabled = readOnly;
    button.classList.toggle('disabled', readOnly);
  });

  qsa('#page-seed-data input, #page-seed-data select, #page-seed-data textarea, #page-seed-data button').forEach((element) => {
    if (element.textContent?.includes('Export JSON')) return;
    if (element.classList?.contains('seed-tab')) return;
    element.disabled = readOnly;
  });
}

async function reloadCoreData() {
  const [bootstrapPayload, seedPayload] = await Promise.all([
    api('/api/bootstrap'),
    api('/api/seed-data'),
  ]);
  bootstrap = bootstrapPayload;
  seedData = seedPayload;
  populateGlobalControls();
}

function populateGlobalControls() {
  const deptSelect = byId('dept-select');
  const deptOptions = [createOption('', 'Select Department...')].concat(
    allDepartments().map((dept) => createOption(dept.id, `${dept.name} (${dept.code})`))
  );
  setSelectOptions(deptSelect, deptOptions, currentDiagramDept || deptSelect?.value || '');
  if (!deptSelect?.value && allDepartments()[0]) {
    deptSelect.value = String(allDepartments()[0].id);
    currentDiagramDept = deptSelect.value;
  }

  const userSelectIds = ['overlay-from-user', 'overlay-to-user', 'user-manager', 'test-requester', 'scenario-requester'];
  userSelectIds.forEach((id) => setSelectOptions(byId(id), userOptions(id === 'user-manager'), byId(id)?.value || ''));

  setSelectOptions(
    byId('overlay-dept'),
    allDepartments().map((dept) => createOption(dept.id, `${dept.name} (${dept.code})`)),
    byId('overlay-dept')?.value || ''
  );
  setSelectOptions(
    byId('user-dept'),
    allDepartments().map((dept) => createOption(dept.id, `${dept.name} (${dept.code})`)),
    byId('user-dept')?.value || allDepartments()[0]?.id || ''
  );

  const actionSelects = [
    { id: 'action-highlight-select', blank: 'Highlight Action Route...' },
    { id: 'test-action', blank: 'None (just reporting line)' },
    { id: 'scenario-action', blank: 'Select action...' },
  ];
  actionSelects.forEach(({ id, blank }) => {
    const options = [createOption('', blank)].concat(
      allActions().map((action) => createOption(action.code, `${action.name} (${action.code})`))
    );
    setSelectOptions(byId(id), options, byId(id)?.value || '');
  });

  syncUserModalDeptFields();
}

function syncUserModalDeptFields() {
  const deptId = byId('user-dept')?.value;
  const levelSelect = byId('user-level');
  const orgUnitSelect = byId('user-org-unit');
  if (!deptId || !seedData) return;

  const levels = seedData.dept_levels.filter((level) => String(level.dept_id) === String(deptId));
  setSelectOptions(
    levelSelect,
    levels.map((level) => createOption(level.id, `${level.level_name} (L${level.level_rank})`)),
    levelSelect?.value || levels[0]?.id || ''
  );

  const units = seedData.org_units.filter((unit) => String(unit.dept_id) === String(deptId));
  setSelectOptions(
    orgUnitSelect,
    [createOption('', '— None —')].concat(units.map((unit) => createOption(unit.id, unit.name))),
    orgUnitSelect?.value || ''
  );
}

async function loadPageData(pageName) {
  switch (pageName) {
    case 'dashboard':
      await loadDashboardStats();
      break;
    case 'action-management':
      await loadActions();
      break;
    case 'approval-templates':
      await loadTemplates();
      break;
    case 'dept-diagram':
      await loadDepartmentDiagram();
      break;
    case 'overlay-management':
      await loadOverlays();
      break;
    case 'audit-log':
      await loadAuditLogs();
      break;
    case 'validation':
      await loadValidationIssues();
      break;
    case 'itso-cases':
      initItsoCases();
      break;
    case 'test-diagram':
      initTestDiagramPage();
      break;
    case 'scenario-builder':
      initScenarioBuilderPage();
      break;
    case 'seed-data':
      await loadSeedData();
      break;
    default:
      break;
  }
}

async function refreshAfterMutation(successMessage) {
  await reloadCoreData();
  await loadDashboardStats();
  await loadPageData(currentPage);
  if (successMessage) showToast(successMessage, 'success');
}

async function loadDashboardStats() {
  const stats = await api('/api/dashboard-stats');
  byId('stat-departments').textContent = stats.departments ?? '0';
  byId('stat-employees').textContent = stats.employees ?? '0';
  byId('stat-active').textContent = stats.active_employees ?? '0';
  byId('stat-inactive').textContent = stats.inactive_employees ?? '0';
  byId('stat-overlays').textContent = stats.active_overlays ?? '0';
  byId('stat-actions').textContent = stats.actions ?? '0';
  byId('validation-count').textContent = stats.validation_issues ?? '0';
  byId('validation-badge').style.display = stats.validation_issues ? 'inline-flex' : 'none';
  byId('stat-timestamp').textContent = new Date().toLocaleString();

  const breakdown = byId('overlay-breakdown');
  breakdown.innerHTML = Object.entries(stats.overlay_breakdown || {})
    .map(([key, value]) => `<span class="badge badge-secondary">${escHtml(OVERLAY_TYPE_LABELS[key] || key)}: ${value}</span>`)
    .join(' ');

  const timeline = byId('recent-changes-timeline');
  timeline.innerHTML = (stats.recent_changes || []).length
    ? stats.recent_changes
        .map((change) => `
          <div class="timeline-item">
            <div class="timeline-date">${escHtml(formatDateTime(change.timestamp))}</div>
            <div class="timeline-content">
              <strong>${escHtml(change.actor)}</strong>
              ${escHtml(change.action)}
              <span class="text-muted">${escHtml(change.entity_type)}: ${escHtml(change.entity_name)}</span>
            </div>
          </div>
        `)
        .join('')
    : '<p class="text-muted">No recent changes.</p>';
}

async function loadActions() {
  const payload = await api('/api/actions');
  actionList = payload.actions || [];
  const tbody = byId('actions-table').querySelector('tbody');
  tbody.innerHTML = actionList
    .map((action) => `
      <tr>
        <td>${action.id}</td>
        <td>${escHtml(action.name)}</td>
        <td>${escHtml(action.code)}</td>
        <td>${action.is_project_scoped ? 'Yes' : 'No'}</td>
        <td>${(action.routing_rules || []).map((rule) => `${escHtml(rule.dept_name || '—')}: ${rule.requires_primary ? 'P1' : ''}${rule.requires_second_level ? ' / P2' : ''}` || '—').join('<br>') || '—'}</td>
        <td>
          ${isAdminRole() ? `
            <button class="btn btn-secondary btn-sm edit-action" data-id="${action.id}">Edit</button>
            <button class="btn btn-danger btn-sm delete-action" data-id="${action.id}">Delete</button>
          ` : '—'}
        </td>
      </tr>
    `)
    .join('');

  qsa('.edit-action', tbody).forEach((button) => {
    button.addEventListener('click', () => editAction(Number(button.dataset.id)));
  });
  qsa('.delete-action', tbody).forEach((button) => {
    button.addEventListener('click', () => deleteAction(Number(button.dataset.id)));
  });
  updateRoleUi();
}

let actionList = [];

function showAddActionModal() {
  if (!requireAdmin('add actions')) return;
  byId('action-modal-title').textContent = 'Add Action';
  byId('action-id').value = '';
  byId('action-name').value = '';
  byId('action-code').value = '';
  byId('action-project-scoped').checked = false;
  openModal('action-modal');
}

function editAction(id) {
  if (!requireAdmin('edit actions')) return;
  const action = actionList.find((item) => item.id === id);
  if (!action) return;
  byId('action-modal-title').textContent = 'Edit Action';
  byId('action-id').value = action.id;
  byId('action-name').value = action.name;
  byId('action-code').value = action.code;
  byId('action-project-scoped').checked = !!action.is_project_scoped;
  openModal('action-modal');
}

async function saveAction() {
  if (!requireAdmin('save actions')) return;
  const id = byId('action-id').value;
  const body = {
    name: byId('action-name').value.trim(),
    code: byId('action-code').value.trim(),
    is_project_scoped: byId('action-project-scoped').checked,
  };
  if (!body.name || !body.code) {
    showToast('Action name and code are required.', 'error');
    return;
  }
  try {
    await api(id ? `/api/actions/${id}` : '/api/actions', {
      method: id ? 'PUT' : 'POST',
      body,
    });
    closeModal('action-modal');
    await refreshAfterMutation(`Action ${id ? 'updated' : 'created'}.`);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function deleteAction(id) {
  if (!requireAdmin('delete actions')) return;
  if (!window.confirm('Delete this action?')) return;
  try {
    await api(`/api/actions/${id}`, { method: 'DELETE' });
    await refreshAfterMutation('Action deleted.');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

let templateList = [];

async function loadTemplates() {
  const payload = await api('/api/approval-templates');
  templateList = payload.templates || [];
  const grid = byId('templates-grid');
  grid.innerHTML = templateList.length
    ? templateList
        .map((template) => `
          <div class="card template-card">
            <h3>${escHtml(template.name)}</h3>
            <div class="text-muted">${escHtml(template.code)}</div>
            <p>${escHtml(template.description || 'No description')}</p>
            <div class="template-meta">
              <span class="badge badge-secondary">Levels: ${template.num_levels}</span>
              <span class="badge badge-secondary">${escHtml(template.routing_type)}</span>
              <span class="badge ${template.is_active ? 'badge-success' : 'badge-secondary'}">${template.is_active ? 'Active' : 'Inactive'}</span>
            </div>
            <div class="template-meta">
              <span>Overlay: ${template.allow_overlay ? 'Allowed' : 'Disabled'}</span><br>
              <span>Self approval: ${escHtml(template.self_approval_handling)}</span>
            </div>
            ${isAdminRole() ? `
              <div class="card-actions">
                <button class="btn btn-secondary btn-sm edit-template" data-id="${template.id}">Edit</button>
                <button class="btn btn-danger btn-sm delete-template" data-id="${template.id}">Delete</button>
              </div>
            ` : ''}
          </div>
        `)
        .join('')
    : '<div class="card"><p class="text-muted">No templates found.</p></div>';

  qsa('.edit-template', grid).forEach((button) => {
    button.addEventListener('click', () => editTemplate(Number(button.dataset.id)));
  });
  qsa('.delete-template', grid).forEach((button) => {
    button.addEventListener('click', () => deleteTemplate(Number(button.dataset.id)));
  });
  updateRoleUi();
}

function showAddTemplateModal() {
  if (!requireAdmin('add templates')) return;
  byId('template-modal-title').textContent = 'Add Template';
  byId('template-id').value = '';
  byId('template-name').value = '';
  byId('template-code').value = '';
  byId('template-description').value = '';
  byId('template-levels').value = '2';
  byId('template-routing-type').value = 'sequential';
  byId('template-allow-overlay').checked = true;
  byId('template-self-approval').value = 'skip';
  byId('template-active').checked = true;
  openModal('template-modal');
}

function editTemplate(id) {
  if (!requireAdmin('edit templates')) return;
  const template = templateList.find((item) => item.id === id);
  if (!template) return;
  byId('template-modal-title').textContent = 'Edit Template';
  byId('template-id').value = template.id;
  byId('template-name').value = template.name;
  byId('template-code').value = template.code;
  byId('template-description').value = template.description || '';
  byId('template-levels').value = template.num_levels;
  byId('template-routing-type').value = template.routing_type || 'sequential';
  byId('template-allow-overlay').checked = !!template.allow_overlay;
  byId('template-self-approval').value = template.self_approval_handling || 'skip';
  byId('template-active').checked = !!template.is_active;
  openModal('template-modal');
}

async function saveTemplate() {
  if (!requireAdmin('save templates')) return;
  const id = byId('template-id').value;
  const body = {
    name: byId('template-name').value.trim(),
    code: byId('template-code').value.trim(),
    description: byId('template-description').value.trim(),
    num_levels: Number(byId('template-levels').value || 1),
    routing_type: byId('template-routing-type').value,
    allow_overlay: byId('template-allow-overlay').checked,
    self_approval_handling: byId('template-self-approval').value,
    is_active: byId('template-active').checked,
  };
  if (!body.name || !body.code) {
    showToast('Template name and code are required.', 'error');
    return;
  }
  try {
    await api(id ? `/api/approval-templates/${id}` : '/api/approval-templates', {
      method: id ? 'PUT' : 'POST',
      body,
    });
    closeModal('template-modal');
    await refreshAfterMutation(`Template ${id ? 'updated' : 'created'}.`);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function deleteTemplate(id) {
  if (!requireAdmin('delete templates')) return;
  if (!window.confirm('Delete this template?')) return;
  try {
    await api(`/api/approval-templates/${id}`, { method: 'DELETE' });
    await refreshAfterMutation('Template deleted.');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

const NODE_W = 172;
const NODE_H = 48;
const LEVEL_H = 124;   // vertical gap between level rows (extra clearance for dense lower tiers)
const LEFT_PAD = 60;
const TOP_PAD = 40;
const LEVEL_LABEL_X = 8;
const LEFT_VIEW_EXTRA = 48;

// Layer model: each level rank belongs to one of four reporting-line layers.
// Layer 1 = ranks 1–3 (Provost/VP/School), Layer 2 = rank 4 (Dept Head),
// Layer 3 = ranks 5–7 (Senior Manager/Manager/Systems Analyst), Layer 4 =
// ranks 8–9 (Analyst Programmer/Programmer). Used to color rows by layer band.
function layerForRank(rank) {
  if (rank <= 3) return 1;
  if (rank === 4) return 2;
  if (rank <= 7) return 3;
  return 4;
}

// Snap an elbow turn to the center of a level-gap lane (the empty vertical
// space between two level rows). This keeps horizontal segments away from node
// boxes even when a link spans multiple levels.
function layerGapElbowY(upperBottomY, lowerTopY) {
  const minY = Math.min(upperBottomY, lowerTopY);
  const maxY = Math.max(upperBottomY, lowerTopY);
  const midY = minY + (maxY - minY) / 2;

  const rowGap = Math.max(LEVEL_H - NODE_H, 0);
  if (rowGap <= 0) return midY;

  const baseGapCenter = TOP_PAD + NODE_H + rowGap / 2;
  const kMin = Math.ceil((minY - baseGapCenter) / LEVEL_H);
  const kMax = Math.floor((maxY - baseGapCenter) / LEVEL_H);
  if (kMin > kMax) return midY;

  const nearestK = Math.round((midY - baseGapCenter) / LEVEL_H);
  const clampedK = Math.max(kMin, Math.min(kMax, nearestK));
  return baseGapCenter + clampedK * LEVEL_H;
}

// Distinct colors for reporting lines, assigned per individual person so that
// each subordinate's line up to their manager is visually distinct — even when
// several people at the same rank report into the same higher rank. For
// example, for L8 → L9 both Belle(L8) and Biance(L8) report into L9, but
// Belle's line and Biance's line each get their own color. Palette is chosen
// for good contrast; it wraps around if there are more people than colors.
const EDGE_COLORS = [
  "#4a7fcb", // blue
  "#d62728", // red
  "#2ca02c", // green
  "#e8743b", // orange
  "#9467bd", // purple
  "#17a2b8", // teal
  "#bc5090", // magenta
  "#8c6d31", // brown
];

// Return a stable color for the given zero-based assignment index, wrapping
// around the palette when there are more people than available colors.
function edgeColorForIndex(index) {
  const len = EDGE_COLORS.length;
  const idx = ((Number(index) % len) + len) % len;
  return EDGE_COLORS[idx];
}

// Build a DOM-safe arrow-marker id for a given color (e.g. "#4a7fcb" -> "arrow-4a7fcb").
function rankArrowId(color) {
  return "arrow-" + color.replace(/[^a-z0-9]/gi, "");
}

function fixedNodeKey(user) {
  const dept = user && user.department_code ? String(user.department_code) : "-";
  const name = user && user.name ? String(user.name) : "";
  return `${dept}::${name}`;
}

function collectChartUsers(chart, users) {
  chart.org_units.forEach((ou) => {
    ou.members.forEach((m) => {
      if (!users.find((u) => u.id === m.id)) users.push({ ...m, org_unit: ou.name });
    });
  });
  chart.unassigned_users.forEach((u) => {
    if (!users.find((ex) => ex.id === u.id)) users.push({ ...u, org_unit: null });
  });
}

function renderDiagram(departmentCode) {
  if (!bootstrap) return;

  const svg = document.getElementById("dept-diagram-svg");
  svg.innerHTML = "";  // clear

  // Collect users from a single department chart or all of them.
  const users = [];
  if (departmentCode === "ALL") {
    Object.values(bootstrap.org_charts).forEach((chart) => collectChartUsers(chart, users));
  } else {
    const chart = bootstrap.org_charts[departmentCode];
    if (!chart) return;
    collectChartUsers(chart, users);
  }

  drawDiagram(svg, users, {
    deptTag: departmentCode === "ALL",
    selectedId: selectedNode ? selectedNode.id : null,
    onNodeClick: openEditPanel,
  });
}

// Layout + render a set of users into an SVG element. Shared by the persistent
// Diagram Editor and the temporary Test Case Diagram. Edges are drawn from each
// user's `manager_name`, so callers can render any working set of users.
function drawDiagram(svg, users, options) {
  options = options || {};
  const deptTag = !!options.deptTag;
  const teamSections = !!options.teamSections;
  const fixedDeptColumns = !!options.fixedDeptColumns;
  const fixedAbsoluteNodeX =
    options.fixedAbsoluteNodeX != null ? !!options.fixedAbsoluteNodeX : teamSections;
  const fixedTeamSections =
    options.fixedTeamSections != null ? !!options.fixedTeamSections : teamSections;
  const preferredDeptOrder = Array.isArray(options.deptOrder) ? options.deptOrder : null;
  const selectedId = options.selectedId != null ? options.selectedId : null;
  const onNodeClick = options.onNodeClick || function () {};
  svg.__diagramOnNodeClick = onNodeClick;
  const renderedUsers = users.filter((u) => !u._externalOnly);
  const layoutUsers = users.filter((u) => !u._itsoCase7Loan);
  svg.innerHTML = "";  // clear

  if (!users.length) {
    svg.setAttribute("viewBox", "0 0 600 120");
    svg.style.width = "600px";
    svg.style.height = "120px";
    return;
  }

  // Group by level_rank
  const levelMap = {};
  layoutUsers.forEach((u) => {
    if (!levelMap[u.level_rank]) levelMap[u.level_rank] = [];
    levelMap[u.level_rank].push(u);
  });
  const sortedLevels = Object.keys(levelMap).map(Number).sort((a, b) => a - b);

  // Determine a consistent department order so each department forms a
  // vertical column-group that stays aligned across every level row.
  const DEPT_KEY = (u) => u.department_code || "—";
  const deptCodes = [];
  layoutUsers.forEach((u) => {
    const code = DEPT_KEY(u);
    if (!deptCodes.includes(code)) deptCodes.push(code);
  });
  deptCodes.sort();
  if (preferredDeptOrder && preferredDeptOrder.length) {
    const rank = new Map(preferredDeptOrder.map((code, idx) => [code, idx]));
    deptCodes.sort((a, b) => {
      const ar = rank.has(a) ? rank.get(a) : Number.MAX_SAFE_INTEGER;
      const br = rank.has(b) ? rank.get(b) : Number.MAX_SAFE_INTEGER;
      if (ar !== br) return ar - br;
      return String(a).localeCompare(String(b));
    });
  }
  // Place the corporate tier (EXEC) in the centre of the department columns
  // rather than at the far left so the chart reads outward from the top tier.
  const execIdx = deptCodes.indexOf("EXEC");
  if (execIdx !== -1 && deptCodes.length > 1) {
    deptCodes.splice(execIdx, 1);
    deptCodes.splice(Math.floor(deptCodes.length / 2), 0, "EXEC");
  }
  const groupByDept = deptCodes.length > 1;
  const groupByTeam = teamSections;

  const COL_GAP = 20;    // gap between nodes within a department block
  const DEPT_GAP = 60;   // extra gap separating department blocks
  const TEAM_GAP = 42;   // extra gap separating teams inside a department
  const TEAM_GAP_ITSO = 72; // extra breathing room between ITSO team lanes
  const SIBLING_INNER_GAP = 40;   // spread same-manager siblings for clearer lower-tier structure
  const MANAGER_CLUSTER_GAP = 56; // keep manager clusters visually distinct
  const teamGapForDept = (code) => (code === "ITSO" ? TEAM_GAP_ITSO : TEAM_GAP);

  const estimateGroupWidth = (members) => {
    if (!members || !members.length) return NODE_W;
    const ordered = [...members].sort((a, b) => {
      if ((a.manager_name || "") !== (b.manager_name || "")) {
        return (a.manager_name || "").localeCompare(b.manager_name || "");
      }
      return a.name.localeCompare(b.name);
    });
    let width = NODE_W;
    for (let i = 1; i < ordered.length; i++) {
      const sameManager =
        !!ordered[i - 1].manager_name && ordered[i - 1].manager_name === ordered[i].manager_name;
      width += COL_GAP + NODE_W + (sameManager ? SIBLING_INNER_GAP : MANAGER_CLUSTER_GAP);
    }
    return width;
  };

  const RAW_TEAM_KEY = (u) => (u.org_unit && String(u.org_unit).trim()) || "Dept Leadership";
  const teamByDept = {};
  if (groupByTeam) {
    deptCodes.forEach((code) => {
      const teams = [];
      layoutUsers
        .filter((u) => DEPT_KEY(u) === code)
        .forEach((u) => {
          const t = RAW_TEAM_KEY(u);
          if (!teams.includes(t)) teams.push(t);
        });
      const nonLeadership = teams
        .filter((t) => t !== "Dept Leadership")
        .sort((a, b) => a.localeCompare(b));
      // Do not create a separate "Dept Leadership" team column. Leadership
      // users are mapped into the nearest existing team lane for layout.
      const computedTeams = nonLeadership.length ? nonLeadership : ["Dept Leadership"];
      if (fixedTeamSections) {
        const baseline = fixedTeamOrderByDept[code] || [];
        const merged = baseline.length ? [...baseline] : [];
        computedTeams.forEach((t) => {
          if (!merged.includes(t)) merged.push(t);
        });
        teamByDept[code] = merged.length ? merged : ["Dept Leadership"];
        fixedTeamOrderByDept[code] = [...teamByDept[code]];
      } else {
        teamByDept[code] = computedTeams;
      }
    });
  }
  const TEAM_KEY = (u) => {
    const raw = RAW_TEAM_KEY(u);
    if (raw !== "Dept Leadership") return raw;
    const lanes = teamByDept[DEPT_KEY(u)] || [];
    if (!lanes.length) return "Dept Leadership";
    const realTeams = lanes.filter((t) => t !== "Dept Leadership");
    if (!realTeams.length) return lanes[0];
    return realTeams[Math.floor(realTeams.length / 2)];
  };

  // Width of each department/team block = max structural row width needed on
  // any level after manager-cluster spacing is applied.
  const deptMaxWidth = {};
  deptCodes.forEach((code) => (deptMaxWidth[code] = NODE_W));
  const teamMaxWidth = {};
  if (groupByTeam) {
    deptCodes.forEach((code) => {
      (teamByDept[code] || []).forEach((team) => {
        teamMaxWidth[`${code}::${team}`] = NODE_W;
      });
    });
  }
  sortedLevels.forEach((rank) => {
    const byDeptUsers = {};
    const byTeamUsers = {};
    levelMap[rank].forEach((u) => {
      const code = DEPT_KEY(u);
      (byDeptUsers[code] = byDeptUsers[code] || []).push(u);
      if (groupByTeam) {
        const tk = `${code}::${TEAM_KEY(u)}`;
        (byTeamUsers[tk] = byTeamUsers[tk] || []).push(u);
      }
    });
    deptCodes.forEach((code) => {
      deptMaxWidth[code] = Math.max(deptMaxWidth[code], estimateGroupWidth(byDeptUsers[code] || []));
      if (groupByTeam) {
        (teamByDept[code] || []).forEach((team) => {
          const tk = `${code}::${team}`;
          teamMaxWidth[tk] = Math.max(teamMaxWidth[tk] || NODE_W, estimateGroupWidth(byTeamUsers[tk] || []));
        });
      }
    });
  });

  // Horizontal start offset + block width for each department.
  const deptStartX = {};
  const deptBlockW = {};
  const teamStartX = {};
  const teamBlockW = {};
  let cursor = LEFT_PAD;
  deptCodes.forEach((code) => {
    let startX = cursor;
    if (fixedDeptColumns && Object.prototype.hasOwnProperty.call(fixedDeptStartXByCode, code)) {
      // Reuse prior column starts only when they do not overlap the current
      // layout cursor; otherwise push right to preserve department separation.
      startX = Math.max(cursor, fixedDeptStartXByCode[code]);
    }
    let blockW;
    if (groupByTeam) {
      const teams = teamByDept[code] || ["Dept Leadership"];
      const teamGap = teamGapForDept(code);
      let teamCursor = startX;
      teams.forEach((team, idx) => {
        const key = `${code}::${team}`;
        let w = Math.max(teamMaxWidth[key] || NODE_W, NODE_W);
        if (fixedTeamSections && Object.prototype.hasOwnProperty.call(fixedTeamWidthByKey, key)) {
          w = Math.max(w, fixedTeamWidthByKey[key]);
        }
        if (fixedTeamSections) fixedTeamWidthByKey[key] = w;
        teamStartX[key] = teamCursor;
        teamBlockW[key] = w;
        teamCursor += w;
        if (idx < teams.length - 1) teamCursor += teamGap;
      });
      blockW = teamCursor - startX;
    } else {
      blockW = Math.max(deptMaxWidth[code] || NODE_W, NODE_W);
    }
    deptStartX[code] = startX;
    deptBlockW[code] = blockW;
    if (fixedDeptColumns) {
      fixedDeptStartXByCode[code] = startX;
    }
    cursor = Math.max(cursor, startX + blockW + DEPT_GAP);
  });

  // Assign positions: within each level row, place each department's users
  // inside that department's block, centered horizontally within the block.
  const posMap = {};  // user.id → {x, y}
  const managerCenterX = (u) => {
    if (!u || !u.manager_name) return null;
    const mgr = layoutUsers.find((m) => m.name === u.manager_name);
    if (!mgr || !posMap[mgr.id]) return null;
    return posMap[mgr.id].x + NODE_W / 2;
  };
  const orderedByReportingLine = (group) => {
    return [...group].sort((a, b) => {
      const ax = managerCenterX(a);
      const bx = managerCenterX(b);
      if (ax != null && bx != null && Math.abs(ax - bx) > 0.5) return ax - bx;
      if (ax != null && bx == null) return -1;
      if (ax == null && bx != null) return 1;
      if ((a.manager_name || "") !== (b.manager_name || "")) {
        return (a.manager_name || "").localeCompare(b.manager_name || "");
      }
      return a.name.localeCompare(b.name);
    });
  };
  const layoutGroupX = (group) => {
    if (!group.length) return { xList: [], totalW: 0 };
    const MIN_MANAGER_CENTER_CLEARANCE = 34;

    const clusters = [];
    group.forEach((u) => {
      const key = u.manager_name ? `mgr:${u.manager_name}` : `solo:${u.id}`;
      const last = clusters[clusters.length - 1];
      if (last && last.key === key) {
        last.members.push(u);
      } else {
        clusters.push({ key, managerName: u.manager_name || null, members: [u] });
      }
    });

    const xById = {};
    let cursorX = 0;
    let minX = Infinity;
    let maxX = -Infinity;

    clusters.forEach((cluster) => {
      const n = cluster.members.length;
      const clusterW = n * NODE_W + (n - 1) * (COL_GAP + SIBLING_INNER_GAP);
      let startX = cursorX;
      const anchor = managerCenterX(cluster.members[0]);
      if (anchor != null) {
        // Prefer centering under the manager; only push right when needed to
        // preserve ordering and avoid overlapping the previous cluster lane.
        const anchoredStart = anchor - clusterW / 2;
        startX = Math.max(startX, anchoredStart);
      }

      if (anchor != null && n > 1) {
        // Keep same-manager children off the manager's exact centerline so the
        // child->manager links do not visually run through the manager node.
        let minDist = Infinity;
        for (let i = 0; i < n; i++) {
          const childCenter = startX + i * (NODE_W + COL_GAP + SIBLING_INNER_GAP) + NODE_W / 2;
          minDist = Math.min(minDist, Math.abs(childCenter - anchor));
        }
        if (minDist < MIN_MANAGER_CENTER_CLEARANCE) {
          startX += MIN_MANAGER_CENTER_CLEARANCE - minDist;
        }
      }

      cluster.members.forEach((u, idx) => {
        const x = startX + idx * (NODE_W + COL_GAP + SIBLING_INNER_GAP);
        xById[u.id] = x;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
      });

      cursorX = startX + clusterW + MANAGER_CLUSTER_GAP;
    });

    const shift = Number.isFinite(minX) ? minX : 0;
    const xList = group.map((u) => (xById[u.id] || 0) - shift);
    const totalW = Number.isFinite(maxX) ? maxX - shift + NODE_W : 0;
    return { xList, totalW };
  };

  sortedLevels.forEach((rank, rowIdx) => {
    const y = TOP_PAD + rowIdx * LEVEL_H;
    const byDept = {};
    const byTeam = {};
    levelMap[rank].forEach((u) => {
      const code = DEPT_KEY(u);
      (byDept[code] = byDept[code] || []).push(u);
      if (groupByTeam) {
        const tk = `${code}::${TEAM_KEY(u)}`;
        (byTeam[tk] = byTeam[tk] || []).push(u);
      }
    });
    deptCodes.forEach((code) => {
      if (groupByTeam) {
        const teams = teamByDept[code] || ["Dept Leadership"];
        teams.forEach((team) => {
          const key = `${code}::${team}`;
          const group = orderedByReportingLine(byTeam[key] || []);
          const laidOut = layoutGroupX(group);
          const offset = Math.max(0, (teamBlockW[key] - Math.max(laidOut.totalW, 0)) / 2);
          group.forEach((u, i) => {
            posMap[u.id] = {
              x: teamStartX[key] + offset + laidOut.xList[i],
              y,
            };
          });
        });
      } else {
        const group = orderedByReportingLine(byDept[code] || []);
        const laidOut = layoutGroupX(group);
        const offset = Math.max(0, (deptBlockW[code] - laidOut.totalW) / 2);
        group.forEach((u, i) => {
          posMap[u.id] = {
            x: deptStartX[code] + offset + laidOut.xList[i],
            y,
          };
        });
      }
    });
  });

  // Stabilize x-lanes with department-relative offsets so node structure stays
  // fixed inside each department while department blocks can move globally.
  layoutUsers.forEach((u) => {
    if (!posMap[u.id]) return;
    const key = fixedNodeKey(u);
    const deptCode = DEPT_KEY(u);
    if (
      Object.prototype.hasOwnProperty.call(fixedNodeOffsetByKey, key)
      && Object.prototype.hasOwnProperty.call(deptStartX, deptCode)
    ) {
      posMap[u.id].x = deptStartX[deptCode] + fixedNodeOffsetByKey[key];
    }
  });

  // Specific alignment tweak: keep Felix on Gemma's vertical lane so this
  // subtree reads clearly in the dense L8/L9 section.
  const felix = layoutUsers.find((u) => u.name === "Felix");
  const gemma = layoutUsers.find((u) => u.name === "Gemma");
  if (felix && gemma && posMap[felix.id] && posMap[gemma.id]) {
    posMap[felix.id].x = posMap[gemma.id].x;
  }

  // Specific alignment tweak: keep Faye on Greg's vertical lane so this
  // subtree reads clearly in the dense L8/L9 section.
  const faye = layoutUsers.find((u) => u.name === "Faye");
  const greg = layoutUsers.find((u) => u.name === "Greg");
  if (faye && greg && posMap[faye.id] && posMap[greg.id]) {
    posMap[faye.id].x = posMap[greg.id].x;
  }

  // Case 7/19: place the extra HRO Boris node at the rightmost HRO lane on
  // the same row, using normal horizontal spacing.
  const case7Loan = users.find((u) => u._itsoCase7Loan);
  const kevinHro = layoutUsers.find((u) => u.name === "Kevin" && u.department_code === "HRO");
  const homeBoris = layoutUsers.find((u) => u.name === "Boris" && u.department_code === "ITSO");
  if (case7Loan && kevinHro && posMap[kevinHro.id]) {
    const pitch = NODE_W + COL_GAP;
    const rowY = (homeBoris && posMap[homeBoris.id] ? posMap[homeBoris.id].y : posMap[kevinHro.id].y);
    const occupied = layoutUsers
      .filter((u) =>
        u.department_code === "HRO" &&
        posMap[u.id] &&
        Math.abs(posMap[u.id].y - rowY) < 0.5
      )
      .map((u) => posMap[u.id].x);
    // Keep the extra HRO Boris as the rightmost node in the destination row.
    const rightmost = occupied.length ? Math.max(...occupied) : posMap[kevinHro.id].x;
    let laneX = rightmost + pitch;
    while (occupied.some((x) => Math.abs(x - laneX) < pitch - 4)) {
      laneX += pitch;
    }
    posMap[case7Loan.id] = { x: laneX, y: rowY };
  }

  // Case 28: place Bianca [shell] as the rightmost HRO node on Bianca's row
  // (same style as normal chart nodes, not external panel style).
  const case28Shell = users.find((u) => u._itsoCase28Shell);
  const homeBiancaCase28 = layoutUsers.find((u) => u.name === "Bianca" && u.department_code === "ITSO");
  const hroAnchor = layoutUsers.find((u) => u.department_code === "HRO" && posMap[u.id]);
  if (case28Shell && posMap[case28Shell.id] && hroAnchor) {
    const pitch = NODE_W + COL_GAP;
    const rowY = (homeBiancaCase28 && posMap[homeBiancaCase28.id]
      ? posMap[homeBiancaCase28.id].y
      : posMap[hroAnchor.id].y);
    const occupied = layoutUsers
      .filter((u) =>
        u.department_code === "HRO" &&
        posMap[u.id] &&
        Math.abs(posMap[u.id].y - rowY) < 0.5
      )
      .map((u) => posMap[u.id].x);
    const fallbackRightmost = Object.values(posMap)
      .map((p) => p.x)
      .reduce((m, x) => Math.max(m, x), posMap[hroAnchor.id].x);
    const rightmost = occupied.length ? Math.max(...occupied) : fallbackRightmost;
    let laneX = rightmost + pitch;
    while (occupied.some((x) => Math.abs(x - laneX) < pitch - 4)) {
      laneX += pitch;
    }
    posMap[case28Shell.id] = { x: laneX, y: rowY };
  }

  // In combined department/team view, keep each department head centered on
  // that department block. For HRO this puts Hannah between the two team lanes.
  if (groupByDept && groupByTeam) {
    deptCodes.forEach((code) => {
      const heads = layoutUsers.filter((u) => u.department_code === code && u.is_top_level && posMap[u.id]);
      if (heads.length !== 1) return;
      posMap[heads[0].id].x = deptStartX[code] + deptBlockW[code] / 2 - NODE_W / 2;
    });
  }

  // Generic 2x2 balancing: if a manager has exactly two direct reports and
  // each of those reports has exactly one direct report, distribute the four
  // nodes into two equal columns for a clean, organized subtree.
  const directByManager = {};
  layoutUsers.forEach((u) => {
    if (!u.manager_name) return;
    (directByManager[u.manager_name] = directByManager[u.manager_name] || []).push(u);
  });
  Object.keys(directByManager).forEach((managerName) => {
    const mid = directByManager[managerName] || [];
    if (mid.length !== 2) return;
    const aKids = directByManager[mid[0].name] || [];
    const bKids = directByManager[mid[1].name] || [];
    if (aKids.length !== 1 || bKids.length !== 1) return;

    const a = mid[0];
    const b = mid[1];
    const c = aKids[0];
    const d = bKids[0];
    if (!posMap[a.id] || !posMap[b.id] || !posMap[c.id] || !posMap[d.id]) return;

    const pairs = [
      { upper: a, lower: c },
      { upper: b, lower: d },
    ].sort((p1, p2) => {
      const x1 = posMap[p1.upper.id].x + NODE_W / 2;
      const x2 = posMap[p2.upper.id].x + NODE_W / 2;
      return x1 - x2;
    });

    const centers = [a, b, c, d].map((u) => posMap[u.id].x + NODE_W / 2);
    const clusterCenter = centers.reduce((sum, v) => sum + v, 0) / centers.length;
    const currentSpread = Math.max(...centers) - Math.min(...centers);
    const laneGap = Math.max(NODE_W + COL_GAP + 28, currentSpread);
    const leftX = clusterCenter - laneGap / 2 - NODE_W / 2;
    const rightX = clusterCenter + laneGap / 2 - NODE_W / 2;

    posMap[pairs[0].upper.id].x = leftX;
    posMap[pairs[0].lower.id].x = leftX;
    posMap[pairs[1].upper.id].x = rightX;
    posMap[pairs[1].lower.id].x = rightX;
  });

  // Persist department-relative offsets once (first-seen baseline) so node
  // lanes remain fixed inside each department across later case changes.
  layoutUsers.forEach((u) => {
    if (!posMap[u.id]) return;
    const deptCode = DEPT_KEY(u);
    if (!Object.prototype.hasOwnProperty.call(deptStartX, deptCode)) return;
    const key = fixedNodeKey(u);
    if (!Object.prototype.hasOwnProperty.call(fixedNodeOffsetByKey, key)) {
      fixedNodeOffsetByKey[key] = posMap[u.id].x - deptStartX[deptCode];
    }
  });

  // If this view has a single department head, place that node at the
  // horizontal center of the rendered graph.
  const headCandidates = layoutUsers.filter((u) => u.is_top_level && posMap[u.id]);
  if (headCandidates.length === 1) {
    let minNodeX = Infinity;
    let maxNodeX = -Infinity;
    Object.values(posMap).forEach(({ x }) => {
      minNodeX = Math.min(minNodeX, x);
      maxNodeX = Math.max(maxNodeX, x + NODE_W);
    });
    if (Number.isFinite(minNodeX) && Number.isFinite(maxNodeX)) {
      const centerX = (minNodeX + maxNodeX) / 2;
      posMap[headCandidates[0].id].x = centerX - NODE_W / 2;
    }
  }

  // Optional strict lock: apply after all layout tweaks so nodes keep a truly
  // fixed absolute X across case switches and re-renders.
  if (fixedAbsoluteNodeX) {
    const usersWithPlacedNodes = users.filter((u) => posMap[u.id]);

    usersWithPlacedNodes.forEach((u) => {
      const key = fixedNodeKey(u);
      if (Object.prototype.hasOwnProperty.call(fixedNodeAbsoluteXByKey, key)) {
        posMap[u.id].x = fixedNodeAbsoluteXByKey[key];
      }
    });

    usersWithPlacedNodes.forEach((u) => {
      const key = fixedNodeKey(u);
      if (!Object.prototype.hasOwnProperty.call(fixedNodeAbsoluteXByKey, key)) {
        fixedNodeAbsoluteXByKey[key] = posMap[u.id].x;
      }
    });
  }

  // Calculate SVG dimensions
  let minX = Infinity, maxX = 0, maxY = 0;
  Object.values(posMap).forEach(({ x, y }) => {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x + NODE_W);
    maxY = Math.max(maxY, y + NODE_H);
  });
  const viewMinX = Number.isFinite(minX) ? Math.min(0, minX - LEFT_PAD - LEFT_VIEW_EXTRA) : 0;
  const viewMaxX = Math.max(maxX + LEFT_PAD, 600);
  const svgW = Math.max(600, viewMaxX - viewMinX);
  const viewRightX = viewMinX + svgW;
  const svgH = maxY + 60;
  svg.setAttribute("viewBox", `${viewMinX} 0 ${svgW} ${svgH}`);
  // Render at natural pixel size so large departments (e.g. ITSO's 30 staff and
  // HRO's 20 staff) are not squished to fit the container width. The
  // `.diagram-container` uses `overflow: auto`, so the full-size diagram scrolls
  // horizontally and vertically while keeping every node readable.
  svg.style.width = `${svgW}px`;
  svg.style.height = `${svgH}px`;

  const ns = "http://www.w3.org/2000/svg";
  const teamLabelY = (() => {
    const layer3Idx = sortedLevels.findIndex((rank) => layerForRank(rank) === 3);
    if (layer3Idx === -1) return TOP_PAD - 2;
    const rowY = TOP_PAD + layer3Idx * LEVEL_H;
    // Place team labels in the Layer 3 row lane, above node boxes.
    return rowY - 8;
  })();

  // Layer bands: shade each contiguous group of level rows by their reporting
  // layer so the four-tier structure (Layer 1–4) reads at a glance. Drawn first
  // so they sit behind separators, edges, and nodes.
  for (let i = 0; i < sortedLevels.length; i++) {
    const layer = layerForRank(sortedLevels[i]);
    let j = i;
    while (j + 1 < sortedLevels.length && layerForRank(sortedLevels[j + 1]) === layer) j++;
    const bandTop = TOP_PAD + i * LEVEL_H - 30;
    const bandBottom = TOP_PAD + j * LEVEL_H + NODE_H + 14;
    const band = document.createElementNS(ns, "rect");
    band.setAttribute("x", viewMinX);
    band.setAttribute("y", bandTop);
    band.setAttribute("width", svgW);
    band.setAttribute("height", bandBottom - bandTop);
    band.setAttribute("class", `layer-band layer-band-${layer}`);
    svg.appendChild(band);
    // Layer caption on the left margin, aligned with the first row of the band.
    const caption = document.createElementNS(ns, "text");
    caption.setAttribute("x", viewMinX + LEVEL_LABEL_X);
    caption.setAttribute("y", TOP_PAD + i * LEVEL_H - 16);
    caption.setAttribute("class", "layer-band-label");
    caption.textContent = `Layer ${layer}`;
    svg.appendChild(caption);
    i = j;
  }

  // Department group headers and separators (only in the combined view).
  if (groupByDept) {
    deptCodes.forEach((code, idx) => {
      // Header label centered over the department block.
      const label = document.createElementNS(ns, "text");
      label.setAttribute("x", deptStartX[code] + deptBlockW[code] / 2);
      label.setAttribute("y", TOP_PAD - 16);
      label.setAttribute("class", "dept-label");
      label.textContent = code;
      svg.appendChild(label);

      // Dashed vertical separator in the gap before each block (except first).
      if (idx > 0) {
        const sep = document.createElementNS(ns, "line");
        const sx = deptStartX[code] - DEPT_GAP / 2;
        sep.setAttribute("x1", sx);
        sep.setAttribute("y1", TOP_PAD - 24);
        sep.setAttribute("x2", sx);
        sep.setAttribute("y2", svgH - 20);
        sep.setAttribute("class", "dept-separator");
        svg.appendChild(sep);
      }

      if (groupByTeam) {
        const teams = teamByDept[code] || ["Dept Leadership"];
        const teamGap = teamGapForDept(code);
        teams.forEach((team, tIdx) => {
          const key = `${code}::${team}`;
          const teamLabel = document.createElementNS(ns, "text");
          teamLabel.setAttribute("x", String(teamStartX[key] + teamBlockW[key] / 2));
          teamLabel.setAttribute("y", String(teamLabelY));
          teamLabel.setAttribute("class", "team-label");
          teamLabel.textContent = team;
          svg.appendChild(teamLabel);

          if (tIdx > 0) {
            const teamSep = document.createElementNS(ns, "line");
            const sx = teamStartX[key] - teamGap / 2;
            teamSep.setAttribute("x1", String(sx));
            teamSep.setAttribute("y1", String(TOP_PAD - 8));
            teamSep.setAttribute("x2", String(sx));
            teamSep.setAttribute("y2", String(svgH - 20));
            teamSep.setAttribute("class", "team-separator");
            svg.appendChild(teamSep);
          }
        });
      }
    });
  } else if (groupByTeam && deptCodes.length === 1) {
    const code = deptCodes[0];
    const teams = teamByDept[code] || ["Dept Leadership"];
    const teamGap = teamGapForDept(code);
    teams.forEach((team, tIdx) => {
      const key = `${code}::${team}`;
      const teamLabel = document.createElementNS(ns, "text");
      teamLabel.setAttribute("x", String(teamStartX[key] + teamBlockW[key] / 2));
      teamLabel.setAttribute("y", String(teamLabelY));
      teamLabel.setAttribute("class", "team-label");
      teamLabel.textContent = team;
      svg.appendChild(teamLabel);

      if (tIdx > 0) {
        const teamSep = document.createElementNS(ns, "line");
        const sx = teamStartX[key] - teamGap / 2;
        teamSep.setAttribute("x1", String(sx));
        teamSep.setAttribute("y1", String(TOP_PAD - 8));
        teamSep.setAttribute("x2", String(sx));
        teamSep.setAttribute("y2", String(svgH - 20));
        teamSep.setAttribute("class", "team-separator");
        svg.appendChild(teamSep);
      }
    });
  }

  // Level bands and labels
  sortedLevels.forEach((rank, rowIdx) => {
    const y = TOP_PAD + rowIdx * LEVEL_H;
    // Dashed horizontal guide line
    const line = document.createElementNS(ns, "line");
    line.setAttribute("x1", viewMinX);
    line.setAttribute("y1", y - 10);
    line.setAttribute("x2", viewRightX);
    line.setAttribute("y2", y - 10);
    line.setAttribute("class", "level-band");
    svg.appendChild(line);
    // Level label
    const text = document.createElementNS(ns, "text");
    text.setAttribute("x", viewMinX + LEVEL_LABEL_X);
    text.setAttribute("y", y + NODE_H / 2 + 4);
    text.setAttribute("class", "diagram-level-label");
    text.textContent = `L${rank}`;
    svg.appendChild(text);
  });

  // Reporting-line edges (draw behind nodes)
  const edgeGroup = document.createElementNS(ns, "g");
  svg.appendChild(edgeGroup);
  const EDGE_PORT_OFFSET = 6;

  // Each edge is colored per individual subordinate (the person whose line runs
  // up to their manager), so two people at the same rank reporting into the same
  // higher rank — e.g. Belle(L8) and Biance(L8) both reporting to L9 — each get
  // their own distinct color. Colors are assigned in a stable order so a given
  // person keeps the same color across re-renders.
  const usedColors = new Set();
  const personColor = {};  // user.id → color
  let colorCursor = 0;
  renderedUsers.forEach((u) => {
    if (personColor[u.id] === undefined) {
      personColor[u.id] = edgeColorForIndex(colorCursor);
      colorCursor += 1;
    }
  });

  renderedUsers.forEach((u) => {
    if (!u.manager_name) return;
    const manager = renderedUsers.find((m) => m.name === u.manager_name);
    if (!manager) return;
    const from = posMap[manager.id];
    const to = posMap[u.id];
    if (!from || !to) return;

    // Use an orthogonal connector with a single elbow so lower-level lines rise
    // first, then turn once at the higher-level row. This keeps paths readable
    // and removes redundant side turns in deep hierarchies.
    const x1 = from.x + NODE_W / 2;
    const y1 = from.y + NODE_H + EDGE_PORT_OFFSET;
    const x2 = to.x + NODE_W / 2;
    const y2 = to.y - EDGE_PORT_OFFSET;
    const color = personColor[u.id];
    usedColors.add(color);

    const edge = document.createElementNS(ns, "path");
    // Connect only at top/bottom ports: subordinate top -> manager bottom.
    // Place the horizontal turn in the middle vertical gap so it stays clear
    // of both node borders.
    if (Math.abs(x1 - x2) < 0.5) {
      // Same column: a single straight vertical rise.
      edge.setAttribute("d", `M ${x2} ${y2} L ${x1} ${y1}`);
    } else {
      const elbowY = layerGapElbowY(y1, y2);
      edge.setAttribute(
        "d",
        `M ${x2} ${y2} L ${x2} ${elbowY} L ${x1} ${elbowY} L ${x1} ${y1}`
      );
    }
    const isHroL9Edge = u.department_code === "HRO" && Number(u.level_rank) === 9;
    edge.setAttribute("class", `diagram-edge${isHroL9Edge ? " hro-l9-edge" : ""}`);
    edge.style.stroke = color;
    // Record the child→parent relationship so the selected user's reporting
    // line (the upward chain of edges) can be emphasised on demand.
    edge.dataset.childId = u.id;
    edge.dataset.parentId = manager.id;
    // Arrow marker, color-matched to this edge's stroke.
    edge.setAttribute("marker-end", `url(#${rankArrowId(color)})`);
    edgeGroup.appendChild(edge);
  });

  // Arrow marker definitions — one per color actually used, so each arrowhead
  // matches the color of its reporting line.
  const defs = document.createElementNS(ns, "defs");
  defs.innerHTML = Array.from(usedColors)
    .map(
      (color) => `
    <marker id="${rankArrowId(color)}" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="${color}" />
    </marker>`
    )
    .join("");
  svg.insertBefore(defs, svg.firstChild);

  // Nodes
  renderedUsers.forEach((u) => {
    const pos = posMap[u.id];
    if (!pos) return;
    const classes = ["diagram-node"];
    if (selectedId != null && selectedId === u.id) classes.push("selected");
    if (u.active === false) classes.push("inactive");
    const g = document.createElementNS(ns, "g");
    g.setAttribute("class", classes.join(" "));
    g.setAttribute("transform", `translate(${pos.x},${pos.y})`);
    g.dataset.userId = u.id;
    g.dataset.levelRank = String(u.level_rank ?? "");

    const rect = document.createElementNS(ns, "rect");
    rect.setAttribute("width", NODE_W);
    rect.setAttribute("height", NODE_H);
    rect.setAttribute("rx", 8);
    if (u.is_top_level) rect.setAttribute("class", "top-level");
    g.appendChild(rect);

    // Name
    const nameText = document.createElementNS(ns, "text");
    nameText.setAttribute("x", NODE_W / 2);
    nameText.setAttribute("y", 18);
    nameText.setAttribute("class", "node-name");
    nameText.textContent =
      u.name +
      (deptTag && u.department_code ? ` [${u.department_code}]` : "") +
      (u.is_team_lead ? " ★" : "");
    g.appendChild(nameText);

    // Level
    const levelText = document.createElementNS(ns, "text");
    levelText.setAttribute("x", NODE_W / 2);
    levelText.setAttribute("y", 34);
    levelText.setAttribute("class", "node-level");
    levelText.textContent = `${u.level_name} (L${u.level_rank})`;
    g.appendChild(levelText);

    g.addEventListener("click", () => onNodeClick(u));
    svg.appendChild(g);

    // Keep labels inside the node box: if a name/level label is wider than the
    // node, compress it horizontally so adjacent nodes never overlap.
    const maxTextW = NODE_W - 12;
    [nameText, levelText].forEach((t) => {
      if (t.getComputedTextLength && t.getComputedTextLength() > maxTextW) {
        t.setAttribute("textLength", maxTextW);
        t.setAttribute("lengthAdjust", "spacingAndGlyphs");
      }
    });
  });

  // Emphasise the selected user's reporting line (the upward chain of edges).
  highlightReportingLine(svg, selectedId);
}

// Bold the reporting-line chain for the given user by walking the rendered
// edges upward (child → parent) and toggling the `highlighted` class. Passing a
// null/undefined userId simply clears any existing emphasis. Operates purely on
// the edges' data-child-id / data-parent-id attributes so it works for any SVG
// produced by drawDiagram without needing the original users array.
function highlightReportingLine(svg, userId) {
  if (!svg) return;
  const edges = Array.from(svg.querySelectorAll(".diagram-edge"));
  edges.forEach((e) => e.classList.remove("highlighted"));
  if (userId == null) return;
  const edgeByChild = {};
  edges.forEach((e) => {
    edgeByChild[e.dataset.childId] = e;
  });
  let current = String(userId);
  const visited = new Set();
  while (edgeByChild[current] && !visited.has(current)) {
    visited.add(current);
    const edge = edgeByChild[current];
    edge.classList.add("highlighted");
    current = edge.dataset.parentId;
  }
}


function openEditPanel(user) {
  openDiagramSidebar(user);
}

function renderLevelLabels() {
  const container = byId('level-labels');
  if (!container || !diagramData) return;
  const labels = [...(diagramData.levels || [])]
    .sort((a, b) => a.level_rank - b.level_rank)
    .map((level) => `
      <div class="level-label">
        <span class="level-label-rank">L${level.level_rank}</span>
        <span class="level-label-name">${escHtml(level.level_name)}</span>
      </div>
    `)
    .join(' ');
  container.innerHTML = labels;
}

function decorateDiagram(svg, users, { searchTerm = '', routeNames = [] } = {}) {
  if (!svg) return;
  const term = searchTerm.trim().toLowerCase();
  const usersById = new Map((users || []).map((user) => [String(user.id), user]));
  const highlightedNames = new Set((routeNames || []).map((name) => String(name).toLowerCase()));

  qsa('.diagram-node', svg).forEach((node) => {
    const user = usersById.get(node.dataset.userId);
    const rect = node.querySelector('rect');
    const match = !term || `${user?.name || ''} ${user?.email || ''} ${user?.level_name || ''}`.toLowerCase().includes(term);
    node.style.opacity = match ? '1' : '0.18';
    if (rect) {
      rect.style.stroke = '';
      rect.style.strokeWidth = '';
      rect.style.fill = '';
      if (highlightedNames.has(String(user?.name || '').toLowerCase())) {
        rect.style.stroke = '#f59e0b';
        rect.style.strokeWidth = '3';
        rect.style.fill = '#fff6d5';
      } else if (match && term) {
        rect.style.stroke = '#2563eb';
        rect.style.strokeWidth = '2';
      }
    }
  });

  qsa('.diagram-edge', svg).forEach((edge) => {
    if (!term) {
      edge.style.opacity = '1';
      return;
    }
    const child = usersById.get(edge.dataset.childId);
    const parent = usersById.get(edge.dataset.parentId);
    const childMatch = child && `${child.name} ${child.email || ''}`.toLowerCase().includes(term);
    const parentMatch = parent && `${parent.name} ${parent.email || ''}`.toLowerCase().includes(term);
    edge.style.opacity = childMatch || parentMatch ? '1' : '0.15';
  });
}

function currentDiagramSearchTerm() {
  return byId('user-search')?.value || '';
}

function renderDepartmentDiagram() {
  const svg = byId('dept-diagram-svg');
  if (!svg || !diagramData) return;
  currentDeptUsersForRender = normalizeUsersForDiagram(diagramData.users, diagramData.org_units);
  drawDiagram(svg, currentDeptUsersForRender, {
    selectedId: selectedNode?.id ?? null,
    onNodeClick: openDiagramSidebar,
    teamSections: true,
    fixedAbsoluteNodeX: true,
    fixedTeamSections: true,
  });
  renderLevelLabels();
  decorateDiagram(svg, currentDeptUsersForRender, {
    searchTerm: currentDiagramSearchTerm(),
    routeNames: currentHighlightedRouteNames,
  });
}

async function loadDepartmentDiagram() {
  const deptId = byId('dept-select')?.value || currentDiagramDept || allDepartments()[0]?.id;
  if (!deptId) return;
  currentDiagramDept = String(deptId);
  try {
    diagramData = await api(`/api/departments/${deptId}/diagram-data`);
    if (selectedNode) {
      selectedNode = diagramData.users.find((user) => String(user.id) === String(selectedNode.id)) || null;
      if (!selectedNode) currentHighlightedRouteNames = [];
    }
    renderDepartmentDiagram();
    if (selectedNode) {
      openDiagramSidebar(selectedNode, true);
    } else {
      closeDiagramSidebar(false);
    }
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function computeReportingPath(user) {
  const users = [...(diagramData?.users || []), ...allUsers()];
  const userById = new Map(users.map((item) => [String(item.id), item]));
  const path = [];
  let current = user;
  const visited = new Set();
  while (current?.manager_id && !visited.has(String(current.manager_id))) {
    visited.add(String(current.manager_id));
    const manager = userById.get(String(current.manager_id));
    if (!manager) break;
    path.push(manager);
    current = manager;
  }
  return path;
}

function directReportsFor(userId) {
  return allUsers().filter((user) => String(user.manager_id) === String(userId));
}

function renderSidebarProfile() {
  const user = selectedNode;
  if (!user) {
    byId('tab-profile').innerHTML = '<p class="text-muted">Select a user node.</p>';
    return;
  }
  const deptId = user.department_id;
  const levels = (seedData?.dept_levels || []).filter((level) => String(level.dept_id) === String(deptId));
  const units = (seedData?.org_units || []).filter((unit) => String(unit.dept_id) === String(deptId));
  const managers = allUsers().filter((candidate) => String(candidate.id) !== String(user.id));
  byId('tab-profile').innerHTML = `
    <div class="form-group"><label>Name</label><input id="sidebar-profile-name" type="text" value="${escHtml(user.name)}"></div>
    <div class="form-group"><label>Email</label><input id="sidebar-profile-email" type="email" value="${escHtml(user.email || '')}"></div>
    <div class="form-group"><label>Level</label><select id="sidebar-profile-level">${levels.map((level) => `<option value="${level.id}" ${String(level.id) === String(user.dept_level_id) ? 'selected' : ''}>${escHtml(level.level_name)} (L${level.level_rank})</option>`).join('')}</select></div>
    <div class="form-group"><label>Org Unit</label><select id="sidebar-profile-org-unit"><option value="">— None —</option>${units.map((unit) => `<option value="${unit.id}" ${String(unit.id) === String(user.org_unit_ids?.[0] || '') ? 'selected' : ''}>${escHtml(unit.name)}</option>`).join('')}</select></div>
    <div class="form-group"><label>Manager</label><select id="sidebar-profile-manager"><option value="">— None / Top-level —</option>${managers.map((manager) => `<option value="${manager.id}" ${String(manager.id) === String(user.manager_id || '') ? 'selected' : ''}>${escHtml(userLabel(manager))}</option>`).join('')}</select></div>
    <div class="form-group"><label><input id="sidebar-profile-team-lead" type="checkbox" ${user.is_team_lead ? 'checked' : ''}> Team Lead</label></div>
    <div class="form-group"><label><input id="sidebar-profile-active" type="checkbox" ${user.is_active ? 'checked' : ''}> Active</label></div>
  `;
}

function renderSidebarReporting() {
  const user = selectedNode;
  if (!user) {
    byId('tab-reporting').innerHTML = '<p class="text-muted">Select a user node.</p>';
    return;
  }
  const path = computeReportingPath(user);
  const directReports = directReportsFor(user.id);
  byId('tab-reporting').innerHTML = `
    <h4>Reporting Path</h4>
    ${path.length ? `<ol>${path.map((person) => `<li>${escHtml(person.name)} — ${escHtml(person.level_name || '')}</li>`).join('')}</ol>` : '<p class="text-muted">No manager assigned.</p>'}
    <h4>Direct Reports</h4>
    ${directReports.length ? `<ul>${directReports.map((person) => `<li>${escHtml(person.name)} — ${escHtml(person.level_name)}</li>`).join('')}</ul>` : '<p class="text-muted">No direct reports.</p>'}
  `;
}

function renderRouteResult(target, result) {
  if (!target) return;
  if (!result || result.status !== 'success') {
    target.innerHTML = `<div class="text-danger">${escHtml(result?.error || 'No route found.')}</div>`;
    currentHighlightedRouteNames = [];
    renderDepartmentDiagram();
    return;
  }
  currentHighlightedRouteNames = [selectedNode?.name, ...(result.steps || []).map((step) => step.approver)].filter(Boolean);
  renderDepartmentDiagram();
  target.innerHTML = `
    <div class="card">
      <p><strong>Status:</strong> ${escHtml(result.status)}</p>
      ${result.wording ? `<p>${escHtml(result.wording)}</p>` : ''}
      <ol>${(result.steps || []).map((step) => `<li>${escHtml(step.approver)} <span class="text-muted">(${escHtml(step.source || 'official')}${step.is_fallback ? ', fallback' : ''})</span></li>`).join('')}</ol>
    </div>
  `;
}

function renderSidebarRouteForm() {
  const user = selectedNode;
  const currentAction = byId('action-highlight-select')?.value || '';
  const container = byId('tab-route');
  if (!user) {
    container.innerHTML = '<p class="text-muted">Select a user node.</p>';
    return;
  }
  container.innerHTML = `
    <div class="form-group">
      <label>Action</label>
      <select id="sidebar-route-action">
        ${allActions().map((action) => `<option value="${escHtml(action.code)}" ${action.code === currentAction ? 'selected' : ''}>${escHtml(action.name)} (${escHtml(action.code)})</option>`).join('')}
      </select>
    </div>
    <div class="form-group">
      <label>Date (optional)</label>
      <input id="sidebar-route-date" type="date">
    </div>
    <button class="btn btn-primary" id="sidebar-route-run">Simulate Route</button>
    <div id="sidebar-route-result" style="margin-top: 1rem;"></div>
  `;
  byId('sidebar-route-run').addEventListener('click', async () => {
    try {
      const result = await api('/api/simulate-request', {
        method: 'POST',
        body: {
          requester_id: user.id,
          action_code: byId('sidebar-route-action').value,
          request_at: apiDate(byId('sidebar-route-date').value),
        },
      });
      byId('action-highlight-select').value = byId('sidebar-route-action').value;
      renderRouteResult(byId('sidebar-route-result'), result);
    } catch (error) {
      renderRouteResult(byId('sidebar-route-result'), { status: 'error', error: error.message });
    }
  });
}

function renderSidebarOverlays() {
  const container = byId('tab-overlays');
  if (!selectedNode || !diagramData) {
    container.innerHTML = '<p class="text-muted">Select a user node.</p>';
    return;
  }
  const items = Object.entries(diagramData.overlays || {}).flatMap(([type, rows]) =>
    (rows || [])
      .filter((item) => String(item.from_user_id) === String(selectedNode.id) || String(item.to_user_id) === String(selectedNode.id))
      .map((item) => ({ ...item, overlay_type: type }))
  );
  container.innerHTML = items.length
    ? `<ul>${items.map((item) => `<li><strong>${escHtml(OVERLAY_TYPE_LABELS[item.overlay_type] || item.overlay_type)}</strong>: ${escHtml(item.from_user_name || '—')} → ${escHtml(item.to_user_name || '—')} (${escHtml(formatDate(item.effective_from))} to ${escHtml(formatDate(item.effective_to))})</li>`).join('')}</ul>`
    : '<p class="text-muted">No overlays for this user.</p>';
}

async function renderSidebarHistory() {
  const container = byId('tab-history');
  if (!selectedNode) {
    container.innerHTML = '<p class="text-muted">Select a user node.</p>';
    return;
  }
  container.innerHTML = '<p class="text-muted">Loading history…</p>';
  try {
    const payload = await api('/api/audit-logs?entity_type=user&limit=100', { silent: true });
    const logs = (payload.logs || []).filter((log) => String(log.entity_id) === String(selectedNode.id) || String(log.entity_name || '') === String(selectedNode.name));
    container.innerHTML = logs.length
      ? `<ul>${logs.map((log) => `<li><strong>${escHtml(formatDateTime(log.timestamp))}</strong> — ${escHtml(log.action)} (${escHtml(log.result || 'success')})<br><span class="text-muted">${escHtml(log.details || log.source_page || '')}</span></li>`).join('')}</ul>`
      : '<p class="text-muted">No audit history found for this user.</p>';
  } catch (error) {
    container.innerHTML = `<p class="text-danger">${escHtml(error.message)}</p>`;
  }
}

function renderDiagramSidebar() {
  renderSidebarProfile();
  renderSidebarReporting();
  renderSidebarRouteForm();
  renderSidebarOverlays();
  renderSidebarHistory();
}

function openDiagramSidebar(user, preserveTab = false) {
  if (!user) return;
  selectedNode = diagramData?.users?.find((item) => String(item.id) === String(user.id)) || user;
  byId('diagram-sidebar').style.display = 'block';
  byId('sidebar-title').textContent = selectedNode.name;
  renderDepartmentDiagram();
  renderDiagramSidebar();
  if (!preserveTab) setSidebarTabActive('profile');
}

function closeDiagramSidebar(clearSelection = true) {
  byId('diagram-sidebar').style.display = 'none';
  if (clearSelection) {
    selectedNode = null;
    currentHighlightedRouteNames = [];
  }
  renderDepartmentDiagram();
}

async function saveSidebarChanges() {
  if (!requireAdmin('save diagram changes')) return;
  if (!selectedNode) return;
  const body = {
    user_id: selectedNode.id,
    name: byId('sidebar-profile-name').value.trim(),
    email: byId('sidebar-profile-email').value.trim(),
    dept_level_id: Number(byId('sidebar-profile-level').value),
    is_team_lead: byId('sidebar-profile-team-lead').checked,
    is_active: byId('sidebar-profile-active').checked,
  };
  const orgUnitId = byId('sidebar-profile-org-unit').value;
  body.org_unit_id = orgUnitId ? Number(orgUnitId) : null;
  const managerId = byId('sidebar-profile-manager').value;
  body.manager_id = managerId ? Number(managerId) : null;

  try {
    await api('/api/diagram/update-node', { method: 'POST', body });
    await refreshAfterMutation('User updated from diagram.');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function highlightActionRoute() {
  const actionCode = byId('action-highlight-select').value;
  if (!actionCode) {
    currentHighlightedRouteNames = [];
    renderDepartmentDiagram();
    return;
  }
  if (!selectedNode) {
    showToast('Select a user node first, then choose an action route to highlight.', 'info');
    byId('action-highlight-select').value = '';
    return;
  }
  setSidebarTabActive('route');
  renderSidebarRouteForm();
  byId('sidebar-route-action').value = actionCode;
  byId('sidebar-route-run').click();
}

function searchUsers() {
  decorateDiagram(byId('dept-diagram-svg'), currentDeptUsersForRender, {
    searchTerm: currentDiagramSearchTerm(),
    routeNames: currentHighlightedRouteNames,
  });
}

let overlayList = [];

function overlayStatus(overlay) {
  const now = Date.now();
  const start = overlay.effective_from ? new Date(overlay.effective_from).getTime() : 0;
  const end = overlay.effective_to ? new Date(overlay.effective_to).getTime() : Number.MAX_SAFE_INTEGER;
  if (!overlay.is_active) return 'inactive';
  if (start > now) return 'upcoming';
  if (end < now) return 'expired';
  return 'active';
}

async function loadOverlays() {
  const payload = await api('/api/overlays');
  overlayList = payload.overlays || [];
  const typeFilter = byId('overlay-type-filter').value;
  const statusFilter = byId('overlay-status-filter').value;
  const filtered = overlayList.filter((overlay) => {
    const status = overlayStatus(overlay);
    if (typeFilter && overlay.overlay_type !== typeFilter) return false;
    if (statusFilter && status !== statusFilter) return false;
    return true;
  });
  const tbody = byId('overlays-table').querySelector('tbody');
  tbody.innerHTML = filtered
    .map((overlay) => `
      <tr>
        <td>${escHtml(OVERLAY_TYPE_LABELS[overlay.overlay_type] || overlay.overlay_type)}</td>
        <td>${escHtml(overlay.from_user_name || '—')}</td>
        <td>${escHtml(overlay.to_user_name || '—')}</td>
        <td>${escHtml(overlay.dept_name || '—')}</td>
        <td>${escHtml(formatDate(overlay.effective_from))}</td>
        <td>${escHtml(formatDate(overlay.effective_to))}</td>
        <td>${escHtml(overlayStatus(overlay))}</td>
        <td>${escHtml(overlay.policy || '—')}</td>
        <td>${isAdminRole() ? `<button class="btn btn-danger btn-sm delete-overlay" data-type="${overlay.overlay_type}" data-id="${overlay.id}">Delete</button>` : '—'}</td>
      </tr>
    `)
    .join('');
  qsa('.delete-overlay', tbody).forEach((button) => {
    button.addEventListener('click', () => deleteOverlay(button.dataset.type, Number(button.dataset.id)));
  });
  updateRoleUi();
}

function showAddOverlayModal() {
  if (!requireAdmin('add overlays')) return;
  byId('overlay-type').value = 'acting';
  byId('overlay-from-user').value = allUsers()[0] ? String(allUsers()[0].id) : '';
  byId('overlay-to-user').value = allUsers()[1] ? String(allUsers()[1].id) : byId('overlay-from-user').value;
  byId('overlay-dept').value = allDepartments()[0] ? String(allDepartments()[0].id) : '';
  byId('overlay-from').value = '';
  byId('overlay-to').value = '';
  openModal('overlay-modal');
}

async function saveOverlay() {
  if (!requireAdmin('save overlays')) return;
  const body = {
    overlay_type: byId('overlay-type').value,
    from_user_id: Number(byId('overlay-from-user').value),
    to_user_id: Number(byId('overlay-to-user').value),
    dept_id: Number(byId('overlay-dept').value),
    effective_from: apiDate(byId('overlay-from').value),
    effective_to: apiDate(byId('overlay-to').value),
    status: 'active',
  };
  try {
    await api('/api/overlays', { method: 'POST', body });
    closeModal('overlay-modal');
    await refreshAfterMutation('Overlay created.');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function deleteOverlay(type, id) {
  if (!requireAdmin('delete overlays')) return;
  if (!window.confirm('Delete this overlay?')) return;
  try {
    await api(`/api/overlays/${type}/${id}`, { method: 'DELETE' });
    await refreshAfterMutation('Overlay deleted.');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function loadAuditLogs() {
  const entityType = byId('audit-entity-filter').value;
  const limit = Number(byId('audit-limit').value || 50);
  const query = new URLSearchParams();
  if (entityType) query.set('entity_type', entityType);
  query.set('limit', String(limit));
  const payload = await api(`/api/audit-logs?${query.toString()}`);
  const tbody = byId('audit-table').querySelector('tbody');
  tbody.innerHTML = (payload.logs || [])
    .map((log) => `
      <tr title="${escHtml(log.details || '')}">
        <td>${escHtml(formatDateTime(log.timestamp))}</td>
        <td>${escHtml(log.actor)}</td>
        <td>${escHtml(log.action)}</td>
        <td>${escHtml(log.entity_type)}</td>
        <td>${escHtml(log.entity_name || `ID ${log.entity_id || '—'}`)}</td>
        <td>${escHtml(log.result || 'success')}</td>
        <td>${escHtml(log.source_page || '—')}</td>
      </tr>
    `)
    .join('');
}

async function loadValidationIssues() {
  const payload = await api('/api/validation-issues');
  const container = byId('validation-content');
  container.innerHTML = (payload.issues || []).length
    ? (payload.issues || [])
        .map((issue) => `
          <div class="card validation-issue">
            <strong>${escHtml(issue.type)}</strong>
            <p>${escHtml(issue.message)}</p>
            ${issue.user_name ? `<span class="text-muted">User: ${escHtml(issue.user_name)}</span>` : ''}
          </div>
        `)
        .join('')
    : '<div class="card"><p class="text-muted">No validation issues.</p></div>';
}

const THIRTY_CASES = [
  { id: 1, category: "Acting & Coverage", title: "Skip-level Acting", focus: "Boris", focusDept: "ITSO", scenario: "A senior leader leaves and a junior employee acts for the whole department.", method: "Add an Acting record and assign the junior to the Acting Senior Leader job position; authority is inherited from that position.", target: [["Boris", "Ivan"]], requestAt: "2027-07-15T00:00:00+00:00", note: "The seeded acting record is keyed on Ivan and active 1–31 Jul 2027. To see it in action, click one of Ivan's dependents (e.g. Isaac) — on the case date their approval line keeps Ivan [official] with Boris annotated as acting on his behalf." },
  { id: 2, category: "Acting & Coverage", title: "Peer Coverage", focus: "Cyrus", focusDept: "ITSO", scenario: "Applications team lead Cara is on leave, so Infrastructure team lead Ingrid temporarily covers her team — when Cyrus requests annual leave, Ingrid acts as team lead to approve.", method: "Give the covering team lead (Ingrid) a second assignment as Acting Applications Team lead, so Cara's team members route to Ingrid while Cara is away.", target: [["Cyrus", "Ingrid"]], overlaysByName: [{ type: "peer_coverage", owner: "Cara", substitute: "Ingrid" }] },
  { id: 3, category: "Acting & Coverage", title: "Partial Acting", focus: "Cleo", focusDept: "ITSO", scenario: "Manager Cyrus is on leave, so his approvals are split by type: one peer covers leave approvals and another covers performance reviews, while the second level rolls back to his own manager (Cara). E.g. when Cleo applies for annual leave, Isaac approves it; Cara remains the second level.", method: "Decouple workflows by approval type: leave-approval cover and performance-review cover are separate action-scoped coverage overlays; the second level stays the on-leave manager's own manager.", action: "annual_leave", partialActing: { manager: "Cyrus", leaveCover: "Isaac", reviewCover: "Evan", leaveAction: "annual_leave", reviewAction: "performance_review" }, target: [["Cleo", "Isaac", "Cara"]] },
  { id: 4, category: "Acting & Coverage", title: "Dummy Head", focus: "Hannah", focusDept: "HRO", scenario: "A new department lacks a head, so a neighboring head is temporarily assigned.", method: "Assign the neighboring department head to the new department's Head job position.", target: [["Hannah", "Ivan"]] },
  { id: 5, category: "Acting & Coverage", title: "Self-Approval", focus: "Ingrid", focusDept: "ITSO", scenario: "A manager acting in their own supervisor's role routes their leave back to themselves.", method: "Safeguard: if Submitter == Approver, roll up to next level or route to HR.", target: [["Ingrid", "Ivan"]] },
  { id: 6, category: "Acting & Coverage", title: "Handover Overlap", focus: "Isaac", focusDept: "ITSO", scenario: "Old and new managers occupy the same Head position during a 2-week overlap.", method: "Support over-hiring; HR specifies who holds approval authority during transition.", target: [["Isaac", "Ingrid", "Ivan"]] },
  { id: 7, category: "Matrix & Dual Reporting", title: "Cross-Department Project", focus: "Boris", focusDept: "ITSO", scenario: "An IT employee is seconded 100% to HR for a six-month project.", method: "Keep IT job position for payroll; add Override_Reports_To to the HR Project Manager for leave approval.", target: [["Boris", "Hannah"]] },
  { id: 8, category: "Matrix & Dual Reporting", title: "Split Allocation", focus: "Bruno", focusDept: "ITSO", scenario: "A professor spends 50% in two schools.", method: "Create two job assignments and define which is the main approval line.", target: [["Bruno", "Ingrid", "Ivan"], ["Bruno", "Harvey", "Ivan"]] },
  { id: 9, category: "Matrix & Dual Reporting", title: "Co-Heads", focus: "Cara", focusDept: "ITSO", scenario: "A team has two equal Co-Directors.", method: "Link the Org Unit to multiple Co-Head positions; workflow is Any-One-Approve.", target: [["Cara", "Ivan"], ["Cara", "Ingrid"]] },
  { id: 10, category: "Matrix & Dual Reporting", title: "Executive Assistant Delegation", focus: "Ivan", focusDept: "ITSO", scenario: "An executive never logs in; their EA handles all approvals.", method: "Delegation module: executive delegates authority to the EA; audit log records on-behalf-of.", target: [["Isaac", "Ivan"]] },
  { id: 11, category: "Matrix & Dual Reporting", title: "Tech Lead vs People Manager", focus: "Dana", focusDept: "ITSO", scenario: "Tech lead manages work; another manager handles people matters.", method: "Tech Lead/Dotted-line for projects; People Manager as solid-line manager.", target: [["Dana", "Cara", "Ivan"]] },
  { id: 12, category: "Matrix & Dual Reporting", title: "Global Matrix", focus: "Hope", focusDept: "HRO", scenario: "HK employee on a Local Line reports functionally to a Global Head in the US.", method: "Use Local Line for HR/leave; store Global Head in an override field for business reporting.", target: [["Hope", "Hannah"]] },
  { id: 13, category: "Hierarchy Anomalies & Loops", title: "Circular Reporting Line", focus: "Isaac", focusDept: "ITSO", scenario: "A→B→C and C acts in a role reporting back to A.", method: "Run DFS/BFS validation before saving; reject cycles with a validation error.", target: [["Isaac", "Ingrid", "Ivan"]] },
  { id: 14, category: "Hierarchy Anomalies & Loops", title: "Orphan Node", focus: "Carl", focusDept: "ITSO", scenario: "An employee's team is dissolved; they are not reassigned.", method: "If Org_Unit_ID is null, treat as Orphan and route to HRBP/HR queue.", target: [["Carl", "Hannah"]] },
  { id: 15, category: "Hierarchy Anomalies & Loops", title: "Super Flat Organization", focus: "Ivan", focusDept: "ITSO", scenario: "CEO directly manages 150 juniors with no middle layer.", method: "Allow one manager many direct reports; support large span-of-control queries.", target: [["Ingrid", "Ivan"], ["Isaac", "Ivan"]] },
  { id: 16, category: "Hierarchy Anomalies & Loops", title: "Skip-Level Reporting", focus: "Bonnie", focusDept: "ITSO", scenario: "A junior bypasses their supervisor to report to a grandparent manager.", method: "Use Override_Reports_To pointing to the grandparent manager.", target: [["Bonnie", "Ivan"]] },
  { id: 17, category: "Hierarchy Anomalies & Loops", title: "One-Man Department", focus: "Hannah", focusDept: "HRO", scenario: "A department has only one person, who is also the head.", method: "Normal case: that person's requests roll up to next level.", target: [["Hannah", "Ivan"]] },
  { id: 18, category: "Hierarchy Anomalies & Loops", title: "Parking Department", focus: "Hilda", focusDept: "HRO", scenario: "A special department parks staff pending redundancy or long leave.", method: "Special Org Unit with auto-approval or centralized HR handling.", target: [["Hilda", "Hannah"]] },
  { id: 19, category: "Temporal & Effective Dating", title: "Future Transfer", focus: "Boris", focusDept: "ITSO", scenario: "Future transfer set; leave applied for after the effective date.", method: "Resolve approver by event date; route to the future New Manager.", target: [["Boris", "Hannah"]] },
  { id: 20, category: "Temporal & Effective Dating", title: "Retroactive Promotion", focus: "Cyrus", focusDept: "ITSO", scenario: "Promotion entered late; early requests approved by wrong person.", method: "Completed transactions not re-routed; audit log flags the prior approver.", target: [["Cyrus", "Cara", "Ivan"]] },
  { id: 21, category: "Temporal & Effective Dating", title: "Manager Gap", focus: "Hazel", focusDept: "HRO", scenario: "Old manager leaves Fri, new starts Wed; who approves in the gap?", method: "Roll up to Next-Level Manager or queue until new manager is effective.", target: [["Hazel", "Hannah"]] },
  { id: 22, category: "Temporal & Effective Dating", title: "Management Trainee Rotation", focus: "Dean", focusDept: "ITSO", scenario: "A trainee rotates teams every three months.", method: "Preconfigure rotational positions with start/end dates; auto-switch org unit.", target: [["Dean", "Cara", "Ivan"]] },
  { id: 23, category: "Temporal & Effective Dating", title: "No Pay Leave", focus: "Daisy", focusDept: "ITSO", scenario: "A staff is on unpaid leave for a year, no approvals allowed.", method: "Set assignment Inactive; suspend workflow responsibilities.", target: [] },
  { id: 24, category: "Temporal & Effective Dating", title: "Re-Hire", focus: "Hugo", focusDept: "HRO", scenario: "An employee leaves and returns in a new role two years later.", method: "New assignment, same Employee ID; historical lines unaffected.", target: [["Hugo", "Hannah"]] },
  { id: 25, category: "Special Entities", title: "External Consultant / Vendor", focus: "Isaac", focusDept: "ITSO", scenario: "Outsourced IT team reports leave to an internal IT Manager.", method: "Create a Contingent Worker identity and attach to the relevant Org Unit.", target: [["Isaac", "Ivan"]] },
  { id: 26, category: "Special Entities", title: "Cross-Company Secondment", focus: "Hannah", focusDept: "HRO", scenario: "Affiliate A staff seconded to Affiliate B as manager.", method: "Multi-entity architecture: A's employee occupies a position in B.", target: [["Hannah", "Ivan"]] },
  { id: 27, category: "Special Entities", title: "Job Sharing", focus: "Bruno", focusDept: "ITSO", scenario: "Two part-time employees share one full-time role.", method: "Both assigned to the same position at 0.5 FTE each.", target: [["Bruno", "Ingrid", "Ivan"], ["Bella", "Ingrid", "Ivan"]] },
  { id: 28, category: "Special Entities", title: "Shell Position", focus: "Bianca", focusDept: "ITSO", scenario: "Budgeted in Dept A but works in Dept B.", method: "Keep Dept A for budget; override reporting line to Dept B.", target: [["Bianca", "Hannah"]] },
  { id: 29, category: "Special Entities", title: "Terminated Approver", focus: "Bonnie", focusDept: "ITSO", scenario: "A left manager keeps receiving routed requests.", method: "Check approver status; if terminated, fallback to HR.", target: [["Bonnie", "Ivan"]] },
  { id: 30, category: "Special Entities", title: "Union / Special Committee", focus: "Hope", focusDept: "HRO", scenario: "Union matters report to the union chair, not the daily manager.", method: "Dotted-line or dedicated Committee Org Unit for specific request types.", target: [["Hope", "Hannah"]] },
  { id: 31, category: "Corporate Tier (Layer 1)", title: "Dept Head Escalation", focus: "Ivan", focusDept: "EXEC", scenario: "An ITSO department head escalates a request up to the corporate School tier.", method: "Roll up past the department head to the Layer 1 School position.", target: [["Ivan", "School"]] },
  { id: 32, category: "Corporate Tier (Layer 1)", title: "Provost Reporting Line", focus: "School", focusDept: "EXEC", scenario: "The School reports to the VP, who reports to the Provost.", method: "Walk the corporate tier chain School → VP → Provost.", target: [["School", "VP"], ["VP", "Provost"]] },
  { id: 33, category: "Corporate Tier (Layer 1)", title: "Cross-Department Roll-Up", focus: "School", focusDept: "EXEC", scenario: "Both ITSO and HRO department heads roll up to the same School position.", method: "Multiple department heads report into one shared Layer 1 School.", target: [["Ivan", "School"], ["Hannah", "School"]] },
];

function initItsoCases() {
  const list = byId('case-list');
  const details = byId('case-details');
  if (!list || !details) return;
  const grouped = THIRTY_CASES.reduce((acc, item) => {
    (acc[item.category] = acc[item.category] || []).push(item);
    return acc;
  }, {});
  list.innerHTML = Object.entries(grouped)
    .map(([category, cases]) => `
      <div class="case-group">
        <h4>${escHtml(category)}</h4>
        ${cases
          .map((item) => `<button class="btn btn-secondary case-item ${selectedCaseId === item.id ? 'active' : ''}" data-id="${item.id}">${item.id}. ${escHtml(item.title)}</button>`)
          .join('')}
      </div>
    `)
    .join('');

  qsa('.case-item', list).forEach((button) => {
    button.addEventListener('click', () => showItsoCase(Number(button.dataset.id)));
  });

  if (selectedCaseId) {
    const item = THIRTY_CASES.find((entry) => entry.id === selectedCaseId);
    if (item) renderItsoCaseDetails(item);
  } else {
    details.innerHTML = '<p class="text-muted">Select a test case to view details.</p>';
  }
}

function renderItsoCaseDetails(item) {
  byId('case-details').innerHTML = `
    <h3>${item.id}. ${escHtml(item.title)}</h3>
    <p><strong>Category:</strong> ${escHtml(item.category)}</p>
    <p><strong>Scenario:</strong> ${escHtml(item.scenario)}</p>
    <p><strong>Method:</strong> ${escHtml(item.method)}</p>
    ${item.note ? `<p><strong>Note:</strong> ${escHtml(item.note)}</p>` : ''}
    ${item.action ? `<p><strong>Action:</strong> ${escHtml(item.action)}</p>` : ''}
    ${item.requestAt ? `<p><strong>Request At:</strong> ${escHtml(formatDateTime(item.requestAt))}</p>` : ''}
  `;
}

function showItsoCase(caseId) {
  selectedCaseId = caseId;
  const item = THIRTY_CASES.find((entry) => entry.id === caseId);
  if (!item) return;
  qsa('.case-item', byId('case-list')).forEach((button) => {
    button.classList.toggle('active', Number(button.dataset.id) === caseId);
  });
  renderItsoCaseDetails(item);
}

function openDeptDiagram() {
  showPage('dept-diagram');
}

function openITSOCases() {
  showPage('itso-cases');
}

async function resetDatabase() {
  if (!requireAdmin('reset the database')) return;
  if (!window.confirm('Reset the database to the default seed data?')) return;
  try {
    await api('/api/reset', { method: 'POST' });
    await refreshAfterMutation('Database reset to default seed data.');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function initTestDiagramPage() {
  if (!bootstrap) return;
  if (!byId('test-requester').value && allUsers()[0]) byId('test-requester').value = String(allUsers()[0].id);
  if (!byId('test-action').value) byId('test-action').value = '';
}

function addTestOverlay() {
  const container = byId('test-overlays-container');
  const overlayTypes = bootstrap?.overlay_simulations || [];
  const policies = bootstrap?.handover_policies || [];
  const row = document.createElement('div');
  row.className = 'overlay-row';
  row.innerHTML = `
    <select class="test-overlay-type">${overlayTypes.map((item) => `<option value="${escHtml(item.type)}">${escHtml(item.label)}</option>`).join('')}</select>
    <select class="test-overlay-owner">${allUsers().map((user) => `<option value="${user.id}">${escHtml(userLabel(user))}</option>`).join('')}</select>
    <select class="test-overlay-substitute">${allUsers().map((user) => `<option value="${user.id}">${escHtml(userLabel(user))}</option>`).join('')}</select>
    <select class="test-overlay-policy">${policies.map((policy) => `<option value="${escHtml(policy)}">${escHtml(policy)}</option>`).join('')}</select>
    <button class="btn btn-danger btn-sm remove-test-overlay" type="button">Remove</button>
  `;
  container.appendChild(row);
  row.querySelector('.remove-test-overlay').addEventListener('click', () => row.remove());
}

function collectTestOverlays() {
  return qsa('#test-overlays-container .overlay-row').map((row) => ({
    type: row.querySelector('.test-overlay-type').value,
    owner_id: Number(row.querySelector('.test-overlay-owner').value),
    substitute_id: Number(row.querySelector('.test-overlay-substitute').value),
    policy: row.querySelector('.test-overlay-policy').value,
  }));
}

function renderTestDiagramResult(result, requesterId) {
  const results = byId('test-diagram-results');
  const output = byId('test-diagram-output');
  results.style.display = 'block';
  const requester = allUsers().find((user) => String(user.id) === String(requesterId));
  output.innerHTML = `
    <div class="card">
      <p><strong>Status:</strong> ${escHtml(result.status || 'unknown')}</p>
      ${result.wording ? `<p>${escHtml(result.wording)}</p>` : ''}
      ${result.error ? `<p class="text-danger">${escHtml(result.error)}</p>` : ''}
      ${(result.steps || []).length ? `<ol>${result.steps.map((step) => `<li>${escHtml(step.user || requester?.name || 'Requester')} → ${escHtml(step.approver || step.manager_label || '—')} <span class="text-muted">(${escHtml(step.source || 'official')})</span></li>`).join('')}</ol>` : ''}
      <div class="svg-container" style="overflow:auto;"><svg id="test-diagram-svg"></svg></div>
    </div>
  `;
  const svg = byId('test-diagram-svg');
  const users = normalizeUsersForDiagram(allUsers(), seedData?.org_units || []);
  drawDiagram(svg, users, {
    selectedId: requester ? requester.id : null,
    onNodeClick: () => {},
    deptTag: true,
    teamSections: true,
    fixedAbsoluteNodeX: true,
    fixedTeamSections: true,
  });
  const routeNames = [requester?.name, ...(result.steps || []).map((step) => step.approver)].filter(Boolean);
  decorateDiagram(svg, users, { routeNames });
}

async function runTestDiagram() {
  const requesterId = byId('test-requester').value;
  if (!requesterId) {
    showToast('Select a requester first.', 'error');
    return;
  }
  const edges = allUsers().map((user) => ({
    user_id: user.id,
    manager_id: user.manager_id ?? null,
  }));
  try {
    const result = await api('/api/simulate-reporting-line', {
      method: 'POST',
      body: {
        requester_id: Number(requesterId),
        action_code: byId('test-action').value || null,
        request_at: apiDate(byId('test-date').value),
        overlays: byId('test-enable-overlays').checked ? collectTestOverlays() : [],
        edges,
      },
    });
    renderTestDiagramResult(result, requesterId);
  } catch (error) {
    renderTestDiagramResult({ status: 'error', error: error.message }, requesterId);
  }
}

function initScenarioBuilderPage() {
  if (!bootstrap) return;
  if (!byId('scenario-requester').value && allUsers()[0]) byId('scenario-requester').value = String(allUsers()[0].id);
  if (!byId('scenario-action').value && allActions()[0]) byId('scenario-action').value = allActions()[0].code;
}

async function runScenario() {
  const requesterId = byId('scenario-requester').value;
  if (!requesterId) {
    showToast('Select a requester first.', 'error');
    return;
  }
  try {
    const result = await api('/api/scenario-builder', {
      method: 'POST',
      body: {
        scenario_name: byId('scenario-name').value.trim(),
        requester_id: Number(requesterId),
        action_code: byId('scenario-action').value,
        request_date: apiDate(byId('scenario-date').value),
        overlay_enabled: byId('scenario-overlay-enable').checked,
      },
    });
    byId('scenario-results').style.display = 'block';
    byId('scenario-output').innerHTML = `
      <p><strong>${escHtml(result.scenario_name || 'Scenario')}</strong></p>
      <p>${escHtml(result.explanation || '')}</p>
      <p><strong>Validation:</strong> ${escHtml(result.validation_result || '—')}</p>
      <p><strong>Fallback Used:</strong> ${result.fallback_used ? 'Yes' : 'No'}</p>
      <p><strong>Overlays Applied:</strong> ${escHtml((result.overlays_applied || []).join(', ') || 'None')}</p>
      ${(result.steps || []).length ? `<ol>${result.steps.map((step) => `<li>${escHtml(step.approver)} <span class="text-muted">(${escHtml(step.source || 'official')})</span></li>`).join('')}</ol>` : '<p class="text-muted">No approval steps returned.</p>'}
    `;
  } catch (error) {
    byId('scenario-results').style.display = 'block';
    byId('scenario-output').innerHTML = `<p class="text-danger">${escHtml(error.message)}</p>`;
  }
}

function seedRowInputs(row) {
  const body = {};
  qsa('[data-field]', row).forEach((field) => {
    if (field.type === 'checkbox') body[field.dataset.field] = field.checked;
    else if (field.type === 'number') body[field.dataset.field] = Number(field.value);
    else body[field.dataset.field] = field.value;
  });
  return body;
}

async function loadSeedData(force = true) {
  if (force) seedData = await api('/api/seed-data');
  renderSeedDepartments();
  renderSeedLevels();
  renderSeedOrgUnits();
  renderSeedUsers();
  renderSeedReportingLines();
  renderSeedActions();
  renderSeedRoutingRules();
  renderSeedFallbackRules();
  updateRoleUi();
}

function renderSeedDepartments() {
  const container = byId('seed-departments');
  container.innerHTML = `
    <table class="data-table">
      <thead><tr><th>ID</th><th>Name</th><th>Code</th><th>Actions</th></tr></thead>
      <tbody>${(seedData.departments || []).map((dept) => `
        <tr data-id="${dept.id}">
          <td>${dept.id}</td>
          <td><input data-field="name" value="${escHtml(dept.name)}"></td>
          <td><input data-field="code" value="${escHtml(dept.code)}"></td>
          <td><button class="btn btn-primary btn-sm save-dept">Save</button> <button class="btn btn-danger btn-sm delete-dept">Delete</button></td>
        </tr>`).join('')}</tbody>
      <tfoot><tr><td>New</td><td><input id="seed-new-dept-name"></td><td><input id="seed-new-dept-code"></td><td><button class="btn btn-primary btn-sm" id="seed-add-dept">Add</button></td></tr></tfoot>
    </table>
  `;
  qsa('.save-dept', container).forEach((button) => button.addEventListener('click', async () => {
    const row = button.closest('tr');
    try {
      await api(`/api/departments/${row.dataset.id}`, { method: 'PUT', body: seedRowInputs(row) });
      await refreshAfterMutation('Department updated.');
      await loadSeedData();
    } catch (error) { showToast(error.message, 'error'); }
  }));
  qsa('.delete-dept', container).forEach((button) => button.addEventListener('click', async () => {
    if (!window.confirm('Delete this department?')) return;
    try {
      await api(`/api/departments/${button.closest('tr').dataset.id}`, { method: 'DELETE' });
      await refreshAfterMutation('Department deleted.');
      await loadSeedData();
    } catch (error) { showToast(error.message, 'error'); }
  }));
  byId('seed-add-dept').addEventListener('click', async () => {
    try {
      await api('/api/departments', { method: 'POST', body: { name: byId('seed-new-dept-name').value.trim(), code: byId('seed-new-dept-code').value.trim() } });
      await refreshAfterMutation('Department created.');
      await loadSeedData();
    } catch (error) { showToast(error.message, 'error'); }
  });
}

function renderSeedLevels() {
  const deptOptions = (seedData.departments || []).map((dept) => `<option value="${dept.id}">${escHtml(dept.name)} (${escHtml(dept.code)})</option>`).join('');
  const container = byId('seed-levels');
  container.innerHTML = `
    <table class="data-table">
      <thead><tr><th>ID</th><th>Department</th><th>Rank</th><th>Name</th><th>Top Level</th><th>Actions</th></tr></thead>
      <tbody>${(seedData.dept_levels || []).map((level) => `
        <tr data-id="${level.id}">
          <td>${level.id}</td>
          <td>${escHtml(level.dept_name)}</td>
          <td><input type="number" data-field="level_rank" value="${level.level_rank}"></td>
          <td><input data-field="level_name" value="${escHtml(level.level_name)}"></td>
          <td><input type="checkbox" data-field="is_top_level" ${level.is_top_level ? 'checked' : ''}></td>
          <td><button class="btn btn-primary btn-sm save-level">Save</button> <button class="btn btn-danger btn-sm delete-level">Delete</button></td>
        </tr>`).join('')}</tbody>
      <tfoot><tr><td>New</td><td><select id="seed-new-level-dept">${deptOptions}</select></td><td><input id="seed-new-level-rank" type="number" value="1"></td><td><input id="seed-new-level-name"></td><td><input id="seed-new-level-top" type="checkbox"></td><td><button class="btn btn-primary btn-sm" id="seed-add-level">Add</button></td></tr></tfoot>
    </table>
  `;
  qsa('.save-level', container).forEach((button) => button.addEventListener('click', async () => {
    const row = button.closest('tr');
    try {
      await api(`/api/dept-levels/${row.dataset.id}`, { method: 'PUT', body: seedRowInputs(row) });
      await refreshAfterMutation('Level updated.');
      await loadSeedData();
    } catch (error) { showToast(error.message, 'error'); }
  }));
  qsa('.delete-level', container).forEach((button) => button.addEventListener('click', async () => {
    if (!window.confirm('Delete this level?')) return;
    try {
      await api(`/api/dept-levels/${button.closest('tr').dataset.id}`, { method: 'DELETE' });
      await refreshAfterMutation('Level deleted.');
      await loadSeedData();
    } catch (error) { showToast(error.message, 'error'); }
  }));
  byId('seed-add-level').addEventListener('click', async () => {
    try {
      await api('/api/dept-levels', { method: 'POST', body: { dept_id: Number(byId('seed-new-level-dept').value), level_rank: Number(byId('seed-new-level-rank').value), level_name: byId('seed-new-level-name').value.trim(), is_top_level: byId('seed-new-level-top').checked } });
      await refreshAfterMutation('Level created.');
      await loadSeedData();
    } catch (error) { showToast(error.message, 'error'); }
  });
}

function renderSeedOrgUnits() {
  const deptOptions = (seedData.departments || []).map((dept) => `<option value="${dept.id}">${escHtml(dept.name)} (${escHtml(dept.code)})</option>`).join('');
  const container = byId('seed-org-units');
  container.innerHTML = `
    <table class="data-table">
      <thead><tr><th>ID</th><th>Department</th><th>Name</th><th>Code</th><th>Actions</th></tr></thead>
      <tbody>${(seedData.org_units || []).map((unit) => `
        <tr data-id="${unit.id}">
          <td>${unit.id}</td>
          <td>${escHtml(unit.dept_name)}</td>
          <td><input data-field="name" value="${escHtml(unit.name)}"></td>
          <td><input data-field="code" value="${escHtml(unit.code)}"></td>
          <td><button class="btn btn-primary btn-sm save-org-unit">Save</button> <button class="btn btn-danger btn-sm delete-org-unit">Delete</button></td>
        </tr>`).join('')}</tbody>
      <tfoot><tr><td>New</td><td><select id="seed-new-org-unit-dept">${deptOptions}</select></td><td><input id="seed-new-org-unit-name"></td><td><input id="seed-new-org-unit-code"></td><td><button class="btn btn-primary btn-sm" id="seed-add-org-unit">Add</button></td></tr></tfoot>
    </table>
  `;
  qsa('.save-org-unit', container).forEach((button) => button.addEventListener('click', async () => {
    const row = button.closest('tr');
    try {
      await api(`/api/org-units/${row.dataset.id}`, { method: 'PUT', body: seedRowInputs(row) });
      await refreshAfterMutation('Org unit updated.');
      await loadSeedData();
    } catch (error) { showToast(error.message, 'error'); }
  }));
  qsa('.delete-org-unit', container).forEach((button) => button.addEventListener('click', async () => {
    if (!window.confirm('Delete this org unit?')) return;
    try {
      await api(`/api/org-units/${button.closest('tr').dataset.id}`, { method: 'DELETE' });
      await refreshAfterMutation('Org unit deleted.');
      await loadSeedData();
    } catch (error) { showToast(error.message, 'error'); }
  }));
  byId('seed-add-org-unit').addEventListener('click', async () => {
    try {
      await api('/api/org-units', { method: 'POST', body: { dept_id: Number(byId('seed-new-org-unit-dept').value), name: byId('seed-new-org-unit-name').value.trim(), code: byId('seed-new-org-unit-code').value.trim() } });
      await refreshAfterMutation('Org unit created.');
      await loadSeedData();
    } catch (error) { showToast(error.message, 'error'); }
  });
}

function renderSeedUsers() {
  const levelOptions = (seedData.dept_levels || []).map((level) => `<option value="${level.id}">${escHtml(level.dept_name)} — ${escHtml(level.level_name)} (L${level.level_rank})</option>`).join('');
  const container = byId('seed-users');
  container.innerHTML = `
    <table class="data-table">
      <thead><tr><th>ID</th><th>Name</th><th>Email</th><th>Level</th><th>Active</th><th>Actions</th></tr></thead>
      <tbody>${(seedData.users || []).map((user) => `
        <tr data-id="${user.id}">
          <td>${user.id}</td>
          <td><input data-field="name" value="${escHtml(user.name)}"></td>
          <td><input data-field="email" value="${escHtml(user.email)}"></td>
          <td><select data-field="dept_level_id">${(seedData.dept_levels || []).map((level) => `<option value="${level.id}" ${String(level.id) === String(user.dept_level_id) ? 'selected' : ''}>${escHtml(level.dept_name)} — ${escHtml(level.level_name)} (L${level.level_rank})</option>`).join('')}</select></td>
          <td><input type="checkbox" data-field="is_active" ${user.is_active ? 'checked' : ''}></td>
          <td>
            <button class="btn btn-primary btn-sm save-seed-user">Save</button>
            <button class="btn btn-danger btn-sm delete-seed-user">Delete</button>
          </td>
        </tr>`).join('')}</tbody>
      <tfoot><tr><td>New</td><td><input id="seed-new-user-name"></td><td><input id="seed-new-user-email"></td><td><select id="seed-new-user-level">${levelOptions}</select></td><td>—</td><td><button class="btn btn-primary btn-sm" id="seed-add-user">Add</button></td></tr></tfoot>
    </table>
  `;
  qsa('.save-seed-user', container).forEach((button) => button.addEventListener('click', async () => {
    const row = button.closest('tr');
    try {
      await api(`/api/users/${row.dataset.id}`, { method: 'PUT', body: seedRowInputs(row) });
      await refreshAfterMutation('User updated.');
      await loadSeedData();
    } catch (error) { showToast(error.message, 'error'); }
  }));
  byId('seed-add-user').addEventListener('click', async () => {
    try {
      await api('/api/users', { method: 'POST', body: { name: byId('seed-new-user-name').value.trim(), email: byId('seed-new-user-email').value.trim(), dept_level_id: Number(byId('seed-new-user-level').value) } });
      await refreshAfterMutation('User created.');
      await loadSeedData();
    } catch (error) { showToast(error.message, 'error'); }
  });
  qsa('.delete-seed-user', container).forEach((button) => button.addEventListener('click', async () => {
    try {
      await api(`/api/users/${button.closest('tr').dataset.id}`, { method: 'DELETE' });
      await refreshAfterMutation('User deleted.');
      await loadSeedData();
    } catch (error) { showToast(error.message, 'error'); }
  }));
}

function renderSeedReportingLines() {
  const users = allUsers();
  const options = users.map((user) => `<option value="${user.id}">${escHtml(userLabel(user))}</option>`).join('');
  const container = byId('seed-reporting-lines');
  container.innerHTML = `
    <table class="data-table">
      <thead><tr><th>ID</th><th>User</th><th>Manager</th><th>Primary</th><th>Actions</th></tr></thead>
      <tbody>${(seedData.reporting_lines || []).map((line) => `
        <tr data-id="${line.id}">
          <td>${line.id}</td>
          <td>${escHtml(line.user_name)}</td>
          <td>${escHtml(line.manager_name || '—')}</td>
          <td>${line.is_primary ? 'Yes' : 'No'}</td>
          <td><button class="btn btn-danger btn-sm delete-reporting-line">Delete</button></td>
        </tr>`).join('')}</tbody>
      <tfoot><tr><td>New</td><td><select id="seed-new-report-user">${options}</select></td><td><select id="seed-new-report-manager">${options}</select></td><td>Yes</td><td><button class="btn btn-primary btn-sm" id="seed-add-reporting-line">Add</button></td></tr></tfoot>
    </table>
  `;
  qsa('.delete-reporting-line', container).forEach((button) => button.addEventListener('click', async () => {
    if (!window.confirm('Delete this reporting line?')) return;
    try {
      await api(`/api/reporting-lines/${button.closest('tr').dataset.id}`, { method: 'DELETE' });
      await refreshAfterMutation('Reporting line deleted.');
      await loadSeedData();
    } catch (error) { showToast(error.message, 'error'); }
  }));
  byId('seed-add-reporting-line').addEventListener('click', async () => {
    try {
      await api('/api/reporting-lines', { method: 'POST', body: { user_id: Number(byId('seed-new-report-user').value), manager_id: Number(byId('seed-new-report-manager').value) } });
      await refreshAfterMutation('Reporting line created.');
      await loadSeedData();
    } catch (error) { showToast(error.message, 'error'); }
  });
}

function renderSeedActions() {
  const container = byId('seed-actions');
  container.innerHTML = `
    <table class="data-table">
      <thead><tr><th>ID</th><th>Name</th><th>Code</th><th>Project Scoped</th><th>Actions</th></tr></thead>
      <tbody>${(seedData.actions || []).map((action) => `
        <tr data-id="${action.id}">
          <td>${action.id}</td>
          <td><input data-field="name" value="${escHtml(action.name)}"></td>
          <td><input data-field="code" value="${escHtml(action.code)}"></td>
          <td><input type="checkbox" data-field="is_project_scoped" ${action.is_project_scoped ? 'checked' : ''}></td>
          <td><button class="btn btn-primary btn-sm save-seed-action">Save</button> <button class="btn btn-danger btn-sm delete-seed-action">Delete</button></td>
        </tr>`).join('')}</tbody>
      <tfoot><tr><td>New</td><td><input id="seed-new-action-name"></td><td><input id="seed-new-action-code"></td><td><input id="seed-new-action-project" type="checkbox"></td><td><button class="btn btn-primary btn-sm" id="seed-add-action">Add</button></td></tr></tfoot>
    </table>
  `;
  qsa('.save-seed-action', container).forEach((button) => button.addEventListener('click', async () => {
    const row = button.closest('tr');
    try {
      await api(`/api/actions/${row.dataset.id}`, { method: 'PUT', body: seedRowInputs(row) });
      await refreshAfterMutation('Action updated.');
      await loadSeedData();
    } catch (error) { showToast(error.message, 'error'); }
  }));
  qsa('.delete-seed-action', container).forEach((button) => button.addEventListener('click', async () => {
    if (!window.confirm('Delete this action?')) return;
    try {
      await api(`/api/actions/${button.closest('tr').dataset.id}`, { method: 'DELETE' });
      await refreshAfterMutation('Action deleted.');
      await loadSeedData();
    } catch (error) { showToast(error.message, 'error'); }
  }));
  byId('seed-add-action').addEventListener('click', async () => {
    try {
      await api('/api/actions', { method: 'POST', body: { name: byId('seed-new-action-name').value.trim(), code: byId('seed-new-action-code').value.trim(), is_project_scoped: byId('seed-new-action-project').checked } });
      await refreshAfterMutation('Action created.');
      await loadSeedData();
    } catch (error) { showToast(error.message, 'error'); }
  });
}

function renderSeedRoutingRules() {
  const container = byId('seed-routing-rules');
  container.innerHTML = `
    <table class="data-table">
      <thead><tr><th>ID</th><th>Action</th><th>Department</th><th>Primary</th><th>Second Level</th><th>Actions</th></tr></thead>
      <tbody>${(seedData.routing_rules || []).map((rule) => `
        <tr data-id="${rule.id}">
          <td>${rule.id}</td>
          <td>${escHtml(rule.action_name)}</td>
          <td>${escHtml(rule.dept_name)}</td>
          <td><input type="checkbox" data-field="requires_primary" ${rule.requires_primary ? 'checked' : ''}></td>
          <td><input type="checkbox" data-field="requires_second_level" ${rule.requires_second_level ? 'checked' : ''}></td>
          <td><button class="btn btn-primary btn-sm save-routing-rule">Save</button></td>
        </tr>`).join('')}</tbody>
    </table>
  `;
  qsa('.save-routing-rule', container).forEach((button) => button.addEventListener('click', async () => {
    const row = button.closest('tr');
    try {
      await api(`/api/routing-rules/${row.dataset.id}`, { method: 'PUT', body: seedRowInputs(row) });
      await refreshAfterMutation('Routing rule updated.');
      await loadSeedData();
    } catch (error) { showToast(error.message, 'error'); }
  }));
}

function renderSeedFallbackRules() {
  const container = byId('seed-fallback-rules');
  container.innerHTML = `
    <table class="data-table">
      <thead><tr><th>ID</th><th>Department</th><th>Fallback User</th><th>Label</th><th>Actions</th></tr></thead>
      <tbody>${(seedData.fallback_rules || []).map((rule) => `
        <tr data-id="${rule.id}">
          <td>${rule.id}</td>
          <td>${escHtml(rule.dept_name)}</td>
          <td><select data-field="fallback_user_id">${allUsers().map((user) => `<option value="${user.id}" ${String(user.id) === String(rule.fallback_user_id) ? 'selected' : ''}>${escHtml(user.name)}</option>`).join('')}</select></td>
          <td><input data-field="fallback_label" value="${escHtml(rule.fallback_label || '')}"></td>
          <td><button class="btn btn-primary btn-sm save-fallback-rule">Save</button></td>
        </tr>`).join('')}</tbody>
    </table>
  `;
  qsa('.save-fallback-rule', container).forEach((button) => button.addEventListener('click', async () => {
    const row = button.closest('tr');
    try {
      await api(`/api/fallback-rules/${row.dataset.id}`, { method: 'PUT', body: seedRowInputs(row) });
      await refreshAfterMutation('Fallback rule updated.');
      await loadSeedData();
    } catch (error) { showToast(error.message, 'error'); }
  }));
}

async function exportSeedData() {
  try {
    const payload = seedData || (await api('/api/seed-data'));
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'seed-data.json';
    anchor.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function resetToDefault() {
  await resetDatabase();
}

function showAddUserModal() {
  if (!requireAdmin('add users')) return;
  byId('user-name').value = '';
  byId('user-email').value = '';
  byId('user-active').checked = true;
  if (allDepartments()[0]) byId('user-dept').value = String(allDepartments()[0].id);
  syncUserModalDeptFields();
  setSelectOptions(byId('user-manager'), userOptions(true, '— None / Top-level —'));
  openModal('user-modal');
}

async function saveUser() {
  if (!requireAdmin('save users')) return;
  const createBody = {
    name: byId('user-name').value.trim(),
    email: byId('user-email').value.trim(),
    dept_level_id: Number(byId('user-level').value),
  };
  if (!createBody.name || !createBody.email || !createBody.dept_level_id) {
    showToast('Name, email and level are required.', 'error');
    return;
  }
  try {
    const created = await api('/api/users', { method: 'POST', body: createBody });
    const userId = created.user?.id || created.id || created.user_id;
    if (userId) {
      const body = {
        user_id: userId,
        dept_level_id: createBody.dept_level_id,
        is_active: byId('user-active').checked,
      };
      const orgUnitId = byId('user-org-unit').value;
      const managerId = byId('user-manager').value;
      if (orgUnitId) body.org_unit_id = Number(orgUnitId);
      if (managerId) body.manager_id = Number(managerId);
      await api('/api/diagram/update-node', { method: 'POST', body });
    }
    closeModal('user-modal');
    await refreshAfterMutation('User created.');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function initializeApp() {
  bindNavigation();
  bindGlobalUi();
  try {
    await reloadCoreData();
    await loadDashboardStats();
    updateRoleUi();
    setPageActive('dashboard');
    setSeedTabActive('departments');
    setSidebarTabActive('profile');
    initItsoCases();
    initTestDiagramPage();
    initScenarioBuilderPage();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

Object.assign(window, {
  openModal,
  closeModal,
  openDeptDiagram,
  openITSOCases,
  resetDatabase,
  showAddActionModal,
  saveAction,
  showAddTemplateModal,
  saveTemplate,
  loadDepartmentDiagram,
  showAddUserModal,
  saveUser,
  highlightActionRoute,
  searchUsers,
  saveSidebarChanges,
  closeDiagramSidebar,
  showAddOverlayModal,
  loadOverlays,
  saveOverlay,
  loadAuditLogs,
  loadValidationIssues,
  addTestOverlay,
  runTestDiagram,
  runScenario,
  exportSeedData,
  resetToDefault,
});

document.addEventListener('DOMContentLoaded', initializeApp);
})();
