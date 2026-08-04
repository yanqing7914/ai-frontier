# UI 设计指南

> **设计类型**: App 设计（应用架构设计）
> **确认检查**: 本指南适用于可交互的应用/网站/工具。

> ℹ️ Section 1 为设计意图与决策上下文。Code agent 实现时以 Section 2 及之后的具体参数为准。

## 1. Design Archetype (设计原型)

### 1.1 内容理解

- **目标用户**: 无锡车联天下内部员工（技术/运营），高频查阅 AI 前沿资讯 + 审核数据质量
- **核心目的**: 高效获取高分资讯 + 精准管控采集链路，建立对 AI 情报系统的信任感
- **情绪基调**: 专业克制 / 信息掌控感；避免花哨干扰、数据焦虑

### 1.2 设计方向

- **Design Style**: Grid 网格 — 资讯看板本质是结构化数据流，网格线+等宽数字强化「精密仪器」感，契合多维打分与溯源链路的理性气质
- **Application Type**: Internal Tool / Dashboard — 阅读页重信息密度，工作台重操作效率
- **Aesthetic Direction**: 冷峻精密的数据仪表盘美学，用网格秩序承载海量信息，用低饱和色彩区分8个AI技术方向

## 2. Color System (色彩系统)

**色彩关系**: 深靛蓝主色 + 冷灰蓝底色 + 近黑文字，8方向标签从主色色相偏移生成低饱和色系
**配色设计理由**: 内部工具需长时间使用不疲劳，冷色调降低视觉刺激；靛蓝传递技术专业感，区别于通用SaaS蓝色
**主色推导**: 深靛蓝(H:220)关联「深度智能」语义，用于关键行动(发布/审核)和总分高亮，收敛于CTA按钮与分数数字
**使用比例**: 70% 冷灰白底 / 20% 卡片白+边框 / 10% 靛蓝主色+8方向标签色

### 2.1 主题颜色

| Token                | HSL 值            | 说明                                     |
| -------------------- | ----------------- | ---------------------------------------- |
| `background`         | hsl(220, 20%, 97%) | 冷灰蓝页面底色，降低长时间阅读疲劳       |
| `card`               | hsl(0, 0%, 100%)   | 纯白卡片容器，与背景形成微对比           |
| `foreground`         | hsl(220, 25%, 12%) | 近黑主文字，带靛蓝倾向保持色彩统一       |
| `muted-foreground`   | hsl(220, 12%, 50%) | 次要文字/时间戳/来源名                   |
| `primary`            | hsl(220, 75%, 45%) | 深靛蓝主交互色，CTA/激活态/总分数字      |
| `primary-foreground` | hsl(0, 0%, 100%)   | 主交互文字                               |
| `accent`             | hsl(220, 20%, 93%) | 次级交互反馈(hover/focus/skeleton)       |
| `accent-foreground`  | hsl(220, 25%, 20%) | accent上的文字                           |
| `border`             | hsl(220, 15%, 88%) | 细分隔线与卡片边框                       |

### 2.2 导航区配色

- **基调关系**: 复用主配色系统，顶栏背景取 `background` 同色+底部 `border` 细线分隔，不额外设独立色板
- **关键状态**: 激活项用 `primary` 下划线指示(2px)，hover 态用 `accent` 背景过渡；文字对比度 ≥ 4.5:1
- **边界与背景**: 非透明背景，底部 1px `border` 色细线分隔内容区

### 2.3 语义颜色

| 用途       | HSL 值            | 衍生说明                              |
| ---------- | ----------------- | ------------------------------------- |
| success    | hsl(150, 60%, 40%) | 已发布/健康/溯源成功，绿色系          |
| warning    | hsl(35, 85%, 45%)  | 待审核/AI降级，橙黄深色变体保对比度   |
| error      | hsl(5, 70%, 50%)   | 拦截/异常/失败，红色系                |
| info       | hsl(220, 75%, 45%) | 等同 primary，用于草稿/中性状态提示   |

### 2.4 9方向标签色板

> 从主色 H:220 出发，等距偏移生成9个低饱和色彩，饱和度统一 45-55%，明度统一 55-65%，确保视觉权重一致。
> 旧方向兼容映射：multi→multimodal, infra→infrastructure, eval→data_eval, data→data_eval, security→safety_governance

| 方向                 | HSL 值            | 标签文字色              |
| -------------------- | ----------------- | ----------------------- |
| model                | hsl(265, 48%, 60%) | hsl(265, 55%, 28%)      |
| agent                | hsl(220, 50%, 58%) | hsl(220, 60%, 25%)      |
| multimodal           | hsl(310, 42%, 58%) | hsl(310, 50%, 28%)      |
| coding               | hsl(170, 45%, 48%) | hsl(170, 55%, 22%)      |
| infrastructure       | hsl(195, 50%, 50%) | hsl(195, 60%, 22%)      |
| data_eval            | hsl(45, 55%, 52%)  | hsl(45, 65%, 25%)       |
| safety_governance    | hsl(0, 48%, 58%)   | hsl(0, 58%, 28%)        |
| applications         | hsl(150, 45%, 50%) | hsl(150, 55%, 22%)      |
| business_ecosystem   | hsl(30, 50%, 52%)  | hsl(30, 60%, 25%)       |

## 3. Typography (字体排版)

- **Heading**: Space Grotesk, "PingFang SC", system-ui, sans-serif
- **Body**: Inter, "PingFang SC", system-ui, sans-serif
- **Mono/Score**: JetBrains Mono, "SF Mono", monospace — 总分数字、维度得分、URL、成功率百分比专用
- **字体策略**: Space Grotesk 几何感契合 Grid 风格且支持中文回退；JetBrains Mono 确保数字等宽对齐，强化数据可读性

## 4. Layout Strategy (布局策略)

- **导航意图**: 3个页面需持久切换 → 顶部 Topbar 导航（今日热点/运营工作台/源管理）；至多一套全局导航；非透明背景
- **页面架构**: 单列居中内容流，阅读页 `max-w-4xl` 保证行长可读性，工作台/源管理 `max-w-6xl` 容纳表格宽度
- **响应式**: 移动端筛选标签横向滚动，表格切换为卡片列表；桌面端保持完整网格布局

## 5. Visual Language (视觉语言)

- **形态参数**: 圆角 `rounded-sm (0.125rem)` · 阴影 `shadow-none`(卡片用 1px border 替代) · 间距基调 `compact`
- **识别签名**: 「总分数字用 JetBrains Mono text-3xl font-bold + primary 色」「9方向标签统一胶囊形+各自方向色」「网格辅助线装饰(可选)」
- **装饰策略**: 仅用 1px 网格线和方向标签色彩作为视觉锚点，不使用渐变/插画/图标装饰
- **动效原则**: 状态切换即时响应 150ms ease-out；筛选/排序无页面跳转动画
- **可及性**: 正文对比度 ≥ 4.5:1；方向标签文字色均经过 WCAG AA 校验；交互元素 focus-visible 用 primary ring 2px

## 6. Component Principles (组件原则)

- **状态完整性**: Button/Input/Toggle/Badge 覆盖 Default/Hover/Focus/Active/Disabled；Focus 态用 `ring-2 ring-primary ring-offset-2`
- **层级清晰**: Primary 按钮填充 `bg-primary`；Secondary/Ghost 用 `border-border hover:bg-accent`；总分数字永远是页面最大最醒目的数据元素
- **一致性**: 所有标签(Badge)统一 `rounded-full px-2.5 py-0.5 text-xs font-medium`；表格行高统一 `h-12`；卡片内边距统一 `p-5`
- **源分类体系**: feed_source 按 source_category 分为 8 大类：research_papers/official_releases/open_source_community/eval_data/infrastructure_industry/policy_safety/media_analysis/newsletters_podcasts
- **数据展示**: 数字一律用 JetBrains Mono；百分比/分数右对齐；状态标签左对齐；URL 文本 `truncate` + tooltip 展开

## 7. Image Direction (图片与视觉资产，按需)

- **Image Role**: 无强制图片需求，优先通过排版、网格线条、方向标签色彩和总分数字的大小对比建立视觉记忆点
- **Image Art Direction**: 无
- **Image Prompt Keywords**: 无
- **Image Avoidance**: 禁止使用通用AI芯片/机器人/神经网络插图；禁止科技感渐变背景图；禁止商务人物素材

## 8. 应避免 (Anti-patterns)

- ❌ 给热点卡片加投影或渐变装饰 — 破坏 Grid 风格的精密克制感，增加视觉噪音
- ❌ 8个方向标签使用高饱和纯色 — 长时间阅读刺眼，且与冷峻基调冲突
- ❌ 工作台表格使用斑马纹或彩色行背景 — 语义色已通过状态标签表达，行背景应保持纯净以支撑高密度信息扫描