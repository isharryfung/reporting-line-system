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
// Keep node x-lanes stable across re-renders using department-relative offsets
// so each department keeps its internal structure but can shift as a whole
// when other departments are shown.
const fixedNodeOffsetByKey = {}; // "DEPT::Name" -> (x - deptStartX[dept])
const fixedDeptStartXByCode = {}; // "DEPT" -> absolute x of department column start
const fixedNodeAbsoluteXByKey = {}; // "DEPT::Name" -> absolute x
const fixedTeamOrderByDept = {}; // "DEPT" -> stable team lane order
const fixedTeamWidthByKey = {}; // "DEPT::Team" -> non-shrinking lane width

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
    if (target === "itso-cases" && bootstrap) {
      initItsoCases();
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
    text.setAttribute("class", "level-label");
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

function escRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function italicizeNodeNames(text, nodeNames) {
  let out = escHtml(text || "");
  if (!out || !Array.isArray(nodeNames) || !nodeNames.length) return out;

  const names = Array.from(new Set(nodeNames.filter(Boolean)))
    .map((name) => escHtml(name))
    .sort((a, b) => b.length - a.length);

  names.forEach((name) => {
    const rx = new RegExp(`\\b${escRegex(name)}\\b`, "g");
    out = out.replace(rx, `<strong>${name}</strong>`);
  });
  return out;
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
    ? `${escHtml(result.primary_approver)} <span class="lab-source">(${escHtml(result.primary_source || "")})</span>` +
      (result.primary_acting_approver
        ? ` <span class="lab-source">(${escHtml(result.primary_acting_approver)} acting)</span>`
        : "")
    : "— none —";
  const second = result.second_level_approver
    ? `${escHtml(result.second_level_approver)} <span class="lab-source">(${escHtml(result.second_level_source || "")})</span>` +
      (result.second_level_acting_approver
        ? ` <span class="lab-source">(${escHtml(result.second_level_acting_approver)} acting)</span>`
        : "")
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
    if (step.acting_approver) {
      const actingTag = document.createElement("span");
      actingTag.className = "overlay-source-tag";
      actingTag.textContent = `${step.acting_approver} acting`;
      li.append(document.createTextNode(" "), actingTag);
    }
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
// The bolded line is always derived live from the org chart (so it matches the
// real chain shown by clicking a node); `target: []` flags inactive cases with
// no workflow, while any other `target` value is illustrative only.
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

// Optional second-line descriptions shown below the official scenario text.
const THIRTY_CASES_ALT_SCENARIO = {
  1: "Our version: Ivan is on leave, Boris acts through the temporary acting node, and approvals continue back into Ivan's normal route.",
  2: "Our version: The selected team lead is marked on leave and their team's leave approvals are temporarily covered by the chosen peer lead.",
  3: "Our version: One manager is on leave while duties split by workflow: leave approvals go to the leave-duty cover, review approvals go to the review-duty cover.",
  4: "Our version: The head position is shown as Vacant [ITSO], with temporary approval coverage assigned to Ivan for continuity.",
  5: "Our version: When acting would cause self-approval, routing safeguards skip self and escalate to the next valid approver.",
  6: "Our version: During overlap, approval rights hand over from Ingrid to Sam while the reporting route remains Isaac -> Ingrid -> Ivan.",
  7: "Our version: A temporary External Employee (HKUST) context block is shown in the HR view to visualize secondment while the approval path remains Boris -> Hannah.",
  8: "Our version: Burno is dual-affiliated (ITSO/HRO). Route A follows the ITSO line Burno -> Ingrid -> Ivan, while Route B links through HRO manager Harvey and still ends at Ivan as the major-department final approver.",
};

// ITSO-only variants of Case 1-30. Cross-department names are remapped to
// ITSO equivalents so the full set can be visualized within one department.
const ITSO_CASE_NAME_REMAP = {
  Hannah: "Ingrid",
  Harvey: "Cara",
  Hazel: "Daisy",
  Hugo: "Drake",
  Hope: "Gemma",
  Hilda: "Faye",
};

function remapItsoCaseName(name) {
  return ITSO_CASE_NAME_REMAP[name] || name;
}

function remapItsoCaseText(text) {
  if (!text) return "";
  return text
    .replace(/\bHRO\b/g, "ITSO Governance")
    .replace(/\bHR\b/g, "ITSO Governance")
    .replace(/Human Resources Office/g, "ITSO Governance")
    .replace(/schools?/gi, "ITSO units")
    .replace(/Cross-Department/gi, "Cross-Team");
}

const ITSO_CASE_TARGET_OVERRIDES = {
  7: [["Boris", "Iris", "Isaac"]],
  8: [["Bruno", "Igor", "Isaac"], ["Bruno", "Conrad", "Cyrus"]],
  10: [["Isaac", "Ivan"]],
  11: [["Dana", "Isaac"]],
  12: [["Gemma", "Ingrid"]],
  14: [["Carl", "Ivan"]],
  17: [["Ivan", "School"]],
  18: [["Faye", "Hannah"]],
  19: [["Boris [ITSO ➜ HRO]", "Hannah"]],
  21: [["Daisy", "Cleo", "Cyrus", "Cara"]],
  22: [["Dana", "Cleo", "Cyrus"], ["Dana", "Igor", "Isaac"]],
  26: [["Ingrid", "Hannah"]],
  28: [["Bianca", "Iris", "Isaac"], ["Bianca [shell]", "Hannah"]],
  30: [["Gemma", "Hannah"]],
};

const ITSO_CASE_SECOND_PARTY = {
  7: { includeHro: true, loan: { person: "Boris", fromDept: "ITSO", toDept: "HRO", toManager: "Hannah" } },
  18: { includeHro: true },
  19: { includeHro: true, loan: { person: "Boris", fromDept: "ITSO", toDept: "HRO", toManager: "Hannah" } },
  26: { includeHro: true, loan: { person: "Ingrid", fromDept: "ITSO", toDept: "HRO", toManager: "Hannah" } },
  28: { includeHro: true, loan: { person: "Bianca", fromDept: "ITSO", toDept: "HRO", toManager: "Hannah" } },
  30: { includeHro: true },
};

const ITSO_CASE_CONTENT_OVERRIDES = {
  1: {
    scenario: "Dept Head Ivan is on leave, and Boris temporarily carries acting authority for head-level approvals.",
    method: "Use a dated acting assignment on Ivan's position so requests keep routing through the acting chain while Ivan remains the formal position owner.",
  },
  2: {
    scenario: "Cara is on leave and Ingrid temporarily covers Cara's team approvals.",
    method: "Apply peer coverage so Cara's team members route to Ingrid during the effective leave window.",
  },
  3: {
    scenario: "A selected manager is on leave, and leave vs review approvals are split across different cover managers.",
    method: "Use the case controls to set manager-on-leave, leave-duty cover, review-duty cover, and active workflow mode.",
  },
  4: {
    scenario: "An ITSO unit has a vacant head position and needs temporary approval ownership.",
    method: "Mark the head role as vacant and route approvals to Ivan as temporary authority until permanent appointment.",
  },
  5: {
    scenario: "An acting setup would cause self-approval for Ingrid.",
    method: "Enforce self-approval prevention and automatically escalate to the next valid approver (Ivan).",
  },
  6: {
    scenario: "Outgoing and incoming managers overlap during a handover period.",
    method: "Keep hierarchy stable and model a temporary approval-right transfer across the overlap window.",
  },
  7: {
    scenario: "Boris is represented with both home-post and loaned-post context while approval remains in the ITSO path.",
    method: "Show dual context nodes and route the home approval chain as Boris -> Iris -> Isaac while still visualizing the loaned placement.",
  },
  8: {
    scenario: "Bruno has split allocation across two ITSO units.",
    method: "Render two deterministic routes (primary and secondary) and preserve a consistent approval endpoint per route.",
  },
  9: {
    scenario: "An ITSO unit is managed by equal co-heads.",
    method: "Show Ivan and Ingrid as co-head approvers with any-one-approve behavior and explicit co-head linkage.",
  },
  10: {
    scenario: "Executive approvals are operationally handled by Isaac on behalf of Ivan.",
    method: "Use explicit delegation flow with owner/delegate context and on-behalf-of audit visibility.",
  },
  11: {
    scenario: "Dana has separate technical and people-management relationships.",
    method: "Keep people-manager routing as primary and render technical leadership as contextual (non-primary) guidance.",
  },
  12: {
    scenario: "Gemma has a local reporting line plus a functional matrix relationship.",
    method: "Keep Ingrid as the formal approver and represent Ivan only as dotted functional context.",
  },
  13: {
    scenario: "A proposed assignment introduces risk of a circular reporting loop.",
    method: "Run cycle validation pre-save and block any routing graph that forms a loop.",
  },
  14: {
    scenario: "Carl becomes orphaned after restructuring and has no valid direct manager.",
    method: "Treat null manager as orphan state and route approvals to fallback authority (Ivan).",
  },
  15: {
    scenario: "ITSO operates a very flat structure with many direct reports to Ivan.",
    method: "Support high span-of-control while keeping routing deterministic and visually readable.",
  },
  16: {
    scenario: "Bonnie uses a skip-level manager override directly to Ivan.",
    method: "Apply explicit override routing while preserving the normal chain as contextual reference.",
  },
  17: {
    scenario: "Only the department head is active, so approval escalates beyond ITSO.",
    method: "Model head-only department behavior and escalate from Ivan to School (EXEC tier).",
  },
  18: {
    scenario: "A dedicated Parking department contains only one active member (Faye).",
    method: "Model Parking as a special unit and centralize approvals through Hannah.",
  },
  19: {
    scenario: "Boris has a future-dated transfer, so both home and future contexts are visible.",
    method: "Show the home chain Boris -> Iris -> Isaac together with the future-placement path, selected by event date.",
  },
  20: {
    scenario: "Cyrus receives a retroactive promotion after approvals already completed.",
    method: "Keep completed approvals locked to historical routing and surface mismatch through audit comparison.",
  },
  21: {
    scenario: "Daisy's path crosses a vacant manager node (gap) before reaching next valid authority.",
    method: "Render gap explicitly as Daisy -> Cleo -> Cyrus (gap) -> Cara and include next-level escalation in the path.",
  },
  22: {
    scenario: "Dana rotates between two ITSO teams and the active rotation path is shown per view state.",
    method: "Default to Dana -> Cleo -> Cyrus and toggle on click to Dana -> Igor -> Isaac; tag team nodes as ratation#1 and ratation#2.",
  },
  23: {
    scenario: "Daisy is on long no-pay leave and should be excluded from active routing.",
    method: "Set assignment inactive and return no approval path until reactivation date.",
  },
  24: {
    scenario: "Drake is re-hired after a service break into a new assignment period.",
    method: "Create a new effective-dated assignment while preserving historical reporting lineage.",
  },
  25: {
    scenario: "A vendor consultant requires internal approval ownership.",
    method: "Proxy external requests through sponsor chain Isaac -> Ivan for accountable approval ownership.",
  },
  26: {
    scenario: "Affiliate-style secondment grants temporary authority inside ITSO.",
    method: "Apply temporary authority assignment with explicit rollback on end date.",
  },
  27: {
    scenario: "Two staff share one role under a formal job-sharing arrangement.",
    method: "Attach both users to one shared position with split FTE and a common manager route.",
  },
  28: {
    scenario: "Bianca's budget home differs from operational working line.",
    method: "Keep budget context fixed and override reporting line to the working-team manager.",
  },
  29: {
    scenario: "A terminated manager remains referenced in configuration.",
    method: "Detect inactive approver state and immediately fail over to fallback approver Ivan.",
  },
  30: {
    scenario: "Committee-type requests require dedicated governance-chair routing.",
    method: "Apply request-type rule to route committee workflows directly to Ivan as chair.",
  },
};

const ITSO_CASES_ALT_SCENARIO = {
  1: "Our version: Ivan is on leave, and Boris acts in his place so the department approval path still resolves through the acting chain.",
  2: "Our version: Cara is on leave, and Ingrid covers Cara's team approvals as the temporary peer lead.",
  3: "Our version: the original split-duty case is now editable: the manager on leave, the leave-duty cover, the review-duty cover, and the active view can all be changed from the description section.",
  4: "Our version: The head post is vacant, so Ivan is shown as the temporary approver for the unit.",
  5: "Our version: The acting setup would create self-approval, so the route is forced to Ivan instead.",
  6: "Our version: Overlap period is visualized so outgoing and incoming authority are distinguishable.",
  7: "Our version: both Boris [ITSO] and Boris [HKUST Loan] [HRO] are highlighted and selectable; the loaned node carries the HRO project reporting route while the original ITSO node remains visible as home post.",
  8: "Our version: Bruno is split across two ITSO units with two understandable approval routes.",
  9: "Our version: Ivan and Ingrid are displayed as co-heads with equal approval authority.",
  10: "Our version: Isaac processes approvals on behalf of Ivan with a delegated process flow overlay.",
  11: "Our version: Dana's technical and people-management responsibilities are shown separately.",
  12: "Our version: Gemma routes formally to Ingrid, while Ivan is shown separately as a dotted functional lead rather than a second approver.",
  13: "Our version: Cycle-risk scenario is marked as a validation case instead of a normal route.",
  14: "Our version: Carl is orphaned and routed to ITSO fallback governance for approval.",
  15: "Our version: Flat span-of-control is emphasized at Ivan's node.",
  16: "Our version: Bonnie uses an override skip-level route directly to Ivan.",
  17: "Our version: Ivan is the lone ITSO node and the chain escalates upward to School in EXEC.",
  18: "Our version: Faye appears as the sole member of Parking and routes approvals to Hannah in HRO.",
  19: "Our version: both Boris [ITSO] and Boris [Future HRO] are shown; the future HRO node carries the transfer route while the home ITSO node still shows the major-department path.",
  20: "Our version: Retroactive promotion keeps historical approvals while audit ownership is explicit.",
  21: "Our version: Daisy rises through Cleo, hits Cyrus as the vacant gap point, and then rolls up to Cara.",
  22: "Our version: Rotation is shown by switching Dean's manager to the current assignment lead.",
  23: "Our version: No-pay-leave assignment is inactive and intentionally has no approval route.",
  24: "Our version: Re-hire is treated as a new assignment while preserving historical identity context.",
  25: "Our version: Consultant/vendor approval route is proxied through an internal ITSO sponsor, with an external consultant node shown in the external section.",
  26: "Our version: Cross-company secondment is represented as affiliate-style authority in ITSO, with an external affiliate node shown in the external section.",
  27: "Our version: Job sharing is shown as one shared position split across Bruno and Bella, both rolling up to the same manager chain.",
  28: "Our version: Shell role keeps budget context separate from working reporting line.",
  29: "Our version: Terminated-manager risk is visualized with fallback to Ivan.",
  30: "Our version: Committee matters route through a designated ITSO governance chair.",
};

const ITSO_CASES_JUSTIFICATION = {
  0: {
    changes: "No policy is applied. This case shows the baseline organization and default reporting lines.",
    why: "Use this as a neutral reference before comparing policy-specific cases.",
  },
  1: {
    differs: "Yes.",
    changes: "The revised case explicitly separates formal ownership (Ivan) from temporary acting authority (Boris) and keeps the live acting route visible.",
    why: "This makes temporary authority auditable without implying a permanent org restructure.",
  },
  2: {
    differs: "Yes.",
    changes: "The revised case names leave owner and substitute explicitly, and binds coverage to the effective leave period.",
    why: "This removes ambiguity and makes peer substitution behavior deterministic.",
  },
  3: {
    differs: "Yes.",
    changes: "The revised case is interactive: manager-on-leave, leave cover, review cover, and workflow mode are all user-selectable.",
    why: "This reflects action-specific delegation logic instead of a fixed static example.",
  },
  4: {
    differs: "Yes.",
    changes: "The revised case shows vacancy plus explicit temporary authority assignment.",
    why: "This explains exactly how approvals continue while the head position is unfilled.",
  },
  5: {
    differs: "Yes.",
    changes: "The revised case identifies the self-approval risk condition and the resulting escalation target.",
    why: "This makes policy-safety behavior explicit and testable.",
  },
  6: {
    differs: "Yes.",
    changes: "The revised case distinguishes authority handover from structural reporting hierarchy.",
    why: "This prevents misreading overlap periods as org-chart rewrites.",
  },
  7: {
    differs: "Yes.",
    changes: "The revised case keeps both home and loaned context, while making the active home approval route explicit as Boris -> Iris -> Isaac.",
    why: "This keeps secondment visibility without losing deterministic approver routing.",
  },
  8: {
    differs: "Yes.",
    changes: "The revised case defines two clear parallel routes and removes ambiguous endpoint interpretation.",
    why: "This makes split-allocation behavior easier to validate and explain.",
  },
  9: {
    differs: "Yes.",
    changes: "The revised case explicitly models equal co-head authority with any-one-approve behavior.",
    why: "This highlights shared authority semantics rather than only role titles.",
  },
  10: {
    differs: "Yes.",
    changes: "The revised case separates operational approver (Isaac) from authority owner (Ivan) and shows delegation flow.",
    why: "This preserves accountability and makes on-behalf-of approval auditable.",
  },
  11: {
    differs: "Yes.",
    changes: "The revised case clearly marks people-manager route as primary and technical lead as contextual.",
    why: "This prevents matrix context from being mistaken as approval authority.",
  },
  12: {
    differs: "Yes.",
    changes: "The revised case preserves local formal approval and renders functional reporting as dotted context only.",
    why: "This resolves potential dual-approver confusion in matrix scenarios.",
  },
  13: {
    differs: "Yes.",
    changes: "The revised case explicitly states pre-save cycle rejection rather than post-failure handling.",
    why: "This communicates that invalid loops are blocked before routing can occur.",
  },
  14: {
    differs: "Yes.",
    changes: "The revised case defines orphan handling with direct fallback routing.",
    why: "This ensures approvals do not terminate on missing-manager nodes.",
  },
  15: {
    differs: "Yes.",
    changes: "The revised case frames flat hierarchy as a span-of-control stress case with deterministic routing.",
    why: "This validates scalability and readability under dense direct-report structures.",
  },
  16: {
    differs: "Yes.",
    changes: "The revised case makes skip-level override explicit while retaining normal chain context.",
    why: "This keeps exception routing transparent and auditable.",
  },
  17: {
    differs: "Yes.",
    changes: "The revised case adds explicit cross-tier escalation from ITSO head to EXEC School.",
    why: "This clarifies endpoint behavior when no in-department approver tier exists.",
  },
  18: {
    differs: "Yes.",
    changes: "The revised case defines Parking as a special unit with centralized approval ownership.",
    why: "This ensures non-standard departments still have clear governance routing.",
  },
  19: {
    differs: "Yes.",
    changes: "The revised case shows both event-dated future path and current home path (Boris -> Iris -> Isaac) in the same scenario context.",
    why: "This demonstrates date-driven routing without hiding current-state accountability.",
  },
  20: {
    differs: "Yes.",
    changes: "The revised case adds dual-timeline semantics: historical approved path versus counterfactual recalculation.",
    why: "This preserves policy correctness (no reroute of completed approvals) while exposing audit mismatch clearly.",
  },
  21: {
    differs: "Yes.",
    changes: "The revised case explicitly includes the gap node and the next-level manager in the same path.",
    why: "This ensures gap handling remains complete and auditable end-to-end.",
  },
  22: {
    differs: "Yes.",
    changes: "The revised case changed to Dana and now toggles two explicit routes: default Dana -> Cleo -> Cyrus, click Dana -> Igor -> Isaac, with rotation-team tags.",
    why: "This makes rotation behavior concrete, interactive, and easy to verify visually.",
  },
  23: {
    differs: "Yes.",
    changes: "The revised case defines inactive assignment state as no-route output until reactivation.",
    why: "This clarifies why approval resolution intentionally returns empty path.",
  },
  24: {
    differs: "Yes.",
    changes: "The revised case models re-hire as a new effective-dated assignment with preserved history.",
    why: "This cleanly separates current approval ownership from historical reporting lineage.",
  },
  25: {
    differs: "Yes.",
    changes: "The revised case routes consultant requests through an explicit internal sponsor chain.",
    why: "External identities still require accountable internal approvers.",
  },
  26: {
    differs: "Yes.",
    changes: "The revised case emphasizes temporary authority window with end-date rollback.",
    why: "This prevents temporary cross-entity assignment from becoming implicit permanent state.",
  },
  27: {
    differs: "Yes.",
    changes: "The revised case states that both job-share holders map to one shared position and common route.",
    why: "This confirms consistency of approval ownership despite split FTE staffing.",
  },
  28: {
    differs: "Yes.",
    changes: "The revised case explicitly separates budget-home context from operational reporting context.",
    why: "This prevents budgeting metadata from being confused with live approver routing.",
  },
  29: {
    differs: "Yes.",
    changes: "The revised case defines immediate bypass of terminated approver and fallback to Ivan.",
    why: "This enforces active-status checks and keeps routing valid under stale records.",
  },
  30: {
    differs: "Yes.",
    changes: "The revised case binds committee request type to designated governance chair routing.",
    why: "This gives special workflows a deterministic authority endpoint.",
  },
};

const ITSO_CASES_DESCRIPTION_DESIGN =
  "Each case uses the same structure: base scenario, ITSO-specific implementation, deterministic target route, and explicit visual cues for special states.";

const ITSO_CASES_GENERAL_JUSTIFICATION =
  "The design keeps routing explainable for reviewers, testable for QA, and auditable for governance decisions.";

const ITSO_CASES_QUALITY_GOALS = [
  "Fidelity: description and diagram must match actual routing logic.",
  "Auditability: approver path and authority context must be explicit.",
  "Determinism: each case should resolve to a stable expected route.",
  "Clarity: special states (leave, gap, shell, inactive) must be visually obvious.",
  "Policy Safety: prevent invalid outcomes such as self-approval or inactive approver routing.",
];

const ITSO_CASE_VISUAL_PLAN = {
  1: { tags: [{ name: "Ivan", text: "on leave", className: "onleave-tag" }, { name: "Boris", text: "acting", className: "itso-case-tag" }] },
  2: { tags: [{ name: "Cara", text: "on leave", className: "onleave-tag" }, { name: "Ingrid", text: "peer cover", className: "itso-case-tag" }, { name: "Cyrus", text: "covered", className: "itso-note-tag" }] },
  3: { tags: [{ name: "Cyrus", text: "on leave", className: "onleave-tag" }, { name: "Isaac", text: "leave duty", className: "duty-leave-tag" }, { name: "Evan", text: "review duty", className: "duty-review-tag" }] },
  4: { tags: [{ name: "Ivan", text: "temp head", className: "itso-case-tag" }, { name: "Ingrid", text: "head vacant", className: "itso-warning-tag" }] },
  5: { tags: [{ name: "Ingrid", text: "self check", className: "itso-warning-tag" }, { name: "Ivan", text: "escalate", className: "itso-case-tag" }] },
  6: { tags: [{ name: "Ingrid", text: "handover", className: "itso-case-tag" }, { name: "Evan", text: "incoming", className: "itso-note-tag" }] },
  7: {
    tags: [
      { name: "Boris", text: "home post", className: "itso-note-tag" },
      { name: "Hannah", text: "project mgr", className: "itso-note-tag" }
    ],
    externalSection: {
      title: "External (HKUST/Vendor/Consult)",
      nearDept: "HRO",
      nodes: [{ name: "Boris [HKUST Loan]", role: "Loaned from ITSO", alignTo: "Boris" }],
      links: [{ from: "Boris [HKUST Loan]", to: "Hannah", label: "project route" }],
    },
  },
  8: { tags: [{ name: "Bruno", text: "split", className: "itso-case-tag" }, { name: "Igor", text: "primary", className: "itso-note-tag" }, { name: "Conrad", text: "secondary", className: "itso-case-tag" }] },
  9: { tags: [{ name: "Ivan", text: "co-head", className: "itso-case-tag" }, { name: "Ingrid", text: "co-head", className: "itso-case-tag" }] },
  10: { tags: [{ name: "Isaac", text: "delegate", className: "itso-case-tag" }, { name: "Ivan", text: "owner", className: "itso-note-tag" }] },
  11: { tags: [{ name: "Cyrus", text: "tech lead", className: "itso-note-tag" }, { name: "Isaac", text: "people mgr", className: "itso-case-tag" }] },
  12: { tags: [{ name: "Gemma", text: "requester", className: "itso-note-tag" }, { name: "Ingrid", text: "local approver", className: "itso-case-tag" }, { name: "Ivan", text: "functional lead", className: "itso-note-tag" }], edges: [{ from: "Gemma", to: "Ivan", label: "functional" }] },
  13: {
    tags: [
      { name: "Isaac", text: "acting head", className: "itso-case-tag" },
      { name: "Isaac", text: "cycle risk", className: "itso-warning-tag" },
      { name: "Ivan", text: "validator", className: "itso-note-tag" }
    ]
  },
  14: { tags: [{ name: "Carl", text: "orphan", className: "itso-warning-tag" }, { name: "Ivan", text: "fallback", className: "itso-case-tag" }] },
  15: { tags: [{ name: "Ivan", text: "wide span", className: "itso-case-tag" }] },
  16: { tags: [{ name: "Bonnie", text: "skip level", className: "itso-case-tag" }, { name: "Ivan", text: "override", className: "itso-note-tag" }] },
  17: { tags: [{ name: "Ivan", text: "dept head", className: "itso-case-tag" }, { name: "School", text: "EXEC", className: "itso-note-tag" }, { name: "Ivan", text: "escalate", className: "itso-note-tag" }] },
  18: { tags: [{ name: "Faye", text: "parking dept (solo)", className: "itso-case-tag" }, { name: "Hannah", text: "HRO approver", className: "itso-note-tag" }] },
  19: {
    tags: [
      { name: "Boris [ITSO ➜ HRO]", text: "future placement", className: "itso-case-tag" },
      { name: "Hannah", text: "future mgr", className: "itso-note-tag" }
    ],
  },
  20: { tags: [{ name: "Cyrus", text: "retro", className: "itso-warning-tag" }, { name: "Ivan", text: "audit", className: "itso-note-tag" }] },
  21: {
    tags: [
      { name: "Daisy", text: "requester", className: "itso-note-tag" },
      { name: "Cleo", text: "line mgr", className: "itso-case-tag" },
      { name: "Cyrus", text: "gap", className: "itso-warning-tag" },
      { name: "Cara", text: "next valid", className: "itso-case-tag" }
    ],
  },
  22: {
    tags: [
      { name: "Dana", text: "rotation trainee", className: "itso-note-tag" },
      { name: "Cleo", text: "ratation#1", className: "itso-case-tag" },
      { name: "Igor", text: "ratation#2", className: "itso-case-tag" },
    ],
  },
  23: { tags: [{ name: "Daisy", text: "inactive", className: "itso-warning-tag" }, { name: "Ivan", text: "no route", className: "itso-note-tag" }], outlines: [{ name: "Daisy", className: "itso-inactive-outline" }] },
  24: { tags: [{ name: "Drake", text: "rehire", className: "itso-case-tag" }] },
  25: {
    tags: [{ name: "Isaac", text: "vendor proxy", className: "itso-note-tag" }, { name: "Ivan", text: "sponsor", className: "itso-case-tag" }],
    externalSection: {
      title: "External (HKUST/Vendor/Consultant)",
      nearDept: "ITSO",
      nodes: [{ name: "Vendor Consultant", role: "External consultant", alignTo: "Isaac" }],
      links: [{ from: "Vendor Consultant", to: "Isaac", label: "sponsor route" }],
    },
  },
  26: {
    tags: [{ name: "Ingrid", text: "affiliate", className: "itso-case-tag" }],
    externalSection: {
      title: "External (HKUST/Vendor/Consultant)",
      nodes: [{ name: "Affiliate Manager [HKUST]", role: "Seconded authority" }],
      links: [{ from: "Affiliate Manager [HKUST]", to: "Ingrid", label: "temporary authority" }],
    },
  },
  27: {
    tags: [
      { name: "Bruno", text: "0.5 FTE", className: "itso-case-tag" },
      { name: "Bella", text: "0.5 FTE", className: "itso-note-tag" },
    ],
  },
  28: {
    tags: [{ name: "Bianca", text: "shell role", className: "itso-warning-tag" }, { name: "Iris", text: "working mgr", className: "itso-note-tag" }],
    edges: [{ from: "Bianca", to: "Bianca [shell]", label: "shell context" }],
  },
  29: { tags: [{ name: "Bonnie", text: "dead mgr", className: "itso-warning-tag" }, { name: "Ivan", text: "fallback", className: "itso-case-tag" }] },
  30: { tags: [{ name: "Gemma", text: "committee", className: "itso-case-tag" }, { name: "Ivan", text: "chair", className: "itso-note-tag" }], edges: [{ from: "Gemma", to: "Ivan", label: "committee" }] },
};

const ITSO_CASE_ZERO = {
  id: 0,
  category: "Overview",
  title: "Overall View (No Policy)",
  focus: "Ivan",
  focusDept: "ITSO",
  scenario: "Baseline overall view of the organization without any case-specific policy, override, or temporary routing behavior.",
  method: "No case policy is applied; this is the reference org chart.",
  target: [],
};

const ITSO_CASES = [
  ITSO_CASE_ZERO,
  ...THIRTY_CASES
    .filter((tc) => tc.id >= 1 && tc.id <= 30)
    .map((tc) => ({
      ...tc,
      focus: remapItsoCaseName(tc.focus),
      focusDept: "ITSO",
      partialActing: tc.id === 3
        ? {
            manager: "Cyrus",
            leaveCover: "Isaac",
            reviewCover: "Evan",
            leaveAction: "annual_leave",
            reviewAction: "performance_review",
          }
        : tc.partialActing,
      scenario: (ITSO_CASE_CONTENT_OVERRIDES[tc.id] && ITSO_CASE_CONTENT_OVERRIDES[tc.id].scenario)
        || remapItsoCaseText(tc.scenario),
      method: (ITSO_CASE_CONTENT_OVERRIDES[tc.id] && ITSO_CASE_CONTENT_OVERRIDES[tc.id].method)
        || remapItsoCaseText(tc.method),
      target: (ITSO_CASE_TARGET_OVERRIDES[tc.id]
        || (tc.target || []).map((chain) => chain.map((name) => remapItsoCaseName(name)))),
    })),
];

let thirtyCasesReady = false;
let thirtyCasesSelected = null;
let thirtyCasesCategory = "";
let itsoCasesReady = false;
let itsoCasesSelected = null;
let itsoCasesCategory = "";
let itsoCasesFocusOverride = null;
let itsoCasesPartialManagerId = null;
let itsoCasesPartialLeaveCoverId = null;
let itsoCasesPartialReviewCoverId = null;
let itsoCasesPartialMode = "leave";
let itsoCase8PathMode = "both";
let itsoCase22PathMode = "primary";
let itsoCase20ViewMode = "historical";
const ITSO_CASE_SELECTED_KEY = "itsoCasesSelectedId";
// When the user clicks a Focus person, store their id here so the
// diagram bolds that person's resolved reporting line instead of the case's
// hardcoded target. null = use the case default. Non-persistent (no DB writes).
let thirtyCasesFocusOverride = null;
// Resolved approval line (real routing simulation) for the clicked focus person
// under the selected case's action; null until a person is clicked. Not persisted.
let thirtyCasesSimChain = null;
// For peer-coverage cases (e.g. Case #2) the user can choose which team lead is
// on leave (owner) and which peer covers (substitute). These hold the chosen
// user ids; null = use the case's documented defaults. Non-persistent.
let thirtyCasesPeerOwnerId = null;
let thirtyCasesPeerSubstituteId = null;
// For partial-acting cases (e.g. Case #3) the user can choose which manager is
// on leave and which peers cover their leave approvals vs performance reviews,
// plus which of those two workflows to simulate. null = use case defaults.
// Non-persistent.
let thirtyCasesPartialManagerId = null;
let thirtyCasesPartialLeaveCoverId = null;
let thirtyCasesPartialReviewCoverId = null;
let thirtyCasesPartialMode = "leave";

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

// Build a name-chain for a chosen Focus user by walking `manager_name` upward
// to the top of the chart (dept head / School). Returns a single chain wrapped
// in a list so it matches the shape `highlightTargetLine` consumes, e.g.
// [["Boris","Ivan","School"]]. A lone person (no manager) yields no chain.
function thirtyCasesFocusChain(users, userId) {
  const start = users.find((u) => u.id === userId);
  if (!start) return null;
  const names = [start.name];
  const seen = new Set([start.name]);
  let current = start;
  while (current && current.manager_name && !seen.has(current.manager_name)) {
    names.push(current.manager_name);
    seen.add(current.manager_name);
    current = users.find((u) => u.name === current.manager_name);
  }
  return names.length > 1 ? [names] : null;
}

function displayCaseCategoryName(category) {
  const names = {
    "Acting & Coverage": "Acting and Coverage",
    "Matrix & Dual Reporting": "Matrix and Dual Reporting",
    "Hierarchy Anomalies & Loops": "Hierarchy Risks and Loops",
    "Temporal & Effective Dating": "Temporal and Effective Dating",
    "Special Entities": "Special Entity Scenarios",
    "Corporate Tier (Layer 1)": "Corporate Tier Layer 1",
  };
  return names[category] || category;
}

const MAJOR_REROUTE_CASE_IDS = new Set([
  1, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 22, 25, 26, 27, 28, 30,
]);
const UNCLEAR_INTENTION_CASE_IDS = new Set([12, 24]);

function caseChangeLevel(caseId) {
  if (UNCLEAR_INTENTION_CASE_IDS.has(Number(caseId))) {
    return { label: "Unclear: I don't know what you want to do", className: "unclear" };
  }
  if (MAJOR_REROUTE_CASE_IDS.has(Number(caseId))) {
    return { label: "Major: Route / Structure Update", className: "major" };
  }
  return { label: "Minor: Label / Wording Update", className: "minor" };
}

const CASE_INTENTION_DETAIL_BY_ID = {
  0: "Provide a policy-neutral baseline view for comparison.",
  1: "Keep department approvals continuous during temporary acting assignment.",
  2: "Apply clear peer-coverage substitution while owner is on leave.",
  3: "Split leave vs review duty with explicit workflow-scoped coverage.",
  4: "Preserve approval continuity when a head position is vacant.",
  5: "Prevent self-approval and force escalation to the next valid approver.",
  6: "Represent handover overlap without rewriting base reporting hierarchy.",
  7: "Show secondment context while keeping deterministic home approval route.",
  8: "Make split-allocation routes explicit and predictable.",
  9: "Model equal co-head authority with any-one-approve behavior.",
  10: "Separate authority owner and operational delegate for auditable delegation.",
  11: "Keep people-manager route primary and technical line contextual.",
  12: "Avoid dual-primary confusion by keeping functional line contextual only.",
  13: "Block circular reporting before invalid routes can be saved.",
  14: "Handle orphaned nodes with deterministic fallback routing.",
  15: "Validate routing clarity under high span-of-control conditions.",
  16: "Make skip-level overrides explicit and traceable.",
  17: "Show escalation beyond department when only head-level node is active.",
  18: "Centralize approvals for special parking-unit governance.",
  19: "Show both event-dated future path and current-state accountability path.",
  20: "Preserve historical approvals and surface counterfactual mismatch for audit.",
  21: "Expose gap node and include next-level escalation in the same route.",
  22: "Demonstrate rotation intent through explicit default/toggled paths.",
  23: "Suspend routing while assignment is inactive on no-pay leave.",
  24: "Treat re-hire as new assignment while preserving historical lineage.",
  25: "Route external requests through accountable internal sponsor chain.",
  26: "Apply temporary authority windows with explicit rollback behavior.",
  27: "Keep job-sharing approvals consistent through one shared position route.",
  28: "Separate budget-home context from operational reporting context.",
  29: "Bypass inactive managers and fail over to valid fallback authority.",
  30: "Route special committee workflows to designated governance chair.",
};

function caseIntentionDetail(caseId) {
  return CASE_INTENTION_DETAIL_BY_ID[Number(caseId)] || "General routing and governance clarity.";
}

function caseIntentionSummary(caseId) {
  const level = caseChangeLevel(caseId);
  return `${level.label}; Intention: ${caseIntentionDetail(caseId)}`;
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
        const level = caseChangeLevel(tc.id);
        text.innerHTML = `<strong>${tc.id}. ${tc.title}</strong><span class="thirty-case-cat"><span class="thirty-case-cat-name">${displayCaseCategoryName(tc.category)}</span><span class="thirty-case-level ${level.className}">${level.label}</span></span>`;
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
          opt.textContent = displayCaseCategoryName(cat);
          return opt;
        })
      );
      filter.addEventListener("change", () => {
        thirtyCasesCategory = filter.value;
        applyThirtyCasesFilter();
      });
    }
    const peerOwnerSel = document.getElementById("thirty-cases-peer-owner");
    const peerSubSel = document.getElementById("thirty-cases-peer-substitute");
    if (peerOwnerSel) peerOwnerSel.addEventListener("change", onThirtyCasesPeerChange);
    if (peerSubSel) peerSubSel.addEventListener("change", onThirtyCasesPeerChange);
    [
      "thirty-cases-partial-manager",
      "thirty-cases-partial-leave-cover",
      "thirty-cases-partial-review-cover",
      "thirty-cases-partial-mode",
    ].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("change", onThirtyCasesPartialChange);
    });
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
  drawDiagram(svg, users, {
    deptTag: true,
    selectedId: thirtyCasesFocusOverride,
    onNodeClick: (u) => {
      // Toggle focus on/off: clicking the focused person clears back to default.
      if (thirtyCasesFocusOverride === u.id) {
        thirtyCasesFocusOverride = null;
        thirtyCasesSimChain = null;
        renderThirtyCasesDiagram();
        updateThirtyCasesDetail();
      } else {
        thirtyCasesFocusOverride = u.id;
        thirtyCasesSimChain = null;
        renderThirtyCasesDiagram();
        updateThirtyCasesDetail();
        // Run the real routing engine for this person under the case's action,
        // then re-render so the resolved approver line is bolded.
        runThirtyCasesSimulation(u.id);
      }
    },
  });
  // Case #1 visual callout: show ITSO head as Ivan with Boris acting.
  if (tc && tc.id === 1) {
    decorateThirtyCaseSkipLevelActing(svg, users);
  }
  // Case #2 visual callout: mark the selected leave owner under their node.
  if (tc && tc.id === 2) {
    decorateThirtyCasePeerCoverageOnLeave(svg, users, tc);
  }
  // Case #3 visual callout: show on-leave manager and role-specific covers.
  if (tc && tc.id === 3) {
    decorateThirtyCasePartialActingDuties(svg, users, tc);
  }
  // Case #4 visual callout: mark Ivan as the temporary vacant-head holder.
  if (tc && tc.id === 4) {
    decorateThirtyCaseVacantHead(svg, users);
  }
  // Case #6 visual callout: handover overlap label on Ingrid node.
  if (tc && tc.id === 6) {
    decorateThirtyCaseHandoverOverlap(svg, users);
  }
  // Case #7 visual callout: external employee block in HR context.
  if (tc && tc.id === 7) {
    decorateThirtyCaseExternalSecondment(svg, users);
  }
  // Case #8 visual callout: show split-allocation dual department label.
  if (tc && tc.id === 8) {
    decorateThirtyCaseSplitAllocation(svg, users);
  }
  // Case #9 visual callout: mark both approvers as co-heads.
  if (tc && tc.id === 9) {
    decorateThirtyCaseCoHeads(svg, users);
  }
  // Case #10 visual callout: executive assistant approves on behalf of Ivan.
  if (tc && tc.id === 10) {
    decorateThirtyCaseExecutiveAssistantDelegation(svg, users);
  }
  // When a person is clicked, bold their real routing-resolved approval line once
  // the simulation returns; before that (and by default) bold the case target.
  const chains = thirtyCasesFocusOverride != null
    ? (thirtyCasesSimChain || thirtyCasesFocusChain(users, thirtyCasesFocusOverride))
    : thirtyCasesTargetChain(users, tc);
  highlightTargetLine(svg, users, chains);
  if (tc && tc.id === 1) {
    rerouteCaseOneHighlightedPathViaActing(svg, users, chains);
  }
  // When a case is selected, fade unrelated nodes/edges so the scenario path
  // is easier to scan without changing the underlying structure.
  dimThirtyCasesContext(svg, users, tc ? chains : null);
}

function dimThirtyCasesContext(svg, users, chains) {
  if (!svg) return;
  svg.querySelectorAll(".diagram-node").forEach((n) => n.classList.remove("muted"));
  svg.querySelectorAll(".diagram-edge").forEach((e) => e.classList.remove("muted"));
  if (!chains || !chains.length) return;

  const idByName = {};
  users.forEach((u) => {
    if (idByName[u.name] == null) idByName[u.name] = u.id;
  });

  const keepNodeIds = new Set();
  const keepEdges = new Set();
  chains.forEach((chain) => {
    if (!Array.isArray(chain) || !chain.length) return;
    chain.forEach((name) => {
      const id = idByName[name];
      if (id != null) keepNodeIds.add(String(id));
    });
    for (let i = 0; i < chain.length - 1; i++) {
      const childId = idByName[chain[i]];
      const parentId = idByName[chain[i + 1]];
      if (childId == null || parentId == null) continue;
      keepEdges.add(`${childId}->${parentId}`);
    }
  });

  svg.querySelectorAll(".diagram-node").forEach((node) => {
    const id = node.dataset.userId;
    if (!keepNodeIds.has(String(id))) node.classList.add("muted");
  });
  svg.querySelectorAll(".diagram-edge").forEach((edge) => {
    const key = `${edge.dataset.childId}->${edge.dataset.parentId}`;
    if (!keepEdges.has(key)) edge.classList.add("muted");
  });
}

function isolateItsoCase10Actors(svg, users) {
  if (!svg) return;
  const isaac = users.find((u) => u.name === "Isaac" && u.department_code === "ITSO");
  const ivan = users.find((u) => u.name === "Ivan" && u.department_code === "ITSO");
  if (!isaac || !ivan) return;
  const keep = new Set([String(isaac.id), String(ivan.id)]);

  svg.querySelectorAll(".diagram-node").forEach((node) => {
    const id = String(node.dataset.userId || "");
    if (!keep.has(id)) {
      node.classList.add("muted");
    }
  });

  svg.querySelectorAll(".diagram-edge").forEach((edge) => {
    const childId = String(edge.dataset.childId || "");
    const parentId = String(edge.dataset.parentId || "");
    const keepEdge = keep.has(childId) && keep.has(parentId);
    if (!keepEdge) edge.classList.add("muted");
  });
}

// Case #1 custom node rendering: draw an acting overlay node to the right of
// Ivan, route dotted arrows into it (Ivan handover + Boris source), then link
// it back to Ivan's normal manager route.
function decorateThirtyCaseSkipLevelActing(svg, users) {
  const ivan = users.find((u) => u.name === "Ivan" && u.department_code === "ITSO");
  const boris = users.find((u) => u.name === "Boris" && u.department_code === "ITSO");
  if (!ivan || !boris) return;

  const ivanNode = svg.querySelector(`.diagram-node[data-user-id="${ivan.id}"]`);
  const borisNode = svg.querySelector(`.diagram-node[data-user-id="${boris.id}"]`);
  if (!ivanNode || !borisNode) return;

  const parsePos = (node) => {
    const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(node.getAttribute("transform") || "");
    if (!m) return null;
    return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
  };
  const ivanPos = parsePos(ivanNode);
  if (!ivanPos) return;

  const ns = "http://www.w3.org/2000/svg";
  const markerId = "acting-overlay-arrow";
  let defs = svg.querySelector("defs");
  if (!defs) {
    defs = document.createElementNS(ns, "defs");
    svg.insertBefore(defs, svg.firstChild);
  }
  if (!defs.querySelector(`#${markerId}`)) {
    const marker = document.createElementNS(ns, "marker");
    marker.setAttribute("id", markerId);
    marker.setAttribute("markerWidth", "8");
    marker.setAttribute("markerHeight", "8");
    marker.setAttribute("refX", "6");
    marker.setAttribute("refY", "3");
    marker.setAttribute("orient", "auto");
    const headPath = document.createElementNS(ns, "path");
    headPath.setAttribute("d", "M0,0 L0,6 L8,3 z");
    headPath.setAttribute("fill", "#e48a1f");
    marker.appendChild(headPath);
    defs.appendChild(marker);
  }

  const actingX = ivanPos.x + NODE_W + 48;
  const actingY = ivanPos.y;

  const actingGroup = document.createElementNS(ns, "g");
  actingGroup.setAttribute("class", "acting-overlay-node");
  actingGroup.setAttribute("transform", `translate(${actingX},${actingY})`);

  const actingRect = document.createElementNS(ns, "rect");
  actingRect.setAttribute("width", NODE_W);
  actingRect.setAttribute("height", NODE_H);
  actingRect.setAttribute("rx", "8");
  actingGroup.appendChild(actingRect);

  const actingName = document.createElementNS(ns, "text");
  actingName.setAttribute("x", NODE_W / 2);
  actingName.setAttribute("y", 18);
  actingName.setAttribute("class", "acting-overlay-name");
  actingName.textContent = "Boris (Acting)";
  actingGroup.appendChild(actingName);

  const actingRole = document.createElementNS(ns, "text");
  actingRole.setAttribute("x", NODE_W / 2);
  actingRole.setAttribute("y", 34);
  actingRole.setAttribute("class", "acting-overlay-role");
  actingRole.textContent = "ITSO Acting Head";
  actingGroup.appendChild(actingRole);

  svg.appendChild(actingGroup);

  appendNodeTag(ivanNode, "(on leave)", "onleave-tag", 12);

  const borisRect = borisNode.querySelector("rect");
  if (borisRect) borisRect.classList.add("acting-source-outline");

  const addActingEdge = (x1, y1, x2, y2, role) => {
    const path = document.createElementNS(ns, "path");
    const midY = y1 + (y2 - y1) / 2;
    path.setAttribute(
      "d",
      Math.abs(x1 - x2) < 0.5
        ? `M ${x1} ${y1} L ${x2} ${y2}`
        : `M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`
    );
    path.setAttribute("class", "acting-overlay-edge");
    if (role) path.dataset.role = role;
    path.setAttribute("marker-end", `url(#${markerId})`);
    svg.appendChild(path);
    return path;
  };

  const ivanBottom = { x: ivanPos.x + NODE_W / 2, y: ivanPos.y + NODE_H };
  const actingTop = { x: actingX + NODE_W / 2, y: actingY };
  addActingEdge(ivanBottom.x, ivanBottom.y, actingTop.x, actingTop.y, "ivan-to-acting");

  const ivanManager = users.find((u) => u.name === ivan.manager_name);
  if (ivanManager) {
    const mgrNode = svg.querySelector(`.diagram-node[data-user-id="${ivanManager.id}"]`);
    const mgrPos = mgrNode ? parsePos(mgrNode) : null;
    if (mgrPos) {
      const actingTop = { x: actingX + NODE_W / 2, y: actingY };
      const mgrBottom = { x: mgrPos.x + NODE_W / 2, y: mgrPos.y + NODE_H };
      addActingEdge(actingTop.x, actingTop.y, mgrBottom.x, mgrBottom.y, "acting-to-manager");
    }
  }
}

// For Case #1, whenever a highlighted chain passes through Ivan (on leave),
// replace the highlighted Ivan->manager segment with Ivan->Acting->manager.
function rerouteCaseOneHighlightedPathViaActing(svg, users, chains) {
  if (!svg || !chains || !chains.length) return;
  const hasIvan = chains.some((chain) => Array.isArray(chain) && chain.includes("Ivan"));
  if (!hasIvan) return;

  const ivan = users.find((u) => u.name === "Ivan" && u.department_code === "ITSO");
  if (!ivan) return;

  chains.forEach((chain) => {
    if (!Array.isArray(chain)) return;
    for (let i = 0; i < chain.length - 1; i++) {
      if (chain[i] !== "Ivan") continue;
      const managerName = chain[i + 1];
      const manager = users.find((u) => u.name === managerName);
      if (!manager) continue;
      const direct = svg.querySelector(
        `.diagram-edge[data-child-id="${ivan.id}"][data-parent-id="${manager.id}"]`
      );
      if (direct) direct.classList.remove("highlighted");
    }
  });

  ["ivan-to-acting", "acting-to-manager"].forEach((role) => {
    svg.querySelectorAll(`.acting-overlay-edge[data-role="${role}"]`).forEach((edge) => {
      edge.classList.add("acting-overlay-edge-emphasis");
    });
  });
}

// Case #2 custom node rendering: show an italic "(onleave)" under the person
// currently marked as on leave (owner in the peer-coverage selector/default).
function decorateThirtyCasePeerCoverageOnLeave(svg, users, testCase) {
  const sel = thirtyCasesPeerSelection(users, testCase);
  if (!sel || sel.ownerId == null) return;
  const node = svg.querySelector(`.diagram-node[data-user-id="${sel.ownerId}"]`);
  if (!node) return;

  appendNodeTag(node, "(on leave)", "onleave-tag", 12);
}

// Append a right-aligned tag under a node and clamp its text width so it stays
// inside the node's right boundary.
function appendNodeTag(node, text, className, yOffset) {
  if (!node) return;
  const ns = "http://www.w3.org/2000/svg";
  const tag = document.createElementNS(ns, "text");
  tag.setAttribute("x", NODE_W - 26);
  tag.setAttribute("y", NODE_H + (yOffset || 12));
  tag.setAttribute("text-anchor", "end");
  tag.setAttribute("class", className);
  tag.textContent = text;
  const maxTagW = Math.min(96, NODE_W - 16);
  if (tag.getComputedTextLength && tag.getComputedTextLength() > maxTagW) {
    tag.setAttribute("textLength", String(maxTagW));
    tag.setAttribute("lengthAdjust", "spacingAndGlyphs");
  }
  node.appendChild(tag);
}

// Case #3 custom node rendering: mark the on-leave manager and annotate who
// covers leave duty vs review duty.
function decorateThirtyCasePartialActingDuties(svg, users, testCase) {
  const sel = thirtyCasesPartialSelection(users, testCase);
  if (!sel) return;
  const managerNode = sel.managerId != null
    ? svg.querySelector(`.diagram-node[data-user-id="${sel.managerId}"]`)
    : null;
  const leaveNode = sel.leaveCoverId != null
    ? svg.querySelector(`.diagram-node[data-user-id="${sel.leaveCoverId}"]`)
    : null;
  const reviewNode = sel.reviewCoverId != null
    ? svg.querySelector(`.diagram-node[data-user-id="${sel.reviewCoverId}"]`)
    : null;

  const managerName = managerNode ? managerNode.querySelector(".node-name")?.textContent || "" : "";
  const leaveName = leaveNode ? leaveNode.querySelector(".node-name")?.textContent || "" : "";
  const reviewName = reviewNode ? reviewNode.querySelector(".node-name")?.textContent || "" : "";

  if (managerNode) appendNodeTag(managerNode, `on leave: ${managerName}`, "onleave-tag", 12);
  if (leaveNode) appendNodeTag(leaveNode, `leave duty: ${leaveName}`, "duty-leave-tag", 12);
  if (reviewNode) appendNodeTag(reviewNode, `review duty: ${reviewName}`, "duty-review-tag", 12);
}

// Case #4 custom node rendering: Ivan is shown as carrying a vacant-head
// assignment so the temporary coverage context is visible on the chart.
function decorateThirtyCaseVacantHead(svg, users) {
  const ivan = users.find((u) => u.name === "Ivan" && u.department_code === "ITSO");
  if (!ivan) return;
  const ivanNode = svg.querySelector(`.diagram-node[data-user-id="${ivan.id}"]`);
  if (!ivanNode) return;
  const rect = ivanNode.querySelector("rect");
  if (rect) rect.classList.add("vacant-node-outline");
  const nameText = ivanNode.querySelector(".node-name");
  if (!nameText) return;
  nameText.textContent = "Vacant";
  nameText.setAttribute("font-style", "italic");
  nameText.removeAttribute("textLength");
  nameText.removeAttribute("lengthAdjust");
  const maxTextW = NODE_W - 12;
  if (nameText.getComputedTextLength && nameText.getComputedTextLength() > maxTextW) {
    nameText.setAttribute("textLength", String(maxTextW));
    nameText.setAttribute("lengthAdjust", "spacingAndGlyphs");
  }
}

// Case #6 custom node rendering: label Ingrid as sharing approval rights with
// Sam during handover overlap.
function decorateThirtyCaseHandoverOverlap(svg, users) {
  const ingrid = users.find((u) => u.name === "Ingrid" && u.department_code === "ITSO");
  if (!ingrid) return;
  const ingridNode = svg.querySelector(`.diagram-node[data-user-id="${ingrid.id}"]`);
  if (!ingridNode) return;
  const nameText = ingridNode.querySelector(".node-name");
  if (!nameText) return;
  nameText.textContent = "Ingrid → Sam (Approval rights)";
  nameText.removeAttribute("textLength");
  nameText.removeAttribute("lengthAdjust");
  const maxTextW = NODE_W - 12;
  if (nameText.getComputedTextLength && nameText.getComputedTextLength() > maxTextW) {
    nameText.setAttribute("textLength", String(maxTextW));
    nameText.setAttribute("lengthAdjust", "spacingAndGlyphs");
  }
}

// Case #7 custom node rendering: show an external secondment context block in
// the HR area so cross-department assignment is visible in the diagram.
function decorateThirtyCaseExternalSecondment(svg, users) {
  const boris = users.find((u) => u.name === "Boris" && u.department_code === "ITSO");
  const hannah = users.find((u) => u.name === "Hannah" && u.department_code === "HRO");
  if (!boris || !hannah) return;

  const borisNode = svg.querySelector(`.diagram-node[data-user-id="${boris.id}"]`);
  const hannahNode = svg.querySelector(`.diagram-node[data-user-id="${hannah.id}"]`);
  if (!borisNode || !hannahNode) return;

  const parsePos = (node) => {
    const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(node.getAttribute("transform") || "");
    if (!m) return null;
    return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
  };
  const bPos = parsePos(borisNode);
  const hPos = parsePos(hannahNode);
  if (!bPos || !hPos) return;

  const ns = "http://www.w3.org/2000/svg";
  const exX = hPos.x + NODE_W + 26;
  const exY = hPos.y - 24;
  const regionW = NODE_W + 28;
  const regionH = NODE_H + 48;
  const copyX = exX + 14;
  const copyY = exY + 26;

  const clampText = (el, maxW) => {
    if (!el || !el.getComputedTextLength) return;
    if (el.getComputedTextLength() > maxW) {
      el.setAttribute("textLength", String(maxW));
      el.setAttribute("lengthAdjust", "spacingAndGlyphs");
    }
  };

  // Rename the original node in this case so the secondment context is clear.
  const originalName = borisNode.querySelector(".node-name");
  if (originalName) {
    originalName.textContent = "Boris (loaned)";
    originalName.removeAttribute("textLength");
    originalName.removeAttribute("lengthAdjust");
    clampText(originalName, NODE_W - 12);
  }

  // Draw a region in the HR side containing a copied Boris node.
  const region = document.createElementNS(ns, "g");
  region.setAttribute("class", "external-region");

  const regionRect = document.createElementNS(ns, "rect");
  regionRect.setAttribute("x", exX);
  regionRect.setAttribute("y", exY);
  regionRect.setAttribute("width", regionW);
  regionRect.setAttribute("height", regionH);
  regionRect.setAttribute("rx", "10");
  regionRect.setAttribute("class", "external-region-box");
  region.appendChild(regionRect);

  const regionTitle = document.createElementNS(ns, "text");
  regionTitle.setAttribute("x", exX + regionW / 2);
  regionTitle.setAttribute("y", exY + 16);
  regionTitle.setAttribute("class", "external-region-title");
  regionTitle.textContent = "External Employee (HKUST)";
  region.appendChild(regionTitle);

  const copyNode = document.createElementNS(ns, "g");
  copyNode.setAttribute("class", "external-copy-node");
  copyNode.setAttribute("transform", `translate(${copyX},${copyY})`);

  const copyRect = document.createElementNS(ns, "rect");
  copyRect.setAttribute("width", NODE_W);
  copyRect.setAttribute("height", NODE_H);
  copyRect.setAttribute("rx", "8");
  copyRect.setAttribute("class", "external-copy-rect");
  copyNode.appendChild(copyRect);

  const copyName = document.createElementNS(ns, "text");
  copyName.setAttribute("x", NODE_W / 2);
  copyName.setAttribute("y", 18);
  copyName.setAttribute("class", "external-copy-name");
  copyName.textContent = "Boris [ITSO]";
  copyNode.appendChild(copyName);

  const copyLevel = document.createElementNS(ns, "text");
  copyLevel.setAttribute("x", NODE_W / 2);
  copyLevel.setAttribute("y", 34);
  copyLevel.setAttribute("class", "external-copy-level");
  copyLevel.textContent = `${boris.level_name} (L${boris.level_rank})`;
  copyNode.appendChild(copyLevel);

  clampText(copyName, NODE_W - 12);
  clampText(copyLevel, NODE_W - 12);

  region.appendChild(copyNode);
  svg.appendChild(region);

  const addEdge = (x1, y1, x2, y2) => {
    const path = document.createElementNS(ns, "path");
    const midY = y1 + (y2 - y1) / 2;
    path.setAttribute(
      "d",
      Math.abs(x1 - x2) < 0.5
        ? `M ${x1} ${y1} L ${x2} ${y2}`
        : `M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`
    );
    path.setAttribute("class", "external-overlay-edge");
    svg.appendChild(path);
  };

  const copyLeft = { x: copyX, y: copyY + NODE_H / 2 };
  const copyCenter = { x: copyX + NODE_W / 2, y: copyY + NODE_H / 2 };
  const hannahLeft = { x: hPos.x, y: hPos.y + NODE_H / 2 };

  addEdge(copyCenter.x, copyCenter.y, hannahLeft.x, hannahLeft.y);
}

// Case #8 custom node rendering: show Bruno as dual-affiliated while keeping
// his data identity unchanged for simulation and routing.
function decorateThirtyCaseSplitAllocation(svg, users) {
  const bruno = users.find((u) => u.name === "Bruno" && u.department_code === "ITSO");
  if (!bruno) return;
  const brunoNode = svg.querySelector(`.diagram-node[data-user-id="${bruno.id}"]`);
  if (!brunoNode) return;

  const nameText = brunoNode.querySelector(".node-name");
  if (!nameText) return;
  nameText.textContent = "Burno [ITSO/HRO]";
  nameText.removeAttribute("textLength");
  nameText.removeAttribute("lengthAdjust");

  const maxTextW = NODE_W - 12;
  if (nameText.getComputedTextLength && nameText.getComputedTextLength() > maxTextW) {
    nameText.setAttribute("textLength", String(maxTextW));
    nameText.setAttribute("lengthAdjust", "spacingAndGlyphs");
  }
}

// Case #9 custom node rendering: show two approvers as equal co-heads.
function decorateThirtyCaseCoHeads(svg, users) {
  const coHeads = ["Ivan", "Ingrid"]
    .map((name) => users.find((u) => u.name === name && u.department_code === "ITSO"))
    .filter(Boolean);
  if (!coHeads.length) return;

  coHeads.forEach((u) => {
    const node = svg.querySelector(`.diagram-node[data-user-id="${u.id}"]`);
    if (!node) return;
    const rect = node.querySelector("rect");
    if (rect) rect.classList.add("cohead-node-outline");
    const nameText = node.querySelector(".node-name");
    if (!nameText) return;
    nameText.textContent = `${u.name} (Co-Head)`;
    nameText.removeAttribute("textLength");
    nameText.removeAttribute("lengthAdjust");
    const maxTextW = NODE_W - 12;
    if (nameText.getComputedTextLength && nameText.getComputedTextLength() > maxTextW) {
      nameText.setAttribute("textLength", String(maxTextW));
      nameText.setAttribute("lengthAdjust", "spacingAndGlyphs");
    }
  });
}

// Case #10 custom node rendering: label Isaac as approving on behalf of Ivan.
function decorateThirtyCaseExecutiveAssistantDelegation(svg, users, options) {
  options = options || {};
  const includeOwnerFlow = options.includeOwnerFlow !== false;
  const isaac = users.find((u) => u.name === "Isaac" && u.department_code === "ITSO");
  const ivan = users.find((u) => u.name === "Ivan" && u.department_code === "ITSO");
  if (!isaac || !ivan) return;

  const isaacNode = svg.querySelector(`.diagram-node[data-user-id="${isaac.id}"]`);
  const ivanNode = svg.querySelector(`.diagram-node[data-user-id="${ivan.id}"]`);
  if (!isaacNode || !ivanNode) return;

  const nameText = isaacNode.querySelector(".node-name");
  if (!nameText) return;
  nameText.textContent = "Isaac (on behalf of Ivan)";
  nameText.removeAttribute("textLength");
  nameText.removeAttribute("lengthAdjust");

  const maxTextW = NODE_W - 12;
  if (nameText.getComputedTextLength && nameText.getComputedTextLength() > maxTextW) {
    nameText.setAttribute("textLength", String(maxTextW));
    nameText.setAttribute("lengthAdjust", "spacingAndGlyphs");
  }

  const parsePos = (node) => {
    const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(node.getAttribute("transform") || "");
    if (!m) return null;
    return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
  };
  const isaacPos = parsePos(isaacNode);
  const ivanPos = parsePos(ivanNode);
  if (!isaacPos || !ivanPos) return;

  const ns = "http://www.w3.org/2000/svg";
  const markerId = "delegation-process-arrow";
  let defs = svg.querySelector("defs");
  if (!defs) {
    defs = document.createElementNS(ns, "defs");
    svg.insertBefore(defs, svg.firstChild);
  }
  if (!defs.querySelector(`#${markerId}`)) {
    const marker = document.createElementNS(ns, "marker");
    marker.setAttribute("id", markerId);
    marker.setAttribute("markerWidth", "8");
    marker.setAttribute("markerHeight", "8");
    marker.setAttribute("refX", "6");
    marker.setAttribute("refY", "3");
    marker.setAttribute("orient", "auto");
    const headPath = document.createElementNS(ns, "path");
    headPath.setAttribute("d", "M0,0 L0,6 L8,3 z");
    headPath.setAttribute("fill", "#7a3aa8");
    marker.appendChild(headPath);
    defs.appendChild(marker);
  }

  const addProcessEdge = (x1, y1, x2, y2) => {
    const path = document.createElementNS(ns, "path");
    const midY = y1 + (y2 - y1) / 2;
    path.setAttribute(
      "d",
      Math.abs(x1 - x2) < 0.5
        ? `M ${x1} ${y1} L ${x2} ${y2}`
        : `M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`
    );
    path.setAttribute("class", "delegation-process-edge");
    path.setAttribute("marker-end", `url(#${markerId})`);
    svg.appendChild(path);
  };

  const requestPoint = {
    x: isaacPos.x + NODE_W / 2,
    y: isaacPos.y + NODE_H + 34,
  };
  const isaacBottom = {
    x: isaacPos.x + NODE_W / 2,
    y: isaacPos.y + NODE_H,
  };
  const isaacTop = {
    x: isaacPos.x + NODE_W / 2,
    y: isaacPos.y,
  };
  const ivanBottom = {
    x: ivanPos.x + NODE_W / 2,
    y: ivanPos.y + NODE_H,
  };

  const addOwnerToDelegateRightLane = () => {
    const path = document.createElementNS(ns, "path");
    const ownerPort = {
      x: ivanPos.x + NODE_W,
      y: ivanPos.y + NODE_H / 2,
    };
    const delegatePort = {
      x: isaacPos.x + NODE_W,
      y: isaacPos.y + NODE_H / 2,
    };
    const laneX = Math.max(ownerPort.x, delegatePort.x) + 28;
    path.setAttribute(
      "d",
      `M ${ownerPort.x} ${ownerPort.y} L ${laneX} ${ownerPort.y} L ${laneX} ${delegatePort.y} L ${delegatePort.x} ${delegatePort.y}`
    );
    path.setAttribute("class", "delegation-process-edge");
    path.setAttribute("marker-end", `url(#${markerId})`);
    svg.appendChild(path);
    return { laneX, ownerPort, delegatePort };
  };

  addProcessEdge(requestPoint.x, requestPoint.y, isaacBottom.x, isaacBottom.y);
  let ownerFlowGeom = null;
  if (includeOwnerFlow) {
    ownerFlowGeom = addOwnerToDelegateRightLane();
  }

  const startDot = document.createElementNS(ns, "circle");
  startDot.setAttribute("cx", String(requestPoint.x));
  startDot.setAttribute("cy", String(requestPoint.y));
  startDot.setAttribute("r", "4");
  startDot.setAttribute("class", "delegation-process-dot");
  svg.appendChild(startDot);

  const requestLabel = document.createElementNS(ns, "text");
  requestLabel.setAttribute("x", String(requestPoint.x + 8));
  requestLabel.setAttribute("y", String(requestPoint.y + 4));
  requestLabel.setAttribute("class", "delegation-process-label");
  requestLabel.textContent = "Request submitted";
  svg.appendChild(requestLabel);

  const flowLabel = document.createElementNS(ns, "text");
  const flowLabelX = ownerFlowGeom ? ownerFlowGeom.laneX + 4 : Math.max(isaacTop.x, ivanBottom.x) + 8;
  const flowLabelY = ownerFlowGeom
    ? ((ownerFlowGeom.ownerPort.y + ownerFlowGeom.delegatePort.y) / 2 - 6)
    : ((isaacTop.y + ivanBottom.y) / 2 - 6);
  flowLabel.setAttribute("x", String(flowLabelX));
  flowLabel.setAttribute("y", String(flowLabelY));
  flowLabel.setAttribute("class", "delegation-process-label");
  flowLabel.textContent = includeOwnerFlow
    ? "Delegated approval only (Ivan -> Isaac)"
    : "Delegation active";
  svg.appendChild(flowLabel);
}

// Resolve a case's default target line from the live org chart. Cases whose
// target is an empty list are intentionally inactive (no workflow), so they
// stay unbolded; every other case bolds the focus member's real reporting
// chain — the same logic used when a node is clicked.
function thirtyCasesTargetChain(users, testCase) {
  if (!testCase || (testCase.target && testCase.target.length === 0)) return null;
  // Peer-coverage cases derive their target line from the chosen on-leave /
  // covering team leads so changing the selectors re-bolds the handoff line.
  const peerChain = thirtyCasesPeerActiveChain(users, testCase);
  if (peerChain) return peerChain;
  // Partial-acting cases derive their target line from the chosen on-leave
  // manager, the active cover (leave vs review), and the default second level.
  const partialChain = thirtyCasesPartialActiveChain(users, testCase);
  if (partialChain) return partialChain;
  // Bold each case's explicit, scenario-specific target line(s) so overlay,
  // override, skip-level and co-head cases highlight the documented approver
  // chain rather than the focus member's plain primary line.
  if (testCase.target && testCase.target.length) return testCase.target;
  return thirtyCasesFocusChain(users, thirtyCasesFocusId(users, testCase));
}

// Update the detail panel text to reflect the case default or chosen focus line.
function updateThirtyCasesDetail(simResult) {
  const tc = THIRTY_CASES.find((c) => c.id === thirtyCasesSelected);
  if (!tc) return;
  document.getElementById("thirty-cases-title").textContent = `${tc.id}. ${tc.title} — ${tc.category}`;
  const scenarioEl = document.getElementById("thirty-cases-scenario");
  const officialText = tc.note ? `${tc.scenario}  ${tc.note}` : tc.scenario;
  const altText = THIRTY_CASES_ALT_SCENARIO[tc.id];
  scenarioEl.innerHTML = altText
    ? `${escHtml(officialText)}<span class="thirty-cases-alt-desc">${escHtml(altText)}</span>`
    : escHtml(officialText);
  const approversEl = document.getElementById("thirty-cases-approvers");
  if (approversEl) {
    approversEl.replaceChildren();
    approversEl.classList.add("hidden");
  }
  let line;
  if (thirtyCasesFocusOverride != null) {
    const users = thirtyCasesUsers();
    const person = users.find((u) => u.id === thirtyCasesFocusOverride);
    const who = person ? person.name : "?";
    if (simResult && (simResult.overlay_steps || []).length) {
      // Real routing answer for this person in this case.
      const steps = simResult.overlay_steps;
      line = `Approver line for ${who} → ` +
        steps
          .map(
            (s) =>
              `${s.approver} [${s.source}]` +
              (s.acting_approver ? ` (${s.acting_approver} acting)` : "")
          )
          .join(" → ");
      if (approversEl) {
        approversEl.classList.remove("hidden");
        steps.forEach((s) => {
          const li = document.createElement("li");
          li.textContent = `${s.approver} — ${s.source}` +
            (s.acting_approver ? ` (${s.acting_approver} acting)` : "") +
            (s.alternate_approvers && s.alternate_approvers.length
              ? ` (or ${s.alternate_approvers.join(", ")})`
              : "");
          approversEl.appendChild(li);
        });
      }
    } else if (simResult && simResult.overlay_error) {
      line = `Approver line: ${simResult.overlay_error}`;
    } else {
      const chain = thirtyCasesFocusChain(users, thirtyCasesFocusOverride);
      line = chain
        ? `Resolving approvers for ${who}…  Reporting line: ${chain.map((c) => c.join(" → ")).join("  •  ")}`
        : `${who} — top of chain, no manager.`;
    }
  } else {
    const users = thirtyCasesUsers();
    const chain = thirtyCasesTargetChain(users, tc);
    line = chain
      ? "Target line: " + chain.map((c) => c.join(" → ")).join("  •  ")
      : "Target line: none — assignment inactive, workflow suspended.";
    if (tc.id === 3) {
      const sel = thirtyCasesPartialSelection(users, tc);
      if (sel && sel.managerId != null) {
        const manager = users.find((u) => u.id === sel.managerId);
        const leaveCover = users.find((u) => u.id === sel.leaveCoverId);
        const reviewCover = users.find((u) => u.id === sel.reviewCoverId);
        const sample = manager ? (users.find((u) => u.manager_name === manager.name) || manager) : null;
        const second = manager ? users.find((u) => u.name === manager.manager_name) : null;
        const sampleName = sample ? sample.name : "Requester";
        const secondName = second ? second.name : "(top)";
        const managerName = manager ? manager.name : "(unknown)";
        const leaveName = leaveCover ? leaveCover.name : "(none)";
        const reviewName = reviewCover ? reviewCover.name : "(none)";
        line += `  •  On leave: ${managerName}. Leave path: ${sampleName} → ${leaveName} → ${secondName}. Review path: ${sampleName} → ${reviewName} → ${secondName}.`;
      }
    }
  }
  document.getElementById("thirty-cases-method").textContent = `${tc.method}  —  ${line}`;
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
  let defs = svg.querySelector("defs");
  if (!defs) {
    defs = document.createElementNS(ns, "defs");
    svg.insertBefore(defs, svg.firstChild);
  }
  if (!defs.querySelector("#target-arrow")) {
    const marker = document.createElementNS(ns, "marker");
    marker.setAttribute("id", "target-arrow");
    marker.setAttribute("markerWidth", "8");
    marker.setAttribute("markerHeight", "8");
    marker.setAttribute("refX", "6");
    marker.setAttribute("refY", "3");
    marker.setAttribute("orient", "auto");
    const headPath = document.createElementNS(ns, "path");
    headPath.setAttribute("d", "M0,0 L0,6 L8,3 z");
    headPath.setAttribute("fill", "#e8a200");
    marker.appendChild(headPath);
    defs.appendChild(marker);
  }
  const idByName = {};
  users.forEach((u) => (idByName[u.name] = u.id));
  const nodeBox = (id) => {
    const g = svg.querySelector(`.diagram-node[data-user-id="${id}"]`);
    if (!g) return null;
    const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(g.getAttribute("transform"));
    if (!m) return null;
    const x = parseFloat(m[1]);
    const y = parseFloat(m[2]);
    return {
      x,
      y,
      left: x,
      right: x + NODE_W,
      top: y,
      bottom: y + NODE_H,
      cx: x + NODE_W / 2,
      cy: y + NODE_H / 2,
    };
  };
  const routedPath = (from, to, fromName, toName) => {
    const useMiddleStart = fromName === "Bruno" && toName === "Conrad" && (itsoCasesSelected === 8 || thirtyCasesSelected === 8);
    const useCase11DanaToIsaac = fromName === "Dana" && toName === "Isaac" && (itsoCasesSelected === 11 || thirtyCasesSelected === 11);
    const useCase14CarlToIvan = fromName === "Carl" && toName === "Ivan" && (itsoCasesSelected === 14 || thirtyCasesSelected === 14);
    const useCase22DanaToIgorSecondary =
      fromName === "Dana" &&
      toName === "Igor" &&
      itsoCasesSelected === 22 &&
      itsoCase22PathMode === "secondary";
    if (useMiddleStart) {
      const startX = from.cx;
      const startY = from.top;
      const endX = to.cx;
      const endY = to.bottom;
      const verticalGap = 24;
      const laneY = endY + verticalGap;
      // Case 8 special route: go straight up, then left, then connect into Conrad bottom.
      return `M ${startX} ${startY} L ${startX} ${laneY} L ${endX} ${laneY} L ${endX} ${endY}`;
    }
    if (useCase11DanaToIsaac) {
      const startX = from.cx;
      const startY = from.top;
      const endX = to.cx;
      const endY = to.bottom;
      const laneY = layerGapElbowY(endY, startY);
      return `M ${startX} ${startY} L ${startX} ${laneY} L ${endX} ${laneY} L ${endX} ${endY}`;
    }
    if (useCase14CarlToIvan) {
      const startX = from.cx;
      const startY = from.top;
      const endX = to.cx;
      const endY = to.bottom;
      const verticalGap = 18;
      const laneY = endY + verticalGap;
      const offsetX = from.right + 18;
      const liftY = startY - 18;
      return `M ${startX} ${startY} L ${startX} ${liftY} L ${offsetX} ${liftY} L ${offsetX} ${laneY} L ${endX} ${laneY} L ${endX} ${endY}`;
    }
    if (useCase22DanaToIgorSecondary) {
      const startX = from.cx;
      const startY = from.top;
      const endX = to.cx;
      const endY = to.bottom;
      const laneY = endY + 14 < startY ? endY + 14 : (startY + endY) / 2;
      return `M ${startX} ${startY} L ${startX} ${laneY} L ${endX} ${laneY} L ${endX} ${endY}`;
    }
    const sameRow = Math.abs(from.cy - to.cy) < 2;
    if (sameRow) {
      // Same-level links must run horizontally only (left<->right), never top<->bottom.
      if (from.cx <= to.cx) {
        const y = (from.cy + to.cy) / 2;
        return `M ${useMiddleStart ? from.cx : from.right} ${y} L ${to.left} ${y}`;
      }
      const y = (from.cy + to.cy) / 2;
      return `M ${useMiddleStart ? from.cx : from.left} ${y} L ${to.right} ${y}`;
    }

    // Cross-level links use a right-side offset lane to keep path away from nodes.
    const movingUp = from.cy >= to.cy;
    const start = movingUp
      ? { x: useMiddleStart ? from.cx : from.right, y: from.top }
      : { x: useMiddleStart ? from.cx : from.right, y: from.bottom };
    const end = movingUp
      ? { x: to.right, y: to.bottom }
      : { x: to.right, y: to.top };
    const laneX = Math.max(from.right, to.right) + 18;
    return `M ${start.x} ${start.y} L ${laneX} ${start.y} L ${laneX} ${end.y} L ${end.x} ${end.y}`;
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
      const child = nodeBox(childId);
      const parent = nodeBox(parentId);
      if (!parent || !child) continue;
      const path = document.createElementNS(ns, "path");
      path.setAttribute("d", routedPath(child, parent, chain[i], chain[i + 1]));
      path.setAttribute("class", "target-edge");
      path.setAttribute("marker-end", "url(#target-arrow)");
      path.dataset.childId = String(childId);
      path.dataset.parentId = String(parentId);
      svg.appendChild(path);
    }
  });
}

// ITSO Case #9 readability tweak: when both co-head routes are shown, draw
// the non-existing branch as a direct connector so it does not form a long
// horizontal segment above nodes.
function highlightItsoCase9TargetLine(svg, users, chains) {
  if (!svg) return;
  svg.querySelectorAll(".diagram-edge").forEach((e) => e.classList.remove("highlighted"));
  svg.querySelectorAll(".target-edge").forEach((e) => e.remove());
  if (!chains || !chains.length) return;

  const ns = "http://www.w3.org/2000/svg";
  let defs = svg.querySelector("defs");
  if (!defs) {
    defs = document.createElementNS(ns, "defs");
    svg.insertBefore(defs, svg.firstChild);
  }
  if (!defs.querySelector("#target-arrow")) {
    const marker = document.createElementNS(ns, "marker");
    marker.setAttribute("id", "target-arrow");
    marker.setAttribute("markerWidth", "8");
    marker.setAttribute("markerHeight", "8");
    marker.setAttribute("refX", "6");
    marker.setAttribute("refY", "3");
    marker.setAttribute("orient", "auto");
    const headPath = document.createElementNS(ns, "path");
    headPath.setAttribute("d", "M0,0 L0,6 L8,3 z");
    headPath.setAttribute("fill", "#e8a200");
    marker.appendChild(headPath);
    defs.appendChild(marker);
  }
  const idByName = {};
  users.forEach((u) => (idByName[u.name] = u.id));
  const nodeBox = (id) => {
    const g = svg.querySelector(`.diagram-node[data-user-id="${id}"]`);
    if (!g) return null;
    const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(g.getAttribute("transform"));
    if (!m) return null;
    const x = parseFloat(m[1]);
    const y = parseFloat(m[2]);
    return {
      x,
      y,
      left: x,
      right: x + NODE_W,
      top: y,
      bottom: y + NODE_H,
      cx: x + NODE_W / 2,
      cy: y + NODE_H / 2,
    };
  };
  const routedPath = (from, to) => {
    const sameRow = Math.abs(from.cy - to.cy) < 2;
    if (sameRow) {
      if (from.cx <= to.cx) {
        const y = (from.cy + to.cy) / 2;
        return `M ${from.right} ${y} L ${to.left} ${y}`;
      }
      const y = (from.cy + to.cy) / 2;
      return `M ${from.left} ${y} L ${to.right} ${y}`;
    }
    const movingUp = from.cy >= to.cy;
    const start = movingUp
      ? { x: from.right, y: from.top }
      : { x: from.right, y: from.bottom };
    const end = movingUp
      ? { x: to.right, y: to.bottom }
      : { x: to.right, y: to.top };
    const laneX = Math.max(from.right, to.right) + 18;
    return `M ${start.x} ${start.y} L ${laneX} ${start.y} L ${laneX} ${end.y} L ${end.x} ${end.y}`;
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

      const child = nodeBox(childId);
      const parent = nodeBox(parentId);
      if (!child || !parent) continue;

      const path = document.createElementNS(ns, "path");
      path.setAttribute("d", routedPath(child, parent));
      path.setAttribute("class", "target-edge itso-case9-target-edge");
      path.setAttribute("marker-end", "url(#target-arrow)");
      path.dataset.childId = String(childId);
      path.dataset.parentId = String(parentId);
      svg.appendChild(path);
    }
  });
}

function selectThirtyCase(id) {
  thirtyCasesSelected = id;
  // Reset any manual focus override so the case's hardcoded target shows first.
  thirtyCasesFocusOverride = null;
  thirtyCasesSimChain = null;
  // Reset peer-coverage choices back to the case's documented defaults.
  thirtyCasesPeerOwnerId = null;
  thirtyCasesPeerSubstituteId = null;
  renderThirtyCasesPeerControls(THIRTY_CASES.find((c) => c.id === id));
  // Reset partial-acting choices back to the case's documented defaults.
  thirtyCasesPartialManagerId = null;
  thirtyCasesPartialLeaveCoverId = null;
  thirtyCasesPartialReviewCoverId = null;
  thirtyCasesPartialMode = "leave";
  renderThirtyCasesPartialControls(THIRTY_CASES.find((c) => c.id === id));
  updateThirtyCasesDetail();
  renderThirtyCasesDiagram();
}

// Action used when simulating a clicked person's real approval line. Cases may
// nominate an action; otherwise leave (annual_leave) is the representative flow.
// Partial-acting cases switch action with the chosen workflow (leave vs review).
function thirtyCasesAction(testCase) {
  const spec = thirtyCasesPartialSpec(testCase);
  if (spec) {
    return thirtyCasesPartialMode === "review"
      ? spec.reviewAction || "performance_review"
      : spec.leaveAction || "annual_leave";
  }
  return (testCase && testCase.action) || "annual_leave";
}

// Build the overlay specs the routing engine expects for a clicked person under
// a case. A case may carry literal `overlays` (already using numeric ids) and/or
// `overlaysByName` entries that name the owner/substitute (e.g. Case #2 peer
// coverage: Cara covered by Ingrid). Names are resolved to live user ids here,
// at click time, since the seeded ids are not known when THIRTY_CASES is defined.
// Entries whose names cannot be resolved are skipped so the simulation still runs.
function thirtyCasesOverlays(testCase) {
  const overlays = [...((testCase && testCase.overlays) || [])];
  const byName = (testCase && testCase.overlaysByName) || [];
  if (byName.length) {
    const users = thirtyCasesUsers();
    const idByName = {};
    users.forEach((u) => (idByName[u.name] = u.id));
    byName.forEach((spec) => {
      let ownerId = idByName[spec.owner];
      let substituteId = idByName[spec.substitute];
      // Peer-coverage cases let the user override who is on leave / who covers.
      if (spec.type === "peer_coverage") {
        if (thirtyCasesPeerOwnerId != null) ownerId = thirtyCasesPeerOwnerId;
        if (thirtyCasesPeerSubstituteId != null) substituteId = thirtyCasesPeerSubstituteId;
      }
      if (ownerId == null || substituteId == null) return;
      const overlay = {
        type: spec.type,
        owner_id: ownerId,
        substitute_id: substituteId,
      };
      if (spec.effectiveFrom) overlay.effective_from = spec.effectiveFrom;
      if (spec.effectiveTo) overlay.effective_to = spec.effectiveTo;
      if (spec.policy) overlay.policy = spec.policy;
      overlays.push(overlay);
    });
  }
  thirtyCasesPartialOverlays(testCase).forEach((overlay) => overlays.push(overlay));
  return overlays;
}

// Return the single peer_coverage overlay spec for a case, if any. These cases
// (e.g. Case #2) expose owner/substitute selectors so the situation is editable.
function thirtyCasesPeerSpec(testCase) {
  const byName = (testCase && testCase.overlaysByName) || [];
  return byName.find((s) => s.type === "peer_coverage") || null;
}

// Resolve the currently chosen owner (on leave) and substitute (peer cover) ids
// for a peer-coverage case, falling back to the case's documented defaults.
function thirtyCasesPeerSelection(users, testCase) {
  const spec = thirtyCasesPeerSpec(testCase);
  if (!spec) return null;
  const defaultOwner = users.find((u) => u.name === spec.owner);
  const defaultSub = users.find((u) => u.name === spec.substitute);
  const ownerId = thirtyCasesPeerOwnerId != null
    ? thirtyCasesPeerOwnerId
    : (defaultOwner ? defaultOwner.id : null);
  const substituteId = thirtyCasesPeerSubstituteId != null
    ? thirtyCasesPeerSubstituteId
    : (defaultSub ? defaultSub.id : null);
  return { ownerId, substituteId };
}

// Build an illustrative default target line for a peer-coverage case: one of the
// on-leave lead's direct reports now routes to the covering lead. Falls back to
// the handoff edge owner → substitute when the lead has no direct reports.
function thirtyCasesPeerActiveChain(users, testCase) {
  const sel = thirtyCasesPeerSelection(users, testCase);
  if (!sel) return null;
  const owner = users.find((u) => u.id === sel.ownerId);
  const sub = users.find((u) => u.id === sel.substituteId);
  if (!owner || !sub) return null;
  const report = users.find((u) => u.manager_name === owner.name);
  return report ? [[report.name, sub.name]] : [[owner.name, sub.name]];
}

// Populate and show the owner/substitute selectors for peer-coverage cases, or
// hide them for any other case. Candidates are the team leads in the on-leave
// lead's department, so users pick a like-for-like peer to cover the team.
function renderThirtyCasesPeerControls(testCase) {
  const wrap = document.getElementById("thirty-cases-peer-controls");
  const ownerSel = document.getElementById("thirty-cases-peer-owner");
  const subSel = document.getElementById("thirty-cases-peer-substitute");
  if (!wrap || !ownerSel || !subSel) return;
  const spec = thirtyCasesPeerSpec(testCase);
  if (!spec) {
    wrap.classList.add("hidden");
    return;
  }
  const users = thirtyCasesUsers();
  const defaultOwner = users.find((u) => u.name === spec.owner);
  const dept = defaultOwner ? defaultOwner.department_code : null;
  const leads = users.filter(
    (u) => u.is_team_lead && (!dept || u.department_code === dept)
  );
  const candidates = leads.length ? leads : users;
  const sel = thirtyCasesPeerSelection(users, testCase) || {};
  const fill = (select, selectedId) => {
    select.replaceChildren(
      ...candidates.map((u) => {
        const opt = document.createElement("option");
        opt.value = String(u.id);
        opt.textContent = `${u.name} — ${u.department_code} / ${u.level_name}`;
        if (u.id === selectedId) opt.selected = true;
        return opt;
      })
    );
  };
  fill(ownerSel, sel.ownerId);
  fill(subSel, sel.substituteId);
  wrap.classList.remove("hidden");
}

// React to a change in either selector: record the choice, re-bold the default
// line, and re-run the simulation for any person currently clicked.
function onThirtyCasesPeerChange() {
  const ownerSel = document.getElementById("thirty-cases-peer-owner");
  const subSel = document.getElementById("thirty-cases-peer-substitute");
  thirtyCasesPeerOwnerId = ownerSel && ownerSel.value ? Number(ownerSel.value) : null;
  thirtyCasesPeerSubstituteId = subSel && subSel.value ? Number(subSel.value) : null;
  renderThirtyCasesDiagram();
  if (thirtyCasesFocusOverride != null) {
    runThirtyCasesSimulation(thirtyCasesFocusOverride);
  } else {
    updateThirtyCasesDetail();
  }
}


// Return the partial-acting spec for a case, if any. These cases (e.g. Case #3)
// expose selectors for the on-leave manager and their leave / review covers.
function thirtyCasesPartialSpec(testCase) {
  return (testCase && testCase.partialActing) || null;
}

// Resolve the currently chosen on-leave manager and the two covers (leave /
// performance review) for a partial-acting case, falling back to its defaults.
function thirtyCasesPartialSelection(users, testCase) {
  const spec = thirtyCasesPartialSpec(testCase);
  if (!spec) return null;
  const byName = (name) => {
    const u = users.find((x) => x.name === name);
    return u ? u.id : null;
  };
  const managerId = thirtyCasesPartialManagerId != null
    ? thirtyCasesPartialManagerId
    : byName(spec.manager);
  const leaveCoverId = thirtyCasesPartialLeaveCoverId != null
    ? thirtyCasesPartialLeaveCoverId
    : byName(spec.leaveCover);
  const reviewCoverId = thirtyCasesPartialReviewCoverId != null
    ? thirtyCasesPartialReviewCoverId
    : byName(spec.reviewCover);
  return { managerId, leaveCoverId, reviewCoverId, mode: thirtyCasesPartialMode };
}

// Build the two action-scoped coverage overlays for a partial-acting case: the
// on-leave manager's leave approvals route to the leave cover, while their
// performance reviews route to the review cover. Scoping each overlay to its own
// action keeps the two workflows decoupled when a person is simulated.
function thirtyCasesPartialOverlays(testCase) {
  const spec = thirtyCasesPartialSpec(testCase);
  if (!spec) return [];
  const users = thirtyCasesUsers();
  const sel = thirtyCasesPartialSelection(users, testCase);
  if (!sel || sel.managerId == null) return [];
  const overlays = [];
  if (sel.leaveCoverId != null) {
    overlays.push({
      type: "peer_coverage",
      owner_id: sel.managerId,
      substitute_id: sel.leaveCoverId,
      action_code: spec.leaveAction || "annual_leave",
    });
  }
  if (sel.reviewCoverId != null) {
    overlays.push({
      type: "peer_coverage",
      owner_id: sel.managerId,
      substitute_id: sel.reviewCoverId,
      action_code: spec.reviewAction || "performance_review",
    });
  }
  return overlays;
}

// Build the illustrative default target line for a partial-acting case: one of
// the on-leave manager's direct reports routes to the active cover (leave or
// review), then up to the manager's own manager (the default second level).
function thirtyCasesPartialActiveChain(users, testCase) {
  const sel = thirtyCasesPartialSelection(users, testCase);
  if (!sel || sel.managerId == null) return null;
  const manager = users.find((u) => u.id === sel.managerId);
  if (!manager) return null;
  const activeCoverId = sel.mode === "review" ? sel.reviewCoverId : sel.leaveCoverId;
  const cover = users.find((u) => u.id === activeCoverId);
  const report = users.find((u) => u.manager_name === manager.name);
  const secondLevel = users.find((u) => u.name === manager.manager_name);
  const head = report || manager;
  const chain = [head.name];
  if (cover) chain.push(cover.name);
  if (secondLevel) chain.push(secondLevel.name);
  return chain.length > 1 ? [chain] : null;
}

// Populate and show the manager / leave-cover / review-cover selectors plus the
// workflow toggle for partial-acting cases, or hide them for any other case.
// Manager candidates are people who manage others in the case's department;
// covers are the team leads / sub-leads who could step in.
function renderThirtyCasesPartialControls(testCase) {
  const wrap = document.getElementById("thirty-cases-partial-controls");
  const managerSel = document.getElementById("thirty-cases-partial-manager");
  const leaveSel = document.getElementById("thirty-cases-partial-leave-cover");
  const reviewSel = document.getElementById("thirty-cases-partial-review-cover");
  const modeSel = document.getElementById("thirty-cases-partial-mode");
  if (!wrap || !managerSel || !leaveSel || !reviewSel || !modeSel) return;
  const spec = thirtyCasesPartialSpec(testCase);
  if (!spec) {
    wrap.classList.add("hidden");
    return;
  }
  const users = thirtyCasesUsers();
  const defaultManager = users.find((u) => u.name === spec.manager);
  const dept = defaultManager ? defaultManager.department_code : null;
  const inDept = (u) => !dept || u.department_code === dept;
  // Managers: anyone in the department who has at least one direct report.
  const managerNames = new Set(
    users.filter((u) => u.manager_name).map((u) => u.manager_name)
  );
  const managers = users.filter((u) => inDept(u) && managerNames.has(u.name));
  // Covers: team leads or anyone who manages others (a like-for-like stand-in).
  const covers = users.filter(
    (u) => inDept(u) && (u.is_team_lead || managerNames.has(u.name))
  );
  const managerPool = managers.length ? managers : users;
  const coverPool = covers.length ? covers : users;
  const sel = thirtyCasesPartialSelection(users, testCase) || {};
  const fill = (select, pool, selectedId) => {
    select.replaceChildren(
      ...pool.map((u) => {
        const opt = document.createElement("option");
        opt.value = String(u.id);
        opt.textContent = `${u.name} — ${u.department_code} / ${u.level_name}`;
        if (u.id === selectedId) opt.selected = true;
        return opt;
      })
    );
  };
  fill(managerSel, managerPool, sel.managerId);
  fill(leaveSel, coverPool, sel.leaveCoverId);
  fill(reviewSel, coverPool, sel.reviewCoverId);
  modeSel.value = thirtyCasesPartialMode;
  wrap.classList.remove("hidden");
}

// React to a change in any partial-acting selector: record the choices, re-bold
// the default line, and re-run the simulation for any person currently clicked.
function onThirtyCasesPartialChange() {
  const managerSel = document.getElementById("thirty-cases-partial-manager");
  const leaveSel = document.getElementById("thirty-cases-partial-leave-cover");
  const reviewSel = document.getElementById("thirty-cases-partial-review-cover");
  const modeSel = document.getElementById("thirty-cases-partial-mode");
  thirtyCasesPartialManagerId = managerSel && managerSel.value ? Number(managerSel.value) : null;
  thirtyCasesPartialLeaveCoverId = leaveSel && leaveSel.value ? Number(leaveSel.value) : null;
  thirtyCasesPartialReviewCoverId = reviewSel && reviewSel.value ? Number(reviewSel.value) : null;
  thirtyCasesPartialMode = modeSel && modeSel.value === "review" ? "review" : "leave";
  renderThirtyCasesDiagram();
  if (thirtyCasesFocusOverride != null) {
    runThirtyCasesSimulation(thirtyCasesFocusOverride);
  } else {
    updateThirtyCasesDetail();
  }
}

async function runThirtyCasesSimulation(userId) {
  const tc = THIRTY_CASES.find((c) => c.id === thirtyCasesSelected);
  try {
    const resp = await fetch("/api/simulate-reporting-line", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requester_id: Number(userId),
        edges: [],
        action_code: thirtyCasesAction(tc),
        request_at: (tc && tc.requestAt) || null,
        project_code: (tc && tc.projectCode) || null,
        overlays: thirtyCasesOverlays(tc),
      }),
    });
    const result = await resp.json();
    // Ignore stale responses if the user moved on to another person/case.
    if (thirtyCasesFocusOverride !== userId) return;
    const steps = result.overlay_steps || [];
    const person = thirtyCasesUsers().find((u) => u.id === userId);
    if (person && steps.length) {
      thirtyCasesSimChain = [[person.name, ...steps.map((s) => s.approver)]];
    } else {
      thirtyCasesSimChain = null;
    }
    renderThirtyCasesDiagram();
    updateThirtyCasesDetail(result);
  } catch (err) {
    thirtyCasesSimChain = null;
    renderThirtyCasesDiagram();
  }
}

// ---------------------------------------------------------------------------
// ITSO case 3 partial-acting controls
// ---------------------------------------------------------------------------

function itsoCasesPartialSpec(testCase) {
  return (testCase && testCase.partialActing) || null;
}

function itsoCasesPartialSelection(users, testCase) {
  const spec = itsoCasesPartialSpec(testCase);
  if (!spec) return null;
  const byName = (name) => {
    const user = users.find((u) => u.name === name);
    return user ? user.id : null;
  };
  const managerId = itsoCasesPartialManagerId != null
    ? itsoCasesPartialManagerId
    : byName(spec.manager);
  const leaveCoverId = itsoCasesPartialLeaveCoverId != null
    ? itsoCasesPartialLeaveCoverId
    : byName(spec.leaveCover);
  const reviewCoverId = itsoCasesPartialReviewCoverId != null
    ? itsoCasesPartialReviewCoverId
    : byName(spec.reviewCover);
  return { managerId, leaveCoverId, reviewCoverId, mode: itsoCasesPartialMode };
}

function itsoCasesPartialOverlays(testCase) {
  const spec = itsoCasesPartialSpec(testCase);
  if (!spec) return [];
  const users = itsoCasesUsers(testCase);
  const sel = itsoCasesPartialSelection(users, testCase);
  if (!sel || sel.managerId == null) return [];
  const overlays = [];
  if (sel.leaveCoverId != null) {
    overlays.push({
      type: "peer_coverage",
      owner_id: sel.managerId,
      substitute_id: sel.leaveCoverId,
      action_code: spec.leaveAction || "annual_leave",
    });
  }
  if (sel.reviewCoverId != null) {
    overlays.push({
      type: "peer_coverage",
      owner_id: sel.managerId,
      substitute_id: sel.reviewCoverId,
      action_code: spec.reviewAction || "performance_review",
    });
  }
  return overlays;
}

function renderItsoCasesPartialControls(testCase) {
  const wrap = document.getElementById("itso-cases-partial-controls");
  const managerSel = document.getElementById("itso-cases-partial-manager");
  const leaveSel = document.getElementById("itso-cases-partial-leave-cover");
  const reviewSel = document.getElementById("itso-cases-partial-review-cover");
  const modeSel = document.getElementById("itso-cases-partial-mode");
  const managerLabel = document.getElementById("itso-cases-partial-manager-label");
  const leaveLabel = document.getElementById("itso-cases-partial-leave-label");
  const reviewLabel = document.getElementById("itso-cases-partial-review-label");
  if (!wrap || !managerSel || !leaveSel || !reviewSel || !modeSel) return;

  const spec = itsoCasesPartialSpec(testCase);
  if (!spec || !testCase || testCase.id !== 3) {
    wrap.classList.add("hidden");
    return;
  }

  const users = itsoCasesUsers(testCase);
  const eligible = users.filter((u) => {
    const rank = Number(u.level_rank);
    return u.department_code === "ITSO" && rank >= 4 && rank <= 7;
  });
  const pool = eligible.length ? eligible : users;
  const sel = itsoCasesPartialSelection(users, testCase) || {};
  const selectedNameById = (id, fallback) => {
    const user = users.find((u) => u.id === id);
    return user ? user.name : fallback;
  };

  const fill = (select, selectedId) => {
    select.replaceChildren(
      ...pool.map((u) => {
        const opt = document.createElement("option");
        opt.value = String(u.id);
        opt.textContent = `${u.name} — L${u.level_rank} / ${u.department_code} / ${u.level_name}`;
        if (u.id === selectedId) opt.selected = true;
        return opt;
      })
    );
  };

  fill(managerSel, sel.managerId);
  fill(leaveSel, sel.leaveCoverId);
  fill(reviewSel, sel.reviewCoverId);
  modeSel.value = itsoCasesPartialMode;
  if (managerLabel) {
    managerLabel.textContent = `On leave${sel.managerId != null ? `: ${selectedNameById(sel.managerId, "")}` : ""}`;
  }
  if (leaveLabel) {
    leaveLabel.textContent = `Leave duty cover${sel.leaveCoverId != null ? `: ${selectedNameById(sel.leaveCoverId, "")}` : ""}`;
  }
  if (reviewLabel) {
    reviewLabel.textContent = `Review duty cover${sel.reviewCoverId != null ? `: ${selectedNameById(sel.reviewCoverId, "")}` : ""}`;
  }
  wrap.classList.remove("hidden");
}

function onItsoCasesPartialChange() {
  const managerSel = document.getElementById("itso-cases-partial-manager");
  const leaveSel = document.getElementById("itso-cases-partial-leave-cover");
  const reviewSel = document.getElementById("itso-cases-partial-review-cover");
  const modeSel = document.getElementById("itso-cases-partial-mode");
  itsoCasesPartialManagerId = managerSel && managerSel.value ? Number(managerSel.value) : null;
  itsoCasesPartialLeaveCoverId = leaveSel && leaveSel.value ? Number(leaveSel.value) : null;
  itsoCasesPartialReviewCoverId = reviewSel && reviewSel.value ? Number(reviewSel.value) : null;
  itsoCasesPartialMode = modeSel && modeSel.value === "review" ? "review" : "leave";
  renderItsoCasesDiagram();
  updateItsoCasesDetail();
}

// ---------------------------------------------------------------------------
// ITSO 30 Cases (Case 1-30 mirrored into ITSO-only scenarios)
// ---------------------------------------------------------------------------

function itsoCasesUsers(testCase) {
  const allUsers = thirtyCasesUsers();
  if (testCase && testCase.id === 0) {
    return allUsers.map((u) => ({ ...u }));
  }
  const users = allUsers
    .filter((u) => u.department_code === "ITSO")
    .map((u) => ({ ...u }));
  if (testCase) {
    applyItsoDepartmentTweaks(users, testCase);
    const party = ITSO_CASE_SECOND_PARTY[testCase.id];
    if (party && party.includeHro) {
      allUsers
        .filter((u) => u.department_code === "HRO")
        .forEach((u) => users.push({ ...u }));
    }
    if (testCase.id === 7) {
      addItsoCaseSevenLoanNode(users);
    }
    if (testCase.id === 19) {
      addItsoCaseFutureTransferNode(users);
    }
    if (testCase.id === 28) {
      addItsoCaseShellPositionNode(users);
    }
    if (party && party.loan && testCase.id !== 7 && testCase.id !== 19 && testCase.id !== 28) {
      applyItsoLoanRepresentation(users, party.loan);
    }

    if (testCase.id === 17) {
      // Case #17: show a head-only ITSO department that escalates to EXEC School.
      const ivan = users.find((u) => u.name === "Ivan" && u.department_code === "ITSO");
      if (ivan) {
        ivan.manager_name = "School";
      }

      for (let i = users.length - 1; i >= 0; i--) {
        const u = users[i];
        if (!(u.name === "Ivan" && u.department_code === "ITSO")) {
          users.splice(i, 1);
        }
      }

      const school = allUsers.find((u) => u.name === "School" && u.department_code === "EXEC");
      if (school) users.push({ ...school });
    }

    if (testCase.id === 18) {
      // Case #18: represent a standalone one-person Parking department.
      const faye = users.find((u) => u.name === "Faye" && u.department_code === "ITSO");
      const hannah = users.find((u) => u.name === "Hannah" && u.department_code === "HRO");
      if (faye) {
        faye.department_code = "PARKING";
        faye.manager_name = "Hannah";
      }

      for (let i = users.length - 1; i >= 0; i--) {
        const u = users[i];
        const keepFaye = !!faye && u.id === faye.id;
        const keepHannah = !!hannah && u.id === hannah.id;
        if (!keepFaye && !keepHannah) {
          users.splice(i, 1);
        }
      }
    }
  }
  return users;
}

function nextSyntheticUserId(users) {
  const used = new Set(users.map((u) => u.id));
  let id = -1;
  while (used.has(id)) id -= 1;
  return id;
}

function addItsoCaseSevenLoanNode(users) {
  const homeBoris = users.find((u) => u.name === "Boris" && u.department_code === "ITSO");
  const hannah = users.find((u) => u.name === "Hannah" && u.department_code === "HRO");
  if (!homeBoris || !hannah) return;

  const hroL9Sample =
    users.find((u) => u.name === "Kevin" && u.department_code === "HRO") ||
    users.find((u) => u.department_code === "HRO" && Number(u.level_rank) === 9) ||
    null;

  const loaned = {
    ...homeBoris,
    id: nextSyntheticUserId(users),
    name: "Boris [HKUST Loan]",
    department_code: "HRO",
    manager_name: "Hannah",
    level_name: `${homeBoris.level_name} [ITSO]`,
    is_top_level: false,
    is_team_lead: false,
    _itsoCase7Loan: true,
    _externalOnly: true,
  };

  if (hroL9Sample) {
    // Keep ITSO Boris rank/title semantics; only borrow HRO lane metadata.
    loaned.org_unit = hroL9Sample.org_unit || loaned.org_unit;
    if (Array.isArray(hroL9Sample.org_unit_ids)) {
      loaned.org_unit_ids = [...hroL9Sample.org_unit_ids];
    }
  }

  users.push(loaned);
}

function addItsoCaseFutureTransferNode(users) {
  const homeBoris = users.find((u) => u.name === "Boris" && u.department_code === "ITSO");
  const hannah = users.find((u) => u.name === "Hannah" && u.department_code === "HRO");
  if (!homeBoris || !hannah) return;

  const hroL9Sample =
    users.find((u) => u.name === "Kevin" && u.department_code === "HRO") ||
    users.find((u) => u.department_code === "HRO" && Number(u.level_rank) === 9) ||
    null;

  const future = {
    ...homeBoris,
    id: nextSyntheticUserId(users),
    name: "Boris [ITSO ➜ HRO]",
    department_code: "HRO",
    manager_name: "Hannah",
    level_name: "Assistant Officer [Future]",
    is_top_level: false,
    is_team_lead: false,
    _itsoCase7Loan: true,
  };

  if (hroL9Sample) {
    // Keep Boris role/rank semantics; borrow HRO lane metadata for placement.
    future.org_unit = hroL9Sample.org_unit || future.org_unit;
    if (Array.isArray(hroL9Sample.org_unit_ids)) {
      future.org_unit_ids = [...hroL9Sample.org_unit_ids];
    }
  }

  users.push(future);
}

function addItsoCaseShellPositionNode(users) {
  const homeBianca = users.find((u) => u.name === "Bianca" && u.department_code === "ITSO");
  const hannah = users.find((u) => u.name === "Hannah" && u.department_code === "HRO");
  if (!homeBianca || !hannah) return;

  const hroSample =
    users.find((u) => u.name === "Joan" && u.department_code === "HRO") ||
    users.find((u) => u.department_code === "HRO" && Number(u.level_rank) === Number(homeBianca.level_rank)) ||
    users.find((u) => u.department_code === "HRO") ||
    null;

  const shell = {
    ...homeBianca,
    id: nextSyntheticUserId(users),
    name: "Bianca [shell]",
    department_code: "HRO",
    manager_name: "Hannah",
    is_top_level: false,
    is_team_lead: false,
    _itsoCase28Shell: true,
  };

  if (hroSample) {
    shell.org_unit = hroSample.org_unit || shell.org_unit;
    if (Array.isArray(hroSample.org_unit_ids)) {
      shell.org_unit_ids = [...hroSample.org_unit_ids];
    }
  }

  users.push(shell);
}

function applyItsoLoanRepresentation(users, loan) {
  const person = users.find((u) => u.name === loan.person && u.department_code === loan.fromDept);
  if (!person) return;

  // Keep a home-position ghost in the original department.
  const ghost = {
    ...person,
    id: nextSyntheticUserId(users),
    name: `${loan.person} [home ${loan.fromDept}]`,
    _homeGhost: true,
    _loanPerson: loan.person,
  };
  users.push(ghost);

  // Active position reports to the loan department manager.
  person.department_code = loan.toDept;
  if (loan.toManager) person.manager_name = loan.toManager;
  person._loanFrom = loan.fromDept;
  person._loanTo = loan.toDept;
}

function applyItsoDepartmentTweaks(users, caseIdOrTestCase) {
  const testCase = typeof caseIdOrTestCase === "object" ? caseIdOrTestCase : { id: caseIdOrTestCase };
  const caseId = testCase.id;
  const byName = (name) => users.find((u) => u.name === name);
  const setManager = (childName, managerName) => {
    const child = byName(childName);
    if (!child) return;
    if (managerName == null) {
      child.manager_name = null;
      return;
    }
    if (byName(managerName)) child.manager_name = managerName;
  };

  switch (caseId) {
    case 2:
      // Peer coverage in a single department: Cara's direct reports flow to Ingrid.
      users.forEach((u) => {
        if (u.manager_name === "Cara") u.manager_name = "Ingrid";
      });
      break;
    case 3:
      {
        const sel = itsoCasesPartialSelection(users, testCase);
        const manager = sel && sel.managerId != null ? users.find((u) => u.id === sel.managerId) : null;
        const leaveCover = sel && sel.leaveCoverId != null ? users.find((u) => u.id === sel.leaveCoverId) : null;
        const reviewCover = sel && sel.reviewCoverId != null ? users.find((u) => u.id === sel.reviewCoverId) : null;
        const activeCover = sel && sel.mode === "review" ? reviewCover : leaveCover;
        const managerName = manager ? manager.name : "Cyrus";
        const managerUpstream = manager ? manager.manager_name : "Cara";
        users.forEach((u) => {
          if (u.manager_name === managerName && activeCover) u.manager_name = activeCover.name;
        });
        if (activeCover) setManager(activeCover.name, managerUpstream || null);
      }
      break;
    case 7:
      setManager("Boris", "Iris");
      setManager("Iris", "Isaac");
      break;
    case 12:
      // Keep a local reporting line while functional line is drawn as context.
      setManager("Gemma", "Ingrid");
      break;
    case 14:
      setManager("Carl", null);
      break;
    case 16:
      setManager("Bonnie", "Ivan");
      break;
    case 19:
      setManager("Boris", "Iris");
      setManager("Iris", "Isaac");
      break;
    case 21:
      setManager("Daisy", "Cleo");
      setManager("Cleo", "Cyrus");
      setManager("Cyrus", "Cara");
      break;
    case 22:
      setManager("Dean", "Ingrid");
      break;
    case 27:
      setManager("Bruno", "Ingrid");
      setManager("Bella", "Ingrid");
      break;
    case 28:
      setManager("Bianca", "Iris");
      setManager("Iris", "Isaac");
      break;
    case 29:
      setManager("Bonnie", "Ivan");
      break;
    case 30:
      setManager("Gemma", "Ivan");
      break;
    default:
      break;
  }
}

function itsoCasesFocusId(users, testCase) {
  const byName = users.find((u) => u.name === testCase.focus);
  if (byName) return byName.id;
  const pool = users.length ? users : [];
  if (!pool.length) return null;
  const deepest = pool.reduce((a, b) => (b.level_rank > a.level_rank ? b : a), pool[0]);
  return deepest ? deepest.id : null;
}

function initItsoCases() {
  const list = document.getElementById("itso-cases-cases");
  if (!list) return;
  if (!itsoCasesReady) {
    list.replaceChildren(
      ...ITSO_CASES.map((tc) => {
        const li = document.createElement("li");
        li.dataset.category = tc.category;
        const label = document.createElement("label");
        label.className = "thirty-case-row";
        const input = document.createElement("input");
        input.type = "radio";
        input.name = "itso-case";
        input.value = String(tc.id);
        input.addEventListener("change", () => selectItsoCase(tc.id));
        const text = document.createElement("span");
        const level = caseChangeLevel(tc.id);
        text.innerHTML = `<strong>${tc.id}. ${tc.title}</strong><span class="thirty-case-cat"><span class="thirty-case-cat-name">${displayCaseCategoryName(tc.category)}</span><span class="thirty-case-level ${level.className}">${level.label}</span></span>`;
        label.append(input, text);
        li.appendChild(label);
        return li;
      })
    );
    const filter = document.getElementById("itso-cases-filter");
    if (filter) {
      const categories = [...new Set(ITSO_CASES.map((tc) => tc.category))];
      filter.append(
        ...categories.map((cat) => {
          const opt = document.createElement("option");
          opt.value = cat;
          opt.textContent = displayCaseCategoryName(cat);
          return opt;
        })
      );
      filter.addEventListener("change", () => {
        itsoCasesCategory = filter.value;
        applyItsoCasesFilter();
        ensureItsoCaseSelection();
        syncItsoCaseRadioSelection();
        updateItsoCasesReviewNav();
        updateItsoCasesDetail();
        renderItsoCasesDiagram();
      });
    }
    const prevBtn = document.getElementById("itso-cases-prev");
    if (prevBtn) {
      prevBtn.addEventListener("click", () => stepItsoCase(-1));
    }
    const nextBtn = document.getElementById("itso-cases-next");
    if (nextBtn) {
      nextBtn.addEventListener("click", () => stepItsoCase(1));
    }
    const partialModeSel = document.getElementById("itso-cases-partial-mode");
    if (partialModeSel) {
      partialModeSel.addEventListener("change", () => {
        itsoCasesPartialMode = partialModeSel.value === "review" ? "review" : "leave";
        updateItsoCasesDetail();
        renderItsoCasesDiagram();
      });
    }
    [
      "itso-cases-partial-manager",
      "itso-cases-partial-leave-cover",
      "itso-cases-partial-review-cover",
    ].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("change", onItsoCasesPartialChange);
    });
    itsoCasesReady = true;
  }
  applyItsoCasesFilter();
  ensureItsoCaseSelection();
  syncItsoCaseRadioSelection();
  updateItsoCasesReviewNav();
  updateItsoCasesDetail();
  renderItsoCasesDiagram();
}

function applyItsoCasesFilter() {
  const list = document.getElementById("itso-cases-cases");
  if (!list) return;
  list.querySelectorAll("li").forEach((li) => {
    const match = !itsoCasesCategory || li.dataset.category === itsoCasesCategory;
    li.hidden = !match;
  });
}

function itsoVisibleCaseIds() {
  const list = document.getElementById("itso-cases-cases");
  if (!list) return [];
  return Array.from(list.querySelectorAll("li"))
    .filter((li) => !li.hidden)
    .map((li) => {
      const input = li.querySelector('input[name="itso-case"]');
      return input ? Number(input.value) : null;
    })
    .filter((id) => Number.isFinite(id));
}

function ensureItsoCaseSelection() {
  const visible = itsoVisibleCaseIds();
  if (!visible.length) {
    itsoCasesSelected = null;
    return;
  }
  if (itsoCasesSelected == null) {
    try {
      const raw = localStorage.getItem(ITSO_CASE_SELECTED_KEY);
      const stored = raw != null ? Number(raw) : null;
      if (Number.isFinite(stored) && visible.includes(stored)) {
        itsoCasesSelected = stored;
      }
    } catch (e) {
      // Ignore storage errors in restricted contexts.
    }
  }
  if (!visible.includes(itsoCasesSelected)) {
    itsoCasesSelected = visible[0];
  }
}

function syncItsoCaseRadioSelection() {
  const list = document.getElementById("itso-cases-cases");
  if (!list) return;
  list.querySelectorAll('input[name="itso-case"]').forEach((input) => {
    input.checked = Number(input.value) === itsoCasesSelected;
  });
}

function updateItsoCasesReviewNav() {
  const visible = itsoVisibleCaseIds();
  const idx = visible.indexOf(itsoCasesSelected);
  const hasCurrent = idx !== -1;
  const posEl = document.getElementById("itso-cases-position");
  const prevBtn = document.getElementById("itso-cases-prev");
  const nextBtn = document.getElementById("itso-cases-next");

  if (posEl) {
    if (!visible.length) {
      posEl.textContent = "Case 0 of 0";
    } else if (!hasCurrent) {
      posEl.textContent = `Case 0 of ${visible.length}`;
    } else {
      posEl.textContent = `Case ${idx + 1} of ${visible.length} (ID ${itsoCasesSelected})`;
    }
  }
  if (prevBtn) prevBtn.disabled = !hasCurrent || idx <= 0;
  if (nextBtn) nextBtn.disabled = !hasCurrent || idx >= visible.length - 1;
}

function stepItsoCase(delta) {
  const visible = itsoVisibleCaseIds();
  if (!visible.length) return;
  const idx = visible.indexOf(itsoCasesSelected);
  const base = idx === -1 ? 0 : idx;
  const nextIdx = Math.max(0, Math.min(visible.length - 1, base + delta));
  const nextId = visible[nextIdx];
  if (nextId == null) return;
  selectItsoCase(nextId);
}

function itsoCase8DisplayedChains(testCase) {
  if (!testCase || testCase.id !== 8 || !Array.isArray(testCase.target)) return null;
  if (!testCase.target.length) return null;
  if (itsoCase8PathMode === "primary") return [testCase.target[0]];
  if (itsoCase8PathMode === "secondary") return testCase.target[1] ? [testCase.target[1]] : [testCase.target[0]];
  return testCase.target;
}

function itsoCase22DisplayedChains(testCase) {
  if (!testCase || testCase.id !== 22 || !Array.isArray(testCase.target)) return null;
  if (!testCase.target.length) return null;
  if (itsoCase22PathMode === "secondary") return testCase.target[1] ? [testCase.target[1]] : [testCase.target[0]];
  return [testCase.target[0]];
}

function itsoCase20ChainBundle(users, testCase) {
  if (!testCase || testCase.id !== 20) return null;

  const historical = capItsoChainsToSecondHigher(
    (testCase.target && testCase.target.length)
      ? testCase.target
      : itsoCasesTargetChain(users, testCase)
  ) || [];

  const cyrus = users.find((u) => u.name === "Cyrus" && u.department_code === "ITSO");
  const isaac = users.find((u) => u.name === "Isaac" && u.department_code === "ITSO");
  const ivan = users.find((u) => u.name === "Ivan" && u.department_code === "ITSO");
  const counterfactual = (cyrus && isaac && ivan)
    ? capItsoChainsToSecondHigher([[cyrus.name, isaac.name, ivan.name]])
    : historical;

  const mode = itsoCase20ViewMode || "historical";
  const primary = mode === "counterfactual" ? counterfactual : historical;
  const dim = mode === "both" ? [...historical, ...counterfactual] : primary;

  return {
    historical,
    counterfactual,
    primary,
    dim,
    mode,
  };
}

function drawItsoCase20CounterfactualOverlay(svg, users, chains) {
  if (!svg) return;
  svg.querySelectorAll(".itso-case20-counterfactual-edge").forEach((e) => e.remove());
  if (!chains || !chains.length) return;

  const ns = "http://www.w3.org/2000/svg";
  let defs = svg.querySelector("defs");
  if (!defs) {
    defs = document.createElementNS(ns, "defs");
    svg.insertBefore(defs, svg.firstChild);
  }
  if (!defs.querySelector("#case20-counterfactual-arrow")) {
    const marker = document.createElementNS(ns, "marker");
    marker.setAttribute("id", "case20-counterfactual-arrow");
    marker.setAttribute("markerWidth", "8");
    marker.setAttribute("markerHeight", "8");
    marker.setAttribute("refX", "6");
    marker.setAttribute("refY", "3");
    marker.setAttribute("orient", "auto");
    const headPath = document.createElementNS(ns, "path");
    headPath.setAttribute("d", "M0,0 L0,6 L8,3 z");
    headPath.setAttribute("fill", "#c47018");
    marker.appendChild(headPath);
    defs.appendChild(marker);
  }

  const idByName = {};
  users.forEach((u) => (idByName[u.name] = u.id));
  const nodeBox = (id) => {
    const g = svg.querySelector(`.diagram-node[data-user-id="${id}"]`);
    if (!g) return null;
    const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(g.getAttribute("transform") || "");
    if (!m) return null;
    const x = parseFloat(m[1]);
    const y = parseFloat(m[2]);
    return {
      left: x,
      right: x + NODE_W,
      top: y,
      bottom: y + NODE_H,
      cx: x + NODE_W / 2,
      cy: y + NODE_H / 2,
    };
  };
  const routedPath = (from, to) => {
    const sameRow = Math.abs(from.cy - to.cy) < 2;
    if (sameRow) {
      const y = (from.cy + to.cy) / 2;
      if (from.cx <= to.cx) return `M ${from.right} ${y} L ${to.left} ${y}`;
      return `M ${from.left} ${y} L ${to.right} ${y}`;
    }
    const movingUp = from.cy >= to.cy;
    const start = movingUp
      ? { x: from.right, y: from.top }
      : { x: from.right, y: from.bottom };
    const end = movingUp
      ? { x: to.right, y: to.bottom }
      : { x: to.right, y: to.top };
    const laneX = Math.max(from.right, to.right) + 18;
    return `M ${start.x} ${start.y} L ${laneX} ${start.y} L ${laneX} ${end.y} L ${end.x} ${end.y}`;
  };

  chains.forEach((chain) => {
    for (let i = 0; i < chain.length - 1; i++) {
      const childId = idByName[chain[i]];
      const parentId = idByName[chain[i + 1]];
      if (childId == null || parentId == null) continue;

      const existing = svg.querySelector(
        `.diagram-edge[data-child-id="${childId}"][data-parent-id="${parentId}"]`
      );
      const path = document.createElementNS(ns, "path");
      const existingD = existing ? existing.getAttribute("d") : "";
      if (existingD) {
        path.setAttribute("d", existingD);
      } else {
        const child = nodeBox(childId);
        const parent = nodeBox(parentId);
        if (!child || !parent) continue;
        path.setAttribute("d", routedPath(child, parent));
      }
      path.setAttribute("class", "target-edge itso-case20-counterfactual-edge");
      path.setAttribute("marker-end", "url(#case20-counterfactual-arrow)");
      path.dataset.childId = String(childId);
      path.dataset.parentId = String(parentId);
      svg.appendChild(path);
    }
  });
}

function renderItsoCasesDiagram() {
  const svg = document.getElementById("itso-cases-svg");
  if (!svg) return;
  const tc = ITSO_CASES.find((c) => c.id === itsoCasesSelected) || null;
  const users = itsoCasesUsers(tc);
  drawDiagram(svg, users, {
    deptTag: true,
    teamSections: true,
    fixedTeamSections: true,
    deptOrder: ["ITSO", "HRO", "EXEC"],
    fixedDeptColumns: true,
    fixedAbsoluteNodeX: true,
    selectedId: itsoCasesFocusOverride,
    onNodeClick: (u) => {
      if (tc && tc.id === 8) {
        if (itsoCase8PathMode === "both") itsoCase8PathMode = "primary";
        else if (itsoCase8PathMode === "primary") itsoCase8PathMode = "secondary";
        else itsoCase8PathMode = "both";
        itsoCasesFocusOverride = null;
        renderItsoCasesDiagram();
        updateItsoCasesDetail();
        return;
      }
      if (tc && tc.id === 22) {
        itsoCase22PathMode = itsoCase22PathMode === "primary" ? "secondary" : "primary";
        itsoCasesFocusOverride = null;
        renderItsoCasesDiagram();
        updateItsoCasesDetail();
        return;
      }
      if (itsoCasesFocusOverride === u.id) {
        itsoCasesFocusOverride = null;
      } else {
        itsoCasesFocusOverride = u.id;
      }
      renderItsoCasesDiagram();
      updateItsoCasesDetail();
    },
  });

  decorateItsoCaseVisuals(svg, users, tc);

  const case20Bundle = (tc && tc.id === 20 && itsoCasesFocusOverride == null)
    ? itsoCase20ChainBundle(users, tc)
    : null;

  const chainsRaw = itsoCasesFocusOverride != null
    ? itsoCasesFocusedChain(users, tc, itsoCasesFocusOverride)
    : (tc && tc.id === 20
      ? (case20Bundle ? case20Bundle.primary : itsoCasesTargetChain(users, tc))
      : (tc && tc.id === 8
        ? itsoCase8DisplayedChains(tc)
        : (tc && tc.id === 22 ? itsoCase22DisplayedChains(tc) : itsoCasesTargetChain(users, tc))));
  const chains = capItsoChainsToSecondHigher(chainsRaw, tc);
  if ((tc && tc.id === 3 && itsoCasesFocusOverride == null) || (tc && tc.id === 10 && itsoCasesFocusOverride == null)) {
    highlightTargetLine(svg, users, null);
  } else if (tc && tc.id === 9 && itsoCasesFocusOverride == null) {
    highlightItsoCase9TargetLine(svg, users, chains);
  } else {
    highlightTargetLine(svg, users, chains);
  }
  if (tc && tc.id === 20 && itsoCasesFocusOverride == null && case20Bundle && case20Bundle.mode === "both") {
    drawItsoCase20CounterfactualOverlay(svg, users, case20Bundle.counterfactual);
  }
  if (tc && tc.id === 1) {
    rerouteItsoCaseOneHighlightedPathViaActing(svg, users, chains);
  }
  const dimChains = ((tc && tc.id === 3 && itsoCasesFocusOverride == null) || (tc && tc.id === 10 && itsoCasesFocusOverride == null))
    ? null
    : (tc && tc.id === 20 && itsoCasesFocusOverride == null && case20Bundle
      ? case20Bundle.dim
      : (itsoCasesSelected != null ? chains : null));
  const dimChainsFinal = (tc && tc.id === 28 && itsoCasesFocusOverride == null && Array.isArray(dimChains))
    ? [...dimChains, ["Bianca", "Bianca [shell]"]]
    : dimChains;
  dimThirtyCasesContext(svg, users, dimChainsFinal);
  if (tc && tc.id === 10 && itsoCasesFocusOverride == null) {
    isolateItsoCase10Actors(svg, users);
  }
}

function decorateItsoCaseVisuals(svg, users, testCase) {
  if (!svg || !testCase) return;

  if (testCase.id === 1) {
    decorateItsoCaseSkipLevelActing(svg, users);
  }

  if (testCase.id === 4) {
    decorateItsoCaseVacantHead(svg, users);
  }

  if (testCase.id === 8) {
    decorateItsoCaseSplitAllocation(svg, users);
  }
  if (testCase.id === 9) {
    decorateItsoCaseCoHeads(svg, users);
  }
  if (testCase.id === 10) {
    // ITSO case 10: keep the formal manager relation visible, and add a
    // separate delegation-only owner->delegate link.
    decorateThirtyCaseExecutiveAssistantDelegation(svg, users, { includeOwnerFlow: true });
  }
  if (testCase.id === 13) {
    decorateItsoCaseCycleValidation(svg, users);
  }
  if (testCase.id === 15) {
    decorateItsoCaseFlatAllToIvan(svg, users);
  }
  if (testCase.id === 18) {
    decorateItsoCaseParkingCentralized(svg, users);
  }
  if (testCase.id === 23) {
    const daisy = users.find((u) => u.name === "Daisy" && u.department_code === "ITSO");
    if (daisy) {
      const daisyNode = svg.querySelector(`.diagram-node[data-user-id="${daisy.id}"]`);
      if (daisyNode) {
        daisyNode.classList.add("muted");
        daisyNode.style.pointerEvents = "none";
      }

      svg
        .querySelectorAll(`.diagram-edge[data-child-id="${daisy.id}"]`)
        .forEach((edge) => edge.classList.add("muted"));
    }
  }

  if (testCase.id === 27) {
    decorateItsoCaseJobSharing(svg, users);
  }

  if (testCase.id === 6) {
    decorateThirtyCaseHandoverOverlap(svg, users);
  }

  if (testCase.id === 2) {
    const onLeave = users.find((u) => u.name === "Cara" && u.department_code === "ITSO");
    if (onLeave) {
      const node = svg.querySelector(`.diagram-node[data-user-id="${onLeave.id}"]`);
      if (node) {
        node.classList.add("onleave-emphasis");
        const rect = node.querySelector("rect");
        if (rect) rect.classList.add("onleave-node-outline");
      }
    }
  }

  const plan = ITSO_CASE_VISUAL_PLAN[testCase.id];
  if (!plan) return;

  const tagCount = {};
  const MAX_TAGS_PER_NODE = 3;
  const addNodeTag = (node, key, text, className) => {
    if (!node || !text) return;
    const idx = tagCount[key] || 0;
    if (idx >= MAX_TAGS_PER_NODE) return;
    appendNodeTag(node, text, className || "itso-case-tag", 12 + idx * 11);
    tagCount[key] = idx + 1;
  };
  const nodeByName = (name) => {
    const user = users.find((u) => u.name === name);
    if (!user) return null;
    return svg.querySelector(`.diagram-node[data-user-id="${user.id}"]`);
  };

  if (testCase.id === 3) {
    const sel = itsoCasesPartialSelection(users, testCase);
    if (sel) {
      const manager = users.find((u) => u.id === sel.managerId);
      const leaveCover = users.find((u) => u.id === sel.leaveCoverId);
      const reviewCover = users.find((u) => u.id === sel.reviewCoverId);
      const isDefaultView = itsoCasesFocusOverride == null;

      if (manager) {
        const managerNode = svg.querySelector(`.diagram-node[data-user-id="${manager.id}"]`);
        if (managerNode) {
          addNodeTag(managerNode, `${manager.name}:onleave`, "on leave", "onleave-tag");
          const rect = managerNode.querySelector("rect");
          if (rect) rect.classList.add("onleave-node-outline");
        }
      }

      const addDutyTag = (cover, dutyText, dutyClass, keySuffix) => {
        if (!cover) return;
        const dutyNode = svg.querySelector(`.diagram-node[data-user-id="${cover.id}"]`);
        if (!dutyNode) return;
        addNodeTag(dutyNode, `${cover.name}:${keySuffix}`, dutyText, dutyClass);
        const rect = dutyNode.querySelector("rect");
        if (rect) rect.classList.add("acting-source-outline");
      };

      if (isDefaultView) {
        addDutyTag(leaveCover, "leave duty", "duty-leave-tag", "leave-duty");
        addDutyTag(reviewCover, "review duty", "duty-review-tag", "review-duty");
      } else {
        const activeCover = sel.mode === "review" ? reviewCover : leaveCover;
        if (activeCover) {
          addDutyTag(
            activeCover,
            sel.mode === "review" ? "review duty" : "leave duty",
            sel.mode === "review" ? "duty-review-tag" : "duty-leave-tag",
            sel.mode === "review" ? "review-duty" : "leave-duty"
          );
        }
      }
    }
  }

  if (testCase.id === 7 || testCase.id === 19) {
    const borisNode = nodeByName("Boris");
    if (borisNode) {
      const rect = borisNode.querySelector("rect");
      if (rect) rect.classList.add("loan-home-ghost-outline");
      addNodeTag(borisNode, "Boris", testCase.id === 19 ? "previous dept" : "major dept", "itso-note-tag");
    }
  }

  const clampNodeName = (textEl) => {
    if (!textEl) return;
    textEl.removeAttribute("textLength");
    textEl.removeAttribute("lengthAdjust");
    const maxTextW = NODE_W - 12;
    if (textEl.getComputedTextLength && textEl.getComputedTextLength() > maxTextW) {
      textEl.setAttribute("textLength", String(maxTextW));
      textEl.setAttribute("lengthAdjust", "spacingAndGlyphs");
    }
  };

  if (Array.isArray(plan.renames)) {
    plan.renames.forEach((rename) => {
      const node = nodeByName(rename.name);
      if (!node) return;
      const nameText = node.querySelector(".node-name");
      if (!nameText) return;
      nameText.textContent = rename.text;
      clampNodeName(nameText);
    });
  }

  if (Array.isArray(plan.outlines)) {
    plan.outlines.forEach((outline) => {
      const node = nodeByName(outline.name);
      if (!node) return;
      const rect = node.querySelector("rect");
      if (rect) rect.classList.add(outline.className || "itso-inactive-outline");
    });
  }

  if (Array.isArray(plan.tags) && testCase.id !== 3) {
    plan.tags.forEach((tag) => {
      const node = nodeByName(tag.name);
      if (!node) return;
      addNodeTag(node, tag.name, tag.text, tag.className || "itso-case-tag");
    });
  }

  if (Array.isArray(plan.edges)) {
    plan.edges.forEach((edge) => {
      addItsoContextEdge(svg, users, edge.from, edge.to, edge.label || "");
    });
  }

  // Loaned staff should show active placement in loan dept and ghost home
  // position in original dept for both-party visibility.
  users.filter((u) => u._loanFrom && !u._homeGhost).forEach((u) => {
    const node = svg.querySelector(`.diagram-node[data-user-id="${u.id}"]`);
    if (!node) return;
    const nameText = node.querySelector(".node-name");
    if (nameText) {
      nameText.textContent = `${u.name} [loaned from ${u._loanFrom}]`;
      nameText.removeAttribute("textLength");
      nameText.removeAttribute("lengthAdjust");
      const maxTextW = NODE_W - 12;
      if (nameText.getComputedTextLength && nameText.getComputedTextLength() > maxTextW) {
        nameText.setAttribute("textLength", String(maxTextW));
        nameText.setAttribute("lengthAdjust", "spacingAndGlyphs");
      }
    }
    addNodeTag(node, u.name, `to ${u._loanTo}`, "itso-warning-tag");
  });

  users.filter((u) => u._homeGhost).forEach((u) => {
    const node = svg.querySelector(`.diagram-node[data-user-id="${u.id}"]`);
    if (!node) return;
    const rect = node.querySelector("rect");
    if (rect) rect.classList.add("loan-home-ghost-outline");
    addNodeTag(node, u.name, "home post", "itso-note-tag");
    addItsoContextEdge(svg, users, u._loanPerson, u.name, "keeps original position");
  });

  if (plan.externalSection) {
    drawItsoExternalSection(svg, users, plan.externalSection);
  }
}

function drawItsoExternalSection(svg, users, section) {
  if (!svg || !section || !Array.isArray(section.nodes) || !section.nodes.length) return;

  const ns = "http://www.w3.org/2000/svg";
  const nodes = Array.from(svg.querySelectorAll(".diagram-node"));
  const parsePos = (node) => {
    const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(node.getAttribute("transform") || "");
    if (!m) return null;
    return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
  };
  const allPos = nodes
    .map((n) => parsePos(n))
    .filter(Boolean);
  if (!allPos.length) return;

  const maxX = allPos.reduce((m, p) => Math.max(m, p.x), allPos[0].x);
  const minY = allPos.reduce((m, p) => Math.min(m, p.y), allPos[0].y);

  const deptBounds = {};
  const userPosByName = {};
  users.forEach((u) => {
    const node = svg.querySelector(`.diagram-node[data-user-id="${u.id}"]`);
    if (!node) return;
    const p = parsePos(node);
    if (!p) return;
    userPosByName[u.name] = p;
    const code = u.department_code || "—";
    if (!deptBounds[code]) {
      deptBounds[code] = { minX: p.x, maxX: p.x, minY: p.y, maxY: p.y };
      return;
    }
    deptBounds[code].minX = Math.min(deptBounds[code].minX, p.x);
    deptBounds[code].maxX = Math.max(deptBounds[code].maxX, p.x);
    deptBounds[code].minY = Math.min(deptBounds[code].minY, p.y);
    deptBounds[code].maxY = Math.max(deptBounds[code].maxY, p.y);
  });

  let sectionW = NODE_W + 80;
  let sectionX = maxX + NODE_W + 28;
  let sectionY = Math.max(16, minY - 24);
  let insideDeptBounds = null;

  if (section.insideDept && deptBounds[section.insideDept]) {
    const b = deptBounds[section.insideDept];
    insideDeptBounds = b;
    const innerPad = 8;
    sectionW = NODE_W + 16;
    sectionX = b.minX - innerPad;
    sectionY = Math.max(16, b.minY - 20);
    if (section.leftOf && userPosByName[section.leftOf]) {
      sectionX = Math.max(12, userPosByName[section.leftOf].x - sectionW - 18);
    }
  } else if (section.nearDept && deptBounds[section.nearDept]) {
    const b = deptBounds[section.nearDept];
    sectionX = b.maxX + NODE_W + 16;
    sectionY = Math.max(16, b.minY - 20);
  }
  const nodeGap = 12;
  const sectionH = 28 + section.nodes.length * NODE_H + Math.max(0, section.nodes.length - 1) * nodeGap + 12;

  // Grow the SVG canvas so the external region is never clipped by the
  // existing viewBox that was sized before overlays were added.
  ensureSvgCanvasFits(svg, sectionX + sectionW + LEFT_PAD, sectionY + sectionH + 36);

  const region = document.createElementNS(ns, "g");
  region.setAttribute("class", "itso-external-region");

  const regionRect = document.createElementNS(ns, "rect");
  regionRect.setAttribute("x", String(sectionX));
  regionRect.setAttribute("y", String(sectionY));
  regionRect.setAttribute("width", String(sectionW));
  regionRect.setAttribute("height", String(sectionH));
  regionRect.setAttribute("rx", "10");
  regionRect.setAttribute("class", "itso-external-region-box");
  region.appendChild(regionRect);

  const title = document.createElementNS(ns, "text");
  title.setAttribute("x", String(sectionX + sectionW / 2));
  title.setAttribute("y", String(sectionY + sectionH - 10));
  title.setAttribute("class", "itso-external-region-title");
  title.textContent = section.title || "External";
  region.appendChild(title);

  const externalAnchors = {};
  const clamp = (el, maxW) => {
    if (!el || !el.getComputedTextLength) return;
    if (el.getComputedTextLength() > maxW) {
      el.setAttribute("textLength", String(maxW));
      el.setAttribute("lengthAdjust", "spacingAndGlyphs");
    }
  };

  const internalAnchors = {};
  users.forEach((u) => {
    const node = svg.querySelector(`.diagram-node[data-user-id="${u.id}"]`);
    if (!node) return;
    const p = parsePos(node);
    if (!p) return;
    internalAnchors[u.name] = {
      centerX: p.x + NODE_W / 2,
      centerY: p.y + NODE_H / 2,
      topY: p.y,
      bottomY: p.y + NODE_H,
      deptCode: u.department_code || null,
    };
  });

  const desiredExternalCenterYCandidates = {};
  const pushDesiredCenterY = (externalName, centerY) => {
    if (!Number.isFinite(centerY)) return;
    if (!desiredExternalCenterYCandidates[externalName]) {
      desiredExternalCenterYCandidates[externalName] = [];
    }
    desiredExternalCenterYCandidates[externalName].push(centerY);
  };
  if (Array.isArray(section.links)) {
    section.links.forEach((lnk) => {
      const fromIsExternal = section.nodes.some((n) => n.name === lnk.from);
      const toIsExternal = section.nodes.some((n) => n.name === lnk.to);
      if (fromIsExternal && internalAnchors[lnk.to]) {
        pushDesiredCenterY(lnk.from, internalAnchors[lnk.to].centerY);
      }
      if (toIsExternal && internalAnchors[lnk.from]) {
        pushDesiredCenterY(lnk.to, internalAnchors[lnk.from].centerY);
      }
    });
  }

  const desiredExternalCenterY = {};
  Object.keys(desiredExternalCenterYCandidates).forEach((name) => {
    const vals = desiredExternalCenterYCandidates[name];
    // If an external node is linked to multiple internal levels, align to the
    // deepest linked level (e.g. L9 over L4) to preserve level mapping intent.
    desiredExternalCenterY[name] = Math.max(...vals);
  });

  // Explicit alignment hint for cases where the external node should preserve
  // a specific home-level row even when links only point to higher levels.
  section.nodes.forEach((entry) => {
    if (entry.alignTo && internalAnchors[entry.alignTo]) {
      desiredExternalCenterY[entry.name] = internalAnchors[entry.alignTo].centerY;
      return;
    }
    // Fallback: infer home identity from names like "Boris [HKUST Loan]".
    const inferredBase = /^(.+?)\s*\[[^\]]+\]\s*$/.exec(entry.name || "");
    if (inferredBase && internalAnchors[inferredBase[1]]) {
      desiredExternalCenterY[entry.name] = internalAnchors[inferredBase[1]].centerY;
    }
  });

  const desiredCenters = section.nodes
    .map((entry) => desiredExternalCenterY[entry.name])
    .filter((v) => Number.isFinite(v));
  if (desiredCenters.length) {
    const targetCenterY = desiredCenters.reduce((sum, v) => sum + v, 0) / desiredCenters.length;
    const desiredTop = targetCenterY - (26 + NODE_H / 2);
    if (insideDeptBounds) {
      const minTop = Math.max(16, insideDeptBounds.minY - 20);
      const maxTop = Math.max(minTop, insideDeptBounds.maxY + NODE_H + 16 - sectionH);
      sectionY = Math.max(minTop, Math.min(maxTop, desiredTop));
    } else {
      sectionY = Math.max(16, desiredTop);
    }
    regionRect.setAttribute("y", String(sectionY));
    title.setAttribute("y", String(sectionY + sectionH - 10));
    ensureSvgCanvasFits(svg, sectionX + sectionW + LEFT_PAD, sectionY + sectionH + 36);
  }

  const overlapsInternalNodes = (x, y) => {
    const values = Object.values(internalAnchors);
    for (let i = 0; i < values.length; i += 1) {
      const a = values[i];
      const nx = a.centerX - NODE_W / 2;
      const ny = a.topY;
      const overlap =
        x < nx + NODE_W &&
        x + sectionW > nx &&
        y < ny + NODE_H &&
        y + sectionH > ny;
      if (overlap) return true;
    }
    return false;
  };

  let moveGuard = 0;
  while (overlapsInternalNodes(sectionX, sectionY) && moveGuard < 80) {
    sectionX = Math.max(12, sectionX - 24);
    moveGuard += 1;
    if (sectionX <= 12) break;
  }
  regionRect.setAttribute("x", String(sectionX));
  title.setAttribute("x", String(sectionX + sectionW / 2));
  ensureSvgCanvasFits(svg, sectionX + sectionW + LEFT_PAD, sectionY + sectionH + 36);

  section.nodes.forEach((entry, idx) => {
    const nodeX = sectionX + (sectionW - NODE_W) / 2;
    const defaultY = sectionY + 8 + idx * (NODE_H + nodeGap);
    const minNodeY = sectionY + 8;
    const maxNodeY = sectionY + sectionH - NODE_H - 24;
    const desiredCenterY = desiredExternalCenterY[entry.name];
    const mappedY = Number.isFinite(desiredCenterY)
      ? desiredCenterY - NODE_H / 2
      : defaultY;
    const nodeY = Math.max(minNodeY, Math.min(maxNodeY, mappedY));

    const g = document.createElementNS(ns, "g");
    g.setAttribute("class", "itso-external-node");
    g.setAttribute("transform", `translate(${nodeX},${nodeY})`);
    const externalUser = users.find((u) => u.name === entry.name) || null;
    const externalOnNodeClick = typeof svg.__diagramOnNodeClick === "function"
      ? svg.__diagramOnNodeClick
      : null;
    if (externalUser && externalOnNodeClick) {
      g.addEventListener("click", () => externalOnNodeClick(externalUser));
    }

    const rect = document.createElementNS(ns, "rect");
    rect.setAttribute("width", String(NODE_W));
    rect.setAttribute("height", String(NODE_H));
    rect.setAttribute("rx", "8");
    rect.setAttribute("class", "itso-external-node-rect");
    g.appendChild(rect);

    const name = document.createElementNS(ns, "text");
    name.setAttribute("x", String(NODE_W / 2));
    name.setAttribute("y", "18");
    name.setAttribute("class", "itso-external-node-name");
    name.textContent = entry.name;
    g.appendChild(name);

    const role = document.createElementNS(ns, "text");
    role.setAttribute("x", String(NODE_W / 2));
    role.setAttribute("y", "34");
    role.setAttribute("class", "itso-external-node-role");
    role.textContent = entry.role || "External role";
    g.appendChild(role);

    clamp(name, NODE_W - 12);
    clamp(role, NODE_W - 12);
    region.appendChild(g);

    externalAnchors[entry.name] = {
      centerX: nodeX + NODE_W / 2,
      centerY: nodeY + NODE_H / 2,
      topY: nodeY,
      bottomY: nodeY + NODE_H,
      deptCode: section.insideDept || section.nearDept || null,
    };
  });

  svg.appendChild(region);

  const getAnchor = (name) => {
    if (externalAnchors[name]) {
      const a = externalAnchors[name];
      return {
        kind: "external",
        centerX: a.centerX,
        centerY: a.centerY,
        leftX: a.centerX - NODE_W / 2,
        rightX: a.centerX + NODE_W / 2,
        topY: a.topY,
        bottomY: a.bottomY,
        deptCode: a.deptCode || null,
      };
    }
    if (internalAnchors[name]) {
      const a = internalAnchors[name];
      return {
        kind: "internal",
        centerX: a.centerX,
        centerY: a.centerY,
        leftX: a.centerX - NODE_W / 2,
        rightX: a.centerX + NODE_W / 2,
        topY: a.topY,
        bottomY: a.bottomY,
        deptCode: a.deptCode || null,
      };
    }
    return null;
  };

  const clampLane = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const deptLaneX = (deptCode, towardX) => {
    const b = deptCode ? deptBounds[deptCode] : null;
    if (!b) return towardX;
    const left = b.minX + 8;
    const right = b.maxX + NODE_W - 8;
    return clampLane(towardX, left, right);
  };

  const addLink = (from, to, label) => {
    const a1 = getAnchor(from);
    const a2 = getAnchor(to);
    if (!a1 || !a2) return;

    const canUseSidePorts =
      ((a1.kind === "external" && a2.kind === "internal") ||
        (a1.kind === "internal" && a2.kind === "external")) &&
      Math.abs(a1.centerY - a2.centerY) <= NODE_H * 0.75;

    if (canUseSidePorts) {
      const leftAnchor = a1.centerX <= a2.centerX ? a1 : a2;
      const rightAnchor = leftAnchor === a1 ? a2 : a1;
      const p1 = { x: leftAnchor.rightX, y: leftAnchor.centerY };
      const p2 = { x: rightAnchor.leftX, y: rightAnchor.centerY };
      const midX = (p1.x + p2.x) / 2;
      const d = Math.abs(p1.y - p2.y) <= 0.5
        ? `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`
        : `M ${p1.x} ${p1.y} L ${midX} ${p1.y} L ${midX} ${p2.y} L ${p2.x} ${p2.y}`;

      const path = document.createElementNS(ns, "path");
      path.setAttribute("d", d);
      path.setAttribute("class", "itso-external-link");
      svg.appendChild(path);

      if (label) {
        const t = document.createElementNS(ns, "text");
        t.setAttribute("x", String(midX + 4));
        t.setAttribute("y", String((p1.y + p2.y) / 2 - 5));
        t.setAttribute("class", "itso-external-link-label");
        t.textContent = label;
        svg.appendChild(t);
      }

      ensureSvgCanvasFits(svg, Math.max(p1.x, p2.x, midX) + LEFT_PAD, Math.max(p1.y, p2.y) + 36);
      return;
    }

    const pickVerticalPort = (anchor, other) => {
      if (other.centerY < anchor.centerY - 0.5) return { x: anchor.centerX, y: anchor.topY };
      if (other.centerY > anchor.centerY + 0.5) return { x: anchor.centerX, y: anchor.bottomY };
      return { x: anchor.centerX, y: anchor.bottomY };
    };

    // Top/bottom-only attachment ports; no left/right node connections.
    const rawP1 = pickVerticalPort(a1, a2);
    const rawP2 = pickVerticalPort(a2, a1);

    // Enforce bottom-to-top direction for animated flow.
    const p1 = rawP1.y >= rawP2.y ? rawP1 : rawP2;
    const p2 = rawP1.y >= rawP2.y ? rawP2 : rawP1;
    const sameDept =
      a1.deptCode &&
      a2.deptCode &&
      a1.deptCode === a2.deptCode &&
      Boolean(deptBounds[a1.deptCode]);

    let d = "";
    let labelX = Math.max(p1.x, p2.x) + 24;
    let labelY = (p1.y + p2.y) / 2 - 5;
    const crossY = (p1.y + p2.y) / 2;

    if (sameDept) {
      const laneX = deptLaneX(a1.deptCode, Math.max(p1.x, p2.x) + 24);
      d = `M ${p1.x} ${p1.y} L ${p1.x} ${crossY} L ${laneX} ${crossY} L ${laneX} ${p2.y} L ${p2.x} ${p2.y}`;
      labelX = laneX + 4;
      labelY = crossY - 5;
      ensureSvgCanvasFits(svg, laneX + LEFT_PAD, Math.max(p1.y, p2.y, crossY) + 36);
    } else {
      const lane1Pref = a1.centerX <= a2.centerX ? p1.x + 24 : p1.x - 24;
      const lane2Pref = a2.centerX <= a1.centerX ? p2.x + 24 : p2.x - 24;
      const lane1X = deptLaneX(a1.deptCode, lane1Pref);
      const lane2X = deptLaneX(a2.deptCode, lane2Pref);
      d = `M ${p1.x} ${p1.y} L ${p1.x} ${crossY} L ${lane1X} ${crossY} L ${lane2X} ${crossY} L ${lane2X} ${p2.y} L ${p2.x} ${p2.y}`;
      labelX = (lane1X + lane2X) / 2 + 4;
      labelY = crossY - 5;
      ensureSvgCanvasFits(
        svg,
        Math.max(lane1X, lane2X) + LEFT_PAD,
        Math.max(p1.y, p2.y, crossY) + 36
      );
    }

    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    path.setAttribute("class", "itso-external-link");
    svg.appendChild(path);

    if (!label) return;
    const t = document.createElementNS(ns, "text");
    t.setAttribute("x", String(labelX));
    t.setAttribute("y", String(labelY));
    t.setAttribute("class", "itso-external-link-label");
    t.textContent = label;
    svg.appendChild(t);
  };

  (section.links || []).forEach((lnk) => addLink(lnk.from, lnk.to, lnk.label || ""));
}

function ensureSvgCanvasFits(svg, minWidth, minHeight) {
  if (!svg) return;
  const vb = (svg.getAttribute("viewBox") || "").trim().split(/\s+/).map(Number);
  const currentW = vb.length === 4 && Number.isFinite(vb[2]) ? vb[2] : 600;
  const currentH = vb.length === 4 && Number.isFinite(vb[3]) ? vb[3] : 120;
  const nextW = Math.max(currentW, Math.ceil(minWidth || 0));
  const nextH = Math.max(currentH, Math.ceil(minHeight || 0));
  if (nextW === currentW && nextH === currentH) return;
  svg.setAttribute("viewBox", `0 0 ${nextW} ${nextH}`);
  svg.style.width = `${nextW}px`;
  svg.style.height = `${nextH}px`;
}

function addItsoContextEdge(svg, users, fromName, toName, label) {
  const from = users.find((u) => u.name === fromName);
  const to = users.find((u) => u.name === toName);
  if (!from || !to) return;

  const fromNode = svg.querySelector(`.diagram-node[data-user-id="${from.id}"]`);
  const toNode = svg.querySelector(`.diagram-node[data-user-id="${to.id}"]`);
  if (!fromNode || !toNode) return;

  const parsePos = (node) => {
    const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(node.getAttribute("transform") || "");
    if (!m) return null;
    return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
  };
  const fromPos = parsePos(fromNode);
  const toPos = parsePos(toNode);
  if (!fromPos || !toPos) return;

  const ns = "http://www.w3.org/2000/svg";
  const pFrom =
    toPos.y < fromPos.y
      ? { x: fromPos.x + NODE_W / 2, y: fromPos.y }
      : { x: fromPos.x + NODE_W / 2, y: fromPos.y + NODE_H };
  const pTo =
    fromPos.y < toPos.y
      ? { x: toPos.x + NODE_W / 2, y: toPos.y }
      : { x: toPos.x + NODE_W / 2, y: toPos.y + NODE_H };
  // Enforce bottom-to-top direction for animated flow.
  const p1 = pFrom.y >= pTo.y ? pFrom : pTo;
  const p2 = pFrom.y >= pTo.y ? pTo : pFrom;
  const detourX = Math.max(p1.x, p2.x) + 24;
  ensureSvgCanvasFits(svg, detourX + LEFT_PAD, Math.max(p1.y, p2.y) + 28);

  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", `M ${p1.x} ${p1.y} L ${detourX} ${p1.y} L ${detourX} ${p2.y} L ${p2.x} ${p2.y}`);
  path.setAttribute("class", "itso-context-edge");
  svg.appendChild(path);

  if (!label) return;
  const text = document.createElementNS(ns, "text");
  text.setAttribute("x", String(detourX + 4));
  text.setAttribute("y", String((p1.y + p2.y) / 2 - 6));
  text.setAttribute("class", "itso-context-label");
  text.textContent = label;
  svg.appendChild(text);
}

function decorateItsoCaseJobSharing(svg, users) {
  const bruno = users.find((u) => u.name === "Bruno" && u.department_code === "ITSO");
  const bella = users.find((u) => u.name === "Bella" && u.department_code === "ITSO");
  const ingrid = users.find((u) => u.name === "Ingrid" && u.department_code === "ITSO");
  if (!bruno || !bella) return;

  const brunoNode = svg.querySelector(`.diagram-node[data-user-id="${bruno.id}"]`);
  const bellaNode = svg.querySelector(`.diagram-node[data-user-id="${bella.id}"]`);
  const ingridNode = ingrid ? svg.querySelector(`.diagram-node[data-user-id="${ingrid.id}"]`) : null;
  if (!brunoNode || !bellaNode) return;

  const parsePos = (node) => {
    const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(node.getAttribute("transform") || "");
    if (!m) return null;
    return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
  };

  const bPos = parsePos(brunoNode);
  const bePos = parsePos(bellaNode);
  const iPos = ingridNode ? parsePos(ingridNode) : null;
  if (!bPos || !bePos) return;

  [brunoNode, bellaNode].forEach((node) => {
    const rect = node.querySelector("rect");
    if (rect) rect.classList.add("itso-jobshare-holder-outline");
  });

  const ns = "http://www.w3.org/2000/svg";
  const left = bPos.x <= bePos.x ? bPos : bePos;
  const right = left === bPos ? bePos : bPos;
  const holdersTop = Math.min(bPos.y, bePos.y);
  const holdersBottom = Math.max(bPos.y + NODE_H, bePos.y + NODE_H);
  const sharedW = 184;
  const sharedH = 40;
  const sharedX = (left.x + right.x + NODE_W) / 2 - sharedW / 2;
  const preferAboveY = holdersTop - 56;
  const sharedY = preferAboveY >= 8 ? preferAboveY : holdersBottom + 18;
  const boxAboveHolders = sharedY < holdersTop;

  const group = document.createElementNS(ns, "g");
  group.setAttribute("class", "itso-jobshare-group");

  const rect = document.createElementNS(ns, "rect");
  rect.setAttribute("x", String(sharedX));
  rect.setAttribute("y", String(sharedY));
  rect.setAttribute("width", String(sharedW));
  rect.setAttribute("height", String(sharedH));
  rect.setAttribute("rx", "10");
  rect.setAttribute("class", "itso-jobshare-box");
  group.appendChild(rect);

  const title = document.createElementNS(ns, "text");
  title.setAttribute("x", String(sharedX + sharedW / 2));
  title.setAttribute("y", String(sharedY + 17));
  title.setAttribute("class", "itso-jobshare-title");
  title.textContent = "Shared Position";
  group.appendChild(title);

  const sub = document.createElementNS(ns, "text");
  sub.setAttribute("x", String(sharedX + sharedW / 2));
  sub.setAttribute("y", String(sharedY + 30));
  sub.setAttribute("class", "itso-jobshare-sub");
  sub.textContent = "1.0 FTE total";
  group.appendChild(sub);

  svg.appendChild(group);

  const sharedPortY = boxAboveHolders ? sharedY + sharedH : sharedY;
  const holderPortY = (p) => (boxAboveHolders ? p.y : p.y + NODE_H);
  const sharedCenterX = sharedX + sharedW / 2;
  const holderCenters = [
    { x: bPos.x + NODE_W / 2, y: holderPortY(bPos) },
    { x: bePos.x + NODE_W / 2, y: holderPortY(bePos) },
  ];

  holderCenters.forEach((pt) => {
    const path = document.createElementNS(ns, "path");
    const bendY = boxAboveHolders
      ? Math.max(sharedPortY + 10, pt.y - 12)
      : Math.min(sharedPortY - 10, pt.y + 12);
    const anchorX = pt.x <= sharedCenterX ? sharedX + sharedW * 0.34 : sharedX + sharedW * 0.66;
    path.setAttribute(
      "d",
      `M ${anchorX} ${sharedPortY} L ${anchorX} ${bendY} L ${pt.x} ${bendY} L ${pt.x} ${pt.y}`
    );
    path.setAttribute("class", "itso-jobshare-link");
    svg.appendChild(path);
  });

  if (iPos) {
    const mgrPath = document.createElementNS(ns, "path");
    const fromY = boxAboveHolders ? sharedY : sharedY + sharedH;
    const toY = iPos.y + NODE_H;
    const toX = iPos.x + NODE_W / 2;
    const laneX = Math.max(sharedX + sharedW, toX) + 24;
    mgrPath.setAttribute(
      "d",
      `M ${sharedCenterX} ${fromY} L ${laneX} ${fromY} L ${laneX} ${toY} L ${toX} ${toY}`
    );
    mgrPath.setAttribute("class", "itso-jobshare-manager-link");
    svg.appendChild(mgrPath);
  }

  ensureSvgCanvasFits(
    svg,
    Math.max(sharedX + sharedW, bPos.x + NODE_W, bePos.x + NODE_W, (iPos ? iPos.x + NODE_W : 0)) + LEFT_PAD,
    Math.max(sharedY + sharedH, holdersBottom, (iPos ? iPos.y + NODE_H : 0)) + 36
  );
}

// ITSO Case #13: show the proposed circular edge as explicitly rejected while
// preserving the real reporting path highlight.
function decorateItsoCaseCycleValidation(svg, users) {
  const ivan = users.find((u) => u.name === "Ivan" && u.department_code === "ITSO");
  const ingrid = users.find((u) => u.name === "Ingrid" && u.department_code === "ITSO");
  const isaac = users.find((u) => u.name === "Isaac" && u.department_code === "ITSO");
  if (!ivan || !ingrid || !isaac) return;

  const ivanNode = svg.querySelector(`.diagram-node[data-user-id="${ivan.id}"]`);
  const ingridNode = svg.querySelector(`.diagram-node[data-user-id="${ingrid.id}"]`);
  const isaacNode = svg.querySelector(`.diagram-node[data-user-id="${isaac.id}"]`);
  if (!ivanNode || !ingridNode || !isaacNode) return;

  const parsePos = (node) => {
    const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(node.getAttribute("transform") || "");
    if (!m) return null;
    return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
  };
  const ivanPos = parsePos(ivanNode);
  const ingridPos = parsePos(ingridNode);
  const isaacPos = parsePos(isaacNode);
  if (!ivanPos || !ingridPos || !isaacPos) return;

  // Case framing: proposed state is that Isaac becomes department head, but
  // validation blocks the resulting circular edge before save.
  const isaacName = isaacNode.querySelector(".node-name");
  const isaacLevel = isaacNode.querySelector(".node-level");
  const ivanName = ivanNode.querySelector(".node-name");
  const clamp = (textEl) => {
    if (!textEl) return;
    textEl.removeAttribute("textLength");
    textEl.removeAttribute("lengthAdjust");
    const maxTextW = NODE_W - 12;
    if (textEl.getComputedTextLength && textEl.getComputedTextLength() > maxTextW) {
      textEl.setAttribute("textLength", String(maxTextW));
      textEl.setAttribute("lengthAdjust", "spacingAndGlyphs");
    }
  };
  if (isaacName) {
    isaacName.textContent = "Isaac (Acting Dept Head)";
    clamp(isaacName);
  }
  if (isaacLevel) {
    isaacLevel.textContent = "Manager (L6) -> Dept Head (acting)";
    clamp(isaacLevel);
  }
  if (ivanName) {
    ivanName.textContent = "Isaac (Acting)";
    clamp(ivanName);
  }

  const ns = "http://www.w3.org/2000/svg";
  const from = { x: ivanPos.x + NODE_W / 2, y: ivanPos.y + NODE_H };
  const to = { x: isaacPos.x + NODE_W / 2, y: isaacPos.y };
  const ingridRight = ingridPos.x + NODE_W;
  const laneX = ingridRight + 12;
  const approachY = Math.max(from.y + 12, to.y - 12);
  ensureSvgCanvasFits(svg, laneX + LEFT_PAD, Math.max(from.y, to.y) + 36);

  const rejected = document.createElementNS(ns, "path");
  rejected.setAttribute(
    "d",
    `M ${from.x} ${from.y} L ${laneX} ${from.y} L ${laneX} ${approachY} L ${to.x} ${approachY} L ${to.x} ${to.y}`
  );
  rejected.setAttribute("class", "itso-cycle-rejected-edge");
  svg.appendChild(rejected);

  const edgeLabel = document.createElementNS(ns, "text");
  edgeLabel.setAttribute("x", String(laneX + 4));
  edgeLabel.setAttribute("y", String((from.y + approachY) / 2 - 6));
  edgeLabel.setAttribute("class", "itso-cycle-rejected-label");
  edgeLabel.textContent = "Rejected loop";
  svg.appendChild(edgeLabel);

  const blockA = document.createElementNS(ns, "line");
  blockA.setAttribute("x1", String(to.x - 5));
  blockA.setAttribute("y1", String(to.y - 5));
  blockA.setAttribute("x2", String(to.x + 5));
  blockA.setAttribute("y2", String(to.y + 5));
  blockA.setAttribute("class", "itso-cycle-block");
  svg.appendChild(blockA);

  const blockB = document.createElementNS(ns, "line");
  blockB.setAttribute("x1", String(to.x - 5));
  blockB.setAttribute("y1", String(to.y + 5));
  blockB.setAttribute("x2", String(to.x + 5));
  blockB.setAttribute("y2", String(to.y - 5));
  blockB.setAttribute("class", "itso-cycle-block");
  svg.appendChild(blockB);

  const vb = (svg.getAttribute("viewBox") || "0 0 600 120").trim().split(/\s+/).map(Number);
  const viewW = vb.length === 4 && Number.isFinite(vb[2]) ? vb[2] : 600;
  const badgeW = 212;
  const badgeH = 34;
  const badgeX = Math.max(8, viewW - badgeW - 12);
  const badgeY = 10;

  const badgeRect = document.createElementNS(ns, "rect");
  badgeRect.setAttribute("x", String(badgeX));
  badgeRect.setAttribute("y", String(badgeY));
  badgeRect.setAttribute("width", String(badgeW));
  badgeRect.setAttribute("height", String(badgeH));
  badgeRect.setAttribute("rx", "6");
  badgeRect.setAttribute("class", "itso-cycle-badge");
  svg.appendChild(badgeRect);

  const badgeText = document.createElementNS(ns, "text");
  badgeText.setAttribute("x", String(badgeX + 10));
  badgeText.setAttribute("y", String(badgeY + 21));
  badgeText.setAttribute("class", "itso-cycle-badge-text");
  badgeText.textContent = "Cycle detected (DFS). Save blocked.";
  svg.appendChild(badgeText);
}

// ITSO Case #15: visualize an extreme flat span where everyone reports
// directly to Ivan. This is a case-only overlay and does not alter persisted
// manager relationships.
function decorateItsoCaseFlatAllToIvan(svg, users) {
  const ivan = users.find((u) => u.name === "Ivan" && u.department_code === "ITSO");
  if (!ivan) return;

  const ivanNode = svg.querySelector(`.diagram-node[data-user-id="${ivan.id}"]`);
  if (!ivanNode) return;
  svg.querySelectorAll(".diagram-node").forEach((n) => n.classList.add("selected"));

  const parsePos = (node) => {
    const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(node.getAttribute("transform") || "");
    if (!m) return null;
    return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
  };
  const ivanPos = parsePos(ivanNode);
  if (!ivanPos) return;

  // Remove the original internal ITSO hierarchy so the case reads as a true
  // flat organization rather than an overlay on top of the old tree.
  const itsoIds = new Set(
    users.filter((u) => u.department_code === "ITSO").map((u) => String(u.id))
  );
  svg.querySelectorAll(".diagram-edge").forEach((edge) => {
    const childId = String(edge.dataset.childId || "");
    const parentId = String(edge.dataset.parentId || "");
    if (itsoIds.has(childId) && itsoIds.has(parentId)) edge.remove();
  });

  const ns = "http://www.w3.org/2000/svg";
  const ivanTop = { x: ivanPos.x + NODE_W / 2, y: ivanPos.y };
  const ivanBottom = { x: ivanPos.x + NODE_W / 2, y: ivanPos.y + NODE_H };

  users
    .filter((u) => u.id !== ivan.id && u.department_code === "ITSO")
    .forEach((u) => {
      const node = svg.querySelector(`.diagram-node[data-user-id="${u.id}"]`);
      if (!node) return;
      const p = parsePos(node);
      if (!p) return;

      const from = {
        x: p.x + NODE_W / 2,
        y: p.y >= ivanPos.y ? p.y : p.y + NODE_H,
      };
      const to = p.y >= ivanPos.y ? ivanBottom : ivanTop;
      const elbowY = layerGapElbowY(to.y, from.y);

      const path = document.createElementNS(ns, "path");
      path.setAttribute(
        "d",
        Math.abs(from.x - to.x) < 0.5
          ? `M ${from.x} ${from.y} L ${to.x} ${to.y}`
          : `M ${from.x} ${from.y} L ${from.x} ${elbowY} L ${to.x} ${elbowY} L ${to.x} ${to.y}`
      );
      path.setAttribute("class", "itso-flat-edge");
      svg.appendChild(path);
    });

  const badgeW = 206;
  const badgeH = 30;
  const badgeX = ivanPos.x + NODE_W + 18;
  const badgeY = Math.max(8, ivanPos.y - 2);

  const badgeRect = document.createElementNS(ns, "rect");
  badgeRect.setAttribute("x", String(badgeX));
  badgeRect.setAttribute("y", String(badgeY));
  badgeRect.setAttribute("width", String(badgeW));
  badgeRect.setAttribute("height", String(badgeH));
  badgeRect.setAttribute("rx", "8");
  badgeRect.setAttribute("class", "itso-parking-badge");
  svg.appendChild(badgeRect);

  const badgeText = document.createElementNS(ns, "text");
  badgeText.setAttribute("x", String(badgeX + 10));
  badgeText.setAttribute("y", String(badgeY + 19));
  badgeText.setAttribute("class", "itso-parking-badge-text");
  badgeText.textContent = "All ITSO staff report directly to Ivan";
  svg.appendChild(badgeText);

  ensureSvgCanvasFits(svg, badgeX + badgeW + LEFT_PAD, Math.max(badgeY + badgeH, ivanPos.y + NODE_H) + 36);
}

// ITSO Case #18: show a one-person Parking department with centralized
// approval routed through HRO staff (Hannah).
function decorateItsoCaseParkingCentralized(svg, users) {
  const faye = users.find((u) => u.name === "Faye" && u.department_code === "PARKING");
  const hannah = users.find((u) => u.name === "Hannah" && u.department_code === "HRO");
  if (!faye || !hannah) return;

  const fayeNode = svg.querySelector(`.diagram-node[data-user-id="${faye.id}"]`);
  const hannahNode = svg.querySelector(`.diagram-node[data-user-id="${hannah.id}"]`);
  if (!fayeNode || !hannahNode) return;

  const fayeRect = fayeNode.querySelector("rect");
  if (fayeRect) fayeRect.classList.add("itso-parked-node-outline");

  // In this scenario, Faye is intentionally shown without subtitle text.
  const fayeLevel = fayeNode.querySelector(".node-level");
  if (fayeLevel) fayeLevel.remove();

  const hannahRect = hannahNode.querySelector("rect");
  if (hannahRect) hannahRect.classList.add("itso-central-approver-outline");

  svg
    .querySelectorAll(`[data-child-id="${faye.id}"][data-parent-id="${hannah.id}"]`)
    .forEach((edge) => edge.classList.add("itso-parking-central-edge"));

  const ns = "http://www.w3.org/2000/svg";
  const vb = (svg.getAttribute("viewBox") || "0 0 600 120").trim().split(/\s+/).map(Number);
  const viewW = vb.length === 4 && Number.isFinite(vb[2]) ? vb[2] : 600;
  const badgeW = 192;
  const badgeH = 32;
  const badgeX = Math.max(8, viewW - badgeW - 12);
  const badgeY = 10;

  const badgeRect = document.createElementNS(ns, "rect");
  badgeRect.setAttribute("x", String(badgeX));
  badgeRect.setAttribute("y", String(badgeY));
  badgeRect.setAttribute("width", String(badgeW));
  badgeRect.setAttribute("height", String(badgeH));
  badgeRect.setAttribute("rx", "6");
  badgeRect.setAttribute("class", "itso-parking-badge");
  svg.appendChild(badgeRect);

  const badgeText = document.createElementNS(ns, "text");
  badgeText.setAttribute("x", String(badgeX + 10));
  badgeText.setAttribute("y", String(badgeY + 20));
  badgeText.setAttribute("class", "itso-parking-badge-text");
  badgeText.textContent = "Parking dept (solo): centralized via HRO";
  svg.appendChild(badgeText);
}

function decorateItsoCaseSkipLevelActing(svg, users) {
  const ivan = users.find((u) => u.name === "Ivan" && u.department_code === "ITSO");
  const boris = users.find((u) => u.name === "Boris" && u.department_code === "ITSO");
  if (!ivan || !boris) return;

  const ivanNode = svg.querySelector(`.diagram-node[data-user-id="${ivan.id}"]`);
  const borisNode = svg.querySelector(`.diagram-node[data-user-id="${boris.id}"]`);
  if (!ivanNode || !borisNode) return;

  // Hide the original Boris -> Ivan line for this acting visualization.
  svg
    .querySelectorAll(`.diagram-edge[data-child-id="${boris.id}"][data-parent-id="${ivan.id}"]`)
    .forEach((edge) => edge.remove());

  const parsePos = (node) => {
    const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(node.getAttribute("transform") || "");
    if (!m) return null;
    return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
  };
  const ivanPos = parsePos(ivanNode);
  if (!ivanPos) return;

  const ns = "http://www.w3.org/2000/svg";
  const markerId = "itso-acting-overlay-arrow";
  let defs = svg.querySelector("defs");
  if (!defs) {
    defs = document.createElementNS(ns, "defs");
    svg.insertBefore(defs, svg.firstChild);
  }
  if (!defs.querySelector(`#${markerId}`)) {
    const marker = document.createElementNS(ns, "marker");
    marker.setAttribute("id", markerId);
    marker.setAttribute("markerWidth", "8");
    marker.setAttribute("markerHeight", "8");
    marker.setAttribute("refX", "6");
    marker.setAttribute("refY", "3");
    marker.setAttribute("orient", "auto");
    const headPath = document.createElementNS(ns, "path");
    headPath.setAttribute("d", "M0,0 L0,6 L8,3 z");
    headPath.setAttribute("fill", "#e48a1f");
    marker.appendChild(headPath);
    defs.appendChild(marker);
  }

  const ivanRect = ivanNode.querySelector("rect");
  if (ivanRect) ivanRect.classList.add("acting-head-outline");
  const borisRect = borisNode.querySelector("rect");
  if (borisRect) borisRect.classList.add("acting-source-outline");

  const actingX = ivanPos.x + NODE_W + 46;
  const actingY = ivanPos.y;

  const actingGroup = document.createElementNS(ns, "g");
  actingGroup.setAttribute("class", "acting-overlay-node");
  actingGroup.setAttribute("transform", `translate(${actingX},${actingY})`);

  const actingRect = document.createElementNS(ns, "rect");
  actingRect.setAttribute("width", String(NODE_W));
  actingRect.setAttribute("height", String(NODE_H));
  actingRect.setAttribute("rx", "8");
  actingGroup.appendChild(actingRect);

  const actingName = document.createElementNS(ns, "text");
  actingName.setAttribute("x", String(NODE_W / 2));
  actingName.setAttribute("y", "18");
  actingName.setAttribute("class", "acting-overlay-name");
  actingName.textContent = "Boris (Acting)";
  actingGroup.appendChild(actingName);

  const actingRole = document.createElementNS(ns, "text");
  actingRole.setAttribute("x", String(NODE_W / 2));
  actingRole.setAttribute("y", "34");
  actingRole.setAttribute("class", "acting-overlay-role");
  actingRole.textContent = "ITSO Acting Head";
  actingGroup.appendChild(actingRole);

  svg.appendChild(actingGroup);

  const path = document.createElementNS(ns, "path");
  const fromX = ivanPos.x + NODE_W;
  const fromY = ivanPos.y + NODE_H / 2;
  const toX = actingX;
  const toY = actingY + NODE_H / 2;
  path.setAttribute("d", `M ${fromX} ${fromY} L ${toX} ${toY}`);
  path.setAttribute("class", "acting-overlay-edge acting-overlay-edge-emphasis");
  path.setAttribute("marker-end", `url(#${markerId})`);
  svg.appendChild(path);
}

function rerouteItsoCaseOneHighlightedPathViaActing(svg, users, chains) {
  if (!svg || !chains || !chains.length) return;
  const hasIvan = chains.some((chain) => Array.isArray(chain) && chain.includes("Ivan"));
  if (!hasIvan) return;

  const ivan = users.find((u) => u.name === "Ivan" && u.department_code === "ITSO");
  const boris = users.find((u) => u.name === "Boris" && u.department_code === "ITSO");
  if (!ivan || !boris) return;

  // Ensure no visible Boris -> Ivan relation in Case 1.
  svg
    .querySelectorAll(`.diagram-edge[data-child-id="${boris.id}"][data-parent-id="${ivan.id}"]`)
    .forEach((edge) => edge.remove());
  svg
    .querySelectorAll(`.target-edge[data-child-id="${boris.id}"][data-parent-id="${ivan.id}"]`)
    .forEach((edge) => edge.remove());
}

function decorateItsoCaseVacantHead(svg, users) {
  const ingrid = users.find((u) => u.name === "Ingrid" && u.department_code === "ITSO");
  if (!ingrid) return;
  const ingridNode = svg.querySelector(`.diagram-node[data-user-id="${ingrid.id}"]`);
  if (!ingridNode) return;
  const rect = ingridNode.querySelector("rect");
  if (rect) rect.classList.add("vacant-node-outline");
  const nameText = ingridNode.querySelector(".node-name");
  if (!nameText) return;
  nameText.textContent = "Vacant";
  nameText.setAttribute("font-style", "italic");
  nameText.removeAttribute("textLength");
  nameText.removeAttribute("lengthAdjust");
  const maxTextW = NODE_W - 12;
  if (nameText.getComputedTextLength && nameText.getComputedTextLength() > maxTextW) {
    nameText.setAttribute("textLength", String(maxTextW));
    nameText.setAttribute("lengthAdjust", "spacingAndGlyphs");
  }
}

function decorateItsoCaseSplitAllocation(svg, users) {
  const bruno = users.find((u) => u.name === "Bruno");
  if (!bruno) return;
  const node = svg.querySelector(`.diagram-node[data-user-id="${bruno.id}"]`);
  if (!node) return;
  const nameText = node.querySelector(".node-name");
  if (!nameText) return;
  nameText.textContent = "Bruno [Infra/Apps]";
  nameText.removeAttribute("textLength");
  nameText.removeAttribute("lengthAdjust");
  const maxTextW = NODE_W - 12;
  if (nameText.getComputedTextLength && nameText.getComputedTextLength() > maxTextW) {
    nameText.setAttribute("textLength", String(maxTextW));
    nameText.setAttribute("lengthAdjust", "spacingAndGlyphs");
  }
}

// ITSO Case #9 refinement: make the co-head model explicit by linking Ivan and
// Ingrid with a shared authority bridge and label (any-one-approve).
function decorateItsoCaseCoHeads(svg, users) {
  decorateThirtyCaseCoHeads(svg, users);

  const ivan = users.find((u) => u.name === "Ivan" && u.department_code === "ITSO");
  const ingrid = users.find((u) => u.name === "Ingrid" && u.department_code === "ITSO");
  if (!ivan || !ingrid) return;

  const ivanNode = svg.querySelector(`.diagram-node[data-user-id="${ivan.id}"]`);
  const ingridNode = svg.querySelector(`.diagram-node[data-user-id="${ingrid.id}"]`);
  if (!ivanNode || !ingridNode) return;

  // Keep both co-head nodes styled consistently.

  const parsePos = (node) => {
    const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(node.getAttribute("transform") || "");
    if (!m) return null;
    return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
  };
  const ivanPos = parsePos(ivanNode);
  const ingridPos = parsePos(ingridNode);
  if (!ivanPos || !ingridPos) return;

  const top = ivanPos.y <= ingridPos.y
    ? { pos: ivanPos }
    : { pos: ingridPos };
  const bottom = top.pos === ivanPos
    ? { pos: ingridPos }
    : { pos: ivanPos };

  const topPort = { x: top.pos.x + NODE_W / 2, y: top.pos.y + NODE_H };
  const bottomPort = { x: bottom.pos.x + NODE_W / 2, y: bottom.pos.y };
  const gap = Math.max(bottomPort.y - topPort.y, 0);
  const laneY = topPort.y + Math.max(10, gap * 0.45);
  const ns = "http://www.w3.org/2000/svg";

  const bridge = document.createElementNS(ns, "path");
  bridge.setAttribute("class", "itso-cohead-bridge");
  bridge.setAttribute(
    "d",
    `M ${topPort.x} ${topPort.y} L ${topPort.x} ${laneY} L ${bottomPort.x} ${laneY} L ${bottomPort.x} ${bottomPort.y}`
  );
  svg.appendChild(bridge);

  const label = document.createElementNS(ns, "text");
  label.setAttribute("class", "itso-cohead-label");
  label.setAttribute("x", String((topPort.x + bottomPort.x) / 2));
  label.setAttribute("y", String(laneY - 6));
  label.textContent = "Any-one-approve co-head bridge";
  svg.appendChild(label);

  const cara = users.find((u) => u.name === "Cara" && u.department_code === "ITSO");
  if (!cara) return;
  [ivan, ingrid].forEach((head) => {
    svg
      .querySelectorAll(`.diagram-edge[data-child-id="${cara.id}"][data-parent-id="${head.id}"]`)
      .forEach((edge) => edge.classList.add("itso-cohead-branch"));
  });
}

function itsoCasesTargetChain(users, testCase) {
  if (!testCase || (testCase.target && testCase.target.length === 0)) return null;
  if (testCase.id === 19) {
    const future = users.find((u) => u.name === "Boris [ITSO ➜ HRO]");
    const chains = [];
    if (future) {
      const futureChain = thirtyCasesFocusChain(users, future.id);
      if (Array.isArray(futureChain)) chains.push(...futureChain);
    }
    const boris = users.find((u) => u.name === "Boris" && u.department_code === "ITSO");
    const iris = users.find((u) => u.name === "Iris" && u.department_code === "ITSO");
    const isaac = users.find((u) => u.name === "Isaac" && u.department_code === "ITSO");
    if (boris && iris && isaac) {
      chains.push([boris.name, iris.name, isaac.name]);
    } else if (boris) {
      const homeChain = thirtyCasesFocusChain(users, boris.id);
      if (Array.isArray(homeChain)) chains.push(...homeChain);
    }
    if (chains.length) return capItsoChainsToSecondHigher(chains, testCase);
  }
  if (testCase.id === 15) {
    const ivan = users.find((u) => u.name === "Ivan" && u.department_code === "ITSO");
    if (!ivan) return null;
    return capItsoChainsToSecondHigher(
      users
        .filter((u) => u.department_code === "ITSO" && u.id !== ivan.id)
        .map((u) => [u.name, ivan.name])
    , testCase);
  }
  if (testCase.id === 9) {
    const cara = users.find((u) => u.name === "Cara" && u.department_code === "ITSO");
    const ivan = users.find((u) => u.name === "Ivan" && u.department_code === "ITSO");
    const ingrid = users.find((u) => u.name === "Ingrid" && u.department_code === "ITSO");
    if (cara && ivan && ingrid) {
      return capItsoChainsToSecondHigher(
        itsoCase9ExpandToCoHeads([[cara.name, ivan.name], [cara.name, ingrid.name]], users)
      , testCase);
    }
    if (cara && ivan) {
      return capItsoChainsToSecondHigher(itsoCase9ExpandToCoHeads([[cara.name, ivan.name]], users), testCase);
    }
    if (cara && ingrid) {
      return capItsoChainsToSecondHigher(itsoCase9ExpandToCoHeads([[cara.name, ingrid.name]], users), testCase);
    }
  }
  if (testCase.id === 3) {
    const sel = itsoCasesPartialSelection(users, testCase);
    if (!sel || sel.managerId == null) return null;
    const manager = users.find((u) => u.id === sel.managerId);
    const leaveCover = users.find((u) => u.id === sel.leaveCoverId);
    const reviewCover = users.find((u) => u.id === sel.reviewCoverId);
    const cover = sel.mode === "review" ? reviewCover : leaveCover;
    const secondLevel = manager && manager.manager_name ? users.find((u) => u.name === manager.manager_name) : null;
    const requester = manager ? users.find((u) => u.manager_name === manager.name) || manager : null;
    if (requester && cover && secondLevel) return capItsoChainsToSecondHigher([[requester.name, cover.name, secondLevel.name]], testCase);
    if (requester && cover) return capItsoChainsToSecondHigher([[requester.name, cover.name]], testCase);
  }
  if (testCase.target && testCase.target.length) return capItsoChainsToSecondHigher(testCase.target, testCase);
  return capItsoChainsToSecondHigher(thirtyCasesFocusChain(users, itsoCasesFocusId(users, testCase)), testCase);
}

function itsoCase9ExpandToCoHeads(chains, users) {
  if (!Array.isArray(chains)) return chains;
  const ivan = users.find((u) => u.name === "Ivan" && u.department_code === "ITSO");
  const ingrid = users.find((u) => u.name === "Ingrid" && u.department_code === "ITSO");
  const coHeads = [ivan, ingrid].filter(Boolean).map((u) => u.name);
  if (!coHeads.length) return chains;

  const expanded = [];
  const seen = new Set();
  const addUnique = (chain) => {
    if (!Array.isArray(chain) || !chain.length) return;
    const key = chain.join("|");
    if (seen.has(key)) return;
    seen.add(key);
    expanded.push(chain);
  };

  chains.forEach((chain) => {
    if (!Array.isArray(chain) || !chain.length) return;
    const headIdx = chain.findIndex((name) => coHeads.includes(name));
    if (headIdx === -1) {
      addUnique(chain);
      return;
    }
    coHeads.forEach((headName) => {
      addUnique([...chain.slice(0, headIdx), headName]);
    });
  });

  return expanded;
}

function itsoCasesFocusedChain(users, testCase, focusId) {
  if (focusId == null) return null;
  const base = thirtyCasesFocusChain(users, focusId);
  if (!Array.isArray(base) || !base.length || !testCase) {
    return capItsoChainsToSecondHigher(base, testCase);
  }

  if (testCase.id === 19) {
    const person = users.find((u) => u.id === focusId);
    const future = users.find((u) => u.name === "Boris [ITSO ➜ HRO]");
    const boris = users.find((u) => u.name === "Boris" && u.department_code === "ITSO");
    const iris = users.find((u) => u.name === "Iris" && u.department_code === "ITSO");
    const isaac = users.find((u) => u.name === "Isaac" && u.department_code === "ITSO");
    if (person?.name === "Boris [ITSO ➜ HRO]" && future) {
      return capItsoChainsToSecondHigher(thirtyCasesFocusChain(users, future.id), testCase);
    }
    if (person?.name === "Boris" && boris && iris && isaac) {
      return [[boris.name, iris.name, isaac.name]];
    }
  }

  if (testCase.id === 22) {
    const person = users.find((u) => u.id === focusId);
    const dana = users.find((u) => u.name === "Dana" && u.department_code === "ITSO");
    const cleo = users.find((u) => u.name === "Cleo" && u.department_code === "ITSO");
    const cyrus = users.find((u) => u.name === "Cyrus" && u.department_code === "ITSO");
    const igor = users.find((u) => u.name === "Igor" && u.department_code === "ITSO");
    const isaac = users.find((u) => u.name === "Isaac" && u.department_code === "ITSO");
    if (
      person?.name === "Dana" &&
      dana && cleo && cyrus && igor && isaac
    ) {
      const route = itsoCase22PathMode === "secondary"
        ? [[dana.name, igor.name, isaac.name]]
        : [[dana.name, cleo.name, cyrus.name]];
      return capItsoChainsToSecondHigher(
        route,
        testCase
      );
    }
  }

  if (testCase.id === 15) {
    const person = users.find((u) => u.id === focusId);
    const ivan = users.find((u) => u.name === "Ivan" && u.department_code === "ITSO");
    if (!person || !ivan || person.id === ivan.id) return capItsoChainsToSecondHigher(base, testCase);
    return [[person.name, ivan.name]];
  }

  if (testCase.id === 9) {
    return capItsoChainsToSecondHigher(itsoCase9ExpandToCoHeads(base, users), testCase);
  }

  if (testCase.id !== 3) {
    return capItsoChainsToSecondHigher(base, testCase);
  }

  const sel = itsoCasesPartialSelection(users, testCase);
  if (!sel || sel.managerId == null) return capItsoChainsToSecondHigher(base, testCase);

  const manager = users.find((u) => u.id === sel.managerId);
  const leaveCover = users.find((u) => u.id === sel.leaveCoverId);
  const reviewCover = users.find((u) => u.id === sel.reviewCoverId);
  const cover = sel.mode === "review" ? reviewCover : leaveCover;
  if (!manager || !cover) return capItsoChainsToSecondHigher(base, testCase);

  const adjusted = base.map((chain) => {
    if (!Array.isArray(chain) || !chain.length) return chain;
    const idx = chain.indexOf(manager.name);
    if (idx === -1) return chain;
    return [...chain.slice(0, idx), cover.name, ...chain.slice(idx + 1)];
  });

  return capItsoChainsToSecondHigher(adjusted, testCase);
}

function capItsoChainsToSecondHigher(chains, testCase) {
  if (!Array.isArray(chains)) return chains;
  const cap = testCase && testCase.id === 21 ? 4 : 3;
  return chains
    .filter((chain) => Array.isArray(chain) && chain.length)
    .map((chain) => chain.slice(0, cap));
}

function selectItsoCase(id) {
  itsoCasesSelected = id;
  try {
    localStorage.setItem(ITSO_CASE_SELECTED_KEY, String(id));
  } catch (e) {
    // Ignore storage errors in restricted contexts.
  }
  itsoCasesFocusOverride = null;
  itsoCasesPartialManagerId = null;
  itsoCasesPartialLeaveCoverId = null;
  itsoCasesPartialReviewCoverId = null;
  itsoCasesPartialMode = "leave";
  itsoCase8PathMode = "both";
  itsoCase22PathMode = "primary";
  itsoCase20ViewMode = "historical";
  syncItsoCaseRadioSelection();
  updateItsoCasesReviewNav();
  updateItsoCasesDetail();
  renderItsoCasesDiagram();
}

function updateItsoCasesDetail() {
  const tc = ITSO_CASES.find((c) => c.id === itsoCasesSelected);
  const titleEl = document.getElementById("itso-cases-title");
  const scenarioEl = document.getElementById("itso-cases-scenario");
  const methodEl = document.getElementById("itso-cases-method");
  const partialWrap = document.getElementById("itso-cases-partial-controls");
  if (!titleEl || !scenarioEl || !methodEl) return;
  if (!tc) {
    titleEl.textContent = "Select an ITSO case";
    scenarioEl.textContent = "Pick a case on the left to bold its ITSO-only target reporting line.";
    methodEl.textContent = "";
    if (partialWrap) partialWrap.classList.add("hidden");
    return;
  }
  if (partialWrap) partialWrap.classList.toggle("hidden", tc.id !== 3);
  const users = itsoCasesUsers(tc);
  const nodeNames = users.map((u) => u.name);
  const fmtNodeText = (text) => italicizeNodeNames(text, nodeNames);
  titleEl.textContent = `${tc.id}. ${tc.title} — ${tc.category}`;
  const justificationText = ITSO_CASES_JUSTIFICATION[tc.id];
  const party = ITSO_CASE_SECOND_PARTY[tc.id];
  const partyText = party && party.includeHro
    ? "<div class=\"itso-note-card\"><span class=\"itso-note-title\">Cross-party context</span><p>ITSO + HRO are shown together for this case.</p></div>"
    : "";
  const caseStudyHtml = `<p class="itso-case-main">${fmtNodeText(tc.scenario)}</p>`;
  const level = caseChangeLevel(tc.id);
  const levelBadge = `<div class="itso-case-meta"><span class="thirty-case-level ${level.className}">${escHtml(level.label)}</span></div>`;
  const intentionBlock = `
    <div class="itso-desc-section itso-intention-section">
      <h4>Intention</h4>
      <div class="itso-case-intention">${fmtNodeText(caseIntentionDetail(tc.id))}</div>
    </div>
  `;
  const case20ControlsHtml = tc.id === 20
    ? `
      <div class="itso-case20-controls" id="itso-case20-controls">
        <span class="itso-case20-controls-title">Case 20 view:</span>
        <label><input type="radio" name="itso-case20-mode" value="historical" ${itsoCase20ViewMode === "historical" ? "checked" : ""}> Approved history</label>
        <label><input type="radio" name="itso-case20-mode" value="counterfactual" ${itsoCase20ViewMode === "counterfactual" ? "checked" : ""}> Counterfactual recalculation</label>
        <label><input type="radio" name="itso-case20-mode" value="both" ${itsoCase20ViewMode === "both" ? "checked" : ""}> Show both</label>
      </div>
    `
    : "";
  const justificationHtml = justificationText && typeof justificationText === "object"
    ? `
      <ul class="itso-just-points">
        <li><span>What changed</span><p>${fmtNodeText(justificationText.changes || "")}</p></li>
        <li><span>Why we applied it</span><p>${fmtNodeText(justificationText.why || "")}</p></li>
      </ul>
    `
    : `<div class="itso-note-card"><span class="itso-note-title">Justification</span><p>${fmtNodeText(justificationText || "No case-specific justification is defined yet.")}</p></div>`;
  scenarioEl.innerHTML = `
    ${levelBadge}
    <div class="itso-desc-section itso-description-section">
      <h4>Description</h4>
      ${caseStudyHtml}
      ${partyText ? `<div class="itso-note-grid">${partyText}</div>` : ""}
    </div>
    ${intentionBlock}
    <div class="itso-desc-section itso-route-section">
      <h4>Route and Rules</h4>
      ${case20ControlsHtml}
    </div>
    <div class="itso-desc-section itso-justification-section">
      <h4>Case-Specific Justification</h4>
      ${justificationHtml}
    </div>
  `;
  if (tc.id === 20) {
    scenarioEl.querySelectorAll('input[name="itso-case20-mode"]').forEach((input) => {
      input.addEventListener("change", () => {
        itsoCase20ViewMode = input.value;
        renderItsoCasesDiagram();
        updateItsoCasesDetail();
      });
    });
  }
  let line = "";
  if (itsoCasesFocusOverride != null) {
    const person = users.find((u) => u.id === itsoCasesFocusOverride);
    const chain = itsoCasesFocusedChain(users, tc, itsoCasesFocusOverride);
    line = chain
      ? `Selected chain for ${person ? person.name : "?"}: ${chain.map((c) => c.join(" → ")).join("  •  ")}`
      : `${person ? person.name : "Selected user"} has no manager path in this ITSO variant.`;
  } else {
    if (tc.id === 3) {
      line = "Default view: no approval path shown. Click a person to inspect the selected duty path.";
    } else {
    const case20Bundle = tc.id === 20 ? itsoCase20ChainBundle(users, tc) : null;
    const chainRaw = tc.id === 20
      ? (case20Bundle ? case20Bundle.primary : itsoCasesTargetChain(users, tc))
      : (tc.id === 8
        ? itsoCase8DisplayedChains(tc)
        : (tc.id === 22
          ? itsoCase22DisplayedChains(tc)
          : itsoCasesTargetChain(users, tc)));
    const chain = capItsoChainsToSecondHigher(chainRaw, tc);
    const modeText = tc.id === 3
      ? `Partial view: ${itsoCasesPartialMode === "review" ? "Review duty" : "Leave duty"}. `
      : (tc.id === 20
        ? `Timeline view: ${itsoCase20ViewMode}. `
      : (tc.id === 8
        ? `Route view: ${itsoCase8PathMode}. `
        : (tc.id === 22
          ? `Route view: ${itsoCase22PathMode}. `
        : "")));
    line = chain
      ? `${modeText}ITSO target line: ${chain.map((c) => c.join(" → ")).join("  •  ")}`
      : "ITSO target line: none — assignment inactive, workflow suspended.";
    if (tc.id === 20 && case20Bundle) {
      line += `  •  Historical: ${case20Bundle.historical.map((c) => c.join(" → ")).join("  •  ") || "n/a"}`;
      line += `  •  Counterfactual: ${case20Bundle.counterfactual.map((c) => c.join(" → ")).join("  •  ") || "n/a"}`;
      line += "  •  Policy: completed approvals stay locked; mismatch is audit-only.";
    }
    }
  }
  if (tc.id === 0 && itsoCasesFocusOverride == null) {
    line = "Overall baseline view: no case policy is applied; chart shows default reporting structure.";
  }
  if (tc.id === 10 && itsoCasesFocusOverride == null) {
    line += "  •  Operational approver: Isaac (on behalf of Ivan). Authority context: Ivan delegates approval authority to Isaac.";
  }
  methodEl.innerHTML = `
    <div class="itso-route-card">
      <span class="itso-note-title">${itsoCasesFocusOverride != null ? "Selected route" : "Default route"}</span>
      <p>${fmtNodeText(line)}</p>
    </div>
  `;

  const routeSection = scenarioEl.querySelector(".itso-route-section");
  if (routeSection) {
    if (partialWrap) routeSection.appendChild(partialWrap);
    routeSection.appendChild(methodEl);
  }

  renderItsoCasesPartialControls(tc);
}

// ---------------------------------------------------------------------------
// Initial load
// ---------------------------------------------------------------------------
loadBootstrap();

