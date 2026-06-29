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
    if (target === "testcase-diagram" && bootstrap) {
      initTestCaseDiagram();
    }
    if (target === "thirty-cases" && bootstrap) {
      initThirtyCases();
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
const NODE_W = 172;
const NODE_H = 48;
const LEVEL_H = 100;   // vertical gap between level rows
const LEFT_PAD = 60;
const TOP_PAD = 40;
const LEVEL_LABEL_X = 8;

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
  const selectedId = options.selectedId != null ? options.selectedId : null;
  const onNodeClick = options.onNodeClick || function () {};
  svg.innerHTML = "";  // clear

  if (!users.length) {
    svg.setAttribute("viewBox", "0 0 600 120");
    svg.style.width = "600px";
    svg.style.height = "120px";
    return;
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
  // Place the corporate tier (EXEC) in the centre of the department columns
  // rather than at the far left so the chart reads outward from the top tier.
  const execIdx = deptCodes.indexOf("EXEC");
  if (execIdx !== -1 && deptCodes.length > 1) {
    deptCodes.splice(execIdx, 1);
    deptCodes.splice(Math.floor(deptCodes.length / 2), 0, "EXEC");
  }
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
  // Render at natural pixel size so large departments (e.g. ITSO's 30 staff and
  // HRO's 20 staff) are not squished to fit the container width. The
  // `.diagram-container` uses `overflow: auto`, so the full-size diagram scrolls
  // horizontally and vertically while keeping every node readable.
  svg.style.width = `${svgW}px`;
  svg.style.height = `${svgH}px`;

  const ns = "http://www.w3.org/2000/svg";

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
    band.setAttribute("x", 0);
    band.setAttribute("y", bandTop);
    band.setAttribute("width", svgW);
    band.setAttribute("height", bandBottom - bandTop);
    band.setAttribute("class", `layer-band layer-band-${layer}`);
    svg.appendChild(band);
    // Layer caption on the left margin, aligned with the first row of the band.
    const caption = document.createElementNS(ns, "text");
    caption.setAttribute("x", LEVEL_LABEL_X);
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

  // Each edge is colored per individual subordinate (the person whose line runs
  // up to their manager), so two people at the same rank reporting into the same
  // higher rank — e.g. Belle(L8) and Biance(L8) both reporting to L9 — each get
  // their own distinct color. Colors are assigned in a stable order so a given
  // person keeps the same color across re-renders.
  const usedColors = new Set();
  const personColor = {};  // user.id → color
  let colorCursor = 0;
  users.forEach((u) => {
    if (personColor[u.id] === undefined) {
      personColor[u.id] = edgeColorForIndex(colorCursor);
      colorCursor += 1;
    }
  });

  users.forEach((u) => {
    if (!u.manager_name) return;
    const manager = users.find((m) => m.name === u.manager_name);
    if (!manager) return;
    const from = posMap[manager.id];
    const to = posMap[u.id];
    if (!from || !to) return;

    // Use an orthogonal (elbow) connector instead of a straight diagonal so the
    // reporting lines between ranks stay vertical/horizontal and don't cross
    // over each other or through nodes. The line drops straight down from the
    // manager, runs horizontally along a band in the gap, then drops straight
    // down into the child node — the standard, easy-to-read org-chart style.
    const x1 = from.x + NODE_W / 2;
    const y1 = from.y + NODE_H;
    const x2 = to.x + NODE_W / 2;
    const y2 = to.y;
    // Horizontal band sits midway in the vertical gap between the two nodes.
    const midY = y1 + (y2 - y1) / 2;

    const color = personColor[u.id];
    usedColors.add(color);

    const edge = document.createElementNS(ns, "path");
    // Draw from the subordinate up to the manager so the arrowhead (marker-end)
    // points upwards, toward the person being reported to.
    if (Math.abs(x1 - x2) < 0.5) {
      // Same column: a single straight vertical rise.
      edge.setAttribute("d", `M ${x2} ${y2} L ${x1} ${y1}`);
    } else {
      edge.setAttribute(
        "d",
        `M ${x2} ${y2} L ${x2} ${midY} L ${x1} ${midY} L ${x1} ${y1}`
      );
    }
    edge.setAttribute("class", "diagram-edge");
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
  users.forEach((u) => {
    const pos = posMap[u.id];
    const g = document.createElementNS(ns, "g");
    g.setAttribute("class", "diagram-node" + (selectedId != null && selectedId === u.id ? " selected" : ""));
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
  // Bold this user's reporting line in the diagram.
  highlightReportingLine(document.getElementById("diagram-svg"), user.id);

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
  highlightReportingLine(document.getElementById("diagram-svg"), null);
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
  const ownerCaption = document.createTextNode("");
  ownerLabel.append(ownerCaption, ownerSel);
  const subLabel = document.createElement("label");
  subLabel.className = "overlay-sub-label";
  const subCaption = document.createTextNode("");
  subLabel.append(subCaption, subSel);
  const policyLabel = document.createElement("label");
  policyLabel.textContent = "Policy";
  policyLabel.appendChild(policySel);

  function syncLabels() {
    const meta = overlayTypes.find((o) => o.type === typeSel.value) || {};
    ownerCaption.nodeValue = meta.owner_label || "Authority owner";
    subCaption.nodeValue = meta.substitute_label || "Substitute";
    policyLabel.classList.toggle("hidden", typeSel.value !== "handover");
  }
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
// TEST CASE DIAGRAM (temporary, non-persisted)
// ---------------------------------------------------------------------------
// A working copy of users whose `manager_id` / `manager_name` can be edited
// in-memory without ever touching the persisted POC state. The resolved
// reporting line is fetched from the backend and shown as wording below.
let tcUsers = [];              // working copy of all users for this tab
let tcDept = null;             // currently displayed department code (or "ALL")
let tcSelected = null;         // user currently being edited
let testCaseDiagramReady = false;

function tcCloneUsers() {
  // Deep-ish clone so edits never leak back into bootstrap.users.
  tcUsers = (bootstrap ? bootstrap.users : []).map((u) => ({ ...u }));
}

function tcVisibleUsers() {
  if (tcDept === "ALL") return tcUsers.slice();
  return tcUsers.filter((u) => u.department_code === tcDept);
}

function initTestCaseDiagram() {
  const deptSel = document.getElementById("department-select-testcase");
  const reqSel = document.getElementById("testcase-requester");

  if (!testCaseDiagramReady) {
    deptSel.replaceChildren(
      createOption("ALL", "All Departments"),
      ...bootstrap.departments.map((d) => createOption(d.code, `${d.name} (${d.code})`))
    );
    tcDept = deptSel.value;

    deptSel.addEventListener("change", (e) => {
      tcDept = e.target.value;
      closeTestCaseEditPanel();
      renderTestCaseDiagram();
    });
    reqSel.addEventListener("change", runTestCaseReportingLine);
    document
      .getElementById("testcase-reset-btn")
      .addEventListener("click", () => {
        tcCloneUsers();
        closeTestCaseEditPanel();
        renderTestCaseDiagram();
        runTestCaseReportingLine();
      });
    document
      .getElementById("testcase-edit-close")
      .addEventListener("click", closeTestCaseEditPanel);
    document
      .getElementById("testcase-edit-cancel")
      .addEventListener("click", closeTestCaseEditPanel);
    document
      .getElementById("testcase-edit-apply")
      .addEventListener("click", applyTestCaseManager);

    // Overlay controls: re-resolve whenever the action, project, date, or any
    // overlay row changes.
    const actionSel = document.getElementById("testcase-action");
    const projectInput = document.getElementById("testcase-project-code");
    const requestAtInput = document.getElementById("testcase-request-at");
    if (actionSel) actionSel.addEventListener("change", runTestCaseReportingLine);
    if (projectInput) projectInput.addEventListener("input", runTestCaseReportingLine);
    if (requestAtInput) requestAtInput.addEventListener("change", runTestCaseReportingLine);
    document
      .getElementById("testcase-add-overlay-btn")
      .addEventListener("click", () => addTestCaseOverlayRow());

    testCaseDiagramReady = true;
  }

  // Always start from a fresh, untouched working copy when entering the tab.
  tcCloneUsers();
  reqSel.replaceChildren(...userOptionEls());
  const actionSel = document.getElementById("testcase-action");
  if (actionSel) {
    actionSel.replaceChildren(
      createOption("", "— none (reporting line only) —"),
      ...(bootstrap ? bootstrap.actions : []).map((a) => createOption(a.code, a.name))
    );
  }
  const overlayContainer = document.getElementById("testcase-overlays");
  if (overlayContainer) overlayContainer.replaceChildren();
  closeTestCaseEditPanel();
  renderTestCaseDiagram();
  runTestCaseReportingLine();
}

function renderTestCaseDiagram() {
  const svg = document.getElementById("testcase-svg");
  if (!svg) return;
  drawDiagram(svg, tcVisibleUsers(), {
    deptTag: tcDept === "ALL",
    selectedId: tcSelected ? tcSelected.id : null,
    onNodeClick: onTestCaseNodeClick,
  });
}

// Clicking a person in the Test Case Diagram selects them as the requester so
// the reporting line result describes that person's reporting line, while still
// opening the temporary manager-edit panel for further adjustments.
function onTestCaseNodeClick(user) {
  const reqSel = document.getElementById("testcase-requester");
  if (reqSel && String(reqSel.value) !== String(user.id)) {
    reqSel.value = String(user.id);
    runTestCaseReportingLine();
  }
  openTestCaseEditPanel(user);
}

function openTestCaseEditPanel(user) {
  tcSelected = user;
  const panel = document.getElementById("testcase-edit-panel");
  const title = document.getElementById("testcase-edit-title");
  const managerSel = document.getElementById("testcase-edit-manager");
  hideError(document.getElementById("testcase-edit-error"));

  title.textContent = `Reporting manager for ${user.name}`;
  // Anyone except the user themselves may be chosen as their manager.
  const options = [createOption("", "— none / top-level —")];
  tcUsers
    .filter((u) => u.id !== user.id)
    .forEach((u) =>
      options.push(
        createOption(u.id, `${u.name} — ${u.department_code} / ${u.level_name}`)
      )
    );
  managerSel.replaceChildren(...options);
  managerSel.value = user.manager_id != null ? String(user.manager_id) : "";

  panel.classList.remove("hidden");
  renderTestCaseDiagram();
}

function closeTestCaseEditPanel() {
  tcSelected = null;
  const panel = document.getElementById("testcase-edit-panel");
  if (panel) panel.classList.add("hidden");
  renderTestCaseDiagram();
}

function applyTestCaseManager() {
  if (!tcSelected) return;
  const managerSel = document.getElementById("testcase-edit-manager");
  const raw = managerSel.value;
  const user = tcUsers.find((u) => u.id === tcSelected.id);
  if (!user) return;

  if (raw === "") {
    user.manager_id = null;
    user.manager_name = null;
  } else {
    const managerId = Number(raw);
    const manager = tcUsers.find((u) => u.id === managerId);
    user.manager_id = managerId;
    user.manager_name = manager ? manager.name : null;
  }
  closeTestCaseEditPanel();
  runTestCaseReportingLine();
}

// Build one overlay row for the Test Case Diagram, reusing the Scenario Lab
// overlay metadata. Each row defines an acting / delegation / peer_coverage /
// handover assignment that is applied (and rolled back) server-side.
function addTestCaseOverlayRow() {
  const container = document.getElementById("testcase-overlays");
  if (!container) return;
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
  removeBtn.addEventListener("click", () => {
    row.remove();
    runTestCaseReportingLine();
  });

  const ownerLabel = document.createElement("label");
  ownerLabel.className = "overlay-owner-label";
  const ownerCaption = document.createTextNode("");
  ownerLabel.append(ownerCaption, ownerSel);
  const subLabel = document.createElement("label");
  subLabel.className = "overlay-sub-label";
  const subCaption = document.createTextNode("");
  subLabel.append(subCaption, subSel);
  const policyLabel = document.createElement("label");
  policyLabel.textContent = "Policy";
  policyLabel.appendChild(policySel);

  function syncLabels() {
    const meta = overlayTypes.find((o) => o.type === typeSel.value) || {};
    ownerCaption.nodeValue = meta.owner_label || "Authority owner";
    subCaption.nodeValue = meta.substitute_label || "Substitute";
    policyLabel.classList.toggle("hidden", typeSel.value !== "handover");
  }
  typeSel.addEventListener("change", () => {
    syncLabels();
    runTestCaseReportingLine();
  });
  [ownerSel, subSel, policySel].forEach((sel) =>
    sel.addEventListener("change", runTestCaseReportingLine)
  );

  const typeLabel = document.createElement("label");
  typeLabel.textContent = "Overlay type";
  typeLabel.appendChild(typeSel);

  row.append(typeLabel, ownerLabel, subLabel, policyLabel, removeBtn);
  container.appendChild(row);
  syncLabels();
  runTestCaseReportingLine();
}

// Collect the overlay rows into the payload shape expected by the backend.
function collectTestCaseOverlays() {
  const overlays = [];
  document.querySelectorAll("#testcase-overlays .overlay-row").forEach((row) => {
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
  return overlays;
}

async function runTestCaseReportingLine() {
  const reqSel = document.getElementById("testcase-requester");
  const wordingEl = document.getElementById("testcase-wording");
  const stepsEl = document.getElementById("testcase-steps");
  if (!reqSel || !reqSel.value) return;

  // Send the full temporary diagram as primary manager assignments.
  const edges = tcUsers.map((u) => ({
    user_id: u.id,
    manager_id: u.manager_id != null ? u.manager_id : null,
  }));

  const actionCode = (document.getElementById("testcase-action") || {}).value || "";
  const projectCode = (
    (document.getElementById("testcase-project-code") || {}).value || ""
  ).trim();
  const requestAtRaw =
    (document.getElementById("testcase-request-at") || {}).value || "";

  const resp = await fetch("/api/simulate-reporting-line", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requester_id: Number(reqSel.value),
      edges,
      overlays: collectTestCaseOverlays(),
      action_code: actionCode || null,
      project_code: projectCode || null,
      request_at: requestAtRaw ? `${requestAtRaw}:00+00:00` : null,
    }),
  });
  const result = await resp.json();
  stepsEl.replaceChildren();

  if (result.status !== "success") {
    wordingEl.classList.add("testcase-error");
    wordingEl.textContent = result.error || "Could not resolve the reporting line.";
    renderTestCaseOverlayResult(null);
    return;
  }
  wordingEl.classList.remove("testcase-error");
  wordingEl.textContent = result.wording;

  result.steps.forEach((step) => {
    const li = document.createElement("li");
    li.textContent = `${step.user} → ${step.manager_label}`;
    stepsEl.appendChild(li);
  });

  renderTestCaseOverlayResult(result);
}

// Render the overlay-resolved approval line (when an action was chosen), tagging
// each step with the routing source that produced it.
function renderTestCaseOverlayResult(result) {
  const box = document.getElementById("testcase-overlay-result");
  const wordingEl = document.getElementById("testcase-overlay-wording");
  const stepsEl = document.getElementById("testcase-overlay-steps");
  if (!box || !wordingEl || !stepsEl) return;

  if (!result || !result.action_code) {
    box.classList.add("hidden");
    wordingEl.textContent = "";
    stepsEl.replaceChildren();
    return;
  }

  box.classList.remove("hidden");
  stepsEl.replaceChildren();

  if (result.overlay_error) {
    wordingEl.classList.add("testcase-error");
    wordingEl.textContent = `${result.action_name || result.action_code}: ${result.overlay_error}`;
    return;
  }

  wordingEl.classList.remove("testcase-error");
  wordingEl.textContent = result.overlay_wording || "";

  (result.overlay_steps || []).forEach((step) => {
    const li = document.createElement("li");
    const tag = document.createElement("span");
    tag.className = "overlay-source-tag";
    tag.textContent = step.source;
    li.append(document.createTextNode(`${step.approver} `), tag);
    if (step.alternate_approvers && step.alternate_approvers.length) {
      li.append(
        document.createTextNode(` (or ${step.alternate_approvers.join(", ")})`)
      );
    }
    stepsEl.appendChild(li);
  });
}

// ---------------------------------------------------------------------------
// 30 Testcase Diagram
// ---------------------------------------------------------------------------
// Each case is illustrated on the combined EXEC + ITSO + HRO org chart. `focus`
// nominates the staff member whose reporting line (upward chain to the
// department head) is the "target reporting line" bolded when the case is
// selected. Focus users are picked by name where the seed data is
// deterministic, falling back to the deepest member of the named department.
const THIRTY_CASES = [
  { id: 1, category: "Acting & Coverage", title: "Skip-level Acting", focus: "Boris", focusDept: "ITSO", scenario: "A senior leader leaves and a junior employee acts for the whole department.", method: "Add an Acting record and assign the junior to the Acting Senior Leader job position; authority is inherited from that position.", target: [["Boris", "Ivan"]] },
  { id: 2, category: "Acting & Coverage", title: "Peer Coverage", focus: "Cara", focusDept: "ITSO", scenario: "Team A's manager is on leave; Team B's manager temporarily covers Team A.", method: "Give Team B's manager a second assignment to Acting Team A Head, covering two reporting lines.", target: [["Cara", "Ivan"]] },
  { id: 3, category: "Acting & Coverage", title: "Partial Acting", focus: "Cleo", focusDept: "ITSO", scenario: "Manager leaves; B covers leave approvals, C covers performance reviews.", method: "Decouple workflows by approval type: B under Administrative Head, C under Functional/Dotted-line position.", target: [["Cleo", "Ingrid", "Ivan"], ["Cleo", "Cara", "Ivan"]] },
  { id: 4, category: "Acting & Coverage", title: "Dummy Head", focus: "Hannah", focusDept: "HRO", scenario: "A new department lacks a head, so a neighboring head is temporarily assigned.", method: "Assign the neighboring department head to the new department's Head job position.", target: [["Hannah", "Ivan"]] },
  { id: 5, category: "Acting & Coverage", title: "Self-Approval", focus: "Ingrid", focusDept: "ITSO", scenario: "A manager acting in their own supervisor's role routes their leave back to themselves.", method: "Safeguard: if Submitter == Approver, roll up to next level or route to HR.", target: [["Ingrid", "Ivan"]] },
  { id: 6, category: "Acting & Coverage", title: "Handover Overlap", focus: "Isaac", focusDept: "ITSO", scenario: "Old and new managers occupy the same Head position during a 2-week overlap.", method: "Support over-hiring; HR specifies who holds approval authority during transition.", target: [["Isaac", "Ingrid", "Ivan"]] },
  { id: 7, category: "Matrix & Dual Reporting", title: "Cross-Department Project", focus: "Boris", focusDept: "ITSO", scenario: "An IT employee is seconded 100% to HR for a six-month project.", method: "Keep IT job position for payroll; add Override_Reports_To to the HR Project Manager for leave approval.", target: [["Boris", "Hannah"]] },
  { id: 8, category: "Matrix & Dual Reporting", title: "Split Allocation", focus: "Bruno", focusDept: "ITSO", scenario: "A professor spends 50% in two schools.", method: "Create two job assignments and define which is the main approval line.", target: [["Bruno", "Ingrid", "Ivan"]] },
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
  { id: 27, category: "Special Entities", title: "Job Sharing", focus: "Bruno", focusDept: "ITSO", scenario: "Two part-time employees share one full-time role.", method: "Both assigned to the same position at 0.5 FTE each.", target: [["Bruno", "Ingrid", "Ivan"]] },
  { id: 28, category: "Special Entities", title: "Shell Position", focus: "Bianca", focusDept: "ITSO", scenario: "Budgeted in Dept A but works in Dept B.", method: "Keep Dept A for budget; override reporting line to Dept B.", target: [["Bianca", "Hannah"]] },
  { id: 29, category: "Special Entities", title: "Terminated Approver", focus: "Bonnie", focusDept: "ITSO", scenario: "A left manager keeps receiving routed requests.", method: "Check approver status; if terminated, fallback to HR.", target: [["Bonnie", "Ivan"]] },
  { id: 30, category: "Special Entities", title: "Union / Special Committee", focus: "Hope", focusDept: "HRO", scenario: "Union matters report to the union chair, not the daily manager.", method: "Dotted-line or dedicated Committee Org Unit for specific request types.", target: [["Hope", "Hannah"]] },
  { id: 31, category: "Corporate Tier (Layer 1)", title: "Dept Head Escalation", focus: "Ivan", focusDept: "EXEC", scenario: "An ITSO department head escalates a request up to the corporate School tier.", method: "Roll up past the department head to the Layer 1 School position.", target: [["Ivan", "School"]] },
  { id: 32, category: "Corporate Tier (Layer 1)", title: "Provost Reporting Line", focus: "School", focusDept: "EXEC", scenario: "The School reports to the VP, who reports to the Provost.", method: "Walk the corporate tier chain School → VP → Provost.", target: [["School", "VP"], ["VP", "Provost"]] },
  { id: 33, category: "Corporate Tier (Layer 1)", title: "Cross-Department Roll-Up", focus: "School", focusDept: "EXEC", scenario: "Both ITSO and HRO department heads roll up to the same School position.", method: "Multiple department heads report into one shared Layer 1 School.", target: [["Ivan", "School"], ["Hannah", "School"]] },
];

let thirtyCasesReady = false;
let thirtyCasesSelected = null;
let thirtyCasesCategory = "";

function thirtyCasesUsers() {
  const users = [];
  ["EXEC", "ITSO", "HRO"].forEach((code) => {
    const chart = bootstrap.org_charts[code];
    if (chart) collectChartUsers(chart, users);
  });
  return users;
}

// Resolve a case's focus member: prefer the named user, otherwise fall back to
// the deepest (highest level rank) member of the named department so a chain is
// always available to bold.
function thirtyCasesFocusId(users, testCase) {
  const byName = users.find((u) => u.name === testCase.focus);
  if (byName) return byName.id;
  const inDept = users.filter((u) => u.department_code === testCase.focusDept);
  const pool = inDept.length ? inDept : users;
  const deepest = pool.reduce((a, b) => (b.level_rank > a.level_rank ? b : a), pool[0]);
  return deepest ? deepest.id : null;
}

function initThirtyCases() {
  const list = document.getElementById("thirty-cases-cases");
  if (!list) return;
  if (!thirtyCasesReady) {
    list.replaceChildren(
      ...THIRTY_CASES.map((tc) => {
        const li = document.createElement("li");
        li.dataset.category = tc.category;
        const label = document.createElement("label");
        label.className = "thirty-case-row";
        const input = document.createElement("input");
        input.type = "radio";
        input.name = "thirty-case";
        input.value = String(tc.id);
        input.addEventListener("change", () => selectThirtyCase(tc.id));
        const text = document.createElement("span");
        text.innerHTML = `<strong>${tc.id}. ${tc.title}</strong><span class="thirty-case-cat">${tc.category}</span>`;
        label.append(input, text);
        li.appendChild(label);
        return li;
      })
    );
    const filter = document.getElementById("thirty-cases-filter");
    if (filter) {
      const categories = [...new Set(THIRTY_CASES.map((tc) => tc.category))];
      filter.append(
        ...categories.map((cat) => {
          const opt = document.createElement("option");
          opt.value = cat;
          opt.textContent = cat;
          return opt;
        })
      );
      filter.addEventListener("change", () => {
        thirtyCasesCategory = filter.value;
        applyThirtyCasesFilter();
      });
    }
    thirtyCasesReady = true;
  }
  renderThirtyCasesDiagram();
}

// Show only cases whose category matches the selected filter (empty = all).
function applyThirtyCasesFilter() {
  const list = document.getElementById("thirty-cases-cases");
  if (!list) return;
  list.querySelectorAll("li").forEach((li) => {
    const match = !thirtyCasesCategory || li.dataset.category === thirtyCasesCategory;
    li.hidden = !match;
  });
}

function renderThirtyCasesDiagram() {
  const svg = document.getElementById("thirty-cases-svg");
  if (!svg) return;
  const users = thirtyCasesUsers();
  const tc = THIRTY_CASES.find((c) => c.id === thirtyCasesSelected);
  drawDiagram(svg, users, { deptTag: true });
  // Bold each case's scenario-specific target reporting line (override, acting,
  // fallback, etc.) rather than the plain solid-line chain to the dept head.
  highlightTargetLine(svg, users, tc ? tc.target : null);
}

// Bold the scenario-specific target reporting line(s) for a 30-case scenario.
// `chains` is a list of name chains, e.g. [["Boris","Ivan"]] or two co-head
// branches [["Cara","Ivan"],["Cara","Ingrid"]]. Each consecutive pair gets an
// overlay elbow edge; existing solid edges are reused (bolded) when present so
// real lines stay colored, while overrides/skip-levels add a dashed gold link.
function highlightTargetLine(svg, users, chains) {
  if (!svg) return;
  svg.querySelectorAll(".diagram-edge").forEach((e) => e.classList.remove("highlighted"));
  svg.querySelectorAll(".target-edge").forEach((e) => e.remove());
  if (!chains || !chains.length) return;
  const ns = "http://www.w3.org/2000/svg";
  const idByName = {};
  users.forEach((u) => (idByName[u.name] = u.id));
  const center = (id) => {
    const g = svg.querySelector(`.diagram-node[data-user-id="${id}"]`);
    if (!g) return null;
    const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(g.getAttribute("transform"));
    if (!m) return null;
    return { x: parseFloat(m[1]) + NODE_W / 2, y: parseFloat(m[2]) };
  };
  chains.forEach((chain) => {
    for (let i = 0; i < chain.length - 1; i++) {
      const childId = idByName[chain[i]];
      const parentId = idByName[chain[i + 1]];
      if (childId == null || parentId == null) continue;
      const existing = svg.querySelector(
        `.diagram-edge[data-child-id="${childId}"][data-parent-id="${parentId}"]`
      );
      if (existing) {
        existing.classList.add("highlighted");
        continue;
      }
      const from = center(parentId);
      const to = center(childId);
      if (!from || !to) continue;
      const x1 = from.x, y1 = from.y + NODE_H, x2 = to.x, y2 = to.y;
      const midY = y1 + (y2 - y1) / 2;
      const path = document.createElementNS(ns, "path");
      path.setAttribute(
        "d",
        Math.abs(x1 - x2) < 0.5
          ? `M ${x1} ${y1} L ${x2} ${y2}`
          : `M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`
      );
      path.setAttribute("class", "target-edge");
      svg.appendChild(path);
    }
  });
}

function selectThirtyCase(id) {
  thirtyCasesSelected = id;
  const tc = THIRTY_CASES.find((c) => c.id === id);
  document.getElementById("thirty-cases-title").textContent = `${tc.id}. ${tc.title} — ${tc.category}`;
  document.getElementById("thirty-cases-scenario").textContent = tc.scenario;
  const target = (tc.target && tc.target.length)
    ? "Target line: " + tc.target.map((c) => c.join(" → ")).join("  •  ")
    : "Target line: none — assignment inactive, workflow suspended.";
  document.getElementById("thirty-cases-method").textContent = `${tc.method}  —  ${target}`;
  renderThirtyCasesDiagram();
}

// ---------------------------------------------------------------------------
// Initial load
// ---------------------------------------------------------------------------
loadBootstrap();

