const BROWSER_BATCH_SIZE = 10;
const WORKER_COUNT = 3;
const BATCH_TIMEOUT_MS = 30000;
const BETWEEN_WORKER_BATCH_DELAY_MIN_MS = 750;
const BETWEEN_WORKER_BATCH_DELAY_MAX_MS = 1800;

const trackingInput = document.getElementById("tracking-codes");
const startBtn = document.getElementById("start-btn");
const stopBtn = document.getElementById("stop-btn");
const clearInputBtn = document.getElementById("clear-input-btn");
const clearResultsBtn = document.getElementById("clear-results-btn");
const downloadBtn = document.getElementById("download-btn");
const copyAllBtn = document.getElementById("copy-all-btn");
const copyColumnBtns = document.querySelectorAll(".copy-column-btn");
const stateBadge = document.getElementById("state-badge");
const progressLabel = document.getElementById("progress-label");
const progressBar = document.getElementById("progress-bar");
const rowCount = document.getElementById("row-count");
const batchLabel = document.getElementById("batch-label");
const message = document.getElementById("message");
const resultsBody = document.getElementById("results-body");

let isRunning = false;
let stopRequested = false;
let results = [];
let completed = 0;
let total = 0;
let completedBatches = 0;
let totalBatches = 0;
let orderedEntries = [];
let resultSlots = [];
let workerTabIds = new Map();

async function copyText(text, successMessage = "Copied to clipboard.") {
  if (!text) {
    alert("Nothing to copy.");
    return;
  }

  await navigator.clipboard.writeText(text);
  message.textContent = successMessage;
}

function chunkList(list, size) {
  const chunks = [];
  for (let i = 0; i < list.length; i += size) {
    chunks.push(list.slice(i, i + size));
  }
  return chunks;
}

function parseTrackingCodes() {
  return trackingInput.value
    .split("\n")
    .map((code) => code.trim())
    .filter(Boolean);
}

function isUpsTrackingNumber(trackingNumber) {
  return /^1Z/i.test(trackingNumber);
}

function trackingUrl(trackingCodes) {
  const params = new URLSearchParams({ tLabels: trackingCodes.join(",") });
  return `https://tools.usps.com/go/TrackConfirmAction.action?${params.toString()}`;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function remainingMs(deadline) {
  return Math.max(0, deadline - Date.now());
}

async function waitOrStop(ms) {
  const intervalMs = 250;
  const startedAt = Date.now();
  while (Date.now() - startedAt < ms) {
    if (stopRequested) {
      throw new Error("Stopped by user.");
    }
    await wait(Math.min(intervalMs, ms - (Date.now() - startedAt)));
  }
}

function randomDelay(minMs, maxMs) {
  return minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
}

function waitForTabLoaded(tabId, deadline) {
  return new Promise((resolve) => {
    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearInterval(intervalId);
    };
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        cleanup();
        resolve(true);
      }
    };
    const intervalId = setInterval(() => {
      if (stopRequested || remainingMs(deadline) <= 0) {
        cleanup();
        resolve(false);
      }
    }, 250);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function ensureWorkerTab(workerId) {
  const existingTabId = workerTabIds.get(workerId);
  if (existingTabId) {
    try {
      await chrome.tabs.get(existingTabId);
      return existingTabId;
    } catch (error) {
      workerTabIds.delete(workerId);
    }
  }

  const tab = await chrome.tabs.create({
    active: false,
    url: "about:blank",
  });
  workerTabIds.set(workerId, tab.id);
  return tab.id;
}

async function closeWorkerTabs() {
  const tabIds = Array.from(workerTabIds.values());
  workerTabIds = new Map();

  for (const tabId of tabIds) {
    try {
      await chrome.tabs.remove(tabId);
    } catch (error) {
      // The user may have closed the worker tab manually.
    }
  }
}

async function extractRowsFromTab(tabId, trackingCodes, deadline) {
  let lastBodyText = "";

  while (remainingMs(deadline) > 0) {
    if (stopRequested) {
      throw new Error("Stopped by user.");
    }

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      });

      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => ({
          count: document.querySelectorAll(".track-bar-container, .tracking-number").length,
          bodyText: document.body?.innerText?.slice(0, 800) || "",
        }),
      });

      lastBodyText = result.bodyText || "";
      if (/400|Bad Request|Access Denied|temporarily unavailable/i.test(lastBodyText)) {
        throw new Error(lastBodyText.replace(/\s+/g, " ").slice(0, 160));
      }

      if (result.count > 0) {
        const response = await chrome.tabs.sendMessage(tabId, {
          type: "EXTRACT_USPS_ROWS",
          trackingCodes,
        });
        return response.rows || [];
      }
    } catch (error) {
      if (/400|Bad Request|Access Denied|temporarily unavailable/i.test(error.message)) {
        throw error;
      }
    }

    await waitOrStop(Math.min(750, remainingMs(deadline)));
  }

  const detail = lastBodyText.replace(/\s+/g, " ").slice(0, 120);
  throw new Error(detail || "USPS did not return tracking results within 30 seconds.");
}

async function processBatch(workerId, batchEntries) {
  if (stopRequested) {
    throw new Error("Stopped by user.");
  }

  const deadline = Date.now() + BATCH_TIMEOUT_MS;
  const trackingCodes = batchEntries.map((entry) => entry.code);
  const tabId = await ensureWorkerTab(workerId);

  await chrome.tabs.update(tabId, {
    active: false,
    url: trackingUrl(trackingCodes),
  });

  await waitForTabLoaded(tabId, deadline);
  if (stopRequested) {
    throw new Error("Stopped by user.");
  }

  await waitOrStop(Math.min(1500, remainingMs(deadline)));
  return extractRowsFromTab(tabId, trackingCodes, deadline);
}

function unsupportedCarrierRow(trackingNumber) {
  return [
    trackingNumber,
    "",
    "",
    "",
    "Unsupported carrier",
    "",
    "",
    "This appears to be a UPS tracking number. This extension currently supports USPS tracking numbers only.",
  ];
}

function notTrackedRow(trackingNumber, detail = "USPS did not return this tracking code within 30 seconds.") {
  return [
    trackingNumber,
    "US",
    "",
    "",
    "Not tracked",
    "",
    "",
    detail,
  ];
}

function normalizeReturnedRow(row) {
  if (row[4] === "No USPS result found") {
    return notTrackedRow(row[0], "USPS did not render a tracking result block for this code.");
  }
  return row;
}

function setRowsForEntries(batchEntries, returnedRows, fallbackDetail) {
  const usedRowIndexes = new Set();

  for (const entry of batchEntries) {
    const rowIndex = returnedRows.findIndex((row, index) => (
      !usedRowIndexes.has(index) && row[0] === entry.code
    ));
    if (rowIndex >= 0) {
      usedRowIndexes.add(rowIndex);
      resultSlots[entry.index] = normalizeReturnedRow(returnedRows[rowIndex]);
    } else {
      resultSlots[entry.index] = notTrackedRow(entry.code, fallbackDetail);
    }
  }

  results = resultSlots.filter(Boolean);
  completed = results.length;
}

function setControls() {
  startBtn.disabled = isRunning;
  clearInputBtn.disabled = isRunning;
  clearResultsBtn.disabled = isRunning;
  stopBtn.disabled = !isRunning;
}

function render() {
  const percent = total === 0 ? 0 : Math.round((completed / total) * 100);
  stateBadge.textContent = isRunning ? "Running" : "Ready";
  progressLabel.textContent = `${percent}%`;
  progressBar.value = percent;
  rowCount.textContent = String(results.length);
  batchLabel.textContent = total === 0 ? "Ready" : `${completed}/${total}`;
  setControls();

  resultsBody.innerHTML = "";
  for (const row of results) {
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

function columnToText(columnIndex) {
  return results.map((row) => row[columnIndex] || "").join("\n");
}

function downloadCsv() {
  if (results.length === 0) {
    alert("No tracking results to download.");
    return;
  }

  const csv = results
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

async function runWorker(workerId, queue, nextBatchRef) {
  while (!stopRequested) {
    const batchIndex = nextBatchRef.value;
    nextBatchRef.value += 1;

    if (batchIndex >= queue.length) {
      return;
    }

    const batch = queue[batchIndex];
    message.textContent = `Worker ${workerId + 1}/${WORKER_COUNT} processing batch ${batchIndex + 1}/${totalBatches} (${batch.length} code(s))...`;
    render();

    try {
      const rows = await processBatch(workerId, batch);
      setRowsForEntries(batch, rows, "USPS did not return this tracking code in the batch response.");
    } catch (error) {
      if (stopRequested || error.message === "Stopped by user.") {
        return;
      }
      setRowsForEntries(batch, [], error.message || "USPS did not return tracking results within 30 seconds.");
    }

    completedBatches += 1;
    message.textContent = `Completed ${completedBatches}/${totalBatches} batch(es).`;
    render();

    if (!stopRequested && nextBatchRef.value < queue.length) {
      await waitOrStop(randomDelay(
        BETWEEN_WORKER_BATCH_DELAY_MIN_MS,
        BETWEEN_WORKER_BATCH_DELAY_MAX_MS,
      ));
    }
  }
}

async function runQueue() {
  const trackingCodes = parseTrackingCodes();
  if (trackingCodes.length === 0) {
    alert("Please enter at least one USPS tracking code.");
    return;
  }

  orderedEntries = trackingCodes.map((code, index) => ({ code, index }));
  resultSlots = Array(trackingCodes.length).fill(null);
  results = [];
  completed = 0;
  total = trackingCodes.length;
  completedBatches = 0;
  totalBatches = 0;
  stopRequested = false;

  const uspsEntries = [];
  for (const entry of orderedEntries) {
    if (isUpsTrackingNumber(entry.code)) {
      resultSlots[entry.index] = unsupportedCarrierRow(entry.code);
    } else {
      uspsEntries.push(entry);
    }
  }

  results = resultSlots.filter(Boolean);
  completed = results.length;
  const queue = chunkList(uspsEntries, BROWSER_BATCH_SIZE);
  totalBatches = queue.length;
  isRunning = totalBatches > 0;
  message.textContent = isRunning
    ? `Starting ${Math.min(WORKER_COUNT, totalBatches)} parallel worker(s)...`
    : "No USPS tracking codes to process.";
  render();

  if (!isRunning) {
    return;
  }

  const nextBatchRef = { value: 0 };
  const workers = Array.from(
    { length: Math.min(WORKER_COUNT, totalBatches) },
    (_, workerId) => runWorker(workerId, queue, nextBatchRef),
  );

  try {
    await Promise.all(workers);
  } finally {
    await closeWorkerTabs();
  }

  isRunning = false;
  message.textContent = stopRequested ? "Stopped" : "Complete";
  stopRequested = false;
  render();
}

startBtn.addEventListener("click", runQueue);
stopBtn.addEventListener("click", () => {
  stopRequested = true;
  message.textContent = "Stopping now. Keeping results collected so far...";
  render();
});
clearInputBtn.addEventListener("click", () => {
  trackingInput.value = "";
  trackingInput.focus();
});
clearResultsBtn.addEventListener("click", () => {
  if (isRunning) return;
  results = [];
  orderedEntries = [];
  resultSlots = [];
  completed = 0;
  total = 0;
  completedBatches = 0;
  totalBatches = 0;
  message.textContent = "Ready";
  render();
});
downloadBtn.addEventListener("click", downloadCsv);
copyAllBtn.addEventListener("click", () => {
  copyText(rowsToTsv(results), "All rows copied. Paste directly into Excel.");
});
for (const button of copyColumnBtns) {
  button.addEventListener("click", () => {
    const columnIndex = Number(button.dataset.column);
    copyText(columnToText(columnIndex), "Column copied. Paste directly into Excel.");
  });
}

async function loadPendingWorkspaceCodes() {
  const data = await chrome.storage.local.get([
    "workspaceTrackingCodes",
    "workspaceAutoStart",
  ]);

  if (!data.workspaceTrackingCodes) {
    render();
    return;
  }

  trackingInput.value = data.workspaceTrackingCodes;
  await chrome.storage.local.remove([
    "workspaceTrackingCodes",
    "workspaceAutoStart",
  ]);

  if (data.workspaceAutoStart && !isRunning) {
    runQueue();
    return;
  }

  render();
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type !== "LOAD_WORKSPACE_CODES") {
    return false;
  }

  if (typeof request.codesText === "string") {
    trackingInput.value = request.codesText;
  }
  if (request.autoStart && !isRunning) {
    setTimeout(runQueue, 0);
  } else {
    render();
  }
  sendResponse({ ok: true });
  return false;
});

loadPendingWorkspaceCodes();
