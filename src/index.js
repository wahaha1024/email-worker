// src/index.js - 邮件管理系统 - 无顶栏设计

// 邮件操作日志存储
let operationLogs = [];
const MAX_LOGS = 200;

function addLog(type, action, details = {}) {
  const log = {
    id: Date.now() + Math.random().toString(36).substr(2, 9),
    timestamp: new Date().toISOString(),
    type,
    action,
    details
  };
  operationLogs.unshift(log);
  if (operationLogs.length > MAX_LOGS) {
    operationLogs = operationLogs.slice(0, MAX_LOGS);
  }
  console.log(`[${type}] ${action}`, details);
}

export default {
  async fetch(request, env) {
    const startTime = Date.now();
    const url = new URL(request.url);

    addLog('request', `${request.method} ${url.pathname}`, {
      query: url.search,
      ip: request.headers.get('cf-connecting-ip')
    });

    try {
      const response = await handleRequest(request, env);
      return response;
    } catch (error) {
      addLog('error', `Request failed: ${error.message}`, { stack: error.stack });
      return new Response(renderErrorPage(error.message), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        status: 500
      });
    }
  }
};

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/' || path.startsWith('/?')) {
    return handleHomePage(request, env);
  } else if (path.startsWith('/view/')) {
    return handleEmailView(request, path.split('/')[2], env);
  } else if (path === '/api/emails') {
    return handleApiEmails(request, env);
  } else if (path === '/api/mark-read') {
    return handleMarkRead(request, env);
  } else if (path === '/api/delete') {
    return handleDeleteEmail(request, env);
  } else if (path === '/api/restore') {
    return handleRestoreEmail(request, env);
  } else if (path === '/rss') {
    return handleRssFeed(request, env);
  } else if (path === '/logs') {
    return handleLogsPage(request, env);
  } else if (path === '/api/logs') {
    return handleApiLogs(request, env);
  } else if (path === '/api/clear-logs') {
    return handleClearLogs(request, env);
  } else if (path === '/api/debug') {
    return handleDebug(request, env);
  }

  return new Response('Not Found', { status: 404 });
}

// ============ 页面处理函数 ============

async function handleHomePage(request, env) {
  const url = new URL(request.url);
  const search = url.searchParams.get('search') || '';
  const filter = url.searchParams.get('filter') || 'all';

  const emails = await getEmails(search, filter, env);
  const stats = await getEmailStats(env);

  const html = renderCleanPage({
    title: '收件箱',
    page: 'inbox',
    search,
    filter,
    stats,
    content: renderEmailList(emails, search, filter, stats)
  });

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function handleEmailView(request, emailId, env) {
  try {
    const email = await env.DB.prepare(
      'SELECT * FROM emails WHERE id = ? AND is_deleted = 0'
    ).bind(emailId).first();

    if (!email) {
      return new Response(renderCleanPage({
        title: '邮件不存在',
        page: 'view',
        content: '<div class="empty-state" style="padding-top:100px"><div class="empty-icon">📭</div><div class="empty-title">邮件不存在或已被删除</div></div>'
      }), { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 404 });
    }

    await env.DB.prepare('UPDATE emails SET is_read = 1 WHERE id = ?').bind(emailId).run();
    addLog('read', `查看邮件: ${email.subject}`, { emailId });

    const html = renderCleanPage({
      title: email.subject || '(无主题)',
      page: 'view',
      emailId,
      content: renderEmailDetail(email)
    });

    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  } catch (error) {
    addLog('error', '查看邮件失败', { error: error.message, emailId });
    return new Response(renderErrorPage(error.message), { status: 500 });
  }
}

async function handleLogsPage(request, env) {
  const recentLogs = operationLogs.slice(0, 50);

  const html = renderCleanPage({
    title: '系统日志',
    page: 'logs',
    content: renderLogsContent(recentLogs)
  });

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ============ 页面框架 - 无顶栏设计 ============

function renderCleanPage({ title, page = 'inbox', emailId = null, search = '', filter = 'all', stats = {}, content }) {
  const isInbox = page === 'inbox';
  const isLogs = page === 'logs';
  const isView = page === 'view';

  // 底部悬浮栏按钮配置
  const navButtons = [
    { id: 'inbox', icon: '✉', label: '收件箱', href: '/', active: isInbox },
    { id: 'logs', icon: '◈', label: '日志', href: '/logs', active: isLogs },
    { id: 'rss', icon: '◎', label: '订阅', href: '/rss', active: false, external: true },
  ];

  // 功能按钮（仅在收件箱显示）
  const actionButtons = isInbox ? [
    { id: 'select', icon: '☐', label: '选择', onclick: 'toggleSelectMode()' },
    { id: 'read', icon: '✓', label: '已读', onclick: 'markSelectedRead()', disabled: true, count: true },
    { id: 'delete', icon: '⌫', label: '删除', onclick: 'deleteSelected()', disabled: true, count: true },
  ] : isView ? [
    { id: 'back', icon: '←', label: '返回', onclick: 'history.back()' },
    { id: 'delete', icon: '⌫', label: '删除', onclick: `deleteEmail(${emailId})` },
  ] : [];

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>${escapeHtml(title)}</title>
<style>
/* ========== 极简设计系统 ========== */
:root {
  --bg: #ffffff;
  --bg-secondary: #f7f7f7;
  --text: #1a1a1a;
  --text-secondary: #666666;
  --text-muted: #999999;
  --border: #e5e5e5;
  --accent: #1a1a1a;
  --accent-light: #404040;
  --success: #22c55e;
  --error: #ef4444;
  --warning: #f59e0b;
  --radius: 12px;
  --radius-sm: 8px;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}

* { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; }

body {
  font-family: var(--font);
  background: var(--bg);
  color: var(--text);
  line-height: 1.5;
  font-size: 15px;
  padding-bottom: 100px;
}

/* 主内容区 - 从顶部开始 */
.main {
  max-width: 680px;
  margin: 0 auto;
  padding: 20px 16px 120px;
}

/* 页面标题 */
.page-header {
  margin-bottom: 24px;
}

.page-title {
  font-size: 26px;
  font-weight: 600;
  letter-spacing: -0.5px;
  margin-bottom: 4px;
}

.page-subtitle {
  color: var(--text-muted);
  font-size: 14px;
}

/* 搜索栏 */
.search-box {
  position: relative;
  margin-bottom: 20px;
}

.search-input {
  width: 100%;
  padding: 12px 16px 12px 44px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 15px;
  background: var(--bg-secondary);
  transition: all 0.2s;
}

.search-input:focus {
  outline: none;
  background: var(--bg);
  border-color: var(--accent);
}

.search-icon {
  position: absolute;
  left: 16px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-muted);
  font-size: 16px;
}

.filter-tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 20px;
  overflow-x: auto;
  scrollbar-width: none;
}

.filter-tabs::-webkit-scrollbar { display: none; }

.filter-tab {
  padding: 8px 16px;
  border-radius: 20px;
  font-size: 14px;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border: none;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.2s;
}

.filter-tab:hover {
  color: var(--text);
}

.filter-tab.active {
  background: var(--accent);
  color: white;
}

/* 邮件列表 */
.email-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  background: var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}

.email-item {
  background: var(--bg);
  padding: 16px;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  cursor: pointer;
  transition: background 0.15s;
  position: relative;
}

.email-item:hover {
  background: var(--bg-secondary);
}

.email-item.unread::before {
  content: '';
  position: absolute;
  left: 0;
  top: 20px;
  bottom: 20px;
  width: 3px;
  background: var(--accent);
  border-radius: 0 2px 2px 0;
}

.email-checkbox {
  width: 18px;
  height: 18px;
  margin-top: 2px;
  accent-color: var(--accent);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.2s;
}

.select-mode .email-checkbox {
  opacity: 1;
}

.email-content {
  flex: 1;
  min-width: 0;
}

.email-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 4px;
}

.email-sender {
  font-weight: 500;
  font-size: 15px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.email-time {
  font-size: 13px;
  color: var(--text-muted);
  white-space: nowrap;
}

.email-subject {
  color: var(--text-secondary);
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 4px;
}

.email-item.unread .email-subject {
  color: var(--text);
  font-weight: 500;
}

.email-preview {
  color: var(--text-muted);
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 空状态 */
.empty-state {
  text-align: center;
  padding: 80px 20px;
  color: var(--text-muted);
}

.empty-icon {
  font-size: 48px;
  margin-bottom: 16px;
  opacity: 0.5;
}

.empty-title {
  font-size: 16px;
  font-weight: 500;
  color: var(--text);
  margin-bottom: 8px;
}

/* 邮件详情 */
.email-detail {
  background: var(--bg);
  border-radius: var(--radius);
  border: 1px solid var(--border);
  overflow: hidden;
}

.email-detail-header {
  padding: 20px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
}

.email-detail-subject {
  font-size: 20px;
  font-weight: 600;
  line-height: 1.4;
  margin-bottom: 12px;
}

.email-detail-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 13px;
  color: var(--text-secondary);
}

.email-detail-body {
  padding: 20px;
  line-height: 1.8;
}

.email-detail-body img {
  max-width: 100%;
  height: auto;
  border-radius: var(--radius-sm);
}

/* 日志页面 */
.logs-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.log-item {
  padding: 14px 16px;
  background: var(--bg-secondary);
  border-radius: var(--radius-sm);
  font-size: 13px;
}

.log-header {
  display: flex;
  gap: 10px;
  margin-bottom: 6px;
  align-items: center;
}

.log-time {
  color: var(--text-muted);
  font-family: monospace;
  font-size: 12px;
}

.log-type {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
}

.log-type-receive { background: #dbeafe; color: #1e40af; }
.log-type-parse { background: #dcfce7; color: #166534; }
.log-type-read { background: #f3e8ff; color: #7c3aed; }
.log-type-delete { background: #fee2e2; color: #991b1b; }
.log-type-error { background: #fecaca; color: #7f1d1d; }
.log-type-request { background: var(--border); color: var(--text-secondary); }

.log-content {
  color: var(--text);
  line-height: 1.5;
}

.log-details {
  color: var(--text-muted);
  font-size: 12px;
  margin-top: 4px;
  font-family: monospace;
}

/* ========== Koobai 风格底部悬浮栏 ========== */
.floating-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 1000;
  padding: 12px 16px calc(12px + env(safe-area-inset-bottom));
  background: rgba(255, 255, 255, 0.85);
  backdrop-filter: saturate(180%) blur(20px);
  -webkit-backdrop-filter: saturate(180%) blur(20px);
  border-top: 1px solid rgba(0, 0, 0, 0.06);
}

.floating-bar-inner {
  max-width: 680px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.floating-divider {
  width: 1px;
  height: 24px;
  background: var(--border);
  margin: 0 4px;
}

.floating-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 8px 16px;
  border-radius: 12px;
  font-size: 12px;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
  transition: all 0.2s;
  text-decoration: none;
  position: relative;
  min-width: 56px;
}

.floating-btn:hover {
  color: var(--text);
  background: rgba(0, 0, 0, 0.04);
}

.floating-btn.active {
  color: var(--accent);
  background: rgba(0, 0, 0, 0.08);
}

.floating-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.floating-btn .icon {
  font-size: 20px;
  line-height: 1;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.floating-btn .count {
  position: absolute;
  top: 4px;
  right: 8px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  background: var(--accent);
  color: white;
  font-size: 10px;
  font-weight: 600;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 响应式 */
@media (max-width: 480px) {
  .main { padding: 16px 12px 100px; }
  .page-title { font-size: 22px; }
  .floating-btn { padding: 6px 12px; min-width: 48px; }
  .floating-btn .icon { font-size: 18px; height: 22px; }
}
</style>
</head>
<body>

<main class="main">
  ${content}
</main>

<!-- Koobai 风格底部悬浮栏 -->
<div class="floating-bar">
  <div class="floating-bar-inner">
    ${navButtons.map(btn => `
      <a href="${btn.href}" ${btn.external ? 'target="_blank"' : ''}
         class="floating-btn ${btn.active ? 'active' : ''}" data-nav="${btn.id}">
        <span class="icon">${btn.icon}</span>
        <span>${btn.label}</span>
      </a>
    `).join('')}

    ${actionButtons.length > 0 ? '<div class="floating-divider"></div>' : ''}

    ${actionButtons.map(btn => `
      <button class="floating-btn" id="${btn.id}Btn" onclick="${btn.onclick}"
              ${btn.disabled ? 'disabled' : ''}>
        <span class="icon">${btn.icon}</span>
        <span>${btn.label}</span>
        ${btn.count ? `<span class="count" id="${btn.id}Count" style="display:none">0</span>` : ''}
      </button>
    `).join('')}
  </div>
</div>

<script>
  // 选择模式状态
  let selectMode = false;
  let selectedIds = new Set();

  // 切换选择模式
  function toggleSelectMode() {
    selectMode = !selectMode;
    const list = document.querySelector('.email-list');
    const btn = document.getElementById('selectBtn');

    if (selectMode) {
      list.classList.add('select-mode');
      btn.classList.add('active');
      btn.querySelector('.icon').textContent = '☑';
    } else {
      list.classList.remove('select-mode');
      btn.classList.remove('active');
      btn.querySelector('.icon').textContent = '☐';
      document.querySelectorAll('.email-checkbox').forEach(cb => cb.checked = false);
      selectedIds.clear();
      updateActionButtons();
    }
  }

  // 更新选择
  function updateSelection() {
    selectedIds = new Set();
    document.querySelectorAll('.email-checkbox:checked').forEach(cb => {
      selectedIds.add(cb.value);
    });
    updateActionButtons();
  }

  // 更新按钮状态
  function updateActionButtons() {
    const count = selectedIds.size;
    const readBtn = document.getElementById('readBtn');
    const deleteBtn = document.getElementById('deleteBtn');
    const readCount = document.getElementById('readCount');
    const deleteCount = document.getElementById('deleteCount');

    if (readBtn) readBtn.disabled = count === 0;
    if (deleteBtn) deleteBtn.disabled = count === 0;

    if (count > 0) {
      if (readCount) { readCount.textContent = count; readCount.style.display = 'flex'; }
      if (deleteCount) { deleteCount.textContent = count; deleteCount.style.display = 'flex'; }
    } else {
      if (readCount) readCount.style.display = 'none';
      if (deleteCount) deleteCount.style.display = 'none';
    }
  }

  // 标记已读
  async function markSelectedRead() {
    if (selectedIds.size === 0) return;
    const res = await fetch('/api/mark-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: Array.from(selectedIds) })
    });
    if (res.ok) location.reload();
  }

  // 删除邮件
  async function deleteSelected() {
    if (selectedIds.size === 0) return;
    if (!confirm('确定要删除 ' + selectedIds.size + ' 封邮件吗？')) return;
    const res = await fetch('/api/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: Array.from(selectedIds) })
    });
    if (res.ok) location.reload();
  }

  // 删除单封邮件
  async function deleteEmail(id) {
    if (!confirm('确定要删除这封邮件吗？')) return;
    const res = await fetch('/api/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id] })
    });
    if (res.ok) location.href = '/';
  }

  // 过滤切换
  function setFilter(filter) {
    const search = document.querySelector('.search-input')?.value || '';
    location.href = '/?filter=' + filter + (search ? '&search=' + encodeURIComponent(search) : '');
  }

  // 搜索
  function doSearch() {
    const search = document.querySelector('.search-input').value;
    const activeFilter = document.querySelector('.filter-tab.active');
    const filter = activeFilter ? activeFilter.dataset.filter : 'all';
    location.href = '/?search=' + encodeURIComponent(search) + '&filter=' + filter;
  }

  // 清空日志
  async function clearLogs() {
    if (!confirm('确定要清空所有日志吗？')) return;
    await fetch('/api/clear-logs', { method: 'POST' });
    location.reload();
  }

  // 初始化
  document.addEventListener('DOMContentLoaded', function() {
    // 搜索框回车
    const searchInput = document.querySelector('.search-input');
    if (searchInput) {
      searchInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter') doSearch();
      });
    }

    // 邮件项点击
    document.querySelectorAll('.email-item').forEach(item => {
      item.addEventListener('click', function(e) {
        if (selectMode && e.target.type !== 'checkbox') {
          e.preventDefault();
          const cb = this.querySelector('.email-checkbox');
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

function renderEmailList(emails, search, filter, stats) {
  const emailItems = emails.map(email => {
    const preview = (email.content_text || '').substring(0, 80).replace(/\s+/g, ' ');
    return `
      <div class="email-item ${!email.is_read ? 'unread' : ''}" data-id="${email.id}">
        <input type="checkbox" class="email-checkbox" value="${email.id}" onclick="event.stopPropagation(); updateSelection();">
        <div class="email-content" onclick="if(!selectMode) location.href='/view/${email.id}'">
          <div class="email-header">
            <span class="email-sender">${escapeHtml(email.sender_name || email.sender || '未知')}</span>
            <span class="email-time">${formatTime(email.date_sent)}</span>
          </div>
          <div class="email-subject">${escapeHtml(email.subject || '(无主题)')}</div>
          <div class="email-preview">${escapeHtml(preview)}</div>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="page-header">
      <h1 class="page-title">收件箱</h1>
      <p class="page-subtitle">${stats.total} 封邮件 · ${stats.unread} 封未读</p>
    </div>

    <div class="search-box">
      <span class="search-icon">⌕</span>
      <input type="text" class="search-input" placeholder="搜索邮件..." value="${escapeHtml(search)}">
    </div>

    <div class="filter-tabs">
      <button class="filter-tab ${filter === 'all' ? 'active' : ''}" data-filter="all" onclick="setFilter('all')">全部</button>
      <button class="filter-tab ${filter === 'unread' ? 'active' : ''}" data-filter="unread" onclick="setFilter('unread')">未读</button>
      <button class="filter-tab ${filter === 'read' ? 'active' : ''}" data-filter="read" onclick="setFilter('read')">已读</button>
    </div>

    ${emails.length > 0 ? `
      <div class="email-list">
        ${emailItems}
      </div>
    ` : `
      <div class="empty-state">
        <div class="empty-icon">📭</div>
        <div class="empty-title">没有邮件</div>
        <p>收件箱是空的</p>
      </div>
    `}
  `;
}

// ============ 邮件详情渲染 ============

function renderEmailDetail(email) {
  const content = email.content_html || `<pre style="white-space:pre-wrap;font-family:inherit;line-height:1.6">${escapeHtml(email.content_text || '')}</pre>`;

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
      <div class="email-detail-body">
        ${content}
      </div>
    </div>
  `;
}

// ============ 日志页面渲染 ============

function renderLogsContent(logs) {
  return `
    <div class="page-header">
      <h1 class="page-title">系统日志</h1>
      <p class="page-subtitle">最近 ${logs.length} 条操作记录</p>
    </div>

    <div class="logs-list">
      ${logs.length > 0 ? logs.map(log => `
        <div class="log-item">
          <div class="log-header">
            <span class="log-time">${formatShortTime(log.timestamp)}</span>
            <span class="log-type log-type-${log.type}">${log.type}</span>
          </div>
          <div class="log-content">${escapeHtml(log.action)}</div>
          ${log.details ? `<div class="log-details">${escapeHtml(JSON.stringify(log.details).substring(0, 100))}</div>` : ''}
        </div>
      `).join('') : `
        <div class="empty-state">
          <div class="empty-icon">◈</div>
          <div class="empty-title">暂无日志</div>
        </div>
      `}
    </div>
  `;
}

function renderErrorPage(message) {
  return renderCleanPage({
    title: '错误',
    content: `
      <div class="empty-state" style="padding-top:100px">
        <div class="empty-icon">⚠</div>
        <div class="empty-title">出错了</div>
        <p>${escapeHtml(message)}</p>
      </div>
    `
  });
}

// ============ 工具函数 ============

function formatTime(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  const now = new Date();
  const diff = now - date;

  if (diff < 24 * 60 * 60 * 1000 && now.getDate() === date.getDate()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  if (now.getFullYear() === date.getFullYear()) {
    return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  }
  return date.toLocaleDateString('zh-CN', { year: '2-digit', month: 'numeric', day: 'numeric' });
}

function formatFullTime(dateString) {
  if (!dateString) return '';
  return new Date(dateString).toLocaleString('zh-CN');
}

function formatShortTime(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// ============ API 处理函数 ============

async function getEmails(search, filter, env) {
  try {
    let query = 'SELECT * FROM emails WHERE is_deleted = 0';
    let params = [];

    if (filter === 'unread') query += ' AND is_read = 0';
    else if (filter === 'read') query += ' AND is_read = 1';

    if (search) {
      query += ' AND (subject LIKE ? OR content_text LIKE ? OR sender LIKE ?)';
      params.push('%' + search + '%', '%' + search + '%', '%' + search + '%');
    }

    query += ' ORDER BY date_sent DESC';

    const { results } = await env.DB.prepare(query).bind(...params).all();
    return results || [];
  } catch (error) {
    addLog('error', '获取邮件失败', { error: error.message });
    return [];
  }
}

async function getEmailStats(env) {
  try {
    const total = await env.DB.prepare('SELECT COUNT(*) as count FROM emails WHERE is_deleted = 0').first();
    const unread = await env.DB.prepare('SELECT COUNT(*) as count FROM emails WHERE is_deleted = 0 AND is_read = 0').first();
    return { total: total?.count || 0, unread: unread?.count || 0 };
  } catch (error) {
    return { total: 0, unread: 0 };
  }
}

async function handleApiEmails(request, env) {
  const url = new URL(request.url);
  const emails = await getEmails(
    url.searchParams.get('search') || '',
    url.searchParams.get('filter') || 'all',
    env
  );
  return new Response(JSON.stringify(emails), { headers: { 'Content-Type': 'application/json' } });
}

async function handleMarkRead(request, env) {
  const data = await request.json();
  try {
    if (data.ids && Array.isArray(data.ids)) {
      const ids = data.ids.map(id => parseInt(id)).filter(id => !isNaN(id));
      if (ids.length) {
        const placeholders = ids.map(() => '?').join(',');
        await env.DB.prepare(`UPDATE emails SET is_read = 1 WHERE id IN (${placeholders})`).bind(...ids).run();
        addLog('read', `标记已读 ${ids.length} 封`, { ids });
      }
    } else if (data.id) {
      const id = parseInt(data.id);
      if (!isNaN(id)) {
        await env.DB.prepare('UPDATE emails SET is_read = 1 WHERE id = ?').bind(id).run();
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
    if (data.ids && Array.isArray(data.ids)) {
      const ids = data.ids.map(id => parseInt(id)).filter(id => !isNaN(id));
      if (ids.length) {
        const placeholders = ids.map(() => '?').join(',');
        await env.DB.prepare(`UPDATE emails SET is_deleted = 1 WHERE id IN (${placeholders})`).bind(...ids).run();
        addLog('delete', `删除 ${ids.length} 封`, { ids });
      }
    }
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    addLog('error', '删除失败', { error: error.message });
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500 });
  }
}

async function handleRestoreEmail(request, env) {
  const data = await request.json();
  try {
    if (data.ids) {
      const ids = data.ids.map(id => parseInt(id)).filter(id => !isNaN(id));
      const placeholders = ids.map(() => '?').join(',');
      await env.DB.prepare(`UPDATE emails SET is_deleted = 0 WHERE id IN (${placeholders})`).bind(...ids).run();
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

  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>MailBox</title>
<link>https://email.zjyyy.top</link>
<description>邮件订阅</description>
${items}
</channel>
</rss>`;

  return new Response(rss, { headers: { 'Content-Type': 'application/rss+xml' } });
}

async function handleApiLogs(request, env) {
  return new Response(JSON.stringify(operationLogs), { headers: { 'Content-Type': 'application/json' } });
}

async function handleClearLogs(request, env) {
  operationLogs = [];
  return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleDebug(request, env) {
  const stats = await getEmailStats(env);
  return new Response(JSON.stringify({ success: true, stats, logs: operationLogs.length }), {
    headers: { 'Content-Type': 'application/json' }
  });
}