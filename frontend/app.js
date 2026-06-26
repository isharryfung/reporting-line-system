const departmentSelect = document.querySelector("#department-select");
const requesterSelect = document.querySelector("#requester-select");
const actionSelect = document.querySelector("#action-select");
const scenarioDepartmentSelect = document.querySelector("#scenario-department-select");
const scenarioOrgUnitSelect = document.querySelector("#scenario-org-unit-select");
const scenarioLevelSelect = document.querySelector("#scenario-level-select");
const approvalLevelSelect = document.querySelector("#approval-level-select");
const overlaySelect = document.querySelector("#overlay-select");
const requestAtInput = document.querySelector("#request-at-input");
const projectCodeInput = document.querySelector("#project-code-input");
const routingForm = document.querySelector("#routing-form");
const routingOutput = document.querySelector("#routing-output");
const orgChart = document.querySelector("#org-chart");
const orgDiagram = document.querySelector("#org-diagram");
const notes = document.querySelector("#notes");
const seedUsers = document.querySelector("#seed-users");
const businessCaseBody = document.querySelector("#business-case-body");
const scenarioList = document.querySelector("#scenario-list");
const scenarioOutput = document.querySelector("#scenario-output");

const editForm = document.querySelector("#edit-form");
const editorScopeSelect = document.querySelector("#editor-scope-select");
const editorSelect = document.querySelector("#editor-select");
const targetSelect = document.querySelector("#target-select");
const editDepartmentSelect = document.querySelector("#edit-department-select");
const editOrgUnitSelect = document.querySelector("#edit-org-unit-select");
const editLevelSelect = document.querySelector("#edit-level-select");
const editManagerSelect = document.querySelector("#edit-manager-select");
const editTeamLeadSelect = document.querySelector("#edit-team-lead-select");
const permissionOutput = document.querySelector("#permission-output");

const routingRuleForm = document.querySelector("#routing-rule-form");
const ruleDepartmentSelect = document.querySelector("#rule-department-select");
const ruleActionSelect = document.querySelector("#rule-action-select");
const ruleApprovalLevelSelect = document.querySelector("#rule-approval-level-select");

const fallbackForm = document.querySelector("#fallback-form");
const fallbackDepartmentSelect = document.querySelector("#fallback-department-select");
const fallbackUserSelect = document.querySelector("#fallback-user-select");

let bootstrap = null;
let activeChart = null;
let latestSimulation = null;

function createOption(value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

function renderPrettyJson(value) {
  return JSON.stringify(value, null, 2);
}

function renderSeedUsers(users) {
  seedUsers.replaceChildren(
    ...users.map((user) => {
      const pill = document.createElement("article");
      pill.className = "pill";
      pill.innerHTML = `
        <strong>${user.name}</strong>
        <span>${user.department_code} · Level ${user.level_rank}</span>
        <span>${user.level_name}</span>
        <span>${user.org_units.join(", ") || "No org-unit"}</span>
      `;
      return pill;
    })
  );
}

function renderNotes(items) {
  notes.replaceChildren(
    ...items.map((item) => {
      const li = document.createElement("li");
      li.textContent = item;
      return li;
    })
  );
}

function renderBusinessCases(cases) {
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

function renderOrgChartSummary(chart) {
  const fallback = chart.fallback_approver
    ? `${chart.fallback_approver.name} (${chart.fallback_approver.label})`
    : "Not configured";
  const levelLegend = chart.level_labels
    .map((item) => `${item.label}: ${item.ownership}`)
    .join(" | ");
  orgChart.innerHTML = `
    <p><strong>Department fallback approver:</strong> ${fallback}</p>
    <p><strong>Levels:</strong> ${levelLegend}</p>
    <p><strong>Ownership regions:</strong> ${chart.ownership_regions
      .map((item) => `${item.name} (L${item.min_level}-L${item.max_level})`)
      .join(" · ")}</p>
  `;
}

function routeEdgesFromSimulation(chart, simulation) {
  if (!simulation || simulation.status !== "success" || !simulation.steps?.length) {
    return [];
  }
  const nodesByName = new Map(chart.graph.nodes.map((node) => [node.name, node]));
  const requestNode = nodesByName.get(simulation.requester);
  if (!requestNode) {
    return [];
  }
  const edges = [];
  let previous = requestNode;
  simulation.steps.forEach((step) => {
    const current = nodesByName.get(step.approver);
    if (!current) {
      return;
    }
    edges.push({ from: previous.id, to: current.id, source: step.source });
    previous = current;
  });
  return edges;
}

function renderDiagram(chart, simulation = null) {
  activeChart = chart;
  const routeEdges = routeEdgesFromSimulation(chart, simulation);
  const nodes = chart.graph.nodes;
  const edges = chart.graph.edges;
  const maxX = Math.max(...nodes.map((node) => node.x), 900) + 120;
  const maxY = Math.max(...nodes.map((node) => node.y), 900) + 120;
  const nodesById = new Map(nodes.map((node) => [node.id, node]));

  const svgEdges = edges
    .map((edge) => {
      const from = nodesById.get(edge.from);
      const to = nodesById.get(edge.to);
      if (!from || !to) {
        return "";
      }
      return `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" class="official-edge" />`;
    })
    .join("");
  const svgRouteEdges = routeEdges
    .map((edge) => {
      const from = nodesById.get(edge.from);
      const to = nodesById.get(edge.to);
      if (!from || !to) {
        return "";
      }
      return `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" class="route-edge" />`;
    })
    .join("");

  const ownershipBands = chart.ownership_regions
    .map((region) => {
      const top = 20 + (region.min_level - 1) * 120;
      const height = (region.max_level - region.min_level + 1) * 120;
      return `<div class="ownership-band" style="top:${top}px;height:${height}px;"><span>${region.name}</span></div>`;
    })
    .join("");
  const teamBoxes = chart.team_regions
    .map((region, index) => {
      const top = 20 + (region.min_level - 1) * 120;
      const height = (region.max_level - region.min_level + 1) * 120;
      const left = 30 + (index % 3) * 300;
      return `<div class="team-region" style="top:${top}px;height:${height}px;left:${left}px;">${region.name}</div>`;
    })
    .join("");
  const levelLabels = chart.level_labels
    .map((item) => `<div class="level-label" style="top:${26 + (item.level - 1) * 120}px;">${item.label}</div>`)
    .join("");
  const nodeCards = nodes
    .map(
      (node) => `
      <button class="graph-node" data-user-id="${node.id}" style="left:${node.x - 90}px;top:${node.y - 28}px;">
        <strong>${node.name}</strong>
        <span>${node.label} · L${node.level}</span>
        <span>${node.org_unit}${node.is_team_lead ? " · Team Lead" : ""}</span>
      </button>`
    )
    .join("");

  orgDiagram.innerHTML = `
    <div class="diagram-canvas" style="width:${maxX}px;height:${maxY}px;">
      ${ownershipBands}
      ${teamBoxes}
      ${levelLabels}
      <svg class="diagram-edges" viewBox="0 0 ${maxX} ${maxY}" preserveAspectRatio="none">
        ${svgEdges}
        ${svgRouteEdges}
      </svg>
      ${nodeCards}
    </div>
    <p class="diagram-legend">
      <span class="swatch solid"></span> Official reporting line
      <span class="swatch dashed"></span> Dashed approval route
    </p>
  `;

  orgDiagram.querySelectorAll(".graph-node").forEach((nodeElement) => {
    nodeElement.addEventListener("click", () => {
      targetSelect.value = nodeElement.dataset.userId;
      editManagerSelect.value = "";
      permissionOutput.textContent = `Selected target node user id=${nodeElement.dataset.userId}`;
    });
  });
}

function fillSelectors() {
  const users = bootstrap.users;
  const departments = bootstrap.departments;
  const actions = bootstrap.actions;
  const options = bootstrap.options;
  const userOptions = users.map((user) =>
    createOption(user.id, `${user.name} — ${user.department_code} / L${user.level_rank}`)
  );
  requesterSelect.replaceChildren(...userOptions.map((option) => option.cloneNode(true)));
  editorSelect.replaceChildren(...userOptions.map((option) => option.cloneNode(true)));
  targetSelect.replaceChildren(...userOptions.map((option) => option.cloneNode(true)));
  editManagerSelect.replaceChildren(
    createOption("", "No change"),
    ...userOptions.map((option) => option.cloneNode(true))
  );
  fallbackUserSelect.replaceChildren(...userOptions.map((option) => option.cloneNode(true)));

  actionSelect.replaceChildren(...actions.map((item) => createOption(item.code, item.name)));
  ruleActionSelect.replaceChildren(...actions.map((item) => createOption(item.code, item.name)));

  const deptOptions = departments.map((item) =>
    createOption(item.code, `${item.name} (${item.code})`)
  );
  departmentSelect.replaceChildren(...deptOptions.map((option) => option.cloneNode(true)));
  scenarioDepartmentSelect.replaceChildren(...deptOptions.map((option) => option.cloneNode(true)));
  ruleDepartmentSelect.replaceChildren(...deptOptions.map((option) => option.cloneNode(true)));
  fallbackDepartmentSelect.replaceChildren(...deptOptions.map((option) => option.cloneNode(true)));

  editDepartmentSelect.replaceChildren(
    createOption("", "No change"),
    ...departments.map((item) => createOption(item.id, `${item.name} (${item.code})`))
  );

  editOrgUnitSelect.replaceChildren(
    createOption("", "No change"),
    ...options.org_units.map((item) => createOption(item.id, `${item.name} (${item.code})`))
  );
  scenarioOrgUnitSelect.replaceChildren(
    createOption("", "Any team"),
    ...options.org_units.map((item) => createOption(item.code, `${item.name} (${item.code})`))
  );

  editLevelSelect.replaceChildren(
    createOption("", "No change"),
    ...options.levels.map((item) =>
      createOption(item.id, `${item.level_name} (L${item.level_rank})`)
    )
  );
  scenarioLevelSelect.replaceChildren(
    createOption("", "Any level"),
    ...options.levels.map((item) =>
      createOption(item.level_rank, `${item.level_name} (L${item.level_rank})`)
    )
  );
}

function renderAdvancedScenarios(items) {
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

async function refreshBootstrapAndChart(selectedDepartment = null) {
  const response = await fetch("/api/bootstrap");
  bootstrap = await response.json();
  renderSeedUsers(bootstrap.users);
  renderNotes(bootstrap.notes);
  renderBusinessCases(bootstrap.business_cases);
  renderAdvancedScenarios(bootstrap.advanced_scenarios);
  fillSelectors();

  const departmentCode = selectedDepartment || departmentSelect.value || bootstrap.departments[0].code;
  departmentSelect.value = departmentCode;
  const orgChartResponse = await fetch(`/api/org-chart?department=${encodeURIComponent(departmentCode)}`);
  const chart = await orgChartResponse.json();
  renderOrgChartSummary(chart);
  renderDiagram(chart, latestSimulation);
}

departmentSelect.addEventListener("change", async () => {
  const response = await fetch(`/api/org-chart?department=${encodeURIComponent(departmentSelect.value)}`);
  const chart = await response.json();
  renderOrgChartSummary(chart);
  renderDiagram(chart, latestSimulation);
});

routingForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = {
    requester_id: Number(requesterSelect.value),
    action_code: actionSelect.value,
    request_at: requestAtInput.value ? `${requestAtInput.value}:00+00:00` : null,
    project_code: projectCodeInput.value || null,
    department_code: scenarioDepartmentSelect.value || null,
    org_unit_code: scenarioOrgUnitSelect.value || null,
    position_level: scenarioLevelSelect.value ? Number(scenarioLevelSelect.value) : null,
    approval_level: approvalLevelSelect.value || null,
    overlay_case: overlaySelect.value || null,
  };
  const response = await fetch("/api/simulate-request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  latestSimulation = await response.json();
  routingOutput.textContent = renderPrettyJson(latestSimulation);
  if (activeChart) {
    renderDiagram(activeChart, latestSimulation);
  }
});

editForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = {
    editor_scope: editorScopeSelect.value,
    editor_id: editorSelect.value ? Number(editorSelect.value) : null,
    target_user_id: Number(targetSelect.value),
    department_id: editDepartmentSelect.value ? Number(editDepartmentSelect.value) : null,
    org_unit_id: editOrgUnitSelect.value ? Number(editOrgUnitSelect.value) : null,
    level_id: editLevelSelect.value ? Number(editLevelSelect.value) : null,
    manager_id: editManagerSelect.value ? Number(editManagerSelect.value) : null,
    is_team_lead:
      editTeamLeadSelect.value === ""
        ? null
        : editTeamLeadSelect.value === "true",
  };
  const response = await fetch("/api/graph-edit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  permissionOutput.textContent = renderPrettyJson(result);
  if (result.status === "success") {
    latestSimulation = null;
    await refreshBootstrapAndChart(result.department_code || departmentSelect.value);
  }
});

routingRuleForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const response = await fetch("/api/routing-rule-edit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      department_code: ruleDepartmentSelect.value,
      action_code: ruleActionSelect.value,
      approval_level: ruleApprovalLevelSelect.value,
    }),
  });
  const result = await response.json();
  permissionOutput.textContent = renderPrettyJson(result);
  await refreshBootstrapAndChart(ruleDepartmentSelect.value);
});

fallbackForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const response = await fetch("/api/fallback-edit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      department_code: fallbackDepartmentSelect.value,
      fallback_user_id: Number(fallbackUserSelect.value),
    }),
  });
  const result = await response.json();
  permissionOutput.textContent = renderPrettyJson(result);
  await refreshBootstrapAndChart(fallbackDepartmentSelect.value);
});

refreshBootstrapAndChart();
