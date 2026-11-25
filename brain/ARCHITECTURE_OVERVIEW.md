# 外置轨迹认知大脑：跨学科方法论与双项目硬核总述

> **核心一句话**：  
> 我们没有去跟大模型卷参数量，也没有在重造轮子——而是把行为学、心理学和经典计算机科学研究了半个世纪的成熟模型（Event Sourcing、CQRS、BDI、UCB1、TD-λ、BM25、Process Mining Token-Replay），用零依赖软件工程接回 AI Agent 外部，让 Agent 从“每步靠猜的黑盒”变成“0-Token 可学、可审计、可证明还算不算数”的确定性认知系统。

---

## 一、从零发现问题并拼出成熟系统的“六步工程法”

1. **问题翻译**：把模糊的“AI 变笨/失忆/乱跑”，拆成具体结构故障（缺前置状态、重复撞墙、半路掉链、压缩丢约束、老结论改口打架）。
2. **跨学科切片**：用行为学、运筹学和经典 CS 把复杂问题拆成正交小块（感知示能、探索权衡、激活与遗忘、组块与持续性、因果归因、工作/陈述记忆分离）。
3. **对齐高层概念**：拿着每个小块去找学术界和工业界早就定型的高层定义与基准公式，不凭直觉硬编规则。
4. **寻找成熟开源轮子**：复用现成底层身体与标准件（如 `mineflayer`、`minecraft-data`、`prismarine-recipe`、原生 Node 事件流），不做无意义的底层重写。
5. **只改算子、配置与接点**：保持核心物理底座零侵入，把全部智力投入到 **A/B 物理隔离边界、状态分桶、四定义数学算子和裁决账本** 上。
6. **0-Token 回放 + 真机故障注入打磨**：先用确定性边界测试和离线路演验证防死锁、崩溃自愈与收敛性，再入真机抓“假成功/地形误判”，最后才低成本接入大模型。

---

## 二、为什么不是重造轮子？AI 痛点与行为学 / 经典 CS 的精确映射

当前大模型 Agent 反复踩坑的六大难题，其实早在几十年前就已在其他学科给出了标准答案：

| 问题小块 | 行为学 / 心理学原型 | 经典计算机科学对应概念 | 本体系采用的现成模型 / 公式 |
|---|---|---|---|
| **1. 当前面对什么局势、能干嘛？** | **示能性（Affordance, Gibson 1979）**：生物眼里的世界不是像素，而是“眼前可砍的树、挡路的墙”等可行动机会。 | **STRIPS / PDDL 状态空间**、Petri 网 C/E 系统 | `prismarine-recipe`、`minecraft-data`、PDDL 后继状态公理 |
| **2. 多条路之间选稳的还是试新的？** | **探索-利用权衡（Exploration–Exploitation）**：既不死守第一次撞见的小树丛，也不盲目乱逛饿死。 | **多臂老虎机（Multi-Armed Bandit）** | **UCB1 公式**：$\hat{\mu} + \sqrt{2\ln t / n}$（$n=0$ 冷启动防除零先验） |
| **3. 刚走顺的路怎么记、过时路径怎么退场？** | **刺激消退与间隔重复（Eligibility & Spacing Effect）**：刚成功的动作保持兴奋，长期未触发的经验渐弱让位。 | **TD-$\lambda$ 资格迹**（Sutton & Barto） | 惰性衰减 $\text{eligibility}_{\text{now}} = \text{eligibility} \times 0.9^{\Delta \text{rounds}}$ |
| **4. 碎动作如何成“套路”，被打断怎么接上？** | **动作组块化（Chunking）与意图持续性（Bratman BDI）**：玩家脑子里是一整套连招；半路躲怪后记得接回原招式做完。 | **MBTS 轨迹缝合**、Macro-Actions、断点状态机 | 因果拼接（`ensures ⊇ requires`）+ 带 `ttl` 的 `suspendedArc` 断点续跑 |
| **5. 怎么证明哪里“卡死、漏了前置、自食其果”？** | **归因分析与反事实后悔（Causal Attribution & Regret）**：复盘是哪一步漏了前置条件才导致后续返工。 | **流程挖掘（Process Mining）Token-Replay** | 缺失令牌检查、物理对齐 `checkAlignment`、`compaction_regret` 后悔回溯 |
| **6. 经验怎么既省内存不撑爆，改口还不打架？** | **工作记忆 vs 长时陈述记忆 + 信念修正（Belief Revision）**：只按当前任务调出“还算数”的那几条；新事实推翻旧事实时立据下线。 | **Event Sourcing（只追加事件流）+ CQRS 读写隔离 + 经典 IR** | **Robertson/Sparck-Jones BM25 (IDF)**、事务原子快照、`superseded / disputed` 状态机 |

---

## 三、统一内核：A/B 物理隔离 + 四定义双层控制

两个项目共用同一套底层认知骨架——把经验彻底从易失的 LLM 上下文里抽成进程外可审计数据流：

- **Environment A（低维即时反应层）**：只看当前实时局面 + 唯一原子快照，做 $O(\text{候选数})$ 查表与排序，**代码级禁止在热路径读全量历史流**（既保毫秒级响应与 0-Token 运行，又彻底防止冷热同源死循环）。
- **Environment B（高维周期复盘层）**：消费 Append-Only JSONL 事件流的时间窗切片，算四定义流形态、提取长链或裁决结论冲突，通过原子替换/事务批处理刷新快照反哺 A 层。

| 四定义 | BDI 映射 | 低维即时层（毫秒级查表） | 高维复盘层（切片看流形态） |
|---|---|---|---|
| **权重 (Weight)** | **Desire**<br>配额分配 | 查类目/作用域/人设配额 | 检查资源占比是否失衡（如压缩丢光硬约束配额 `weight_quota`） |
| **可信度 (Confidence)** | **Commitment**<br>承诺力度 | 查效率均值 + UCB1 + 长链承诺度 `macro_commitment` / 权威度 | 评估长链完整走通率与压缩后悔率 `trust_score = 1 - regret_rate` |
| **熟练度 (Proficiency)** | **Intention**<br>方向稳定性 | 查状态分桶计数 + 动作族惯性 `momentum` / 效用反馈 `utility` | 观测表现方差与常见断点（`macro_break_at` / 压缩保留率方差） |
| **学习指数 (Learning Index)** | **Belief**<br>大局进展 | 查先例冷启动闸门（防除零/NaN） | 监测主线推进走势（停滞 K 步告警与 HITL 求助单 / 压缩后滑坡） |

---

## 四、双子星项目硬核说明

### 1. `minecraft-trajectory-brain` —— 具身动作外置轨迹大脑
- **解决什么问题**：解决传统 MC Agent 换模型就失忆、每步全靠烧 API 试错、在复杂地形反复卡死且攒不出连贯套路的痛点。
- **核心架构与机制**：
  - **零侵入解耦**：不改上游 `minecraft-agent-harness` 一行 `src/` 源码，外挂 `brain/` 实现观测归一化、配方递归总量计算（`recipe_planner.mjs`）与即时查表选路。
  - **跨尺度粒度对齐 & 抗噪长链**：用单步均摊耗时（`duration_ms / completed_steps`）拉平单步动作与 4 步长链的评价尺度；环境 B 过滤探索与避险噪声并做因果首尾拼贴（`stitched_macros`），全局配额 `weight` 与连招承诺度 `macro_commitment` 物理分字段隔离。
  - **插槽化 + 断点续跑 + 防假成功**：支持运行时木种与地表坐标重算、半路跳过已满足步、遇怪打断后通过 `suspendedArc` 脱险接回；`checkAlignment()` 识别并拦截 `dropsMissed` 等“工具不报错但背包没东西”的假成功污染；并通过 `claim_bridge.mjs` 联动区域避雷记忆。
- **实测表现**：**58/58 单元测试全绿**；真机外科修复后失败率从 **52% 降至 8%~20%**、`go_to` 探索成功率 **80%~92%**；0-Token 离线 5 局跨局学习步数 **`12 → 7`**、失败 **`2 → 0`**、长链走通率 **`100%`**。

### 2. `agent-claim-memory` —— 工作记忆裁决层 + 上下文压缩流审计仪
- **解决什么问题**：补齐编码 Agent 上下文窗口（第 ① 层）和宿主摘要压缩（第 ② 层）之外缺失的 **第 ③ 层**：在不把 Prompt 撑爆的前提下，回答“这条三周前的架构结论现在还算不算数、依据在哪、这次压缩到底丢了啥、丢了之后有没有自食其果”。
- **核心架构与机制**：
  - **工作四维召回（刻意拒绝时间淘汰）**：`scope_match × BM25(IDF) × authority × confidence × status`。三周前确立的约束只要未被推翻就永远有效；按当前修改文件路径硬过滤，三通道分流编译注入（`compiled_constraints` / `context_claims` / `pitfall_warnings`），20 轮真实回放对比全量注入节省 **92.9%** 字符体积。
  - **无死锁事务与可翻案裁决账本**：`store.transaction()` 单事务批处理增量收敛，支持末行截断与索引损坏无损自愈（`verifyIndexConsistency` 校验 100% 一致）；覆写旧结论标 `superseded` 并保留举证原文 `evidence`；`restoreClaim` 翻案强制 `replace_current` 或 `mark_disputed` 双方进争议态，严格防双活。
  - **Token-Replay 级压缩审计（`compaction_regret`）与顶层大结论**：`auditCompaction` 抓出摘要遗漏的 `lost_claims`，后续 `verify(ok=false)` 在同作用域踩坑时自动因果关联成 `compaction_regret`；由四定义压缩流评估与 `stream_verdict.mjs` 收敛成 4 种面向用户的人话态度（`healthy` / `drifting` / `regret_alert` / `ready_to_promote`）。
- **实测表现**：零外部重型依赖，**14/14 单元测试全绿**（覆盖断电自愈、冷重启按裸 ID 定位、状态机拉扯压测、IDF 抗水词），自带 3457 端口玻璃箱控制台与 `npm run demo` 一键剧本回放。
