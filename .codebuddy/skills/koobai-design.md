# Koobai.com UI 设计规范 (完整版)

## 概述
Koobai.com 是一个使用 Hugo 构建的个人博客，采用极简主义设计风格。底部固定导航栏是其标志性设计元素。

## 技术栈
- **静态生成器**: Hugo
- **部署**: GitHub → 宝塔自动部署
- **图标库**: [Lucide Icons](https://lucide.dev/)
- **图片存储**: 又拍云

## 色彩系统

### 主色调
| 名称 | 色值 | 用途 |
|------|------|------|
| 页面背景 | `#f2f0eb` / `rgb(242, 240, 235)` | 页面主背景 |
| 卡片背景 | `#fffdfa` / `rgb(255, 253, 250)` | 内容卡片 |
| 主文字 | `#222222` / `rgb(34, 34, 34)` | 标题、正文 |
| 次要文字 | `#444444` / `rgb(68, 68, 68)` | 普通链接、正文 |
| 弱化文字 | `#a7a7a7` / `rgb(167, 167, 167)` | 时间、元信息 |

### 强调色
| 名称 | 色值 | 用途 |
|------|------|------|
| 强调色/当前项 | `#994d61` / `rgb(153, 77, 97)` | 当前导航项、强调元素 |
| 装饰色 | `#b8aba2` / `rgb(184, 171, 162)` | 装饰元素 |
| 半透明遮罩 | `rgba(85, 82, 78, 0.6)` | 遮罩层 |

### 导航栏特殊色
| 名称 | 色值 | 用途 |
|------|------|------|
| 导航背景 | `rgba(242, 240, 235, 0.5)` | 底部导航栏背景 |
| 磨砂效果 | `blur(20px) saturate(1.8)` | backdrop-filter |
| 阴影 | `rgba(0,0,0,0.1) 0px 0px 1px, rgba(0,0,0,0.12) 0px 10px 30px` | 导航栏阴影 |

## 字体系统

### 字体栈
```css
font-family: JetBrainsMono, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Ubuntu, "Helvetica Neue", Helvetica, "PingFang SC", "Hiragino Sans GB", "Microsoft Yahei", sans-serif;
```

### 字体层级
| 元素 | 字号 | 字重 | 行高 | 颜色 | 用途 |
|------|------|------|------|------|------|
| 页面标题 | 28-32px | 600 | 1.4 | #222222 | 页面主标题 |
| 卡片标题 | 18-20px | 500 | 1.6 | #222222 | 文章标题 |
| 导航项 | 12.8px | 400 | normal | #444444/#994d61 | 底部导航 |
| 正文 | 16px | 400 | 1.7 | #444444 | 普通内容 |
| 小字/时间 | 13-14px | 400 | 1.5 | #a7a7a7 | 辅助信息 |

## 图标系统

### 使用 Lucide Icons
```html
<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-[icon-name]">
  <!-- icon paths -->
</svg>
```

### 常用图标
| 图标 | 名称 | 用途 |
|------|------|------|
| 🐦 | `lucide-bird` | 首页/Logo |
| ✉ | `lucide-mail` | 邮件/消息 |
| 🏠 | `lucide-home` | 首页 |
| 📄 | `lucide-file-text` | 文档/文章 |
| ⚙ | `lucide-settings` | 设置 |
| 🗑 | `lucide-trash-2` | 删除 |
| ✓ | `lucide-check` | 确认/已读 |
| ◈ | `lucide-activity` | 日志/活动 |
| ◎ | `lucide-rss` | 订阅 |
| ☰ | `lucide-menu` | 菜单 |

## 间距系统

### 页面间距
| 元素 | 数值 | 用途 |
|------|------|------|
| 容器最大宽度 | 600-800px | 内容区域 |
| 容器边距 | auto (居中) | 水平居中 |
| 页面内边距 | 24px | 主容器内边距 |
| 移动端内边距 | 16px | 小屏幕适配 |

### 组件间距
| 元素 | 数值 | 用途 |
|------|------|------|
| 导航项间距 | 40px | 底部导航项之间 |
| 卡片间距 | 16-20px | 列表项之间 |
| 卡片内边距 | 20-24px | 卡片内部 |
| 元素间距 | 12-16px | 内部元素 |

## 圆角系统
| 元素 | 数值 | 用途 |
|------|------|------|
| 导航栏 | 50px | 底部导航（胶囊形） |
| 大卡片 | 16px | 内容卡片 |
| 小卡片 | 12px | 小组件 |
| 按钮 | 40px | 按钮选中状态 |

## 底部导航栏规范

### 容器样式
```css
.header {
  position: fixed;
  bottom: 30px;
  left: 50%;
  transform: translateX(-50%);
  width: 600px;
  max-width: 600px;
  background: rgba(242, 240, 235, 0.5);
  backdrop-filter: blur(20px) saturate(1.8);
  -webkit-backdrop-filter: blur(20px) saturate(1.8);
  border-radius: 50px;
  padding: 20px 30px;
  box-shadow: rgba(0, 0, 0, 0.1) 0px 0px 1px 0px, 
              rgba(0, 0, 0, 0.12) 0px 10px 30px 0px;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: center;
}
```

### 导航菜单
```css
.menu {
  display: flex;
  gap: 40px;
  align-items: center;
}
```

### 导航项
```css
.nav-item {
  font-size: 12.8px;
  color: #444444;
  text-decoration: none;
  padding: 0;
  background: transparent;
  border: none;
  cursor: pointer;
  transition: color 0.2s ease;
}

.nav-item:hover {
  color: #994d61;
}

.nav-item.current {
  color: #994d61;
}
```

### 菜单图标
```css
.menu-icon {
  display: inline-flex;
  align-items: center;
  margin-right: 6px;
}

.menu-icon svg {
  width: 20px;
  height: 20px;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
```

## 内容卡片规范

### 卡片容器
```css
.card {
  background: #fffdfe;
  border-radius: 16px;
  padding: 20px;
  margin-bottom: 16px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  transition: all 0.2s ease;
}

.card:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 24px rgba(0,0,0,0.08);
}
```

### 卡片标题
```css
.card-title {
  font-size: 18px;
  font-weight: 500;
  color: #222222;
  line-height: 1.6;
  margin-bottom: 8px;
}
```

### 卡片正文
```css
.card-content {
  font-size: 16px;
  color: #444444;
  line-height: 1.7;
}
```

## 交互规范

### 过渡效果
| 状态 | 属性 | 时间 | 缓动 |
|------|------|------|------|
| 默认过渡 | all | 0.2s | ease |
| 悬停阴影 | box-shadow | 0.2s | ease |
| 位移效果 | transform | 0.2s | ease |

### 悬停效果
- 卡片悬停: `transform: translateY(-2px)` + 阴影加深
- 链接悬停: 颜色变为 `#994d61`
- 按钮悬停: 背景变为 `rgba(0,0,0,0.06)`

### 阴影层级
| 状态 | 阴影 |
|------|------|
| 默认卡片 | `0 1px 3px rgba(0,0,0,0.04)` |
| 悬停卡片 | `0 8px 24px rgba(0,0,0,0.08)` |
| 导航栏 | `rgba(0,0,0,0.1) 0px 0px 1px, rgba(0,0,0,0.12) 0px 10px 30px` |

## 响应式断点
| 断点 | 宽度 | 调整 |
|------|------|------|
| 桌面 | > 768px | 默认样式 |
| 平板 | 768px | 导航栏宽度调整 |
| 手机 | < 600px | 导航栏全宽，内边距减小 |

## 布局原则
1. **无顶部导航栏**: 页面从内容直接开始
2. **底部固定导航**: 胶囊形磨砂导航栏
3. **大量留白**: 宽松的内边距和间距
4. **卡片式内容**: 圆角卡片组织内容
5. **清晰层级**: 通过字号、颜色、间距建立视觉层级
6. **微妙交互**: 柔和的悬停和点击反馈

## 使用建议
1. 导航项使用 Lucide 图标 + 文字的组合
2. 当前页面导航项使用强调色 `#994d61`
3. 保持底部导航栏始终可见
4. 卡片悬停时添加轻微上浮效果
5. 避免使用过于鲜艳的颜色
6. 保持文字排版清晰易读
