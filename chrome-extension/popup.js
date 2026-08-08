const trackingInput = document.getElementById("tracking-codes");
const startBtn = document.getElementById("start-btn");
const stopBtn = document.getElementById("stop-btn");
const clearInputBtn = document.getElementById("clear-input-btn");
const clearResultsBtn = document.getElementById("clear-results-btn");
const downloadBtn = document.getElementById("download-btn");
const copyAllBtn = document.getElementById("copy-all-btn");
const openWorkspaceBtn = document.getElementById("open-workspace-btn");
const stateBadge = document.getElementById("state-badge");
const progressLabel = document.getElementById("progress-label");
const progressBar = document.getElementById("progress-bar");
const rowCount = document.getElementById("row-count");
const message = document.getElementById("message");
const resultsBody = document.getElementById("results-body");

let pollTimer = null;
let latestResults = [];

async function copyText(text, successMessage = "Copied to clipboard.") {
  if (!text) {
    alert("Nothing to copy.");
    return;
  }

  await navigator.clipboard.writeText(text);
  message.textContent = successMessage;
}

function parseTrackingCodes() {
  return trackingInput.value
    .split("\n")
    .map((code) => code.trim())
    .filter(Boolean);
}

function setControls(isRunning) {
  startBtn.disabled = isRunning;
  clearInputBtn.disabled = isRunning;
  clearResultsBtn.disabled = isRunning;
  stopBtn.disabled = !isRunning;
}

function renderState(state) {
  const isRunning = state.status === "running";
  const completed = state.completed || 0;
  const total = state.total || 0;
  const percent = total === 0 ? 0 : Math.round((completed / total) * 100);

  latestResults = state.results || [];
  stateBadge.textContent = isRunning ? "Running" : "Ready";
  progressLabel.textContent = `${percent}%`;
  progressBar.value = percent;
  rowCount.textContent = String(latestResults.length);
  message.textContent = state.message || "Ready";
  setControls(isRunning);

  resultsBody.innerHTML = "";
  for (const row of latestResults) {
    const tr = document.createElement("tr");
    for (const value of row.slice(0, 8)) {
      const td = document.createElement("td");
      td.textContent = value || "";
      tr.appendChild(td);
    }
    const actionTd = document.createElement("td");
    const copyButton = document.createElement("button");
    copyButton.className = "row-copy-btn";
    copyButton.type = "button";
    copyButton.title = "Copy Row";
    copyButton.setAttribute("aria-label", "Copy Row");
    copyButton.innerHTML = `
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <rect x="9" y="9" width="10" height="10" rx="2"></rect>
        <path d="M5 15V7a2 2 0 0 1 2-2h8"></path>
      </svg>
    `;
    copyButton.addEventListener("click", () => {
      copyText(row.slice(0, 8).join("\t"), "Row copied.");
    });
    actionTd.appendChild(copyButton);
    tr.appendChild(actionTd);
    resultsBody.appendChild(tr);
  }
}

function rowsToTsv(rows) {
  return rows.map((row) => row.slice(0, 8).join("\t")).join("\n");
}

function requestState() {
  chrome.runtime.sendMessage({ type: "GET_STATE" }, (state) => {
    if (chrome.runtime.lastError) return;
    renderState(state);
  });
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(requestState, 1000);
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

function downloadCsv() {
  if (latestResults.length === 0) {
    alert("No tracking results to download.");
    return;
  }

  const csv = latestResults
    .map((row) => row.map((cell) => `"${String(cell || "").replaceAll('"', '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "usps_tracking_results.csv";
  link.click();
  URL.revokeObjectURL(url);
}

async function openWorkspace(codesText = "", autoStart = false) {
  const url = chrome.runtime.getURL("workspace.html");
  const tabs = await chrome.tabs.query({ url });

  if (codesText) {
    await chrome.storage.local.set({
      workspaceTrackingCodes: codesText,
      workspaceAutoStart: autoStart,
    });
  }

  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    if (codesText) {
      try {
        await chrome.tabs.sendMessage(tabs[0].id, {
          type: "LOAD_WORKSPACE_CODES",
          codesText,
          autoStart,
        });
      } catch (error) {
        // The workspace may still be loading; stored values will be picked up on load.
      }
    }
    return;
  }

  await chrome.tabs.create({ url, active: true });
}

startBtn.addEventListener("click", async () => {
  const trackingCodes = parseTrackingCodes();
  if (trackingCodes.length === 0) {
    alert("Please enter at least one USPS tracking code.");
    return;
  }

  await openWorkspace(trackingCodes.join("\n"), true);
});

stopBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "STOP_TRACKING" }, requestState);
});

clearInputBtn.addEventListener("click", () => {
  trackingInput.value = "";
  trackingInput.focus();
});

clearResultsBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CLEAR_RESULTS" }, requestState);
});

downloadBtn.addEventListener("click", downloadCsv);
copyAllBtn.addEventListener("click", () => {
  copyText(rowsToTsv(latestResults), "All rows copied. Paste directly into Excel.");
});

openWorkspaceBtn.addEventListener("click", async () => {
  const trackingCodes = parseTrackingCodes();
  await openWorkspace(trackingCodes.join("\n"), false);
});

requestState();
startPolling();
