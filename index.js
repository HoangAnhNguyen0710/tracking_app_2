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
      return text;
    }

    // Split the text into lines
    const lines = text.trim().split('\n').map(line => line.trim());

    // Extract headers from the first line
    const headers = lines[0].split(/\s{2,}/);

    // Map remaining lines into an array of rows
    const rows = lines.slice(1).map(line => line.split(/\t+|\s{2,}/));
    // console.log("Parsed Rows:", rows); // Debugging rows

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
  let text = ""; // Initialize the result text
  const url = "https://www.ship24.com/tracking";

  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const context = await browser.createBrowserContext();
    const page = await context.newPage();

    // Gán quyền clipboard cho trang web
    await context.overridePermissions('https://www.ship24.com/tracking', ['clipboard-read', 'clipboard-write']);

    console.log("Start...");

    for (const chunk of chunkList(trackingNumbers, 10)) {
      const trackingNumbersStr = chunk.join(",");
      let params = "p=".concat(trackingNumbersStr);
      console.log(params);

      try {
        await page.goto(`${url}?${params}`);

        const iconSelector = 'i.text-2xl.text-gray-500.s24-copy.mr-2';
        await page.waitForSelector(iconSelector, { timeout: 0 });
        const iconElement = await page.$(iconSelector);

        if (iconElement) {
          await iconElement.click();
          await new Promise((resolve) => setTimeout(resolve, 1000));

          const clipboardData = await page.$$eval("button span", async (spans) => {
            for (let span of spans) {
              if (span.textContent.trim() === "Copy status and last event details") {
                const button = span.closest('button');
                button.click();
                await new Promise((resolve) => setTimeout(resolve, 500)); 
                return navigator.clipboard.readText();
              }
            }
            return null; // Return null if no matching button is found
          });

          if (clipboardData) {
            text += await convertToCsv(clipboardData) + "\n";
          }
        }
      } catch (err) {
        console.error(`Error processing chunk: ${params}`, err);
        return text;
      }
    }

    await browser.close();
    console.log("done\n");
  } catch (err) {
    console.error("An error occurred:", err);
  }

  return text; // Return the final processed text
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

const PORT = process.env.PORT || 3000; 
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
