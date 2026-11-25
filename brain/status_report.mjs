// brain/status_report.mjs — 一页纸中文体检看板（任务 3）。
//
// 纯只读脚本：只读取 policy_snapshot.json / decisions.jsonl /
// pending_confirm.jsonl / persona.json / splits.json 这五个文件，不写入、
// 不修改任何文件，不连接 Minecraft 服务器，不调用任何 LLM。缺失文件只打印
// 友好提示，绝不抛错中断——新 clone 下来、一次都没跑过时也能正常运行并给出
// 推荐的启动命令。
//
// 运行方式：node brain/status_report.mjs

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const POLICY_PATH = join(ROOT, 'policy_snapshot.json');
const DECISIONS_PATH = join(ROOT, 'decisions.jsonl');
const PENDING_CONFIRM_PATH = join(ROOT, 'pending_confirm.jsonl');
const PERSONA_PATH = join(__dirname, 'persona.json');
const SPLITS_PATH = join(__dirname, 'splits.json');

function readJsonSafe(path) {
  if (!existsSync(path)) return { ok: false, missing: true, value: null };
  try {
    return { ok: true, missing: false, value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (error) {
    return { ok: false, missing: false, value: null, error: String(error?.message ?? error) };
  }
}

function readJsonlSafe(path) {
  if (!existsSync(path)) return { ok: false, missing: true, records: [] };
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    return { ok: false, missing: false, records: [], error: String(error?.message ?? error) };
  }
  const records = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // 容忍半行/损坏的尾行，与 stream.mjs 的读取策略一致
    }
  }
  return { ok: true, missing: false, records };
}

function fmtPct(x) {
  if (!Number.isFinite(x)) return '未知';
  return `${(x * 100).toFixed(0)}%`;
}

function fmtMs(x) {
  if (!Number.isFinite(x)) return '未知';
  if (x >= 1000) return `${(x / 1000).toFixed(1)}s`;
  return `${Math.round(x)}ms`;
}

function splitLabelForIdx(splits, idx) {
  if (!Array.isArray(splits) || !Number.isFinite(idx) || idx < 0) return '尚未达成任何里程碑（起步阶段）';
  const split = splits[idx];
  if (!split) return `未知里程碑（索引 ${idx}）`;
  return `${split.label ?? split.id ?? ('#' + idx)}（第 ${idx + 1} 个里程碑，id=${split.id ?? '未知'}）`;
}

function section(title) {
  console.log('');
  console.log(`== ${title} ==`);
}

/**
 * 12 个里程碑的 `[x]`/`[ ]` 进度条：cur_idx（最后一个已满足的 split 下标）
 * 之前（含）全部打勾，之后全部打空格。splits 数量若不是 12（例如 splits.json
 * 被人改过），照实际长度渲染，不强行拼成 12 格。
 */
function renderProgressBar(splits, curIdx) {
  if (!Array.isArray(splits) || !splits.length) return '  （splits.json 为空或不可用，无法渲染进度条）';
  const idx = Number.isFinite(curIdx) ? curIdx : -1;
  const lines = splits.map((split, i) => {
    const mark = i <= idx ? '[x]' : '[ ]';
    const current = i === idx ? '  ← 当前' : '';
    return `  ${mark} ${i + 1}. ${split.label ?? split.id ?? '未知'}${current}`;
  });
  return lines.join('\n');
}

function main() {
  const splitsResult = readJsonSafe(SPLITS_PATH);
  const splits = Array.isArray(splitsResult.value) ? splitsResult.value : [];

  const policyResult = readJsonSafe(POLICY_PATH);
  const policy = policyResult.value;

  const decisionsResult = readJsonlSafe(DECISIONS_PATH);
  const decisions = decisionsResult.records;

  const pendingResult = readJsonlSafe(PENDING_CONFIRM_PATH);
  const pendingRecords = pendingResult.records;

  const personaResult = readJsonSafe(PERSONA_PATH);
  const personaConfig = personaResult.value;

  console.log('======================================');
  console.log(' Minecraft AI 轨迹库 · 一页纸体检看板');
  console.log('======================================');

  // 全空数据集的友好提示：policy/decisions/pending 三个运行时文件都不存在，
  // 说明这是一次新 clone、从未运行过任何实验——给出清晰的推荐启动命令，而不是
  // 让人对着一堆"未找到"的分散提示发懵。
  const neverRan = policyResult.missing && decisionsResult.missing && pendingResult.missing;
  if (neverRan) {
    console.log('');
    console.log('  [提示] 尚无任何运行记录（这是一次全新的 clone，还没跑过实验）。');
    console.log('  推荐的 0-Token 实测启动命令（需要一台本地/局域网 Minecraft 服务器）：');
    console.log('    node brain/auto_loop.mjs --port 25565 --steps 15 --persona speedrunner');
    console.log('  跑完后再执行一次本脚本（node brain/status_report.mjs）即可看到真实数据。');
  }

  // --- 1. 当前进度 ---------------------------------------------------
  section('1. 当前进度');
  if (policyResult.missing) {
    console.log('  [提示] 尚未找到 policy_snapshot.json —— 还没有跑过任何一轮决策/复盘。');
  } else if (!policyResult.ok) {
    console.log(`  [提示] policy_snapshot.json 解析失败（${policyResult.error}），已忽略。`);
  } else {
    const curIdx = Number.isFinite(policy?.cur_idx) ? policy.cur_idx : -1;
    console.log(`  所在里程碑：${splitLabelForIdx(splits, curIdx)}`);
    console.log(`  总决策轮次（total_rounds）：${Number.isFinite(policy?.total_rounds) ? policy.total_rounds : '未知'}`);
    console.log('  进度条（12 个里程碑，[x]=已达成）：');
    console.log(renderProgressBar(splits, curIdx));
  }

  // 最近 10 轮成功率与平均耗时：从 decisions.jsonl 的结果记录（有 result 字段的行）里取最后 10 条。
  const outcomeRecords = decisions.filter(r => r && r.result !== undefined && r.chosen);
  const last10 = outcomeRecords.slice(-10);
  if (decisionsResult.missing) {
    console.log('  [提示] 尚未找到 decisions.jsonl —— 还没有任何执行记录。');
  } else if (!last10.length) {
    console.log('  最近 10 轮成功率/耗时：暂无结果记录。');
  } else {
    const okCount = last10.filter(r => r.result?.ok).length;
    const successRate = okCount / last10.length;
    const durations = last10.map(r => r.duration_ms).filter(Number.isFinite);
    const avgDuration = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : NaN;
    console.log(`  最近 ${last10.length} 轮成功率：${fmtPct(successRate)}（${okCount}/${last10.length} 次成功）`);
    console.log(`  最近 ${last10.length} 轮平均单步耗时：${fmtMs(avgDuration)}${durations.length < last10.length ? '（部分旧记录缺 duration_ms，已忽略）' : ''}`);
  }

  // --- 2. 行为偏好与熟练度 Top 5 --------------------------------------
  // 注意：这里的"平均分/资格迹"都来自 prior_confidence/eligibility ——
  // 跟 entries[key].weight（配额权重，见下方小节的专门说明）是两件不同的
  // 事：weight 只管"这个动作该不该在候选池里占更大/更小的份额"，不代表它
  // 跑得好不好。
  section('2. 行为偏好与熟练度 Top 5（最常选的动作）');
  if (policyResult.missing || !policyResult.ok) {
    console.log('  [提示] 没有可用的 policy_snapshot.json，无法统计。');
  } else {
    const entries = policy?.entries && typeof policy.entries === 'object' ? policy.entries : {};
    // 只看"全局键"（不含 "::" 的状态分桶键），避免同一个动作在不同状态桶下重复刷屏。
    const globalKeys = Object.keys(entries).filter(k => !k.includes('::'));
    const ranked = globalKeys
      .map(key => ({ key, ...entries[key] }))
      .filter(e => Number.isFinite(e.proficiency_count) && e.proficiency_count > 0)
      .sort((a, b) => (b.proficiency_count ?? 0) - (a.proficiency_count ?? 0))
      .slice(0, 5);
    if (!ranked.length) {
      console.log('  暂无任何有样本的动作（还没有实际执行记录）。');
    } else {
      for (const [i, e] of ranked.entries()) {
        const score = Number.isFinite(e.prior_confidence) ? e.prior_confidence.toFixed(2) : '未知';
        const elig = Number.isFinite(e.eligibility) ? e.eligibility.toFixed(2) : '无';
        const weight = Number.isFinite(e.weight) ? e.weight.toFixed(2) : '1.00';
        console.log(`  ${i + 1}. ${e.key} —— 平均分 ${score}，已选 ${e.proficiency_count} 次，当前资格迹 ${elig}，配额权重(weight) ${weight}`);
      }
    }
  }

  // --- 3. 已攒下的顺手连招（stitched_macros） -------------------------
  // 两件事分开展示，绝不混为一谈：
  //   · 配额权重（weight）—— entries[]里管"该不该多分配候选池份额"的纯调度量；
  //   · 长链走通率/承诺度（completion_rate / macro_commitment）—— 这条连招
  //     自己实际跑起来「稳不稳」「敢不敢一次性相信它打完」，来自真实执行记录，
  //     从不改写 weight。
  section('3. 已攒下的顺手连招（stitched_macros）—— 含长链章法体检');
  if (policyResult.missing || !policyResult.ok) {
    console.log('  [提示] 没有可用的 policy_snapshot.json，无法查看连招。');
  } else {
    const macros = Array.isArray(policy?.stitched_macros) ? policy.stitched_macros : [];
    if (!macros.length) {
      console.log('  暂无已验证的连招模板（还没有观察到任何"成功且推进路线"的动作序列）。');
    } else {
      for (const [i, macro] of macros.entries()) {
        const chain = Array.isArray(macro.steps) && macro.steps.length
          ? macro.steps.map(s => s.key).join(' -> ')
          : macro.key;
        const stepCount = Array.isArray(macro.steps) && macro.steps.length ? macro.steps.length : 1;
        console.log(`  ${i + 1}. [来源] ${macro.id}（${stepCount} 步，来源标签=${macro.smoothness ?? '未知'}）`);
        console.log(`     步骤链：${chain}`);
        if (Number.isFinite(macro.span_from_idx) && Number.isFinite(macro.span_to_idx)) {
          console.log(`     章法跨度：${macro.phase_label ?? `idx ${macro.span_from_idx} -> idx ${macro.span_to_idx}`}`);
        }
        if (stepCount > 1) {
          const completion = Number.isFinite(macro.completion_rate) ? fmtPct(macro.completion_rate) : '暂无真实多步执行记录';
          const commitment = Number.isFinite(macro.macro_commitment) ? macro.macro_commitment.toFixed(2) : '1.00（中性，尚无证据）';
          const breakStep = Number.isFinite(macro.common_break_step) ? `第 ${macro.common_break_step} 步` : '暂无/全部走完';
          console.log(`     长链走通率(completion_rate)：${completion}；长链承诺度(macro_commitment)：${commitment}；常见半路夭折点：${breakStep}`);
        }
      }
    }
  }

  // --- 3b. 高维长链流形态总览（macro_flow_summary） --------------------
  section('3b. 高维长链流形态总览（macro_flow_summary）');
  if (policyResult.missing || !policyResult.ok) {
    console.log('  [提示] 没有可用的 policy_snapshot.json，无法查看长链流形态。');
  } else {
    const flow = Array.isArray(policy?.macro_flow_summary) ? policy.macro_flow_summary : [];
    if (!flow.length) {
      console.log('  暂无长链执行统计（还没有任何多步连招被真实尝试执行过）。');
    } else {
      for (const [i, f] of flow.entries()) {
        const span = Number.isFinite(f.span_from_idx) && Number.isFinite(f.span_to_idx) ? (f.phase_label ?? `idx ${f.span_from_idx} -> idx ${f.span_to_idx}`) : '跨度未知';
        const completion = Number.isFinite(f.completion_rate) ? fmtPct(f.completion_rate) : '暂无尝试';
        const breakStep = Number.isFinite(f.common_break_step) ? `第 ${f.common_break_step} 步` : '无/全部走完';
        console.log(`  ${i + 1}. ${f.id}（${f.steps ?? '?'} 步，章法=${span}）：尝试 ${f.attempts ?? 0} 次，走通率 ${completion}，常卡在 ${breakStep}，承诺度 ${Number.isFinite(f.macro_commitment) ? f.macro_commitment.toFixed(2) : '1.00'}`);
      }
      console.log('  说明：承诺度(macro_commitment)只影响 decide.mjs 对这条长链第2/3步的"可信度"评分，绝不改写配额权重(weight)。');
    }
  }

  // --- 4. 停滞求助单（pending_confirm.jsonl） -------------------------
  section('4. 停滞求助单（pending_confirm.jsonl）');
  if (pendingResult.missing) {
    console.log('  目前没有任何求助单文件 —— 说明还没有触发过停滞。');
  } else if (!pendingRecords.length) {
    console.log('  求助单文件存在，但没有任何有效记录。');
  } else {
    // 粗略去重：以 dedupeKey 为唯一标识，统计"未处理"的条数——这里没有确认/处理状态区分
    // （确认只会被 brain/deliberate.mjs 的 confirm_audit.jsonl 消费，本脚本不读取/不判断已处理，
    // 只是如实陈列每一条求助单，提示人工去核对）。
    console.log(`  共 ${pendingRecords.length} 条求助记录（每条都需要人工核对是否已处理，本看板不会自动判断）：`);
    const recent = pendingRecords.slice(-5);
    for (const [i, rec] of recent.entries()) {
      const reason = rec.reason ?? '未知原因';
      const stuckAt = Number.isFinite(rec.stuck_at_idx) ? splitLabelForIdx(splits, rec.stuck_at_idx) : '未知位置';
      const confirmedFlag = rec.confirmed === true ? '（已标记 confirmed，但是否生效需看 confirm_audit.jsonl）' : '（尚未标记 confirmed）';
      console.log(`  - [${i + 1}/${recent.length}] 原因=${reason}；卡在=${stuckAt}；连续无进展轮数=${rec.rounds_without_progress ?? '未知'} ${confirmedFlag}`);
    }
    console.log('  处理提示：若要采纳建议，需人工在 pending_confirm.jsonl 里手动追加一条 confirmed:true 的记录（程序绝不会自动确认）。');
  }

  // --- 附：当前经验档案人设（active_persona）+ 可选人格预设 -----------
  // active_persona 是 policy_snapshot.json 自己记录的字段（本轮升级新增，
  // 见 deliberate.mjs 的 runDeliberation(activePersona) 参数）：由
  // auto_loop.mjs/run_win.mjs 每次调用 runDeliberation() 时把当前
  // --persona/BRAIN_PERSONA 解析出的人格名一起传入并落盘，所以这里现在
  // 能回答"这份快照上次是用哪个人设跑出来的"，不再是只能回答"有哪些选项"。
  section('附：当前经验档案人设（active_persona）+ 可选人格预设');
  if (policyResult.missing || !policyResult.ok) {
    console.log('  [提示] 没有可用的 policy_snapshot.json，不知道上次用的是哪个人设。');
  } else {
    const activePersona = typeof policy?.active_persona === 'string' && policy.active_persona ? policy.active_persona : null;
    console.log(`  当前经验档案人设（active_persona）：${activePersona ?? '未知（此快照尚未记录过人设，或从未经过带 persona 的 deliberation）'}`);
  }
  if (personaResult.missing) {
    console.log('  [提示] 未找到 persona.json，--persona 参数将回退为内置中性默认值。');
  } else if (!personaResult.ok) {
    console.log(`  [提示] persona.json 解析失败（${personaResult.error}），已忽略。`);
  } else {
    const names = Object.keys(personaConfig?.presets ?? {});
    console.log(`  默认人格：${personaConfig?.default ?? '未知'}；可选：${names.join('、') || '无'}`);
  }

  // --- 5. 跨局成长轨迹（episode_history，任务4"局间四定义复盘"） --------
  section('5. 跨局成长轨迹（episode_history）');
  if (policyResult.missing || !policyResult.ok) {
    console.log('  [提示] 没有可用的 policy_snapshot.json，无法查看跨局成长轨迹。');
  } else {
    const history = Array.isArray(policy?.episode_history) ? policy.episode_history : [];
    if (!history.length) {
      console.log('  暂无跨局复盘记录（还没有调用过 runDeliberation({ mode: "inter_episode" })）。');
    } else {
      const recent = history.slice(-5);
      console.log(`  共 ${history.length} 局复盘记录（最多保留 20 局），最近 ${recent.length} 局：`);
      for (const ep of recent) {
        const dur = fmtMs(ep.avgStepDurationMs);
        const fail = fmtPct(ep.failureRate);
        const reason = ep.deathOrStuckReason ?? '正常结束/无记录';
        console.log(`  - 第${ep.episodeId}局：步数=${ep.totalSteps}，最高cur_idx=${ep.finalCurIdx}，平均单步耗时=${dur}，失败率=${fail}，死因/卡点=${reason}，人设=${ep.activePersona ?? '未知'}`);
      }
      const first = history[0];
      const last = history[history.length - 1];
      if (history.length > 1 && Number.isFinite(first.finalCurIdx) && Number.isFinite(last.finalCurIdx)) {
        console.log(`  趋势：第1局 cur_idx=${first.finalCurIdx} -> 第${history.length}局 cur_idx=${last.finalCurIdx}（${last.finalCurIdx > first.finalCurIdx ? '进步' : last.finalCurIdx === first.finalCurIdx ? '持平' : '退步'}）。`);
      }
    }
  }

  console.log('');
  console.log('======================================');
}

main();
