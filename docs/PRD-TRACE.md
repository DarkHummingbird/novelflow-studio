# PRD v4.0 → 代码映射表

> 用于交接验收：每条需求指向实现位置与当前状态。状态含义：
> ✅ 已实现并可用 ｜ 🟡 部分实现（已注明差异） ｜ ⬜ 未实现（规划在 v5.0）

## §1.3 版本能力边界矩阵

| 需求 | 状态 | 实现位置 | 备注 |
| --- | --- | --- | --- |
| 纯前端单页工作台 | ✅ | `src/App.tsx` + `components/*` | 另有单文件构建 `dist/novelflow-studio-standalone.html` |
| 双模输入切换 | ✅ / 🟡 | `components/LeftPanel.tsx` | 文本直入完整可用；录屏通道为界面演示 + 文本粘贴 |
| 字数与卡点比例自动诊断 | ✅ | `lib/text.ts` `countWords`、`lib/router.ts` `resolveLengthTier` | 口径：非空白字符数，与平台后台一致 |
| 六大卡点诱饵识别 | ✅ | `lib/text.ts` `classifyBait` | 三级探针：末尾 300 字 → 400 字 → 1,200 字 |
| 起承转合可编辑蓝图 | ✅ | `components/BlueprintPanel.tsx`、`lib/router.ts` `buildSegmentPlan` | 点任意拍点即可编辑，写作阶段按新细纲执行 |
| 走向指令注入 | ✅ | `LeftPanel` + `lib/pipeline.ts` prompt 组装 | 走单 chip 或自由输入 |
| 三档续写字数 | ✅ | `config/presets.ts` `TARGET_TIERS` | 5,500 / 7,500 / 9,500 |
| 滑动窗口分章续写 | ✅ | `lib/pipeline.ts` `contextWindow` | ≤5,500 首段注入全文；否则 Bible + 摘要 + 尾 1,500 字 |
| 套话高亮检测 | ✅ | `components/ReaderPanel.tsx` `withHighlight` | 21 条黑名单，正文中标注并附 title |
| 六道商业门禁 | ✅ | `lib/gates.ts` `evaluateGates` | 判定权在代码；每条有单测 |
| 单段局部重写 | ✅ | `lib/pipeline.ts` `rewriteOneSegment` | 只重写目标段并立即重跑门禁 |
| BYOK 多协议直连 | ✅ | `lib/api.ts` | Gemini 原生 / OpenAI 兼容，SSE 流式、重试、超时、错误映射 |
| localStorage 配置持久化 | ✅ | `App.tsx` `persistApiConfig` | 默认 sessionStorage；可选 localStorage |
| 双视图切换 | ✅ | `components/TopBar.tsx` + 各面板条件渲染 | 架构师视图额外暴露契约与记忆窗口 |
| 上下游 JSON 交接检视 | ✅ | `components/Modals.tsx` `AgentInspector` | 系统提示词 / 输出契约 / 实时载荷 / 挂载技能 |
| 视频抽帧模拟演示 | 🟡 | `LeftPanel` 抽帧演示块 | 图形化演示 + 明确标注「真实 OCR 属 v5.0」 |
| IndexedDB 多项目 / 快照 / 断点 | ✅ | `lib/idb.ts` + `hooks/useProjectStore.ts` | 自动保存（防抖 800ms）、20 个快照/项目、内存降级 |
| 后端 FastAPI / 代理 / 配额 | ⬜ | — | v5.0 |

## §2 领域规则

| 需求 | 状态 | 实现位置 |
| --- | --- | --- |
| 黄金篇幅配比（导语/卡点前/卡点/卡点后） | 🟡 | `lib/router.ts` `buildSegmentPlan` 按 27% / 40% / 33% 分配 |
| 前 800 字即时兑现 | ✅ | 门禁 `instant_payoff_800_ok` + 写作 prompt 红线 |
| 每 600–800 字小钩子 | 🟡 | 写入提示词约束，无逐节拍自动校验 |
| 终局 300–500 字清算 + 金句 | ✅ | 门禁 `golden_ending_ok` |
| 六诱饵分类 | ✅ | `BAIT_RULES`（6 条正则，带机制与兑现指令） |

## §3 体量自适应三档路由

| 前文区间 | 状态 | 行为 |
| --- | --- | --- |
| < 2,500 字 → `EARLY_SETUP_UNDER_2500` | ✅ | 第 1 段改为「蓄势 → 推高至主卡点 → 当场引爆」 |
| 2,500–6,000 字 → `STANDARD_PAYWALL_30_45_PCT` | ✅ | 标准三段式，前 800 字强兑现 |
| > 6,000 字 → `LONG_FORM_SERIAL_OVER_6000` | 🟡 | Arc Unit 已端到端验证（7,248 字输入 → 2 个单元 → 2/2 PASS → Markdown 导出）；缺 Map-Reduce 伏笔账本 |

判定函数：`lib/router.ts` `resolveLengthTier`（边界：2,500 / 6,000，含单测）。

## §4 Agent 契约

| Agent | System Prompt | 契约字段 | 真实调用 | 归一化 |
| --- | --- | --- | --- | --- |
| 01 摄取 | `config/agentSpecs.ts`（逐字对齐 PRD） | `source_type / cleaned_text / total_char_count / length_tier / ending_anchor / paywall_detected` | ✅（≤6,000 字时；超长跳过以控成本） | `normalize.ts` `coerceAgent1`：正文被压缩 → 回退确定性清洗；字数/档位一律以代码为准 |
| 02 主编 | ✅ | `story_bible{...} / segment_outlines[]` | ✅ | `coerceAgent2`：缺拍点补兜底、段数不足整包回退、目标字数偏差 >25% 重分配 |
| 03 主笔 | ✅ | 纯文本正文 | ✅（流式） | `writeWithLLM`：不足 92% 自动微步长续写，最多 4 次 |
| 04 门禁 | ✅（可选复审） | `status / actual_word_count / gates / cliche_hits / golden_quote_extracted / revision_instructions / summary_for_next_segment` | ✅ 确定性 + 可选 LLM | `mergeLLMReview`：模型不能推翻代码 FAIL |

## §5 超长文本四项机制

| 机制 | 状态 | 说明 |
| --- | --- | --- |
| Map-Reduce 增量压缩（Living Story Bible） | ⬜ | 当前为逐段确定性摘要，无 OPEN/RESOLVED 伏笔账本 |
| Arc Unit 循环 | ✅ | `buildSegmentPlan` 长篇分支，2–6 个单元 |
| 1,200–1,500 字微步长接力 | ✅ | `planMicroSteps` + `writeWithLLM` 续写循环；局部重写 `rewriteOneSegment` 同样带接力循环；每次提取尾 400–700 字作下一棒锚点 |
| 分步持久化 / 断点续写 | ✅ | 每段完成即回调 UI 写 IndexedDB；启动自动恢复最近项目 |

## §6 交互与视觉规范

| 需求 | 状态 | 实现 |
| --- | --- | --- |
| Editorial Studio 色彩体系 | ✅ | `src/index.css` `@theme` 令牌（paper #FAF9F6 / ink #1C1917 / line #E7E5E4 / amber / emerald） |
| 正文 1.85 行高、暖纸白、细边框 | ✅ | `nf-prose`、`Panel` |
| 双视图权限分层 | ✅ | 创作视图隐藏 JSON 与记忆窗口提示 |
| 非对称 3:4:5 三栏 + 左栏折叠为 5:7 | ✅ | `App.tsx` 25% / 31% / flex，折叠后 42% / flex |
| 蓝图 Enter 快捷保存 | ✅ | `BlueprintPanel` `onKeyDown` Enter 保存 / Esc 取消 |
| AI 套话高亮开关 | ✅ | `ReaderPanel` `highlight` |
| 单段局部重写抽屉 | ✅ | `ReaderPanel` 内联编辑区 |
| BYOK 一键预设 + Ping Test + 仿真回退 | ✅ | `Modals.tsx` `ApiModal` + `api.ts` `pingLLM` |

## 与 PRD 的已知偏差（交接必读）

1. **字数口径**：PRD 写「净中文字符数」，实现采用「非空白字符数（含标点）」，与番茄/知乎后台显示一致；门禁阈值同口径，不影响判定逻辑。
2. **示例样本**：PRD 称 4,200 字，实际补足为 3,364 字（落在 2,500–6,000 黄金区间）。示例脚本模式下三段目标字数会按脚本实际长度校准，避免假 REJECT。
3. **Agent 01 的 LLM 清洗**：前文 >6,000 字时跳过（成本控制），直接使用确定性清洗，日志会说明。
4. **LLM 复审**：默认关闭（每段多一次调用）；开启后仍以代码判定为准。
