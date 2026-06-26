const departmentSelect = document.querySelector("#department-select");
const requesterSelect = document.querySelector("#requester-select");
const actionSelect = document.querySelector("#action-select");
const requestAtInput = document.querySelector("#request-at-input");
const projectCodeInput = document.querySelector("#project-code-input");
const editorSelect = document.querySelector("#editor-select");
const targetSelect = document.querySelector("#target-select");
const routingForm = document.querySelector("#routing-form");
const permissionForm = document.querySelector("#permission-form");
const routingOutput = document.querySelector("#routing-output");
const permissionOutput = document.querySelector("#permission-output");
const scenarioList = document.querySelector("#scenario-list");
const scenarioOutput = document.querySelector("#scenario-output");
const seedUsers = document.querySelector("#seed-users");
const notes = document.querySelector("#notes");
const orgChart = document.querySelector("#org-chart");
const businessCaseBody = document.querySelector("#business-case-body");
const diagramForm = document.querySelector("#diagram-form");
const diagramEditorSelect = document.querySelector("#diagram-editor-select");
const diagramTargetSelect = document.querySelector("#diagram-target-select");
const diagramDepartmentSelect = document.querySelector("#diagram-department-select");
const diagramLevelSelect = document.querySelector("#diagram-level-select");
const diagramManagerSelect = document.querySelector("#diagram-manager-select");
const diagramOrgUnitSelect = document.querySelector("#diagram-org-unit-select");
const diagramTeamLeadInput = document.querySelector("#diagram-team-lead-input");
const diagramOutput = document.querySelector("#diagram-output");
const configForm = document.querySelector("#config-form");
const configEntitySelect = document.querySelector("#config-entity-select");
const configOperationSelect = document.querySelector("#config-operation-select");
const configPayloadInput = document.querySelector("#config-payload-input");
const configOutput = document.querySelector("#config-output");

let bootstrap = null;

function renderPrettyJson(value) {
  return JSON.stringify(value, null, 2);
}

function createOption(value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

function renderSeedUsers(users) {
  seedUsers.replaceChildren(
    ...users.map((user) => {
      const pill = document.createElement("article");
      pill.className = "pill";
      pill.innerHTML = `
        <strong>${user.name}</strong>
        <span>${user.department_code} · ${user.level_name}</span>
        <span>${user.org_units.join(", ") || "No org-unit"}</span>
        <span>${user.is_team_lead ? "Team Lead" : "Member"}</span>
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

function renderOrgChart(chart) {
  const units = chart.org_units
    .map((orgUnit) => {
      const teamLeads = orgUnit.team_leads.map((lead) => lead.name).join(", ") || "None";
      const coHeads = orgUnit.co_heads
        .map((lead) => `${lead.name}${lead.is_primary ? " (primary)" : ""} · ${lead.policy}`)
        .join(", ");
      const members = orgUnit.members
        .map(
          (member) =>
            `<li><strong>${member.name}</strong> — ${member.level_name} · Manager: ${
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
                `<li><strong>${user.name}</strong> — ${user.level_name}${
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
    <p><strong>Diagram editor supports:</strong> manager, department, level, team and team-lead updates.</p>
    <div class="org-unit-grid">${units}${unassigned}</div>
  `;
}

function renderSimulationResult(payload) {
  const lines = [];
  lines.push(renderPrettyJson(payload));
  if (payload.status === "success") {
    lines.push("");
    lines.push(`approval_levels: ${payload.approval_levels}`);
    lines.push(`fallback_used: ${payload.fallback_used}`);
    lines.push(`overlays_applied: ${payload.overlays_applied.join(", ") || "none"}`);
  }
  return lines.join("\n");
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

async function loadOrgChart(departmentCode) {
  const response = await fetch(`/api/org-chart?department=${encodeURIComponent(departmentCode)}`);
  const payload = await response.json();
  renderOrgChart(payload);
}

async function loadBootstrap() {
  const response = await fetch("/api/bootstrap");
  bootstrap = await response.json();

  renderSeedUsers(bootstrap.users);
  renderNotes(bootstrap.notes);
  renderBusinessCases(bootstrap.business_cases);
  renderAdvancedScenarios(bootstrap.advanced_scenarios);

  departmentSelect.replaceChildren(
    ...bootstrap.departments.map((department) =>
      createOption(department.code, `${department.name} (${department.code})`)
    )
  );
  requesterSelect.replaceChildren(
    ...bootstrap.users.map((user) =>
      createOption(user.id, `${user.name} — ${user.department_code} / ${user.level_name}`)
    )
  );
  editorSelect.replaceChildren(
    ...bootstrap.users.map((user) =>
      createOption(user.id, `${user.name} — ${user.department_code} / ${user.level_name}`)
    )
  );
  targetSelect.replaceChildren(
    ...bootstrap.users.map((user) =>
      createOption(user.id, `${user.name} — ${user.department_code} / ${user.level_name}`)
    )
  );
  actionSelect.replaceChildren(
    ...bootstrap.actions.map((action) =>
      createOption(action.code, action.name)
    )
  );

  const userOptions = bootstrap.users.map((user) =>
    createOption(user.id, `${user.name} — ${user.department_code} / ${user.level_name}`)
  );
  diagramEditorSelect.replaceChildren(...userOptions.map((option) => option.cloneNode(true)));
  diagramTargetSelect.replaceChildren(...userOptions.map((option) => option.cloneNode(true)));
  diagramManagerSelect.replaceChildren(
    createOption("", "No change"),
    ...userOptions.map((option) => option.cloneNode(true))
  );
  diagramDepartmentSelect.replaceChildren(
    createOption("", "No change"),
    ...bootstrap.configurable_data.departments.map((department) =>
      createOption(department.id, `${department.name} (${department.code})`)
    )
  );
  diagramLevelSelect.replaceChildren(
    createOption("", "No change"),
    ...bootstrap.configurable_data.dept_levels.map((level) =>
      createOption(level.id, `${level.level_name} (dept ${level.dept_id})`)
    )
  );
  diagramOrgUnitSelect.replaceChildren(
    createOption("", "No change"),
    ...bootstrap.configurable_data.org_units.map((orgUnit) =>
      createOption(orgUnit.id, `${orgUnit.name} (${orgUnit.code})`)
    )
  );

  await loadOrgChart(departmentSelect.value);
}

departmentSelect.addEventListener("change", () => loadOrgChart(departmentSelect.value));

routingForm.addEventListener("submit", async (event) => {
  event.preventDefault();
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
  routingOutput.textContent = renderSimulationResult(payload);
});

permissionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
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

diagramForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const selectedOrgUnit = diagramOrgUnitSelect.value
    ? [Number(diagramOrgUnitSelect.value)]
    : null;
  const response = await fetch("/api/diagram-edit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      editor_user_id: Number(diagramEditorSelect.value),
      target_user_id: Number(diagramTargetSelect.value),
      dept_id: diagramDepartmentSelect.value ? Number(diagramDepartmentSelect.value) : null,
      dept_level_id: diagramLevelSelect.value ? Number(diagramLevelSelect.value) : null,
      manager_id: diagramManagerSelect.value ? Number(diagramManagerSelect.value) : null,
      org_unit_ids: selectedOrgUnit,
      is_team_lead: diagramTeamLeadInput.checked,
    }),
  });
  const payload = await response.json();
  diagramOutput.textContent = renderPrettyJson(payload);
  await loadBootstrap();
});

configForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  let payload;
  try {
    payload = JSON.parse(configPayloadInput.value);
  } catch (error) {
    configOutput.textContent = `Invalid JSON payload: ${error.message}`;
    return;
  }
  const response = await fetch("/api/configurable-data", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      entity: configEntitySelect.value,
      operation: configOperationSelect.value,
      payload,
    }),
  });
  const result = await response.json();
  configOutput.textContent = renderPrettyJson(result);
  await loadBootstrap();
});

loadBootstrap();
