const express = require("express");
const puppeteer = require("puppeteer");
const path = require("path"); 

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

async function getClipboardText(page) {
  const button = await page.$(
    'button[data-original-title="Copy tracking results summary and paste into an Excel for use."]'
  );
  const clipboardText = await button.evaluate((node) =>
    node.getAttribute("data-clipboard-text")
  );
  const cleanedText = clipboardText
    .split('\n')
    .filter(line => {
      // Loại bỏ các dòng chứa thông tin không mong muốn
      return !line.includes('Powered by www.17track.net') && line.trim() !== '======================================';
    })
    .join('\n')
    .trim();
  return cleanedText;
}

// Hàm gửi các mã tracking
async function sendTrackingCodes(trackingNumbers) {
  // console.log(trackingNumbers)
  const browser = await puppeteer.launch({
    headless: false,
    // executablePath: '/usr/bin/chromium', // Đường dẫn tới Chromium
    // args: [
    //   '--no-sandbox',
    //   '--disable-setuid-sandbox',
    //   '--disable-gpu', // Thêm tham số này để tắt GPU acceleration
    //   '--remote-debugging-port=9222', // Có thể thêm nếu cần thiết
    //   '--display=:99', // Đảm bảo Puppeteer sử dụng DISPLAY đúng
    // ], // Cấu hình thêm nếu cần
  });
  const page = await browser.newPage();
  let text = ""
  await page.goto("https://www.17track.net/en");

  console.log("Start...");
  await new Promise((resolve) => setTimeout(resolve, 3000)); // Tạm dừng 10 giây để người dùng hoàn tất CAPTCHA

  for (const chunk of chunkList(trackingNumbers, 40)) {
    const trackingNumbersStr = chunk.join("\n");
    const searchBox = await page.$("textarea[id='auto-size-textarea']");
    await searchBox.type(trackingNumbersStr);
    const searchBtn = await page.$(
      "div[title=\"Click 'TRACK' to retrieve tracking information for your shipment.\"]"
    );
    await searchBtn.click();

    await new Promise((resolve) => setTimeout(resolve, 3000)); // Đợi 3 giây để kết quả hiển thị

    let captchaResolved = true;
    const checkCaptcha = await page.$('button[data-yq-events="submitCode"]');

    if (checkCaptcha) {
      captchaResolved = false;
      console.log("CAPTCHA detected, waiting for user to solve...");
    }

    while (!captchaResolved) {
      await new Promise((resolve) => setTimeout(resolve, 1500)); // Đợi 1 giây trước khi kiểm tra lại
      const captchaButton = await page.$('button[data-yq-events="submitCode"]');
      if (!captchaButton) {
        captchaResolved = true; // CAPTCHA đã được giải quyết
        console.log("continue...");
      }
    }

    if (captchaResolved) {
      await new Promise((resolve) => setTimeout(resolve, 5000)); // Đợi 5 giây để kết quả hiển thị

      const skipBtn = await page.$("a.introjs-skipbutton");

      if (skipBtn) {
        await skipBtn.click();
        console.log('Clicked skip button');
      } else {
        console.log('No skip button found');
      }
      
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const clipboardText = await getClipboardText(page);
      text += `${clipboardText}\n`;
    }
    await page.goto("https://www.17track.net/en");
  }

  await browser.close();
  return text;
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
