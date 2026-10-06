# qacore spec 修订附录（factory 侧 contract-change 台账）

> **地位与边界**：`docs/specs/qacore.md` 是 oracle `repo/docs/assets/specs/qacore.md`
> 的**字节冻结副本**（REUSED-ASSETS.md 登记册 A 节 #38，sha256
> `924515fa…`，`npm run verify:assets` 逐字节校验）。oracle 已封存只读，故其字节
> 不再可改——本仓对 qacore spec 的**一切后续修订以本附录登记**，逐条注明修订点、
> 依据与影响面；正文（qacore.md）与 oracle 的字节一致性由登记册持续担保。
>
> | 修订 | 日期 | 影响正文位置 | 状态 |
> |---|---|---|---|
> | chk04-determinism（探针旗 + 快速质检等桥） | 2026-09-30 | §4 探针契约、§5 首交互前采集 | 已生效（qacore src 同步落地） |
> | chk02-chk06（文件数 + 退出接口两检查实装） | 2026-10-06 | §1 不做边界、§2 命令契约（新 CLI）、§5 自动试玩驱动（CTA 取证）、§5.1 钩子形状（cta）、§6 检查项判定表（CHK02/CHK06 行）、§8 变异测试（MUT-05/06）、§9 与 pipeline-contract §4 的 facts 键集 | 已生效（qacore src 同步落地） |

---

## chk04-determinism（2026-09-30，contract-change）

**背景**：模式 M 批次 3 差分终审（factory commit a4cbef7，`docs/diff/differential-report.md`
QC-02 / CLI-B 同族）判 FAIL 的两根支柱之一：oracle 产物 A 上新 TS 判官 CHK04（首交互前
静音）43/48 格 fail 而 oracle Python 判官 pass。归因实证：oracle 产物保留引擎真实
AudioContext，其 running 态在亚秒窗翻转（vendor engine.js `onGameVisible`
`setTimeout(…,100)` suspend→resume + BOOT unlock）；瞬时采样下 Python 同步链早读到 0
（假阴性）、Node 异步链晚几十毫秒读到 1，两侧判定纯竞态（`tmp/diff/e3a*-n-*.json` vs
`e3b-o-solo.json`；本机另证翻转本身随机器/会话状态抖动，见
`tmp/diff/probe-contract/`）。

**修订内容（仅 factory 侧，oracle 探针冻结不动）**：

1. **PROBE_JS 新增粘性旗 `audio.everBeforeFirstGesture`**（qacore.md §4 包装
   AudioContext 条目的修订）：`upd()` 内 `ctx.state==='running'` 且
   `firstGestureAt===null` 时置真、**置真不复位**——构造时初次 `upd()` 覆盖"构造即
   running"，既有 `statechange` 监听覆盖其后 resume，事件驱动消除采样竞态。旗只存
   页面 `__pfprobe` 对象，**不新增报告 facts 键**。修订后 factory PROBE_JS 3397 字符
   （oracle 冻结版 3119 字符；新旧 diff 存档 `tmp/diff/probe-contract/`，逐字节一致性
   证据自此失效、以本条登记为准）。
2. **`audioRunningBeforeInteraction` 值语义改旗驱动**（qacore.md §5 首次手势前采集
   条目的修订；判定输入键名不变）：旗真 → 1 粘住；旗假维持原瞬时采样 max 粘住语义
   （旗假 ⇒ 同一 `upd()` 同步记账下采样必为 0，两口径严格一致）。CHK04 判定输入与
   fail/pass 文案逐字不变（checks 零改动，含 qacore.md §6/oracle checks.py:106 同文案
   「首交互前存在 running AudioContext（n）」）。
3. **非 autoplay 快速质检桥就绪有界等待**（qacore.md §5/cli `_run_pass` 非 autoplay
   分支的修订）：直读 `PF.isMuted()` 前先 `page.waitForFunction(() => !!(window.PF &&
   typeof window.PF.isMuted === "function"), {timeout:5000})`（**必须传真函数**——
   playwright-node 把字符串页函数按表达式求值，`"() => …"` 得到恒真函数对象、等待
   立即放行），超时兜底照旧直读，缺桥/慢桥 **None→fail 从严语义不变**；横屏趟一致性
   同改；autoplay 趟 pfMuted 循环采样不动。
4. **快速质检 facts 读取口径对齐 oracle Python `or` 语义**：oracle checks.py:82
   `facts.get("autoplay") or facts.get("muteLoadTime") or {}`——空 dict 为 falsy 时回落
   muteLoadTime；JS `??` 对 `{}` 不回落（移植偏差，曾致快速质检 CHK04 恒读空 →
   isMuted=None 假阴性）。实现为 run.ts facts 组装处 `autoplay: autoplayEnabled ?
   autoplayFacts : null`；报告 facts 本就过滤 `autoplay` 键，报告 JSON 字段签名零变化。

**影响面与证据**：报告 JSON 字段签名零增删（facts 顶层/muteLoadTime/
viewport_shots.portrait 键集 + CHK01–CHK10 键集不变，P4 distinct signatures=1 保持）；
回归面 `qacore/tests/autoplay-flag.test.mjs`（探针旗契约页级真实 WebAudio 向量 +
B-like 阴性 ×5 + 慢桥 ×3）与 `qacore/tests/unit.test.mjs` CHK04 旗驱动值 1 判定向量。
机器层竞态取证（旗必要性）：`tmp/diff/probe-contract/probe_oracle_timeline.mjs`
（oracle A 产物 12 采样全程 running=0）、`probe_cli_sequence.mjs`（无手势 resume 3/3
永不落定）、`probe_unlock_strategies.mjs`、`probe_raciness.mjs`。

---

## chk02-chk06（2026-10-06，contract-change）

**背景**：oracle 原状 CHK02（文件数 ≤ 渠道上限）/CHK06（渠道退出接口调用）两项检查
未实装、各渠道报告如实记 skip（qacore.md §6 判定表两行；CHK06 行并注明"期望值与真实
API 冲突，修正候选见 channel-adapters §3"）。本次按 channel-adapters §3 修正候选
（factory `docs/specs/engine-bridge.md` §2.5 引用表 + oracle `docs/assets/specs/
channel-adapters.md` §3）实装收口：**传 URL 协议断言"调用一次且参数=landingUrl"；
不传 URL 协议断言"调用恰发生 + 触发时机=结束页 CTA 点击"**。

**修订内容（仅 factory 侧；oracle 判官与 qacore.md 正文冻结不动）**：

1. **CHK02 文件数实装**（qacore.md §6 CHK02 行的修订）：判定输入 `file_count` =
   入口 HTML（1）+ 运行期真实取走的**本地伴生文件**数——伺服路由记账里状态 200、
   非容器桩（`stub` 标记，投放时由渠道容器提供非包体内容）、按路径去重、剔除入口
   自身与浏览器自便利请求（`/favicon.ico`）；`channel_max_files` 取自规则库渠道级
   `maxFiles`（无该渠道 → null → **skip**，与 CHK01 同判不假定）。zip 渠道的包内
   条目数仍由打包器 maxFiles 强制（packager build.mjs；qacore 输入契约仍为单 HTML），
   本检查复核"自称单文件交付的产物确实单文件"。fail 文案携带伴生文件清单（恰命中
   可归因）。
2. **CHK06 退出接口实装**（qacore.md §6 CHK06 行 + §1"不注入渠道退出 stub"边界的
   修订）：`wire` 装配段按规则库 `exit.protocol` 在**页面脚本执行前**注入渠道退出桩
   （`qacore/src/exit.ts`：mraid 形含 `getState=loaded`/音量探测面/`open(url)` 记账；
   meta `FbPlayableAd.onComplete`、google `ExitApi.exit`、tiktok `openAppStore`、
   preview 覆写 `window.open` 各记账进 `window.__pfexit.calls`；protocol 未登记形态
   只注入记账器）。桩模拟的是**环境**（投放时由渠道容器提供的全局替身，与
   runtime_stubs 同一立场），产品代码真实加载。自动试玩到达结束页（`state=end` 且
   pf:end 已触发）后，QC 经新模板钩子 `__PF_QC__.cta()` 取 CTA 热区中心坐标，用真实
   pointer 事件点击（与 hint 手势同一语义），再读回记账判定：
   - 规则库无该渠道 exit 配置 / 未开 `--autoplay` / 未达结束页 → **skip**（无判定
     前提；未达项归 CHK07 判定，不双罚）；
   - cta 钩子缺失：有 `--require-exit-url`（make/matrix 对带落地页产物恒传）→
     **从严 fail**（无法验证退出接口即违规，CHK10 自证从严同判）；无要求 → skip
     （显式未测，严禁标 pass）；
   - 钩子在位但无坐标 / 已点击但期望退出函数未记账 / 传 URL 协议参数 ≠
     `--require-exit-url`（未传时要求绝对 http(s) 地址）→ **恰 fail**；
   - 否则 **pass**（pass 文案含协议、调用次数、参数，证据可回放）。
3. **新 CLI `--require-exit-url <url>`**（qacore.md §2 命令契约的追加，可选项不破坏
   既有命令面）：传 URL 退出协议的期望外呼参数；`pf make` 与 `scripts/e2e-matrix.mjs`
   同步接线（值 = spec `flow.endScreen.landingUrl`）。退出码契约不变。
4. **新 facts 键**（qacore.md §9 指向的 pipeline-contract §4 键集的修订，字段表以本条
   登记为准）：`channel_max_files`、`file_count`、`file_count_extras`、`exit_protocol`、
   `exit_call`、`exit_cta_hook`、`exit_cta_gestures`、`exit_calls`、`require_exit_url`。
   报告顶层/checks/requests 键集与退出码不变。
5. **模板钩子 `__PF_QC__.cta()`**（qacore.md §5.1 钩子形状表的追加，可选钩子）：
   返回 `{x, y, type:"tap"} | null`——结束页 CTA 热区中心（仅 `endScreenShown &&
   phase==="end"` 时非 null）。四模板（tmpl-match3/merge/pullpin/sort）已同步落地；
   缺钩子的产物按上文第 2 条分型（有判定要求从严 fail / 无要求显式 skip）。
6. **变异层第二波 MUT-05/06**（qacore.md §8"后续第二波：退出接口缺失（→CHK06 实装后）"
   的落地）：MUT-05 退出缺失（基座 = 新仓自有夹具 `fixtures/mini-exit.html`：把结束页
   CTA 退出外呼行替换为空操作 → 恰 CHK06 fail）；MUT-06 本地伴生文件（基座 =
   `fixtures/mini.html`：QC 桩锚点前注入本地 `<script src="mut06-extra.js">` 并落盘该
   文件 → file_count 2 > 上限 1 → 恰 CHK02 fail）。恰命中断言口径不变（exit 1 且
   fail 集合恰为期望 CHK）。
7. **夹具只读约束澄清**：`fixtures/mini.html` 是 REUSED-ASSETS.md #39 字节复用件
   （sha256 `72060c30…`，`verify:assets` 拦截改动），**不可**为 CHK06 追加取证面——
   新增仓自有夹具 `fixtures/mini-exit.html`（mini 契约 + `__PF_QC__.cta()` + routeExit
   单次锁 + 退出外呼，factory 自有件不入登记册）承载金标 5b（带取证面已实装项零 skip、
   CHK02/CHK06 真实 pass）与 MUT-05 基座；金标 5（mini.html）上 CHK06 为**显式 skip**
   （取证钩子缺失、无判定要求，理由如实落报告），CHK02 照常真实 pass（单文件 ≤ 1）。

**影响面与证据**：四模板 golden + demo-zh 经本判官复验 CHK02/CHK06 全 pass
（`qacore/tests/templates.test.mjs` 5/5：CHK06 pass 文案含 `window.open` 调用与落地页
参数、`file_count=1`）；`pf make` 端到端 applovin/preview 判官 0 fail（`--require-exit-url`
精确匹配 landingUrl 实测，`pf/test/make-serve.test.mjs` 15/15）；`npm run test:qacore`
金标 5 + 金标 5b + 变异 5 mutant（MUT-01→CHK03 / MUT-02→CHK04 / MUT-04→CHK01 /
MUT-05→CHK06 / MUT-06→CHK02）各自恰命中；`qacore/tests/unit.test.mjs` CHK02/CHK06
判定分支向量 + MUT-05/06 构造算法向量。真实判定非恒绿证明 = MUT-05/06 恰命中（exit 1）。
