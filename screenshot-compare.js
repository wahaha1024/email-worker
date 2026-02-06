const puppeteer = require('puppeteer-core');
const path = require('path');

(async () => {
  console.log('启动浏览器...');
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Quark\\quark.exe',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--window-size=1280,800'
    ],
    headless: false // 夸克浏览器需要非 headless 模式
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  // 截图 Koobai
  console.log('访问 https://koobai.com...');
  await page.goto('https://koobai.com', { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'koobai-screenshot.png', fullPage: false });
  console.log('✅ Koobai 截图完成: koobai-screenshot.png');

  // 截图邮件系统
  console.log('访问 https://email.zjyyy.top...');
  await page.goto('https://email.zjyyy.top', { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'email-screenshot.png', fullPage: false });
  console.log('✅ 邮件系统截图完成: email-screenshot.png');

  await browser.close();
  console.log('对比截图完成！');
})().catch(err => {
  console.error('错误:', err.message);
});
