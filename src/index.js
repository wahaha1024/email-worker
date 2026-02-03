// src/index.js - 邮件管理系统 - Koobai 风格

let operationLogs = [];
const MAX_LOGS = 200;

function addLog(type, action, details = {}) {
  const log = {
    id: Date.now() + Math.random().toString(36).substr(2, 9),
    timestamp: new Date().toISOString(),
    type, action, details
  };
  operationLogs.unshift(log);
  if (operationLogs.length > MAX_LOGS) operationLogs = operationLogs.slice(0, MAX_LOGS);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    addLog('request', `${request.method} ${url.pathname}`, { query: url.search });
    try {
      return await handleRequest(request, env);
    } catch (error) {
      addLog('error', error.message);
      return new Response(renderErrorPage(error.message), { status: 500 });
    }
  }
};

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/' || path.startsWith('/?')) return handleHomePage(request, env);
  if (path.startsWith('/view/')) return handleEmailView(request, path.split('/')[2], env);
  if (path === '/api/emails') return handleApiEmails(request, env);
  if (path === '/api/mark-read') return handleMarkRead(request, env);
  if (path === '/api/delete') return handleDeleteEmail(request, env);
  if (path === '/rss') return handleRssFeed(request, env);
  if (path === '/logs') return handleLogsPage(request, env);
  if (path === '/api/clear-logs') return handleClearLogs(request, env);
  return new Response('Not Found', { status: 404 });
}

async function handleHomePage(request, env) {
  const url = new URL(request.url);
  const emails = await getEmails(url.searchParams.get('search') || '', 'all', env);
  const html = renderKoobaiPage({
    page: 'inbox',
    content: renderEmailList(emails)
  });
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function handleEmailView(request, emailId, env) {
  const email = await env.DB.prepare('SELECT * FROM emails WHERE id = ? AND is_deleted = 0').bind(emailId).first();
  if (!email) return new Response(renderKoobaiPage({ page: 'view', content: '<div class="empty">邮件不存在</div>' }), { status: 404 });
  await env.DB.prepare('UPDATE emails SET is_read = 1 WHERE id = ?').bind(emailId).run();
  const html = renderKoobaiPage({ page: 'view', emailId, content: renderEmailDetail(email) });
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function handleLogsPage(request, env) {
  const html = renderKoobaiPage({
    page: 'logs',
    content: renderLogsContent(operationLogs.slice(0, 50))
  });
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ============ Koobai 风格页面 ============

function renderKoobaiPage({ page, emailId, content }) {
  const isInbox = page === 'inbox';
  const isLogs = page === 'logs';
  const isView = page === 'view';

  // 底部导航按钮 - Koobai 风格，使用 Lucide 图标
  const navButtons = [
    { id: 'inbox', icon: 'mail', label: '收件箱', href: '/', active: isInbox },
    { id: 'logs', icon: 'activity', label: '日志', href: '/logs', active: isLogs },
    { id: 'rss', icon: 'rss', label: '订阅', href: '/rss', active: false },
  ];

  // 功能按钮
  const actionButtons = isInbox ? [
    { id: 'select', icon: 'square', label: '选择', onclick: 'toggleSelect()' },
    { id: 'read', icon: 'check', label: '已读', onclick: 'markRead()', disabled: true },
    { id: 'delete', icon: 'trash-2', label: '删除', onclick: 'doDelete()', disabled: true },
  ] : isView ? [
    { id: 'back', icon: 'arrow-left', label: '返回', onclick: 'history.back()' },
    { id: 'delete', icon: 'trash-2', label: '删除', onclick: `deleteEmail(${emailId})` },
  ] : [];

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>MailBox</title>
<script src="https://unpkg.com/lucide@latest/dist/umd/lucide.min.js"></script>
<style>
/* ========== Koobai 设计规范 ========== */
:root {
  --bg: #f2f0eb;
  --bg-card: #fffdfe;
  --text: #222222;
  --text-secondary: #666666;
  --text-muted: #999999;
  --border: rgba(0,0,0,0.08);
  --accent: #994d61;
  --hover-bg: rgba(0,0,0,0.06);
  --active-bg: rgba(0,0,0,0.1);
  --nav-bg: rgba(242, 240, 235, 0.5);
  --radius: 16px;
  --radius-sm: 12px;
  --font: JetBrainsMono, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Ubuntu, "Helvetica Neue", Helvetica, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
}

* { margin: 0; padding: 0; box-sizing: border-box; -webkit-font-smoothing: antialiased; }

body {
  font-family: var(--font);
  background: var(--bg);
  color: var(--text);
  font-size: 16px;
  line-height: 1.6;
  padding-bottom: 120px;
}

/* 主内容区 - 无顶栏 */
.main {
  max-width: 800px;
  margin: 0 auto;
  padding: 24px;
}

/* 页面标题 - Koobai 风格 */
.page-title {
  font-size: 28px;
  font-weight: 600;
  margin-bottom: 8px;
  letter-spacing: -0.3px;
  color: var(--text);
}

.page-subtitle {
  color: var(--text-muted);
  font-size: 14px;
  margin-bottom: 32px;
  font-weight: 400;
}

/* 搜索框 - Koobai 风格 */
.search-box {
  position: relative;
  margin-bottom: 24px;
}

.search-input {
  width: 100%;
  padding: 14px 16px 14px 48px;
  border: none;
  border-radius: var(--radius);
  font-size: 15px;
  background: var(--bg-card);
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  transition: all 0.2s ease;
  font-family: var(--font);
}

.search-input:focus {
  outline: none;
  box-shadow: 0 4px 12px rgba(0,0,0,0.08);
}

.search-input::placeholder {
  color: var(--text-muted);
}

.search-icon {
  position: absolute;
  left: 18px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-muted);
  font-size: 18px;
}

/* 邮件列表 - Koobai 极简风格 */
.email-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.email-item {
  background: var(--bg-card);
  padding: 20px;
  border-radius: var(--radius);
  display: flex;
  align-items: flex-start;
  gap: 16px;
  cursor: pointer;
  transition: all 0.2s ease;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
}

.email-item:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 24px rgba(0,0,0,0.08);
}

.email-checkbox {
  width: 20px;
  height: 20px;
  margin-top: 2px;
  accent-color: var(--accent);
  opacity: 0;
  transition: opacity 0.2s;
  cursor: pointer;
  flex-shrink: 0;
}

.select-mode .email-checkbox {
  opacity: 1;
}

.email-content {
  flex: 1;
  min-width: 0;
}

.email-sender {
  font-weight: 500;
  font-size: 15px;
  margin-bottom: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text);
}

.email-subject {
  color: var(--text);
  font-size: 17.6px;
  font-weight: 500;
  line-height: 29.92px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 6px;
}

.email-preview {
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.5;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.email-time {
  font-size: 13px;
  color: var(--text-muted);
  white-space: nowrap;
  flex-shrink: 0;
  margin-top: 4px;
}

/* 空状态 - Koobai 风格 */
.empty {
  text-align: center;
  padding: 100px 20px;
  color: var(--text-muted);
}

.empty-icon {
  font-size: 56px;
  margin-bottom: 20px;
  opacity: 0.4;
}

.empty-text {
  font-size: 15px;
  color: var(--text-secondary);
}

/* 邮件详情 - Koobai 风格 */
.email-detail {
  background: var(--bg-card);
  border-radius: var(--radius);
  padding: 32px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
}

.email-detail-header {
  margin-bottom: 28px;
  padding-bottom: 24px;
  border-bottom: 1px solid var(--border);
}

.email-detail-subject {
  font-size: 24px;
  font-weight: 600;
  line-height: 1.4;
  margin-bottom: 16px;
  color: var(--text);
  letter-spacing: -0.2px;
}

.email-detail-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 14px;
  color: var(--text-secondary);
}

.email-detail-meta span {
  display: flex;
  align-items: center;
}

.email-detail-body {
  line-height: 1.8;
  color: var(--text);
  font-size: 16px;
}

.email-detail-body img {
  max-width: 100%;
  border-radius: var(--radius-sm);
  margin: 16px 0;
}

.email-detail-body p {
  margin-bottom: 16px;
}

/* ========== Koobai 风格底部导航栏 ========== */
.bottom-nav {
  position: fixed;
  bottom: 30px;
  left: 50%;
  transform: translateX(-50%);
  width: 600px;
  max-width: 90vw;
  background: rgba(242, 240, 235, 0.5);
  backdrop-filter: blur(20px) saturate(1.8);
  -webkit-backdrop-filter: blur(20px) saturate(1.8);
  border-radius: 50px;
  padding: 20px 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  box-shadow: rgba(0, 0, 0, 0.1) 0px 0px 1px 0px, rgba(0, 0, 0, 0.12) 0px 10px 30px 0px;
  z-index: 1000;
}

.nav-menu {
  display: flex;
  align-items: center;
  gap: 32px;
}

.nav-divider {
  width: 1px;
  height: 20px;
  background: rgba(0, 0, 0, 0.1);
}

.nav-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0;
  font-size: 12.8px;
  color: #444444;
  background: transparent;
  border: none;
  cursor: pointer;
  transition: all 0.2s ease;
  text-decoration: none;
}

.nav-btn:hover {
  color: #994d61;
}

.nav-btn.active {
  color: #994d61;
}

.nav-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.nav-btn .icon {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.nav-btn .icon svg {
  width: 20px;
  height: 20px;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* 日志页面 - Koobai 风格 */
.logs-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.log-item {
  background: var(--bg-card);
  padding: 16px 20px;
  border-radius: var(--radius);
  font-size: 14px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  transition: all 0.2s ease;
}

.log-item:hover {
  box-shadow: 0 4px 12px rgba(0,0,0,0.08);
}

.log-header {
  display: flex;
  gap: 12px;
  margin-bottom: 8px;
  align-items: center;
}

.log-time {
  color: var(--text-muted);
  font-family: JetBrainsMono, monospace;
  font-size: 12px;
  letter-spacing: 0.5px;
}

.log-type {
  padding: 3px 10px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.log-type-receive { background: rgba(219, 234, 254, 0.6); color: #1e40af; }
.log-type-read { background: rgba(243, 232, 255, 0.6); color: #7c3aed; }
.log-type-delete { background: rgba(254, 226, 226, 0.6); color: #991b1b; }
.log-type-error { background: rgba(254, 202, 202, 0.6); color: #7f1d1d; }
.log-type-request { background: var(--border); color: var(--text-secondary); }

/* 响应式 - Koobai 风格 */
@media (max-width: 768px) {
  .main { padding: 20px; }
  .email-detail { padding: 24px; }
  
  .bottom-nav {
    width: auto;
    min-width: 500px;
    padding: 16px 24px;
  }
  
  .nav-menu {
    gap: 24px;
  }
}

@media (max-width: 600px) {
  .main { padding: 16px; }
  .page-title { font-size: 24px; }
  .page-subtitle { margin-bottom: 24px; }
  
  .email-item {
    padding: 16px;
    gap: 12px;
  }
  
  .email-subject {
    font-size: 16px;
    line-height: 1.5;
  }
  
  .bottom-nav {
    bottom: 16px;
    width: calc(100% - 32px);
    max-width: none;
    padding: 14px 20px;
    border-radius: 40px;
  }
  
  .nav-menu {
    gap: 16px;
  }
  
  .nav-btn {
    font-size: 12px;
  }
  
  .email-detail {
    padding: 20px;
  }
  
  .email-detail-subject {
    font-size: 20px;
  }
}
</style>
</head>
<body>

<main class="main">
  ${content}
</main>

<!-- Koobai 风格底部导航 -->
<div class="bottom-nav">
  <div class="nav-menu">
    ${navButtons.map(btn => `
      <a href="${btn.href}" ${btn.id === 'rss' ? 'target="_blank"' : ''}
         class="nav-btn ${btn.active ? 'active' : ''}">
        <span class="icon" data-lucide="${btn.icon}"></span>
        <span>${btn.label}</span>
      </a>
    `).join('')}

    ${actionButtons.length > 0 ? '<div class="nav-divider"></div>' : ''}

    ${actionButtons.map(btn => `
      <button class="nav-btn" id="${btn.id}Btn" onclick="${btn.onclick}"
              ${btn.disabled ? 'disabled' : ''}>
        <span class="icon" data-lucide="${btn.icon}"></span>
        <span>${btn.label}</span>
      </button>
    `).join('')}
  </div>
</div>

<script>
  // 初始化 Lucide 图标
  if (typeof lucide !== 'undefined') {
    lucide.createIcons();
  }
</script>

<script>
  let selectMode = false;
  let selectedIds = new Set();

  function toggleSelect() {
    selectMode = !selectMode;
    const list = document.querySelector('.email-list');
    const btn = document.getElementById('selectBtn');
    const icon = btn.querySelector('[data-lucide]');

    if (selectMode) {
      list.classList.add('select-mode');
      btn.classList.add('active');
      if (icon) icon.setAttribute('data-lucide', 'check-square');
    } else {
      list.classList.remove('select-mode');
      btn.classList.remove('active');
      if (icon) icon.setAttribute('data-lucide', 'square');
      document.querySelectorAll('.email-checkbox').forEach(cb => cb.checked = false);
      selectedIds.clear();
      updateButtons();
    }
    // 重新初始化图标
    if (typeof lucide !== 'undefined') {
      lucide.createIcons();
    }
  }

  function updateSelection() {
    selectedIds = new Set();
    document.querySelectorAll('.email-checkbox:checked').forEach(cb => selectedIds.add(cb.value));
    updateButtons();
  }

  function updateButtons() {
    const count = selectedIds.size;
    document.getElementById('readBtn').disabled = count === 0;
    document.getElementById('deleteBtn').disabled = count === 0;
  }

  async function markRead() {
    if (selectedIds.size === 0) return;
    await fetch('/api/mark-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: Array.from(selectedIds) })
    });
    location.reload();
  }

  async function doDelete() {
    if (selectedIds.size === 0) return;
    if (!confirm('确定删除 ' + selectedIds.size + ' 封邮件？')) return;
    await fetch('/api/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: Array.from(selectedIds) })
    });
    location.reload();
  }

  async function deleteEmail(id) {
    if (!confirm('确定删除这封邮件？')) return;
    await fetch('/api/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id] })
    });
    location.href = '/';
  }

  // 搜索
  function doSearch() {
    const search = document.querySelector('.search-input').value;
    location.href = '/?search=' + encodeURIComponent(search);
  }

  document.addEventListener('DOMContentLoaded', () => {
    const searchInput = document.querySelector('.search-input');
    if (searchInput) {
      searchInput.addEventListener('keypress', e => { if (e.key === 'Enter') doSearch(); });
    }

    document.querySelectorAll('.email-item').forEach(item => {
      item.addEventListener('click', e => {
        if (selectMode && e.target.type !== 'checkbox') {
          e.preventDefault();
          const cb = item.querySelector('.email-checkbox');
          cb.checked = !cb.checked;
          updateSelection();
        }
      });
    });
  });
</script>

</body>
</html>`;
}

// ============ 邮件列表渲染 ============

function renderEmailList(emails) {
  const items = emails.map(email => {
    const preview = (email.content_text || '').substring(0, 60).replace(/\s+/g, ' ');
    return `
      <div class="email-item" data-id="${email.id}">
        <input type="checkbox" class="email-checkbox" value="${email.id}" onclick="event.stopPropagation(); updateSelection();">
        <div class="email-content" onclick="if(!selectMode) location.href='/view/${email.id}'">
          <div class="email-sender">${escapeHtml(email.sender_name || email.sender || '未知')}</div>
          <div class="email-subject">${escapeHtml(email.subject || '(无主题)')}</div>
          <div class="email-preview">${escapeHtml(preview)}</div>
        </div>
        <div class="email-time">${formatTime(email.date_sent)}</div>
      </div>
    `;
  }).join('');

  return `
    <h1 class="page-title">收件箱</h1>
    <p class="page-subtitle">${emails.length} 封邮件</p>

    <div class="search-box">
      <span class="search-icon">⌕</span>
      <input type="text" class="search-input" placeholder="搜索邮件...">
    </div>

    ${emails.length > 0 ? `
      <div class="email-list">
        ${items}
      </div>
    ` : `
      <div class="empty">
        <div class="empty-icon">📭</div>
        <div class="empty-text">没有邮件</div>
      </div>
    `}
  `;
}

// ============ 邮件详情渲染 ============

function renderEmailDetail(email) {
  const content = email.content_html || `<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(email.content_text || '')}</pre>`;

  return `
    <div class="email-detail">
      <div class="email-detail-header">
        <div class="email-detail-subject">${escapeHtml(email.subject || '(无主题)')}</div>
        <div class="email-detail-meta">
          <span>${escapeHtml(email.sender_name || email.sender || '未知')}</span>
          <span>·</span>
          <span>${formatFullTime(email.date_sent)}</span>
        </div>
      </div>
      <div class="email-detail-body">${content}</div>
    </div>
  `;
}

// ============ 日志页面 ============

function renderLogsContent(logs) {
  return `
    <h1 class="page-title">系统日志</h1>
    <p class="page-subtitle">最近 ${logs.length} 条记录</p>

    <div class="logs-list">
      ${logs.length > 0 ? logs.map(log => `
        <div class="log-item">
          <div class="log-header">
            <span class="log-time">${formatShortTime(log.timestamp)}</span>
            <span class="log-type log-type-${log.type}">${log.type}</span>
          </div>
          <div>${escapeHtml(log.action)}</div>
        </div>
      `).join('') : `
        <div class="empty">
          <div class="empty-icon">◈</div>
          <div class="empty-text">暂无日志</div>
        </div>
      `}
    </div>
  `;
}

function renderErrorPage(message) {
  return renderKoobaiPage({
    page: 'error',
    content: `<div class="empty"><div class="empty-icon">⚠</div><div>${escapeHtml(message)}</div></div>`
  });
}

// ============ 工具函数 ============

function formatTime(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  const now = new Date();
  if (now - date < 24 * 60 * 60 * 1000 && now.getDate() === date.getDate()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function formatFullTime(dateString) {
  if (!dateString) return '';
  return new Date(dateString).toLocaleString('zh-CN');
}

function formatShortTime(dateString) {
  if (!dateString) return '';
  return new Date(dateString).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ============ API 处理 ============

async function getEmails(search, filter, env) {
  try {
    let query = 'SELECT * FROM emails WHERE is_deleted = 0';
    let params = [];
    if (search) {
      query += ' AND (subject LIKE ? OR content_text LIKE ? OR sender LIKE ?)';
      params.push('%' + search + '%', '%' + search + '%', '%' + search + '%');
    }
    query += ' ORDER BY date_sent DESC';
    const { results } = await env.DB.prepare(query).bind(...params).all();
    return results || [];
  } catch (error) {
    return [];
  }
}

async function handleApiEmails(request, env) {
  const url = new URL(request.url);
  const emails = await getEmails(url.searchParams.get('search') || '', 'all', env);
  return new Response(JSON.stringify(emails), { headers: { 'Content-Type': 'application/json' } });
}

async function handleMarkRead(request, env) {
  const data = await request.json();
  try {
    if (data.ids) {
      const ids = data.ids.map(id => parseInt(id)).filter(id => !isNaN(id));
      if (ids.length) {
        const placeholders = ids.map(() => '?').join(',');
        await env.DB.prepare(`UPDATE emails SET is_read = 1 WHERE id IN (${placeholders})`).bind(...ids).run();
      }
    }
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500 });
  }
}

async function handleDeleteEmail(request, env) {
  const data = await request.json();
  try {
    if (data.ids) {
      const ids = data.ids.map(id => parseInt(id)).filter(id => !isNaN(id));
      if (ids.length) {
        const placeholders = ids.map(() => '?').join(',');
        await env.DB.prepare(`UPDATE emails SET is_deleted = 1 WHERE id IN (${placeholders})`).bind(...ids).run();
      }
    }
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500 });
  }
}

async function handleRssFeed(request, env) {
  const emails = await getEmails('', 'all', env);
  const items = emails.map(e => `
    <item>
      <title>${escapeHtml(e.subject || '(无主题)')}</title>
      <link>https://email.zjyyy.top/view/${e.id}</link>
      <description>${escapeHtml((e.content_text || '').substring(0, 200))}</description>
      <pubDate>${e.date_sent}</pubDate>
    </item>
  `).join('');

  return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>MailBox</title>
<link>https://email.zjyyy.top</link>
<description>邮件订阅</description>
${items}
</channel>
</rss>`, { headers: { 'Content-Type': 'application/rss+xml' } });
}

async function handleClearLogs(request, env) {
  operationLogs = [];
  return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleDebug(request, env) {
  return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
}