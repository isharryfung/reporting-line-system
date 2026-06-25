const testCaseContainer = document.querySelector("#test-cases");
const template = document.querySelector("#test-card-template");
const runAllButton = document.querySelector("#run-all");
const totalCount = document.querySelector("#total-count");
const passCount = document.querySelector("#pass-count");
const failCount = document.querySelector("#fail-count");

const resultState = new Map();

function setSummary() {
  const results = [...resultState.values()];
  totalCount.textContent = document.querySelectorAll(".test-card").length;
  passCount.textContent = results.filter(Boolean).length;
  failCount.textContent = results.filter((value) => value === false).length;
}

function renderActual(actual) {
  return JSON.stringify(actual, null, 2);
}

function updateCard(card, result) {
  const badge = card.querySelector(".status-badge");
  const output = card.querySelector(".actual-output");

  resultState.set(result.id, Boolean(result.passed));
  badge.textContent = result.passed ? "Pass" : "Fail";
  badge.classList.toggle("pass", result.passed);
  badge.classList.toggle("fail", !result.passed);
  output.textContent = renderActual(result);
  setSummary();
}

async function runCase(id, card) {
  const button = card.querySelector(".run-one");
  button.disabled = true;
  button.textContent = "Running...";
  try {
    const response = await fetch(`/api/test-cases/${encodeURIComponent(id)}/run`);
    const result = await response.json();
    updateCard(card, result);
  } catch (error) {
    updateCard(card, {
      id,
      passed: false,
      actual: { status: "frontend_error", error: String(error) },
    });
  } finally {
    button.disabled = false;
    button.textContent = "Run this case";
  }
}

function createCard(testCase) {
  const fragment = template.content.cloneNode(true);
  const card = fragment.querySelector(".test-card");

  card.dataset.testId = testCase.id;
  card.querySelector(".test-id").textContent = testCase.id;
  card.querySelector("h2").textContent = testCase.title;
  card.querySelector(".case-input").textContent = testCase.input;
  card.querySelector(".case-setup").textContent = testCase.setup;
  card.querySelector(".case-expected").textContent = testCase.expected_output;
  card.querySelector(".case-pass").textContent = testCase.pass_criteria;
  card.querySelector(".run-one").addEventListener("click", () => runCase(testCase.id, card));

  return card;
}

async function loadTestCases() {
  const response = await fetch("/api/test-cases");
  const payload = await response.json();
  testCaseContainer.replaceChildren(...payload.test_cases.map(createCard));
  setSummary();
}

async function runAll() {
  runAllButton.disabled = true;
  runAllButton.textContent = "Running all...";
  try {
    const response = await fetch("/api/run-all");
    const payload = await response.json();
    for (const result of payload.results) {
      const card = document.querySelector(`[data-test-id="${result.id}"]`);
      if (card) {
        updateCard(card, result);
      }
    }
  } finally {
    runAllButton.disabled = false;
    runAllButton.textContent = "Run all test cases";
  }
}

runAllButton.addEventListener("click", runAll);
loadTestCases();
