const puppeteer = require('puppeteer');

async function verifyDeployment() {
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: 'C:\\Program Files\\Quark\\quark.exe',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  
  console.log('验证部署...\n');
  
  try {
    // 检查 Debug API
    await page.goto('https://email.zjyyy.top/api/debug', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));
    
    const debugContent = await page.evaluate(() => document.body.textContent);
    console.log('Debug API 响应:');
    console.log(debugContent);
    
    // 检查主页
    await page.goto('https://email.zjyyy.top/', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));
    
    await page.screenshot({ path: 'deployed-ui.png', fullPage: true });
    console.log('\n已截图保存到 deployed-ui.png');
    
    // 检查功能
    const checks = await page.evaluate(() => {
      return {
        hasLucide: typeof lucide !== 'undefined',
        navButtons: document.querySelectorAll('.nav-btn').length,
        hasFilterBar: !!document.querySelector('.filter-bar'),
        hasSearchBox: !!document.querySelector('.search-box')
      };
    });
    
    console.log('\n功能检查:');
    console.log('  Lucide 图标:', checks.hasLucide ? '✅' : '❌');
    console.log('  导航按钮数:', checks.navButtons);
    console.log('  筛选栏:', checks.hasFilterBar ? '✅' : '❌');
    console.log('  搜索框:', checks.hasSearchBox ? '✅' : '❌');
    
  } catch (error) {
    console.error('验证失败:', error.message);
  }
  
  await browser.close();
}

verifyDeployment().catch(console.error);
