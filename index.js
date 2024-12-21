const express = require("express");
const puppeteer = require("puppeteer");
const path = require("path"); 
const { stringify } = require('csv-stringify');

const app = express();
app.use(express.json()); // Đảm bảo phân tích cú pháp JSON

app.use(express.static(path.join(__dirname, 'public')));

// Hàm chia danh sách thành các nhóm nhỏ hơn
function chunkList(lst, n) {
  const result = [];

  // Chia danh sách đã cập nhật thành các nhóm nhỏ hơn
  for (let i = 0; i < lst.length; i += n) {
    result.push(lst.slice(i, i + n));
  }
  
  return result;
}

async function convertToCsv(text) {
  try {
    // Ensure input text is not empty
    if (!text || typeof text !== "string") {
      throw new Error("Input text must be a non-empty string.");
    }

    // Split the text into lines
    const lines = text.trim().split('\n').map(line => line.trim());

    // Extract headers from the first line
    const headers = lines[0].split(/\s{2,}/);

    // Map remaining lines into an array of rows
    const rows = lines.slice(1).map(line => line.split(/\t+|\s{2,}/));
    console.log("Parsed Rows:", rows); // Debugging rows

    // Define the output headers for the CSV
    const outputHeaders = [
      "tracking code",
      "country",
      "location",
      "date & time",
      "status",
      "additional info",
    ];

    // Map rows to match the output format
    const csvRows = rows.map(row => {
      const trackingCode = row[0] || "";
      const country = "";
      const location = row[4] || "";
      const dateTime = row[1] || "";
      const status = row[5] || "";
      const additionalInfo = row[3] || "";

      return [trackingCode, country, location, dateTime, status, additionalInfo];
    });

    return new Promise((resolve, reject) => {
      // Add headers as the first row
      const csvData = [...csvRows];

      // Use csv-stringify to convert the data to CSV
      stringify(csvData,{ delimiter: '\\' }, (err, output) => {
        if (err) reject(err);
        else resolve(output);
      });
    });
  } catch (error) {
    console.error("Error in convertToCsv:", error.message);
    throw error;
  }
}

// Hàm gửi các mã tracking
async function sendTrackingCodes(trackingNumbers) {
  const browser = await puppeteer.launch({
    headless: true
  });
  const context = await browser.createBrowserContext();
  const page = await context.newPage();

  // Gán quyền clipboard cho trang web
  await context.overridePermissions('https://www.ship24.com/tracking', ['clipboard-read', 'clipboard-write']);
  // const page = await browser.newPage();
  let text = "";
  let url = "https://www.ship24.com/tracking";
  let params = "p=";

  console.log("Start...");

  for (const chunk of chunkList(trackingNumbers, 10)) {
    const trackingNumbersStr = chunk.join(",");
    params = params.concat(trackingNumbersStr);

    await page.goto(`${url}?${params}`);

    const iconSelector = 'i.text-2xl.text-gray-500.s24-copy.mr-2';

    // Wait for the icon to be available in the DOM
    await page.waitForSelector(iconSelector);

    const iconElement = await page.$(iconSelector);
    if (iconElement) {
      await iconElement.click();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      
      const clipboardData = await page.$$eval("button span", async (spans) => {
        for (let span of spans) {
          if (span.textContent.trim() === "Copy status and last event details") {
            const button = span.closest('button');
            button.click(); // Simulate the button click
            
            // Wait for the clipboard data to be available (optional delay)
            await new Promise((resolve) => setTimeout(resolve, 500)); 
            
            // Read and return the clipboard text
            return navigator.clipboard.readText();
          }
        }
        return null; // Return null if no matching button is found
      });
      
      await page.evaluate(() => {
        document.addEventListener("copy", (event) => {
          const copiedData = event.clipboardData.getData("text/plain");
          console.log("Copied data:", copiedData);
        });
      });

      console.log("Clipboard data:", clipboardData);

        console.log('Clipboard data:', clipboardData);
        text += clipboardData ? clipboardData : '';
      
    }

    console.log(await convertToCsv(text));
  }

  await browser.close();
  return await convertToCsv(text);
}

// Route chính để phục vụ tệp HTML
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
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

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
