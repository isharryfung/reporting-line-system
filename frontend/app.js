// ============================================================
// University Reporting-Line System POC — app.js
// ============================================================

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let bootstrap = null;          // bootstrap payload from /api/bootstrap
let seedData = null;           // from /api/seed-data
let selectedNode = null;       // currently selected diagram node (user object)
let currentDiagramDept = null; // department code shown in diagram

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function renderPrettyJson(value) {
  return JSON.stringify(value, null, 2);
}

function createOption(value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

function showError(el, msg) {
  el.textContent = msg;
  el.classList.remove("hidden");
}

function hideError(el) {
  el.classList.add("hidden");
  el.textContent = "";
}

// ---------------------------------------------------------------------------
// Tab navigation
// ---------------------------------------------------------------------------
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.tab;
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".tab-content").forEach((tc) => {
      tc.classList.toggle("hidden", !tc.id.startsWith(`tab-${target}`));
      tc.classList.toggle("active", tc.id.startsWith(`tab-${target}`));
    });
    // Refresh diagram on switching to diagram tab
    if (target === "diagram" && bootstrap) {
      renderDiagram(currentDiagramDept || bootstrap.departments[0].code);
    }
    if (target === "seed-editor") {
      loadSeedData();
    }
    if (target === "scenario-lab" && bootstrap) {
      initScenarioLab();
    }
  });
});

// ---------------------------------------------------------------------------
// Seed sub-tab navigation
// ---------------------------------------------------------------------------
document.querySelectorAll(".seed-tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.seed;
    document.querySelectorAll(".seed-tab-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".seed-tab-content").forEach((tc) => {
      tc.classList.toggle("hidden", tc.id !== `seed-tab-${target}`);
    });
  });
});

// ---------------------------------------------------------------------------
// Overview tab
// ---------------------------------------------------------------------------
function renderSeedUsers(users) {
  const seedUsers = document.querySelector("#seed-users");
  seedUsers.replaceChildren(
    ...users.map((user) => {
      const pill = document.createElement("article");
      pill.className = "pill";
      pill.innerHTML = `
        <strong>${user.name}</strong>
        <span>${user.department_code} · ${user.level_name}</span>
        <span>Level ${user.level_rank}</span>
        <span>${user.org_units.join(", ") || "No org-unit"}</span>
        <span>${user.is_team_lead ? "Team Lead" : "Member"}</span>
      `;
      return pill;
    })
  );
}

function renderNotes(items) {
  const notes = document.querySelector("#notes");
  notes.replaceChildren(
    ...items.map((item) => {
      const li = document.createElement("li");
      li.textContent = item;
      return li;
    })
  );
}

function renderBusinessCases(cases) {
  const businessCaseBody = document.querySelector("#business-case-body");
  businessCaseBody.replaceChildren(
    ...cases.map((item) => {
      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${item.id}</td>
        <td>${item.scenario}</td>
        <td>${item.input}</td>
        <td>${item.preconditions}</td>
        <td>${item.expected_output}</td>
        <td>${item.pass_criteria}</td>
      `;
      return row;
    })
  );
}

function renderOrgChart(chart) {
  const orgChart = document.querySelector("#org-chart");
  const units = chart.org_units
    .map((orgUnit) => {
      const teamLeads = orgUnit.team_leads.map((lead) => lead.name).join(", ") || "None";
      const coHeads = orgUnit.co_heads
        .map((lead) => `${lead.name}${lead.is_primary ? " (primary)" : ""} · ${lead.policy}`)
        .join(", ");
      const members = orgUnit.members
        .map(
          (member) =>
            `<li><strong>${member.name}</strong> — ${member.level_name} (Level ${member.level_rank}) · Manager: ${
              member.manager_name || "None"
            }${member.is_team_lead ? " · Team Lead" : ""}</li>`
        )
        .join("");
      return `
        <article class="org-unit-card">
          <h3>${orgUnit.name}</h3>
          <p><strong>Team leads:</strong> ${teamLeads}</p>
          <p><strong>Co-heads:</strong> ${coHeads || "None"}</p>
          <ul>${members}</ul>
        </article>
      `;
    })
    .join("");

  const unassigned = chart.unassigned_users.length
    ? `
      <article class="org-unit-card">
        <h3>Unassigned / department leadership</h3>
        <ul>
          ${chart.unassigned_users
            .map(
              (user) =>
                `<li><strong>${user.name}</strong> — ${user.level_name} (Level ${user.level_rank})${
                  user.is_team_lead ? " · Team Lead" : ""
                }</li>`
            )
            .join("")}
        </ul>
      </article>
    `
    : "";

  const fallback = chart.fallback_approver
    ? `${chart.fallback_approver.name} (${chart.fallback_approver.label})`
    : "Not configured";

  orgChart.innerHTML = `
    <p><strong>Department fallback approver:</strong> ${fallback}</p>
    <div class="org-unit-grid">${units}${unassigned}</div>
  `;
}

function renderAdvancedScenarios(items) {
  const scenarioList = document.querySelector("#scenario-list");
  const scenarioOutput = document.querySelector("#scenario-output");
  scenarioList.replaceChildren(
    ...items.map((item) => {
      const article = document.createElement("article");
      article.className = "pill";
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = item.title;
      button.addEventListener("click", async () => {
        const response = await fetch("/api/simulate-scenario", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scenario_id: item.id }),
        });
        const payload = await response.json();
        scenarioOutput.textContent = renderPrettyJson(payload);
      });
      const description = document.createElement("span");
      description.textContent = item.description;
      article.append(button, description);
      return article;
    })
  );
}

async function loadOrgChart(departmentCode) {
  const response = await fetch(`/api/org-chart?department=${encodeURIComponent(departmentCode)}`);
  const payload = await response.json();
  renderOrgChart(payload);
}

// ---------------------------------------------------------------------------
// Bootstrap / initial load
// ---------------------------------------------------------------------------
async function loadBootstrap() {
  const response = await fetch("/api/bootstrap");
  bootstrap = await response.json();

  renderSeedUsers(bootstrap.users);
  renderNotes(bootstrap.notes);
  renderBusinessCases(bootstrap.business_cases);
  renderAdvancedScenarios(bootstrap.advanced_scenarios);

  const deptSelectOverview = document.querySelector("#department-select-overview");
  const deptSelectDiagram = document.querySelector("#department-select-diagram");

  [deptSelectOverview, deptSelectDiagram].forEach((sel) => {
    sel.replaceChildren(
      ...bootstrap.departments.map((d) => createOption(d.code, `${d.name} (${d.code})`))
    );
  });
  // Diagram supports an extra "All Departments" combined view.
  deptSelectDiagram.insertBefore(
    createOption("ALL", "All Departments"),
    deptSelectDiagram.firstChild
  );

  const requesterSelect = document.querySelector("#requester-select");
  const editorSelect = document.querySelector("#editor-select");
  const targetSelect = document.querySelector("#target-select");
  const actionSelect = document.querySelector("#action-select");

  [requesterSelect, editorSelect, targetSelect].forEach((sel) => {
    sel.replaceChildren(
      ...bootstrap.users.map((user) =>
        createOption(user.id, `${user.name} — ${user.department_code} / ${user.level_name}`)
      )
    );
  });
  actionSelect.replaceChildren(
    ...bootstrap.actions.map((action) => createOption(action.code, action.name))
  );

  await loadOrgChart(deptSelectOverview.value);
  currentDiagramDept = deptSelectDiagram.value;
  renderDiagram(currentDiagramDept);
}

document.querySelector("#department-select-overview").addEventListener("change", (e) =>
  loadOrgChart(e.target.value)
);
document.querySelector("#department-select-diagram").addEventListener("change", (e) => {
  currentDiagramDept = e.target.value;
  renderDiagram(currentDiagramDept);
});

// ---------------------------------------------------------------------------
// Routing form
// ---------------------------------------------------------------------------
document.querySelector("#routing-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const requesterSelect = document.querySelector("#requester-select");
  const actionSelect = document.querySelector("#action-select");
  const requestAtInput = document.querySelector("#request-at-input");
  const projectCodeInput = document.querySelector("#project-code-input");
  const routingOutput = document.querySelector("#routing-output");

  const response = await fetch("/api/simulate-request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requester_id: Number(requesterSelect.value),
      action_code: actionSelect.value,
      request_at: requestAtInput.value ? `${requestAtInput.value}:00+00:00` : null,
      project_code: projectCodeInput.value || null,
    }),
  });
  const payload = await response.json();
  routingOutput.textContent = renderPrettyJson(payload);
});

document.querySelector("#permission-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const editorSelect = document.querySelector("#editor-select");
  const targetSelect = document.querySelector("#target-select");
  const permissionOutput = document.querySelector("#permission-output");

  const response = await fetch("/api/team-lead-permission", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      editor_id: Number(editorSelect.value),
      target_user_id: Number(targetSelect.value),
    }),
  });
  const payload = await response.json();
  permissionOutput.textContent = renderPrettyJson(payload);
});

// ---------------------------------------------------------------------------
// DIAGRAM EDITOR
// ---------------------------------------------------------------------------
const NODE_W = 140;
const NODE_H = 48;
const LEVEL_H = 100;   // vertical gap between level rows
const LEFT_PAD = 60;
const TOP_PAD = 40;
const LEVEL_LABEL_X = 8;

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

  const svg = document.getElementById("diagram-svg");
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

  // Group by level_rank
  const levelMap = {};
  users.forEach((u) => {
    if (!levelMap[u.level_rank]) levelMap[u.level_rank] = [];
    levelMap[u.level_rank].push(u);
  });
  const sortedLevels = Object.keys(levelMap).map(Number).sort((a, b) => a - b);

  // Determine a consistent department order so each department forms a
  // vertical column-group that stays aligned across every level row.
  const DEPT_KEY = (u) => u.department_code || "—";
  const deptCodes = [];
  users.forEach((u) => {
    const code = DEPT_KEY(u);
    if (!deptCodes.includes(code)) deptCodes.push(code);
  });
  deptCodes.sort();
  const groupByDept = deptCodes.length > 1;

  const COL_GAP = 20;    // gap between nodes within a department block
  const DEPT_GAP = 60;   // extra gap separating department blocks

  // Width of each department block = max users it has on any single level.
  const deptMaxCount = {};
  deptCodes.forEach((code) => (deptMaxCount[code] = 0));
  sortedLevels.forEach((rank) => {
    const counts = {};
    levelMap[rank].forEach((u) => {
      const code = DEPT_KEY(u);
      counts[code] = (counts[code] || 0) + 1;
    });
    deptCodes.forEach((code) => {
      deptMaxCount[code] = Math.max(deptMaxCount[code], counts[code] || 0);
    });
  });

  // Horizontal start offset + block width for each department.
  const deptStartX = {};
  const deptBlockW = {};
  let cursor = LEFT_PAD;
  deptCodes.forEach((code) => {
    const blockW = Math.max(deptMaxCount[code], 1) * (NODE_W + COL_GAP) - COL_GAP;
    deptStartX[code] = cursor;
    deptBlockW[code] = blockW;
    cursor += blockW + DEPT_GAP;
  });

  // Assign positions: within each level row, place each department's users
  // inside that department's block, centered horizontally within the block.
  const posMap = {};  // user.id → {x, y}
  sortedLevels.forEach((rank, rowIdx) => {
    const y = TOP_PAD + rowIdx * LEVEL_H;
    const byDept = {};
    levelMap[rank].forEach((u) => {
      const code = DEPT_KEY(u);
      (byDept[code] = byDept[code] || []).push(u);
    });
    deptCodes.forEach((code) => {
      const group = byDept[code] || [];
      const groupW = group.length * (NODE_W + COL_GAP) - COL_GAP;
      const offset = Math.max(0, (deptBlockW[code] - groupW) / 2);
      group.forEach((u, i) => {
        posMap[u.id] = {
          x: deptStartX[code] + offset + i * (NODE_W + COL_GAP),
          y,
        };
      });
    });
  });

  // Calculate SVG dimensions
  let maxX = 0, maxY = 0;
  Object.values(posMap).forEach(({ x, y }) => {
    maxX = Math.max(maxX, x + NODE_W);
    maxY = Math.max(maxY, y + NODE_H);
  });
  const svgW = Math.max(maxX + LEFT_PAD, 600);
  const svgH = maxY + 60;
  svg.setAttribute("viewBox", `0 0 ${svgW} ${svgH}`);
  svg.style.height = `${svgH}px`;

  const ns = "http://www.w3.org/2000/svg";

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
    });
  }

  // Level bands and labels
  sortedLevels.forEach((rank, rowIdx) => {
    const y = TOP_PAD + rowIdx * LEVEL_H;
    // Dashed horizontal guide line
    const line = document.createElementNS(ns, "line");
    line.setAttribute("x1", 0);
    line.setAttribute("y1", y - 10);
    line.setAttribute("x2", svgW);
    line.setAttribute("y2", y - 10);
    line.setAttribute("class", "level-band");
    svg.appendChild(line);
    // Level label
    const text = document.createElementNS(ns, "text");
    text.setAttribute("x", LEVEL_LABEL_X);
    text.setAttribute("y", y + NODE_H / 2 + 4);
    text.setAttribute("class", "level-label");
    text.textContent = `L${rank}`;
    svg.appendChild(text);
  });

  // Reporting-line edges (draw behind nodes)
  const edgeGroup = document.createElementNS(ns, "g");
  svg.appendChild(edgeGroup);

  users.forEach((u) => {
    if (!u.manager_name) return;
    const manager = users.find((m) => m.name === u.manager_name);
    if (!manager) return;
    const from = posMap[manager.id];
    const to = posMap[u.id];
    if (!from || !to) return;

    const line = document.createElementNS(ns, "line");
    line.setAttribute("x1", from.x + NODE_W / 2);
    line.setAttribute("y1", from.y + NODE_H);
    line.setAttribute("x2", to.x + NODE_W / 2);
    line.setAttribute("y2", to.y);
    line.setAttribute("class", "diagram-edge");
    // Arrow marker
    line.setAttribute("marker-end", "url(#arrow)");
    edgeGroup.appendChild(line);
  });

  // Arrow marker definition
  const defs = document.createElementNS(ns, "defs");
  defs.innerHTML = `
    <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="#4a7fcb" />
    </marker>
  `;
  svg.insertBefore(defs, svg.firstChild);

  // Nodes
  users.forEach((u) => {
    const pos = posMap[u.id];
    const g = document.createElementNS(ns, "g");
    g.setAttribute("class", "diagram-node" + (selectedNode && selectedNode.id === u.id ? " selected" : ""));
    g.setAttribute("transform", `translate(${pos.x},${pos.y})`);
    g.dataset.userId = u.id;

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
      (departmentCode === "ALL" && u.department_code ? ` [${u.department_code}]` : "") +
      (u.is_team_lead ? " ★" : "");
    g.appendChild(nameText);

    // Level
    const levelText = document.createElementNS(ns, "text");
    levelText.setAttribute("x", NODE_W / 2);
    levelText.setAttribute("y", 34);
    levelText.setAttribute("class", "node-level");
    levelText.textContent = `${u.level_name} (L${u.level_rank})`;
    g.appendChild(levelText);

    g.addEventListener("click", () => openEditPanel(u));
    svg.appendChild(g);
  });
}

// ---------------------------------------------------------------------------
// Edit Panel
// ---------------------------------------------------------------------------
const editPanel = document.getElementById("edit-panel");
const editPanelTitle = document.getElementById("edit-panel-title");
const editNodeForm = document.getElementById("edit-node-form");
const editUserId = document.getElementById("edit-user-id");
const editName = document.getElementById("edit-name");
const editEmail = document.getElementById("edit-email");
const editLevel = document.getElementById("edit-level");
const editOrgUnit = document.getElementById("edit-org-unit");
const editTeamLead = document.getElementById("edit-team-lead");
const editManager = document.getElementById("edit-manager");
const editError = document.getElementById("edit-error");

document.getElementById("edit-panel-close").addEventListener("click", closeEditPanel);
document.getElementById("edit-cancel-btn").addEventListener("click", closeEditPanel);

function openEditPanel(user) {
  selectedNode = user;
  editPanel.classList.remove("hidden");
  editPanelTitle.textContent = `Edit: ${user.name}`;
  editUserId.value = user.id;
  editName.value = user.name;
  editEmail.value = user.email;
  hideError(editError);

  // Re-highlight selected node
  document.querySelectorAll(".diagram-node").forEach((n) => {
    n.classList.toggle("selected", Number(n.dataset.userId) === user.id);
  });

  // Populate level options from seed data
  loadSeedDataIfNeeded().then(() => {
    const levels = seedData ? seedData.dept_levels : [];
    editLevel.replaceChildren(
      ...levels.map((lv) =>
        createOption(lv.id, `${lv.dept_name} – ${lv.level_name} (L${lv.level_rank})`)
      )
    );
    editLevel.value = user.dept_level_id;

    // Populate org-unit options
    const orgUnits = seedData ? seedData.org_units : [];
    editOrgUnit.replaceChildren(
      createOption("", "— none —"),
      ...orgUnits.map((ou) => createOption(ou.id, `${ou.dept_name} / ${ou.name}`))
    );
    // Set current org unit (first active one)
    if (user.org_unit_ids && user.org_unit_ids.length > 0) {
      editOrgUnit.value = user.org_unit_ids[0];
    } else {
      editOrgUnit.value = "";
    }

    editTeamLead.checked = user.is_team_lead;

    // Populate manager options (all active users except self)
    const allUsers = bootstrap ? bootstrap.users : [];
    editManager.replaceChildren(
      createOption("", "— none / top-level —"),
      ...allUsers
        .filter((u) => u.id !== user.id)
        .map((u) => createOption(u.id, `${u.name} — ${u.department_code} / ${u.level_name}`))
    );
    editManager.value = user.manager_id || "";
  });
}

function closeEditPanel() {
  editPanel.classList.add("hidden");
  selectedNode = null;
  document.querySelectorAll(".diagram-node").forEach((n) => n.classList.remove("selected"));
  hideError(editError);
}

editNodeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideError(editError);

  const userId = Number(editUserId.value);
  const body = {
    user_id: userId,
    name: editName.value.trim(),
    email: editEmail.value.trim(),
    dept_level_id: Number(editLevel.value) || undefined,
    is_team_lead: editTeamLead.checked,
  };

  const ouVal = editOrgUnit.value;
  if (ouVal) body.org_unit_id = Number(ouVal);

  const mgrVal = editManager.value;
  if (mgrVal !== "") {
    body.manager_id = Number(mgrVal);
  }

  const resp = await fetch("/api/diagram/update-node", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await resp.json();

  if (!resp.ok || result.error) {
    showError(editError, result.error || "Unknown error");
    return;
  }

  // Refresh data
  await refreshAll();
  closeEditPanel();
});

// ---------------------------------------------------------------------------
// Seed Data Editor
// ---------------------------------------------------------------------------
async function loadSeedDataIfNeeded() {
  if (!seedData) await loadSeedData();
}

async function loadSeedData() {
  const response = await fetch("/api/seed-data");
  seedData = await response.json();
  renderSeedTables(seedData);
}

function renderSeedTables(data) {
  renderUsersTable(data.users, data.dept_levels);
  renderLevelsTable(data.dept_levels);
  renderRlTable(data.reporting_lines);
  renderRoutingRulesTable(data.routing_rules);
  renderFallbackTable(data.fallback_rules, data.users);
  renderActionsTable(data.actions);
  renderDepartmentsTable(data.departments);
  renderOrgUnitsTable(data.org_units);
}

// Users table
function renderUsersTable(users, levels) {
  const tbody = document.getElementById("users-tbody");
  tbody.replaceChildren(
    ...users.map((u) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${u.id}</td>
        <td><input class="cell-input" data-field="name" data-id="${u.id}" value="${escHtml(u.name)}" /></td>
        <td><input class="cell-input" data-field="email" data-id="${u.id}" value="${escHtml(u.email)}" /></td>
        <td>${escHtml(u.dept_name)}</td>
        <td>
          <select class="cell-select" data-field="dept_level_id" data-id="${u.id}">
            ${levels.map((lv) => `<option value="${lv.id}" ${lv.id === u.dept_level_id ? "selected" : ""}>${lv.dept_name} – ${escHtml(lv.level_name)} (L${lv.level_rank})</option>`).join("")}
          </select>
        </td>
        <td>${u.level_rank}</td>
        <td><input type="checkbox" class="cell-check" data-field="is_active" data-id="${u.id}" ${u.is_active ? "checked" : ""} /></td>
        <td>
          <button type="button" class="btn-small save-user-btn" data-id="${u.id}">Save</button>
        </td>
      `;
      return tr;
    })
  );

  tbody.querySelectorAll(".save-user-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.dataset.id);
      const row = btn.closest("tr");
      const body = {};
      row.querySelectorAll("[data-field]").forEach((el) => {
        const field = el.dataset.field;
        if (el.type === "checkbox") body[field] = el.checked;
        else body[field] = el.type === "number" ? Number(el.value) : el.value;
      });
      const resp = await fetch(`/api/users/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await resp.json();
      if (!resp.ok) {
        alert(result.error || "Error saving user");
        return;
      }
      await refreshAll();
    });
  });

  // Populate new-user level select
  const newUserLevel = document.getElementById("new-user-level");
  if (newUserLevel) {
    newUserLevel.replaceChildren(
      ...levels.map((lv) =>
        createOption(lv.id, `${lv.dept_name} – ${lv.level_name} (L${lv.level_rank})`)
      )
    );
  }
}

// Levels table
function renderLevelsTable(levels) {
  const tbody = document.getElementById("levels-tbody");
  tbody.replaceChildren(
    ...levels.map((lv) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${lv.id}</td>
        <td>${escHtml(lv.dept_name)}</td>
        <td><input type="number" class="cell-input" data-field="level_rank" data-id="${lv.id}" value="${lv.level_rank}" style="width:5rem" /></td>
        <td><input class="cell-input" data-field="level_name" data-id="${lv.id}" value="${escHtml(lv.level_name)}" /></td>
        <td><input type="checkbox" class="cell-check" data-field="is_top_level" data-id="${lv.id}" ${lv.is_top_level ? "checked" : ""} /></td>
        <td>
          <button type="button" class="btn-small save-level-btn" data-id="${lv.id}">Save</button>
          <button type="button" class="btn-small btn-danger delete-level-btn" data-id="${lv.id}">Remove</button>
        </td>
      `;
      return tr;
    })
  );

  tbody.querySelectorAll(".save-level-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.dataset.id);
      const row = btn.closest("tr");
      const body = {};
      row.querySelectorAll("[data-field]").forEach((el) => {
        const field = el.dataset.field;
        if (el.type === "checkbox") body[field] = el.checked;
        else if (el.type === "number") body[field] = Number(el.value);
        else body[field] = el.value;
      });
      const resp = await fetch(`/api/dept-levels/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await resp.json();
      if (!resp.ok) {
        alert(result.error || "Error saving level");
        return;
      }
      await refreshAll();
    });
  });

  tbody.querySelectorAll(".delete-level-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Remove this level?")) return;
      const id = Number(btn.dataset.id);
      const resp = await fetch(`/api/dept-levels/${id}`, { method: "DELETE" });
      const result = await resp.json();
      if (!resp.ok) {
        alert(result.error || "Error removing level");
        return;
      }
      await refreshAll();
    });
  });
}

// Reporting lines table
function renderRlTable(lines) {
  const tbody = document.getElementById("rl-tbody");
  tbody.replaceChildren(
    ...lines.map((rl) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${rl.id}</td>
        <td>${escHtml(rl.user_name)}</td>
        <td>${escHtml(rl.manager_name || "—")}</td>
        <td>${rl.dept_id}</td>
        <td>${rl.is_primary ? "✓" : ""}</td>
        <td>
          <button type="button" class="btn-small btn-danger delete-rl-btn" data-id="${rl.id}">Remove</button>
        </td>
      `;
      return tr;
    })
  );

  tbody.querySelectorAll(".delete-rl-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Remove this reporting line?")) return;
      const id = Number(btn.dataset.id);
      const resp = await fetch(`/api/reporting-lines/${id}`, { method: "DELETE" });
      if (!resp.ok) {
        const r = await resp.json();
        alert(r.error || "Error");
        return;
      }
      await refreshAll();
    });
  });

  // Populate add-RL user/manager selects
  const allUsers = bootstrap ? bootstrap.users : [];
  const rlUser = document.getElementById("new-rl-user");
  const rlMgr = document.getElementById("new-rl-manager");
  if (rlUser && rlMgr) {
    const opts = allUsers.map((u) =>
      createOption(u.id, `${u.name} — ${u.department_code} / ${u.level_name}`)
    );
    rlUser.replaceChildren(...opts);
    rlMgr.replaceChildren(...opts.map((o) => o.cloneNode(true)));
  }
}

function renderRoutingRulesTable(rules) {
  const tbody = document.getElementById("routing-rules-tbody");
  tbody.replaceChildren(
    ...rules.map((rr) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${rr.id}</td>
        <td>${escHtml(rr.action_name)}</td>
        <td>${escHtml(rr.dept_name)}</td>
        <td><input type="checkbox" class="cell-check" data-field="requires_primary" data-id="${rr.id}" ${rr.requires_primary ? "checked" : ""} /></td>
        <td><input type="checkbox" class="cell-check" data-field="requires_second_level" data-id="${rr.id}" ${rr.requires_second_level ? "checked" : ""} /></td>
        <td><button type="button" class="btn-small save-rr-btn" data-id="${rr.id}">Save</button></td>
      `;
      return tr;
    })
  );

  tbody.querySelectorAll(".save-rr-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.dataset.id);
      const row = btn.closest("tr");
      const body = {};
      row.querySelectorAll("[data-field]").forEach((el) => {
        body[el.dataset.field] = el.type === "checkbox" ? el.checked : el.value;
      });
      const resp = await fetch(`/api/routing-rules/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const r = await resp.json();
        alert(r.error || "Error saving rule");
      }
    });
  });
}

function renderFallbackTable(rules, users) {
  const tbody = document.getElementById("fallback-tbody");
  tbody.replaceChildren(
    ...rules.map((fb) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${fb.id}</td>
        <td>${escHtml(fb.dept_name)}</td>
        <td>
          <select class="cell-select" data-field="fallback_user_id" data-id="${fb.id}">
            ${users.map((u) => `<option value="${u.id}" ${u.id === fb.fallback_user_id ? "selected" : ""}>${escHtml(u.name)}</option>`).join("")}
          </select>
        </td>
        <td><input class="cell-input" data-field="fallback_label" data-id="${fb.id}" value="${escHtml(fb.fallback_label || "")}" /></td>
        <td><button type="button" class="btn-small save-fb-btn" data-id="${fb.id}">Save</button></td>
      `;
      return tr;
    })
  );

  tbody.querySelectorAll(".save-fb-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.dataset.id);
      const row = btn.closest("tr");
      const body = {};
      row.querySelectorAll("[data-field]").forEach((el) => {
        body[el.dataset.field] = el.type === "number" ? Number(el.value) : el.value;
      });
      const resp = await fetch(`/api/fallback-rules/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const r = await resp.json();
        alert(r.error || "Error saving fallback rule");
      }
    });
  });
}

function renderActionsTable(actions) {
  const tbody = document.getElementById("actions-tbody");
  tbody.replaceChildren(
    ...actions.map((a) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${a.id}</td>
        <td><input class="cell-input" data-field="name" data-id="${a.id}" value="${escHtml(a.name)}" /></td>
        <td><input class="cell-input" data-field="code" data-id="${a.id}" value="${escHtml(a.code)}" /></td>
        <td><input type="checkbox" class="cell-check" data-field="is_project_scoped" data-id="${a.id}" ${a.is_project_scoped ? "checked" : ""} /></td>
        <td>
          <button type="button" class="btn-small save-action-btn" data-id="${a.id}">Save</button>
          <button type="button" class="btn-small btn-danger delete-action-btn" data-id="${a.id}">Remove</button>
        </td>
      `;
      return tr;
    })
  );

  tbody.querySelectorAll(".save-action-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.dataset.id);
      const row = btn.closest("tr");
      const body = {};
      row.querySelectorAll("[data-field]").forEach((el) => {
        body[el.dataset.field] = el.type === "checkbox" ? el.checked : el.value;
      });
      const resp = await fetch(`/api/actions/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await resp.json();
      if (!resp.ok) {
        alert(result.error || "Error saving action");
        return;
      }
      await refreshAll();
    });
  });

  tbody.querySelectorAll(".delete-action-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Remove this action (and its routing rules)?")) return;
      const id = Number(btn.dataset.id);
      const resp = await fetch(`/api/actions/${id}`, { method: "DELETE" });
      const result = await resp.json();
      if (!resp.ok) {
        alert(result.error || "Error removing action");
        return;
      }
      await refreshAll();
    });
  });
}

function renderDepartmentsTable(depts) {
  const tbody = document.getElementById("departments-tbody");
  tbody.replaceChildren(
    ...depts.map((d) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${d.id}</td>
        <td><input class="cell-input" data-field="name" data-id="${d.id}" value="${escHtml(d.name)}" /></td>
        <td><input class="cell-input" data-field="code" data-id="${d.id}" value="${escHtml(d.code)}" /></td>
        <td>
          <button type="button" class="btn-small save-dept-btn" data-id="${d.id}">Save</button>
          <button type="button" class="btn-small btn-danger delete-dept-btn" data-id="${d.id}">Remove</button>
        </td>
      `;
      return tr;
    })
  );

  tbody.querySelectorAll(".save-dept-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.dataset.id);
      const row = btn.closest("tr");
      const body = {};
      row.querySelectorAll("[data-field]").forEach((el) => {
        body[el.dataset.field] = el.value;
      });
      const resp = await fetch(`/api/departments/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await resp.json();
      if (!resp.ok) {
        alert(result.error || "Error saving department");
        return;
      }
      await refreshAll();
    });
  });

  tbody.querySelectorAll(".delete-dept-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Remove this department (and its levels and org units)?")) return;
      const id = Number(btn.dataset.id);
      const resp = await fetch(`/api/departments/${id}`, { method: "DELETE" });
      const result = await resp.json();
      if (!resp.ok) {
        alert(result.error || "Error removing department");
        return;
      }
      await refreshAll();
    });
  });
}

function renderOrgUnitsTable(units) {
  const tbody = document.getElementById("org-units-tbody");
  tbody.replaceChildren(
    ...units.map((ou) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${ou.id}</td>
        <td>${escHtml(ou.dept_name)}</td>
        <td><input class="cell-input" data-field="name" data-id="${ou.id}" value="${escHtml(ou.name)}" /></td>
        <td><input class="cell-input" data-field="code" data-id="${ou.id}" value="${escHtml(ou.code)}" /></td>
        <td>
          <button type="button" class="btn-small save-ou-btn" data-id="${ou.id}">Save</button>
          <button type="button" class="btn-small btn-danger delete-ou-btn" data-id="${ou.id}">Remove</button>
        </td>
      `;
      return tr;
    })
  );

  tbody.querySelectorAll(".save-ou-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.dataset.id);
      const row = btn.closest("tr");
      const body = {};
      row.querySelectorAll("[data-field]").forEach((el) => {
        body[el.dataset.field] = el.value;
      });
      const resp = await fetch(`/api/org-units/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await resp.json();
      if (!resp.ok) {
        alert(result.error || "Error saving org unit");
        return;
      }
      await refreshAll();
    });
  });

  tbody.querySelectorAll(".delete-ou-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Remove this org unit?")) return;
      const id = Number(btn.dataset.id);
      const resp = await fetch(`/api/org-units/${id}`, { method: "DELETE" });
      const result = await resp.json();
      if (!resp.ok) {
        alert(result.error || "Error removing org unit");
        return;
      }
      await refreshAll();
    });
  });

  // Populate department selects used by the add-level / add-org-unit forms.
  const depts = seedData ? seedData.departments : [];
  const deptOptionEls = depts.map((d) => createOption(d.id, `${d.name} (${d.code})`));
  const newLevelDept = document.getElementById("new-level-dept");
  const newOuDept = document.getElementById("new-ou-dept");
  if (newLevelDept) newLevelDept.replaceChildren(...deptOptionEls.map((o) => o.cloneNode(true)));
  if (newOuDept) newOuDept.replaceChildren(...deptOptionEls.map((o) => o.cloneNode(true)));
}

// Add new user
document.getElementById("add-user-btn").addEventListener("click", () => {
  document.getElementById("add-user-form").classList.remove("hidden");
});
document.getElementById("cancel-new-user-btn").addEventListener("click", () => {
  document.getElementById("add-user-form").classList.add("hidden");
});
document.getElementById("save-new-user-btn").addEventListener("click", async () => {
  const errEl = document.getElementById("new-user-error");
  hideError(errEl);
  const name = document.getElementById("new-user-name").value.trim();
  const email = document.getElementById("new-user-email").value.trim();
  const levelId = Number(document.getElementById("new-user-level").value);
  if (!name || !email || !levelId) {
    showError(errEl, "Name, email and level are required.");
    return;
  }
  const resp = await fetch("/api/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, email, dept_level_id: levelId }),
  });
  const result = await resp.json();
  if (!resp.ok) {
    showError(errEl, result.error || "Error creating user");
    return;
  }
  document.getElementById("add-user-form").classList.add("hidden");
  await refreshAll();
});

// Add new reporting line
document.getElementById("add-rl-btn").addEventListener("click", () => {
  document.getElementById("add-rl-form").classList.remove("hidden");
});
document.getElementById("cancel-new-rl-btn").addEventListener("click", () => {
  document.getElementById("add-rl-form").classList.add("hidden");
});
document.getElementById("save-new-rl-btn").addEventListener("click", async () => {
  const errEl = document.getElementById("new-rl-error");
  hideError(errEl);
  const userId = Number(document.getElementById("new-rl-user").value);
  const managerId = Number(document.getElementById("new-rl-manager").value);
  const resp = await fetch("/api/reporting-lines", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, manager_id: managerId }),
  });
  const result = await resp.json();
  if (!resp.ok) {
    showError(errEl, result.error || "Error creating reporting line");
    return;
  }
  document.getElementById("add-rl-form").classList.add("hidden");
  await refreshAll();
});

// Reset seed data
document.getElementById("reset-seed-btn").addEventListener("click", async () => {
  if (!confirm("Reset all data to default sample data? This cannot be undone.")) return;
  await fetch("/api/reset", { method: "POST" });
  await refreshAll();
});

// Generic add-form toggle wiring
function wireAddForm(toggleId, formId, cancelId) {
  document.getElementById(toggleId).addEventListener("click", () => {
    document.getElementById(formId).classList.remove("hidden");
  });
  document.getElementById(cancelId).addEventListener("click", () => {
    document.getElementById(formId).classList.add("hidden");
  });
}

wireAddForm("add-level-btn", "add-level-form", "cancel-new-level-btn");
wireAddForm("add-action-btn", "add-action-form", "cancel-new-action-btn");
wireAddForm("add-dept-btn", "add-dept-form", "cancel-new-dept-btn");
wireAddForm("add-ou-btn", "add-ou-form", "cancel-new-ou-btn");

// Add new level
document.getElementById("save-new-level-btn").addEventListener("click", async () => {
  const errEl = document.getElementById("new-level-error");
  hideError(errEl);
  const deptId = Number(document.getElementById("new-level-dept").value);
  const rank = Number(document.getElementById("new-level-rank").value);
  const name = document.getElementById("new-level-name").value.trim();
  const isTop = document.getElementById("new-level-top").checked;
  if (!deptId || !name || Number.isNaN(rank)) {
    showError(errEl, "Department, rank and level name are required.");
    return;
  }
  const resp = await fetch("/api/dept-levels", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dept_id: deptId, level_rank: rank, level_name: name, is_top_level: isTop }),
  });
  const result = await resp.json();
  if (!resp.ok) {
    showError(errEl, result.error || "Error creating level");
    return;
  }
  document.getElementById("add-level-form").classList.add("hidden");
  await refreshAll();
});

// Add new action
document.getElementById("save-new-action-btn").addEventListener("click", async () => {
  const errEl = document.getElementById("new-action-error");
  hideError(errEl);
  const name = document.getElementById("new-action-name").value.trim();
  const code = document.getElementById("new-action-code").value.trim();
  const projectScoped = document.getElementById("new-action-project").checked;
  if (!name || !code) {
    showError(errEl, "Name and code are required.");
    return;
  }
  const resp = await fetch("/api/actions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, code, is_project_scoped: projectScoped }),
  });
  const result = await resp.json();
  if (!resp.ok) {
    showError(errEl, result.error || "Error creating action");
    return;
  }
  document.getElementById("add-action-form").classList.add("hidden");
  await refreshAll();
});

// Add new department
document.getElementById("save-new-dept-btn").addEventListener("click", async () => {
  const errEl = document.getElementById("new-dept-error");
  hideError(errEl);
  const name = document.getElementById("new-dept-name").value.trim();
  const code = document.getElementById("new-dept-code").value.trim();
  if (!name || !code) {
    showError(errEl, "Name and code are required.");
    return;
  }
  const resp = await fetch("/api/departments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, code }),
  });
  const result = await resp.json();
  if (!resp.ok) {
    showError(errEl, result.error || "Error creating department");
    return;
  }
  document.getElementById("add-dept-form").classList.add("hidden");
  await refreshAll();
});

// Add new org unit
document.getElementById("save-new-ou-btn").addEventListener("click", async () => {
  const errEl = document.getElementById("new-ou-error");
  hideError(errEl);
  const deptId = Number(document.getElementById("new-ou-dept").value);
  const name = document.getElementById("new-ou-name").value.trim();
  const code = document.getElementById("new-ou-code").value.trim();
  if (!deptId || !name || !code) {
    showError(errEl, "Department, name and code are required.");
    return;
  }
  const resp = await fetch("/api/org-units", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dept_id: deptId, name, code }),
  });
  const result = await resp.json();
  if (!resp.ok) {
    showError(errEl, result.error || "Error creating org unit");
    return;
  }
  document.getElementById("add-ou-form").classList.add("hidden");
  await refreshAll();
});

// ---------------------------------------------------------------------------
// Refresh: reload bootstrap + seed data + re-render diagram
// ---------------------------------------------------------------------------
async function refreshAll() {
  const response = await fetch("/api/bootstrap");
  bootstrap = await response.json();

  renderSeedUsers(bootstrap.users);
  renderNotes(bootstrap.notes);
  renderBusinessCases(bootstrap.business_cases);
  renderAdvancedScenarios(bootstrap.advanced_scenarios);

  // Update simulation selects
  const requesterSelect = document.querySelector("#requester-select");
  const editorSelect = document.querySelector("#editor-select");
  const targetSelect = document.querySelector("#target-select");
  [requesterSelect, editorSelect, targetSelect].forEach((sel) => {
    sel.replaceChildren(
      ...bootstrap.users.map((user) =>
        createOption(user.id, `${user.name} — ${user.department_code} / ${user.level_name}`)
      )
    );
  });

  // Reload org chart (overview)
  const deptCode = document.querySelector("#department-select-overview").value;
  await loadOrgChart(deptCode);

  // Re-render diagram
  renderDiagram(currentDiagramDept || deptCode);

  // Reload seed data editor
  const seedResp = await fetch("/api/seed-data");
  seedData = await seedResp.json();
  renderSeedTables(seedData);
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
function escHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Scenario Lab
// ---------------------------------------------------------------------------
let scenarioLabReady = false;

function userOptionEls() {
  const users = bootstrap ? bootstrap.users : [];
  return users.map((u) =>
    createOption(u.id, `${u.name} — ${u.department_code} / ${u.level_name}`)
  );
}

function addOverlayRow() {
  const container = document.getElementById("lab-overlays");
  const overlayTypes = bootstrap ? bootstrap.overlay_simulations : [];
  const policies = bootstrap ? bootstrap.handover_policies : [];

  const row = document.createElement("div");
  row.className = "overlay-row";

  const typeSel = document.createElement("select");
  typeSel.className = "overlay-type";
  typeSel.replaceChildren(...overlayTypes.map((o) => createOption(o.type, o.label)));

  const ownerSel = document.createElement("select");
  ownerSel.className = "overlay-owner";
  ownerSel.replaceChildren(...userOptionEls());

  const subSel = document.createElement("select");
  subSel.className = "overlay-substitute";
  subSel.replaceChildren(...userOptionEls());

  const policySel = document.createElement("select");
  policySel.className = "overlay-policy";
  policySel.replaceChildren(...policies.map((p) => createOption(p, p)));

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "btn-small btn-danger";
  removeBtn.textContent = "✕";
  removeBtn.addEventListener("click", () => row.remove());

  const ownerLabel = document.createElement("label");
  ownerLabel.className = "overlay-owner-label";
  const subLabel = document.createElement("label");
  subLabel.className = "overlay-sub-label";
  const policyLabel = document.createElement("label");
  policyLabel.textContent = "Policy";
  policyLabel.appendChild(policySel);

  function syncLabels() {
    const meta = overlayTypes.find((o) => o.type === typeSel.value) || {};
    ownerLabel.firstChild && ownerLabel.firstChild.remove();
    ownerLabel.insertBefore(
      document.createTextNode(meta.owner_label || "Authority owner"),
      ownerSel
    );
    subLabel.firstChild && subLabel.firstChild.remove();
    subLabel.insertBefore(
      document.createTextNode(meta.substitute_label || "Substitute"),
      subSel
    );
    policyLabel.classList.toggle("hidden", typeSel.value !== "handover");
  }
  ownerLabel.appendChild(ownerSel);
  subLabel.appendChild(subSel);
  typeSel.addEventListener("change", syncLabels);

  const typeLabel = document.createElement("label");
  typeLabel.textContent = "Overlay type";
  typeLabel.appendChild(typeSel);

  row.append(typeLabel, ownerLabel, subLabel, policyLabel, removeBtn);
  container.appendChild(row);
  syncLabels();
}

function initScenarioLab() {
  const requesterSel = document.getElementById("lab-requester");
  const actionSel = document.getElementById("lab-action");
  if (requesterSel) requesterSel.replaceChildren(...userOptionEls());
  if (actionSel) {
    actionSel.replaceChildren(
      ...bootstrap.actions.map((a) => createOption(a.code, a.name))
    );
  }
  if (!scenarioLabReady) {
    document
      .getElementById("lab-add-overlay-btn")
      .addEventListener("click", addOverlayRow);
    document
      .getElementById("scenario-lab-form")
      .addEventListener("submit", runScenarioLab);
    addOverlayRow();
    scenarioLabReady = true;
  }
}

async function runScenarioLab(event) {
  event.preventDefault();
  const requesterId = Number(document.getElementById("lab-requester").value);
  const actionCode = document.getElementById("lab-action").value;
  const requestAtRaw = document.getElementById("lab-request-at").value;
  const projectCode = document.getElementById("lab-project-code").value.trim();

  const overlays = [];
  document.querySelectorAll("#lab-overlays .overlay-row").forEach((row) => {
    const type = row.querySelector(".overlay-type").value;
    const overlay = {
      type,
      owner_id: Number(row.querySelector(".overlay-owner").value),
      substitute_id: Number(row.querySelector(".overlay-substitute").value),
    };
    if (type === "handover") {
      overlay.policy = row.querySelector(".overlay-policy").value;
    }
    overlays.push(overlay);
  });

  const resp = await fetch("/api/simulate-overlay", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requester_id: requesterId,
      action_code: actionCode,
      overlays,
      request_at: requestAtRaw ? `${requestAtRaw}:00+00:00` : null,
      project_code: projectCode || null,
    }),
  });
  const result = await resp.json();
  const summaryEl = document.getElementById("lab-result-summary");
  const outputEl = document.getElementById("lab-output");
  outputEl.textContent = renderPrettyJson(result);

  if (result.status !== "success") {
    summaryEl.innerHTML = `<span class="lab-error">${escHtml(result.error || "Simulation failed")}</span>`;
    return;
  }
  const primary = result.primary_approver
    ? `${escHtml(result.primary_approver)} <span class="lab-source">(${escHtml(result.primary_source || "")})</span>`
    : "— none —";
  const second = result.second_level_approver
    ? `${escHtml(result.second_level_approver)} <span class="lab-source">(${escHtml(result.second_level_source || "")})</span>`
    : "— none —";
  summaryEl.innerHTML = `
    <div class="lab-line"><span class="lab-label">Primary level:</span> ${primary}</div>
    <div class="lab-line"><span class="lab-label">Second level:</span> ${second}</div>
  `;
}

// ---------------------------------------------------------------------------
// Initial load
// ---------------------------------------------------------------------------
loadBootstrap();

