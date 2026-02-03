const {join} = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // 使用夸克浏览器
  executablePath: 'C:\\Program Files\\Quark\\quark.exe',
  
  // 默认启动参数
  defaultArgs: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage'
  ]
};
