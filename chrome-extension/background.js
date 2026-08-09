const state = {
  status: "idle",
  queue: [],
  completed: 0,
  total: 0,
  results: [],
  message: "Ready",
  activeTabId: null,
  stopRequested: false,
};

const FALLBACK_BATCH_SIZES = [10, 5, 1];
const AFTER_FILL_DELAY_MS = 2500;
const AFTER_SUBMIT_DELAY_MS = 6500;

function isBlockingError(error) {
  return /Access Denied|permission to access|errors\.edgesuite\.net|temporarily unavailable/i
    .test(error?.message || "");
}

function chunkList(list, size) {
  const chunks = [];
  for (let i = 0; i < list.length; i += size) {
    chunks.push(list.slice(i, i + size));
  }
  return chunks;
}

function isUpsTrackingNumber(trackingNumber) {
  return /^1Z/i.test(trackingNumber);
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

function uspsLandingUrl() {
  return "https://www.usps.com/";
}

function trackingHomeUrl() {
  return "https://tools.usps.com/tracking/";
}

async function waitForTabLoaded(tabId) {
  return new Promise((resolve) => {
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureTab() {
  if (state.activeTabId) {
    try {
      await chrome.tabs.get(state.activeTabId);
      return state.activeTabId;
    } catch (error) {
      state.activeTabId = null;
    }
  }

  const tab = await chrome.tabs.create({
    active: false,
    url: "about:blank",
  });
  state.activeTabId = tab.id;
  return tab.id;
}

async function extractRowsFromTab(tabId, trackingCodes) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });

  for (let attempt = 0; attempt < 60; attempt++) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        count: document.querySelectorAll(".track-bar-container, .tracking-number").length,
        bodyText: document.body?.innerText?.slice(0, 500) || "",
      }),
    });

    const bodyText = result.bodyText || "";
    if (/400|Bad Request|Access Denied|temporarily unavailable/i.test(bodyText)) {
      throw new Error(bodyText.replace(/\s+/g, " ").slice(0, 160));
    }

    if (result.count > 0) {
      return chrome.tabs.sendMessage(tabId, {
        type: "EXTRACT_USPS_ROWS",
        trackingCodes,
      });
    }
    await wait(1000);
  }

  throw new Error("Timed out waiting 60 seconds for USPS tracking results after submit.");
}

async function processBatch(batch) {
  const tabId = await ensureTab();
  const landingLoadPromise = waitForTabLoaded(tabId);
  await chrome.tabs.update(tabId, {
    active: false,
    url: uspsLandingUrl(),
  });
  await landingLoadPromise;
  await wait(1500);

  const trackLoadPromise = waitForTabLoaded(tabId);
  const [{ result: quickToolsResult }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
      const clickElement = (element) => {
        element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        element.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
        element.click();
      };

      const quickToolsElement = Array.from(document.querySelectorAll("a, button"))
        .find((element) => /quick\s*tools/i.test(normalize(element.innerText || element.getAttribute("aria-label"))));
      if (quickToolsElement) {
        clickElement(quickToolsElement);
      }

      const trackLink = Array.from(document.querySelectorAll("a, button"))
        .find((element) => {
          const text = normalize(element.innerText || element.value || element.getAttribute("aria-label"));
          const href = element.href || element.getAttribute("href") || "";
          return /track\s+a\s+package|tracking/i.test(text)
            || /TrackConfirmAction|tools\.usps\.com\/tracking/i.test(href);
        });

      if (!trackLink) {
        return { ok: false };
      }

      clickElement(trackLink);
      return { ok: true };
    },
  });

  if (quickToolsResult?.ok) {
    await trackLoadPromise;
  } else {
    const fallbackLoadPromise = waitForTabLoaded(tabId);
    await chrome.tabs.update(tabId, {
      active: false,
      url: trackingHomeUrl(),
    });
    await fallbackLoadPromise;
  }
  await wait(1200);

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (trackingCodes, fillDelayMs) => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
      const selectors = [
        "textarea[name='tLabels']",
        "input[name='tLabels']",
        "#tLabels",
        "#tracking-input",
        "#tracking-input-search",
        "textarea",
        "input[type='text']",
        "input[type='search']",
      ];
      const input = selectors
        .map((selector) => document.querySelector(selector))
        .find((element) => element && !element.disabled && element.offsetParent !== null);

      if (!input) {
        return { ok: false, reason: "Could not find USPS tracking input." };
      }

      input.scrollIntoView({ behavior: "smooth", block: "center" });
      await wait(800);
      input.focus();
      await wait(400);
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await wait(300);
      input.value = trackingCodes.join(",");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await wait(fillDelayMs);

      const normalizedInputValue = normalize(input.value);
      if (!normalizedInputValue.includes(trackingCodes[0]) || !normalizedInputValue.includes(trackingCodes[trackingCodes.length - 1])) {
        return { ok: false, reason: "USPS tracking input did not keep the filled tracking codes." };
      }

      const submitButton = Array.from(document.querySelectorAll("button, input[type='submit']"))
        .find((element) => (
          element.offsetParent !== null
          && !element.disabled
          && /track|submit/i.test(element.innerText || element.value || element.getAttribute("aria-label") || "")
        ));
      if (submitButton) {
        await wait(1000);
        submitButton.click();
        return { ok: true };
      }

      await wait(1000);
      input.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
        code: "Enter",
      }));
      input.dispatchEvent(new KeyboardEvent("keyup", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
        code: "Enter",
      }));

      return { ok: true };
    },
    args: [batch, AFTER_FILL_DELAY_MS],
  });

  if (!result?.ok) {
    throw new Error(result?.reason || "Could not submit USPS tracking form.");
  }

  await wait(AFTER_SUBMIT_DELAY_MS);

  const response = await extractRowsFromTab(tabId, batch);
  return response.rows || [];
}

async function processBatchWithFallback(batch, fallbackSizes = FALLBACK_BATCH_SIZES) {
  try {
    return await processBatch(batch);
  } catch (error) {
    if (batch.length === 1) {
      return [[
        batch[0],
        "US",
        "",
        "",
        "Error",
        "",
        "",
        error.message,
      ]];
    }

    const nextSize = fallbackSizes.find((size) => size < batch.length) || 1;
    state.message = `Batch of ${batch.length} failed. Retrying in groups of ${nextSize}...`;

    const rows = [];
    for (const subBatch of chunkList(batch, nextSize)) {
      if (state.stopRequested) break;
      rows.push(...await processBatchWithFallback(
        subBatch,
        fallbackSizes.filter((size) => size < nextSize),
      ));
    }
    return rows;
  }
}

async function runQueue() {
  state.status = "running";
  state.completed = 0;
  state.message = "Starting tracking queue...";

  while (state.queue.length > 0 && !state.stopRequested) {
    const batch = state.queue.shift();
    state.message = `Processing batch ${state.completed + 1}/${state.total} (${batch.length} code(s))...`;

    try {
      const rows = await processBatchWithFallback(batch);
      state.results.push(...rows);
    } catch (error) {
      if (isBlockingError(error)) {
        throw error;
      }
      state.results.push(...batch.map((trackingNumber) => [
        trackingNumber,
        "US",
        "",
        "",
        "Error",
        "",
        "",
        error.message,
      ]));
    }

    state.completed += 1;
  }

  state.status = "idle";
  state.message = state.stopRequested ? "Stopped" : "Complete";
  state.stopRequested = false;
}

function startTracking(trackingCodes, batchSize) {
  const uspsCodes = [];
  const unsupportedRows = [];

  for (const trackingCode of trackingCodes) {
    if (isUpsTrackingNumber(trackingCode)) {
      unsupportedRows.push(unsupportedCarrierRow(trackingCode));
    } else {
      uspsCodes.push(trackingCode);
    }
  }

  state.queue = chunkList(uspsCodes, batchSize || 30);
  state.total = state.queue.length;
  state.completed = 0;
  state.results = unsupportedRows;
  state.stopRequested = false;
  state.message = state.total === 0 ? "No USPS tracking codes to process." : "Queued";

  if (state.total > 0) {
    runQueue();
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_STATE") {
    sendResponse({ ...state });
    return false;
  }

  if (message.type === "START_TRACKING") {
    if (state.status === "running") {
      sendResponse({ ...state, message: "A tracking job is already running." });
      return false;
    }

    startTracking(message.trackingCodes || [], message.batchSize || 30);
    sendResponse({ ...state });
    return false;
  }

  if (message.type === "STOP_TRACKING") {
    state.stopRequested = true;
    state.message = "Stopping after current batch...";
    sendResponse({ ...state });
    return false;
  }

  if (message.type === "CLEAR_RESULTS") {
    if (state.status !== "running") {
      state.results = [];
      state.completed = 0;
      state.total = 0;
      state.queue = [];
      state.message = "Ready";
    }
    sendResponse({ ...state });
    return false;
  }

  return false;
});
