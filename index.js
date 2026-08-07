const express = require("express");
const puppeteer = require("puppeteer");
const path = require("path"); 
const { stringify } = require('csv-stringify');

const app = express();
app.use(express.json()); // Đảm bảo phân tích cú pháp JSON

app.use(express.static(path.join(__dirname, 'public')));

const USPS_TRACKING_URL = "https://tools.usps.com/go/TrackConfirmAction.action";
const USPS_API_BASE_URLS = {
  production: "https://apis.usps.com",
  test: "https://apis-tem.usps.com",
};
const USPS_MAX_TRACKING_PER_REQUEST = 35;
const PUPPETEER_HEADLESS = process.env.PUPPETEER_HEADLESS !== "false";

// Hàm chia danh sách thành các nhóm nhỏ hơn
function chunkList(lst, n) {
  const result = [];

  // Chia danh sách đã cập nhật thành các nhóm nhỏ hơn
  for (let i = 0; i < lst.length; i += n) {
    result.push(lst.slice(i, i + n));
  }
  
  return result;
}

function convertRowsToCsv(rows) {
  return new Promise((resolve, reject) => {
    stringify(rows, { delimiter: '\\' }, (err, output) => {
      if (err) reject(err);
      else resolve(output);
    });
  });
}

function normalizeApiEnvironment(environment) {
  return environment === "test" ? "test" : "production";
}

function buildApiErrorRows(trackingNumbers, status, message) {
  return trackingNumbers.map((trackingNumber) => [
    trackingNumber,
    "US",
    "",
    "",
    status,
    message,
  ]);
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    return { error: text };
  }
}

async function getUspsAccessToken({ clientId, clientSecret, environment }) {
  const baseUrl = USPS_API_BASE_URLS[environment];
  const response = await fetch(`${baseUrl}/oauth2/v3/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const data = await readJsonResponse(response);

  if (!response.ok) {
    const message = data?.error_description || data?.error || response.statusText;
    const error = new Error(`USPS OAuth failed: ${message}`);
    error.status = response.status;
    throw error;
  }

  if (!data?.access_token) {
    throw new Error("USPS OAuth response did not include an access token.");
  }

  return data.access_token;
}

function uspsApiItemToRow(item, fallbackTrackingNumber = "") {
  const latestEvent = Array.isArray(item?.trackingEvents) && item.trackingEvents.length > 0
    ? item.trackingEvents[0]
    : {};
  const locationParts = [
    latestEvent.eventCity,
    latestEvent.eventState,
    latestEvent.eventZIPCode,
  ].filter(Boolean);
  const location = locationParts.join(", ");
  const dateTime = latestEvent.eventTimestamp || latestEvent.GMTTimestamp || "";
  const status = item?.status || item?.statusCategory || latestEvent.eventType || "No status";
  const additionalInfo = [
    item?.statusSummary,
    item?.mailClass,
    item?.statusCategory,
  ].filter(Boolean).join(" | ");

  return [
    item?.trackingNumber || fallbackTrackingNumber,
    latestEvent.eventCountry || item?.destinationCountry || "US",
    location,
    dateTime,
    status,
    additionalInfo,
  ];
}

async function sendTrackingCodesViaUspsApi({ trackingNumbers, clientId, clientSecret, environment }) {
  const accessToken = await getUspsAccessToken({ clientId, clientSecret, environment });
  const baseUrl = USPS_API_BASE_URLS[environment];
  let rows = [];

  let counter = 0;
  for (const chunk of chunkList(trackingNumbers, USPS_MAX_TRACKING_PER_REQUEST)) {
    counter += 1;
    console.log(`Processing USPS API batch ${counter}: ${chunk.length} tracking number(s)`);

    try {
      const response = await fetch(`${baseUrl}/tracking/v3r2/tracking`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(chunk.map((trackingNumber) => ({ trackingNumber }))),
      });
      const data = await readJsonResponse(response);

      if (!response.ok) {
        const message = data?.error_description || data?.error || data?.message || response.statusText;
        rows = rows.concat(buildApiErrorRows(chunk, `USPS API ${response.status}`, message));
        continue;
      }

      const items = Array.isArray(data) ? data : [data];
      const returnedTrackingNumbers = new Set();
      rows = rows.concat(items.map((item, index) => {
        const fallbackTrackingNumber = chunk[index] || "";
        const row = uspsApiItemToRow(item, fallbackTrackingNumber);
        if (row[0]) {
          returnedTrackingNumbers.add(row[0]);
        }
        return row;
      }));

      rows = rows.concat(chunk
        .filter((trackingNumber) => !returnedTrackingNumbers.has(trackingNumber))
        .map((trackingNumber) => [
          trackingNumber,
          "US",
          "",
          "",
          "No USPS API result found",
          "USPS API did not return a matching item for this tracking number.",
        ]));
    } catch (error) {
      rows = rows.concat(buildApiErrorRows(chunk, "USPS API Error", error.message));
    }
  }

  return convertRowsToCsv(rows);
}

async function extractUspsRows(page, requestedTrackingNumbers) {
  return page.evaluate((requestedTrackingNumbers) => {
    const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
    const monthDateRegex = /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b.+\b\d{4}\b/i;
    const numericDateRegex = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/;
    const locationRegex = /\b[A-Z][A-Z\s.'-]+,\s*[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?\b/;
    const ignoredLines = new Set([
      "Remove",
      "Tracking Number:",
      "Copy",
      "Copy Add to Informed Delivery",
      "Add to Informed Delivery",
      "Latest Update",
      "Track Another Package",
      "Need More Help?",
      "Contact USPS Tracking support for further assistance.",
      "FAQs",
      "Enter and submit the send date.",
      "Send Date (MM/DD/YYYY)",
      "Submit",
    ]);

    const cleanLines = (lines, trackingNumber = "") => lines
      .map(normalize)
      .filter(Boolean)
      .filter((line) => !ignoredLines.has(line))
      .filter((line) => line !== trackingNumber);

    const blocks = Array.from(document.querySelectorAll(".track-bar-container"))
      .map((container) => {
        const fullText = container.innerText || "";
        const trackingNumber = normalize(container.querySelector(".tracking-number")?.innerText)
          || requestedTrackingNumbers.find((code) => fullText.includes(code))
          || "";
        const rawLines = fullText.split("\n").map(normalize).filter(Boolean);

        const latestUpdateIndex = rawLines.findIndex((line) => /latest update/i.test(line));
        const candidateLines = latestUpdateIndex >= 0 ? rawLines.slice(latestUpdateIndex + 1) : rawLines;
        const updateLines = cleanLines(candidateLines, trackingNumber);
        const dateTime = updateLines.find((line) => monthDateRegex.test(line) || numericDateRegex.test(line)) || "";
        const location = updateLines.find((line) => locationRegex.test(line)) || "";
        const status = updateLines.find((line) => line !== dateTime && line !== location) || "";
        const additionalInfo = updateLines
          .filter((line) => line !== status && line !== dateTime && line !== location)
          .join(" | ");

        return [
          trackingNumber,
          "US",
          location,
          dateTime,
          status,
          additionalInfo,
        ];
      })
      .filter((row) => row[0]);

    const foundTrackingNumbers = new Set(blocks.map((row) => row[0]));
    const missingBlocks = requestedTrackingNumbers
      .filter((trackingNumber) => !foundTrackingNumbers.has(trackingNumber))
      .map((trackingNumber) => [
        trackingNumber,
        "US",
        "",
        "",
        "No USPS result found",
        "USPS did not render a tracking result block for this number.",
      ]);

    return [...blocks, ...missingBlocks];
  }, requestedTrackingNumbers);
}

async function sendTrackingCodes(trackingNumbers) {
  let rows = [];
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: PUPPETEER_HEADLESS,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1365,900',
      ],
    });
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");

    console.log("Start...");
    let counter = 0;
    for (const chunk of chunkList(trackingNumbers, USPS_MAX_TRACKING_PER_REQUEST)) {
      counter += 1;
      const params = new URLSearchParams({ tLabels: chunk.join(",") });
      console.log(`Processing USPS batch ${counter}: ${chunk.length} tracking number(s)`);

      try {
        await page.goto(`${USPS_TRACKING_URL}?${params.toString()}`, {
          waitUntil: "networkidle2",
          timeout: 60000,
        });
        await page.waitForSelector(".track-bar-container, .tracking-number", { timeout: 45000 });
        rows = rows.concat(await extractUspsRows(page, chunk));
      } catch (err) {
        console.error(`Error processing USPS batch ${counter}: ${params.toString()}`, err);
        rows = rows.concat(chunk.map((trackingNumber) => [
          trackingNumber,
          "US",
          "",
          "",
          "Error",
          err.message,
        ]));
      }
    }

    console.log("done\n");
  } catch (err) {
    console.error("An error occurred:", err);
  } finally {
    if (browser) {
      await browser.close();
    }
  }

  return convertRowsToCsv(rows);
}


// async function sendTrackingCodes(trackingNumbers) {
//   const browser = await puppeteer.launch({
//     headless: true,
//     args: ['--no-sandbox', '--disable-setuid-sandbox'],
//   });

//   let text = "";
//   try {
//     const context = await browser.createBrowserContext();
//     const page = await context.newPage();

//     // Gán quyền clipboard cho trang web
//     await context.overridePermissions('https://www.ship24.com/tracking', ['clipboard-read', 'clipboard-write']);

//     let url = "https://www.ship24.com/tracking";

//     console.log("Start...");

//     // Tạo các nhóm 10 mã tracking
//     const chunks = chunkList(trackingNumbers, 10);

//     // Hàm xử lý một nhóm mã tracking
//     const processChunk = async (chunk) => {
//       const trackingNumbersStr = chunk.join(",");
//       let params = "p=" + trackingNumbersStr;
//       console.log(params);

//       const newPage = await context.newPage(); // Mỗi nhóm xử lý trên một page riêng
//       await newPage.goto(`${url}?${params}`);

//       const iconSelector = 'i.text-2xl.text-gray-500.s24-copy.mr-2';
//       await newPage.waitForSelector(iconSelector, { timeout: 0 });

//       const iconElement = await newPage.$(iconSelector);
//       if (iconElement) {
//         await iconElement.click();
//         console.log("mita")
//         await new Promise((resolve) => setTimeout(resolve, 500));

//         const clipboardData = await newPage.$$eval("button span", async (spans) => {
//           for (let span of spans) {
//             if (span.textContent.trim() === "Copy status and last event details") {
//               const button = span.closest('button');
//               button.click(); // Simulate the button click

//               // Wait for the clipboard data to be available (optional delay)
//               await new Promise((resolve) => setTimeout(resolve, 500));

//               // Read and return the clipboard text
//               return navigator.clipboard.readText();
//             }
//           }
//           return null; // Return null if no matching button is found
//         });

//         return clipboardData || ""; // Trả về dữ liệu clipboard
//       }

//       return "";
//     };

//     // Xử lý các nhóm song song
//     const results = await Promise.all(
//       chunks.map(async (chunk) => await convertToCsv(processChunk(chunk)))
//     );
    
//     console.log(results)
//     // Gộp tất cả kết quả lại thành một chuỗi
//     text = results.join("");

//     console.log("done");
//   } catch (error) {
//     console.error("An error occurred:", error.message);
//     return await convertToCsv(text); // Trả về dữ liệu hiện tại khi gặp lỗi
//   } finally {
//     await browser.close();
//   }

//   return await convertToCsv(text); // Trả về dữ liệu sau khi hoàn tất
// }


// Route chính để phục vụ tệp HTML
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get("/api", (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'api.html'));
});

app.post("/tracking", async (req, res) => {
    const { trackingCodes } = req.body;
    if (!Array.isArray(trackingCodes) || trackingCodes.length === 0) {
      return res.status(400).send("Invalid input");
    }
    try {
      const outputText = await sendTrackingCodes(trackingCodes);
      res.send({ result: outputText });
    } catch (error) {
      console.error(error);
      res.status(500).send("Error processing request");
    }
  });

app.post("/api-tracking", async (req, res) => {
    const { trackingCodes, clientId, clientSecret, environment } = req.body;
    const normalizedEnvironment = normalizeApiEnvironment(environment);
    const resolvedClientId = clientId || process.env.USPS_CLIENT_ID;
    const resolvedClientSecret = clientSecret || process.env.USPS_CLIENT_SECRET;

    if (!Array.isArray(trackingCodes) || trackingCodes.length === 0) {
      return res.status(400).send("Invalid tracking codes");
    }

    if (!resolvedClientId || !resolvedClientSecret) {
      return res.status(400).send("Missing USPS API credentials");
    }

    try {
      const outputText = await sendTrackingCodesViaUspsApi({
        trackingNumbers: trackingCodes,
        clientId: resolvedClientId,
        clientSecret: resolvedClientSecret,
        environment: normalizedEnvironment,
      });
      res.send({ result: outputText });
    } catch (error) {
      console.error("USPS API tracking error:", error.message);
      res.status(error.status || 500).send(error.message || "Error processing USPS API request");
    }
  });

const PORT = process.env.PORT || 3000; 
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
