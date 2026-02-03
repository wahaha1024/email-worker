# Koobai.com UI 设计规范

## 概述
Koobai.com 采用极简主义设计风格，以米白色为主调，配合透明磨砂玻璃效果，营造现代、清爽的浏览体验。

## 色彩系统

### 主色调
| 名称 | 色值 | 用途 |
|------|------|------|
| 页面背景 | `#f2f0eb` / `rgb(242, 240, 235)` | 页面主背景 |
| 卡片背景 | `#fffdfe` / `rgb(255, 253, 250)` | 内容卡片、容器 |
| 主文字 | `#222222` / `rgb(34, 34, 34)` | 标题、正文 |
| 次要文字 | `#666666` | 辅助信息 |
| 弱化文字 | `#999999` | 时间、元信息 |

### 强调色
| 名称 | 色值 | 用途 |
|------|------|------|
| 强调色 | `#994d61` / `rgb(153, 77, 97)` | 按钮、链接高亮 |
| 选中背景 | `rgba(0, 0, 0, 0.1)` | 选中状态背景 |
| 悬停背景 | `rgba(0, 0, 0, 0.06)` | 悬停状态背景 |

### 导航栏特殊色
| 名称 | 色值 | 用途 |
|------|------|------|
| 导航背景 | `rgba(242, 240, 235, 0.5)` | 底部导航栏背景 |
| 磨砂效果 | `blur(20px) saturate(1.8)` | 背景模糊 |
| 阴影 | `rgba(0,0,0,0.1) 0px 0px 1px, rgba(0,0,0,0.12) 0px 10px 30px` | 导航栏阴影 |

## 字体系统

### 字体栈
```css
font-family: JetBrainsMono, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Ubuntu, "Helvetica Neue", Helvetica, PingFangSC-Regular, "Hiragino Sans GB", "Lantinghei SC", "Microsoft Yahei", "Source Han Sans CN", "WenQuanYi Micro Hei", SimSun, sans-serif;
```

### 字体层级
| 元素 | 字号 | 字重 | 行高 | 用途 |
|------|------|------|------|------|
| 页面标题 | 28-32px | 600 | 1.4 | 页面主标题 |
| 卡片标题 | 17.6px | 500 | 29.92px | 邮件/文章标题 |
| 正文 | 16px | 400 | normal | 普通内容 |
| 小字 | 14px | 400 | 1.5 | 辅助信息、时间 |
| 标签 | 12px | 400 | 1.4 | 底部导航标签 |

## 间距系统

### 页面间距
| 元素 | 数值 | 用途 |
|------|------|------|
| 容器最大宽度 | 800px | 内容区域 |
| 页面内边距 | 24px | 主容器内边距 |
| 移动端内边距 | 16px | 小屏幕适配 |

### 组件间距
| 元素 | 数值 | 用途 |
|------|------|------|
| 卡片间距 | 16-20px | 列表项之间 |
| 卡片内边距 | 16-20px | 卡片内部 |
| 网格间距 | 6px | 网格布局 |

## 圆角系统
| 元素 | 数值 | 用途 |
|------|------|------|
| 导航栏 | 50px | 底部导航（胶囊形） |
| 卡片 | 16px | 内容卡片 |
| 小卡片 | 12px | 小组件 |
| 按钮 | 40px | 导航按钮（选中状态） |

## 组件规范

### 底部导航栏
```css
.bottom-nav {
  position: fixed;
  bottom: 30px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(242, 240, 235, 0.5);
  backdrop-filter: blur(20px) saturate(1.8);
  -webkit-backdrop-filter: blur(20px) saturate(1.8);
  border-radius: 50px;
  padding: 12px 20px;
  box-shadow: rgba(0, 0, 0, 0.1) 0px 0px 1px 0px, 
              rgba(0, 0, 0, 0.12) 0px 10px 30px 0px;
  display: flex;
  align-items: center;
  gap: 4px;
}
```

### 导航按钮
```css
.nav-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 10px 20px;
  border-radius: 40px;
  font-size: 12px;
  color: #666666;
  background: transparent;
  transition: all 0.2s ease;
}

.nav-btn:hover {
  background: rgba(0, 0, 0, 0.06);
}

.nav-btn.active {
  background: rgba(0, 0, 0, 0.1);
  color: #222222;
}
```

### 内容卡片
```css
.card {
  background: #fffdfe;
  border-radius: 16px;
  padding: 16px 20px;
  margin-bottom: 16px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  transition: all 0.2s ease;
}

.card:hover {
  box-shadow: 0 4px 12px rgba(0,0,0,0.08);
}
```

### 邮件列表项
```css
.email-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 20px;
  background: #fffdfe;
  border-radius: 16px;
  margin-bottom: 12px;
  cursor: pointer;
}

.email-title {
  font-size: 17.6px;
  font-weight: 500;
  color: #222222;
  line-height: 1.7;
}

.email-meta {
  font-size: 14px;
  color: #999999;
}
```

## 交互规范

### 悬停效果
- 背景色变化：`transparent` → `rgba(0,0,0,0.06)`
- 过渡时间：200ms
- 缓动函数：ease

### 选中效果
- 背景色：`rgba(0,0,0,0.1)`
- 文字色：`#222222`
- 圆角：40px

### 阴影层级
| 状态 | 阴影 |
|------|------|
| 默认 | `0 1px 3px rgba(0,0,0,0.04)` |
| 悬停 | `0 4px 12px rgba(0,0,0,0.08)` |
| 导航栏 | `rgba(0,0,0,0.1) 0px 0px 1px, rgba(0,0,0,0.12) 0px 10px 30px` |

## 响应式断点
| 断点 | 宽度 | 调整 |
|------|------|------|
| 桌面 | > 768px | 默认样式 |
| 平板 | 768px | 适当缩小间距 |
| 手机 | < 480px | 内边距 12px，导航栏紧凑 |

## 使用建议
1. 保持大量留白，避免内容拥挤
2. 使用半透明背景创造层次感
3. 交互反馈要柔和，避免突兀
4. 文字层级清晰，重要内容突出
5. 圆角统一，保持视觉一致性
