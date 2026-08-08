function extractUspsRows(requestedTrackingNumbers) {
  const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
  const monthDateRegex = /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?/i;
  const numericDateRegex = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/;
  const timeRegex = /\b\d{1,2}:\d{2}\s*(?:am|pm|a\.m\.|p\.m\.)\b/i;
  const locationRegex = /\b[A-Z][A-Z\s.'-]+,\s*[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?\b/;
  const monthNumbers = new Map([
    ["jan", 1],
    ["january", 1],
    ["feb", 2],
    ["february", 2],
    ["mar", 3],
    ["march", 3],
    ["apr", 4],
    ["april", 4],
    ["may", 5],
    ["jun", 6],
    ["june", 6],
    ["jul", 7],
    ["july", 7],
    ["aug", 8],
    ["august", 8],
    ["sep", 9],
    ["sept", 9],
    ["september", 9],
    ["oct", 10],
    ["october", 10],
    ["nov", 11],
    ["november", 11],
    ["dec", 12],
    ["december", 12],
  ]);
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
    "See All Tracking History",
    "What Do USPS Tracking Statuses Mean?",
    "Text & Email Updates",
    "USPS Tracking Plus®",
    "Product Information",
    "See Less",
    "Get More Out of USPS Tracking:",
  ]);
  const ignoredLinePatterns = [
    /^USPS Tracking Plus/i,
    /^Text & Email Updates/i,
    /^Product Information/i,
    /^See All Tracking History/i,
    /^What Do USPS Tracking Statuses Mean/i,
    /^See Less/i,
    /^Get More Out of USPS Tracking/i,
  ];

  const cleanLines = (lines, trackingNumber = "") => lines
    .map(normalize)
    .filter(Boolean)
    .filter((line) => !ignoredLines.has(line))
    .filter((line) => !ignoredLinePatterns.some((pattern) => pattern.test(line)))
    .filter((line) => line !== trackingNumber);

  const extractDateTimeFromText = (text) => {
    const dateMatch = text.match(monthDateRegex) || text.match(numericDateRegex);
    if (!dateMatch) return "";

    const timeMatch = text.match(timeRegex);
    return normalize(`${dateMatch[0]} ${timeMatch ? timeMatch[0] : ""}`);
  };

  const findDateTime = (lines) => {
    const candidates = lines.filter((line) => monthDateRegex.test(line) || numericDateRegex.test(line));
    if (candidates.length === 0) return "";

    const best = candidates
      .map((line) => {
        let score = 0;
        if (timeRegex.test(line)) score += 4;
        if (line.length <= 90) score += 3;
        if (!/^(Your item|Your package|The item|Item)/i.test(line)) score += 3;
        if (/^\w{3,9}\s+\d{1,2}/i.test(line)) score += 2;
        return { line, score };
      })
      .sort((left, right) => right.score - left.score)[0].line;

    if (/^(Your item|Your package|The item|Item)/i.test(best) || best.length > 120) {
      return extractDateTimeFromText(best);
    }

    return best;
  };

  const findStatus = (lines, dateTime, location) => {
    const statusLines = lines.filter((line) => (
      line !== dateTime
      && line !== location
      && !ignoredLines.has(line)
      && !ignoredLinePatterns.some((pattern) => pattern.test(line))
    ));

    return statusLines.find((line) => (
      /delivered|arrived|departed|accepted|available|in transit|out for delivery|forwarded|notice|held|return|processed|picked up/i
        .test(line)
    )) || statusLines[0] || "";
  };

  const parseStatusDate = (status, dateTime) => {
    const source = `${status} ${dateTime}`;
    const match = source.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Sept(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b\s+(\d{1,2})(?:st|nd|rd|th)?(?:,\s*(\d{4}))?/i);
    if (!match) return null;

    const month = monthNumbers.get(match[1].toLowerCase());
    const day = Number(match[2]);
    const year = match[3];
    if (!month || !day) return null;
    return { day, month, year };
  };

  const formatLastUpdateDate = (status, dateTime) => {
    const parsedDate = parseStatusDate(status, dateTime);
    if (!parsedDate) return "";
    return `${parsedDate.day}/${parsedDate.month}`;
  };

  const formatDeliveryDate = (status, dateTime) => {
    if (!/delivered/i.test(status)) return "";

    const parsedDate = parseStatusDate(status, dateTime);
    if (!parsedDate?.year) return "";
    return `${String(parsedDate.day).padStart(2, "0")}/${String(parsedDate.month).padStart(2, "0")}/${parsedDate.year}`;
  };

  const uniqueLines = (lines) => {
    const seen = new Set();
    return lines.filter((line) => {
      const key = line.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

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
      const dateTime = findDateTime(updateLines);
      const location = updateLines.find((line) => locationRegex.test(line)) || "";
      const status = findStatus(updateLines, dateTime, location);
      const deliveryDate = formatDeliveryDate(status, dateTime);
      const lastUpdateDate = formatLastUpdateDate(status, dateTime);
      const additionalInfo = uniqueLines(updateLines
        .filter((line) => line !== status && line !== dateTime && line !== location)
        .filter((line) => !monthDateRegex.test(line) || !status.includes(line))
        .filter((line) => !status.includes(line))
        .filter((line) => line.length <= 180))
        .join(" | ");

      return [
        trackingNumber,
        "US",
        location,
        dateTime,
        status,
        deliveryDate,
        lastUpdateDate,
        additionalInfo,
      ];
    })
    .filter((row) => row[0]);

  const foundTrackingNumbers = new Set(blocks.map((row) => row[0]));
  const missingRows = requestedTrackingNumbers
    .filter((trackingNumber) => !foundTrackingNumbers.has(trackingNumber))
    .map((trackingNumber) => [
      trackingNumber,
      "US",
      "",
      "",
      "No USPS result found",
      "",
      "",
      "USPS did not render a tracking result block for this number.",
    ]);

  return [...blocks, ...missingRows];
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "EXTRACT_USPS_ROWS") return false;

  sendResponse({
    rows: extractUspsRows(message.trackingCodes || []),
    url: location.href,
    title: document.title,
  });
  return false;
});
