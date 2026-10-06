/**
 * qacore 纯逻辑移植 eval（无浏览器层，root npm test 内真实执行）：
 * - checks.evaluate 判定向量：十项检查的 pass/fail/skip 语义（含 skip 不算过、
 *   CHK04 从严 fail、CHK10 自证从严、CHK01 规则库缺渠道 skip；CHK02/CHK06 为
 *   factory 侧 2026-10-06 实装，本套件含其判定分支向量）；向量同时
 *   断言其余检查项"不受扰"（恰命中语义，MUT 设计原则）；
 * - MUT-01/02/04/05/06 构造算法：锚点注入 / 超体积 pad 精确到 maxBytes+4096 /
 *   退出外呼剥除 / 本地伴生文件注入；
 * - pngvar 灰度方差：合成 PNG 的确定性向量 + 阈值 30 判定边界语义；
 * 向量期望值均按 oracle checks.py 语义推导并经本机真实运行复核（2026-09-30）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FACTORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RULES_PATH = join(FACTORY_ROOT, "channel-rules", "channel-rules.json");
const FIXTURE_MINI = join(FACTORY_ROOT, "qacore", "tests", "fixtures", "mini.html");

async function checksModule() {
  return import("./../src/checks.ts");
}
async function pngvarModule() {
  return import("./../src/pngvar.ts");
}

function idsOf(status, checks) {
  return checks.filter((c) => c.status === status).map((c) => c.id);
}

const BASE = {
  artifact_bytes: 10, channel_max_bytes: 100, channel: "preview",
  external_requests: [], rtc_connections: 0, request_count: 0, console_errors: [],
  load_ms: 100, max_load_sec: 2, autoplay_enabled: false,
};

test("CHK01：超上限恰 fail（其余不受扰）/ 规则库无该渠道 skip（不假定）", async () => {
  const { evaluate } = await checksModule();
  let out = evaluate({ ...BASE, artifact_bytes: 3145729, channel_max_bytes: 3145728, channel: "meta" });
  assert.deepEqual(idsOf("fail", out), ["CHK01"]);
  out = evaluate({ ...BASE, artifact_bytes: 1024, channel_max_bytes: 5242880, channel: "preview" });
  assert.deepEqual(idsOf("pass", out), ["CHK01", "CHK03", "CHK08", "CHK09"]);
  out = evaluate({ ...BASE, artifact_bytes: 1024, channel_max_bytes: null, channel: "unknown-channel" });
  assert.deepEqual(idsOf("fail", out), []);
  assert.deepEqual(idsOf("skip", out),
    ["CHK01", "CHK02", "CHK04", "CHK05", "CHK06", "CHK07", "CHK10"]);
});

test("CHK03：外链/WebRTC 记账 → 恰 fail；干净 → pass", async () => {
  const { evaluate } = await checksModule();
  let out = evaluate({ ...BASE, external_requests: ["https://cdn.example.com/x.png"], request_count: 3 });
  assert.deepEqual(idsOf("fail", out), ["CHK03"]);
  out = evaluate({ ...BASE, rtc_connections: 2, request_count: 1 });
  assert.deepEqual(idsOf("fail", out), ["CHK03"]);
  out = evaluate({ ...BASE, external_requests: ["websocket:wss://cdn.example.com/x"], request_count: 1 });
  assert.deepEqual(idsOf("fail", out), ["CHK03"]);
  out = evaluate({ ...BASE, request_count: 2 });
  assert.deepEqual(idsOf("pass", out), ["CHK01", "CHK03", "CHK08", "CHK09"]);
});

test("CHK04：静音要求下缺 PF 桥=从严 fail（不再 skip）；探针缺失 fail；未静音事实 fail", async () => {
  const { evaluate } = await checksModule();
  const base = { ...BASE, channel_mute_required: true };
  let out = evaluate({ ...base, pf_present: false, probe_installed: true, muteLoadTime: {} });
  assert.deepEqual(idsOf("fail", out), ["CHK04"]);
  out = evaluate({ ...base, pf_present: true, probe_installed: false, muteLoadTime: {} });
  assert.deepEqual(idsOf("fail", out), ["CHK04"]);
  out = evaluate({
    ...base, pf_present: true, probe_installed: true,
    muteLoadTime: { firstMutedBeforeInteraction: false, audioRunningBeforeInteraction: 0,
      mediaUnmutedBeforeInteraction: 1, mediaPlaysBeforeInteraction: 0 },
  });
  assert.deepEqual(idsOf("fail", out), ["CHK04"]);
  // 渠道未强制静音且无桥 → skip
  out = evaluate({ ...BASE, channel_mute_required: false, pf_present: false,
    probe_installed: true, muteLoadTime: {} });
  assert.deepEqual(idsOf("skip", out),
    ["CHK02", "CHK04", "CHK05", "CHK06", "CHK07", "CHK10"]);
  // 合规：首交互前静音 + 无未静音媒体（CHK07 仍 skip：未开 autoplay）
  out = evaluate({
    ...base, pf_present: true, probe_installed: true,
    muteLoadTime: { firstMutedBeforeInteraction: true, audioRunningBeforeInteraction: 0,
      mediaUnmutedBeforeInteraction: 0, mediaPlaysBeforeInteraction: 0 },
  });
  assert.deepEqual(idsOf("pass", out), ["CHK01", "CHK03", "CHK04", "CHK08", "CHK09"]);
  // autoplay 时首手势后必须解除静音（此向量同时无 pf:end 证据 → CHK07 同 fail）
  out = evaluate({
    ...base, autoplay_enabled: true, pf_present: true, probe_installed: true,
    autoplay: { firstMutedBeforeInteraction: true, audioRunningBeforeInteraction: 0,
      mediaUnmutedBeforeInteraction: 0, mediaPlaysBeforeInteraction: 0,
      mutedAfterFirstGesture: true, gestures: 1 },
  });
  assert.deepEqual(idsOf("fail", out), ["CHK04", "CHK07"]);
});

test("CHK04：旗驱动值 1（首交互前曾 running）恰 fail 且文案含计数值（chk04-determinism 判定向量）", async () => {
  const { evaluate } = await checksModule();
  const base = { ...BASE, channel_mute_required: true };
  // 值语义改在采集层（旗→1 粘住）；判定层零改动：audioRunningBeforeInteraction=1
  // 走既有 !==0 fail 口径，文案与 oracle checks.py:106 同形（含计数值）。
  const out = evaluate({
    ...base, pf_present: true, probe_installed: true,
    muteLoadTime: { firstMutedBeforeInteraction: true, audioRunningBeforeInteraction: 1,
      mediaUnmutedBeforeInteraction: 0, mediaPlaysBeforeInteraction: 0 },
  });
  assert.deepEqual(idsOf("fail", out), ["CHK04"]);
  const chk04 = out.find((c) => c.id === "CHK04");
  assert.ok(chk04.detail.includes("首交互前存在 running AudioContext（1）"),
    `detail 应含旗驱动计数值文案，实得：${chk04.detail}`);
});

test("CHK05：无画布 skip；有画布方差双达标 pass、单侧低于阈值恰 fail", async () => {
  const { evaluate } = await checksModule();
  const base = { ...BASE, variance_threshold: 30.0 };
  let out = evaluate({ ...base, viewport_shots: {
    portrait: { has_canvas: false }, landscape: { has_canvas: false } } });
  assert.deepEqual(idsOf("skip", out),
    ["CHK02", "CHK04", "CHK05", "CHK06", "CHK07", "CHK10"]);
  out = evaluate({ ...base, viewport_shots: {
    portrait: { has_canvas: true, variance: 120.4 },
    landscape: { has_canvas: true, variance: 88.1 } } });
  assert.deepEqual(idsOf("pass", out), ["CHK01", "CHK03", "CHK05", "CHK08", "CHK09"]);
  out = evaluate({ ...base, viewport_shots: {
    portrait: { has_canvas: true, variance: 2.1 },
    landscape: { has_canvas: true, variance: 88.1 } } });
  assert.deepEqual(idsOf("fail", out), ["CHK05"]);
});

test("CHK07：未开 autoplay skip；无钩子/超预算/未达终态/结束页不可见 恰 fail；齐备 pass", async () => {
  const { evaluate } = await checksModule();
  const base = { ...BASE, variance_threshold: 30, autoplay_timeout_sec: 45,
    viewport_shots: { portrait: { has_canvas: true, variance: 90 },
      landscape: { has_canvas: true, variance: 90 } } };
  let out = evaluate({ ...base });
  assert.deepEqual(idsOf("skip", out), ["CHK02", "CHK04", "CHK06", "CHK07", "CHK10"]);
  const hooks = { qcHooksPresent: true };
  out = evaluate({ ...base, autoplay_enabled: true, autoplay: { ...hooks } });
  assert.deepEqual(idsOf("fail", out), ["CHK07"]);
  out = evaluate({ ...base, autoplay_enabled: true, autoplay: { ...hooks,
    pfEndFired: true, pfEndMs: 46000, reachedState: "end", endScreenVisible: true } });
  assert.deepEqual(idsOf("fail", out), ["CHK07"]);
  out = evaluate({ ...base, autoplay_enabled: true, autoplay: { ...hooks,
    pfEndFired: true, pfEndMs: 9000, reachedState: "playing", endScreenVisible: true } });
  assert.deepEqual(idsOf("fail", out), ["CHK07"]);
  out = evaluate({ ...base, autoplay_enabled: true, autoplay: { ...hooks,
    pfEndFired: true, pfEndMs: 9000, reachedState: "end", endScreenVisible: false } });
  assert.deepEqual(idsOf("fail", out), ["CHK07"]);
  out = evaluate({ ...base, autoplay_enabled: true, autoplay: { ...hooks,
    pfEndFired: true, pfEndMs: 26600, pfEndWin: true, reachedState: "end",
    endScreenVisible: true, gestures: 3 } });
  assert.deepEqual(idsOf("pass", out),
    ["CHK01", "CHK03", "CHK05", "CHK07", "CHK08", "CHK09"]);
});

test("CHK08：console error/pageerror → 恰 fail；零错误 pass", async () => {
  const { evaluate } = await checksModule();
  let out = evaluate({ ...BASE, console_errors: ["pageerror: Error: boom"] });
  assert.deepEqual(idsOf("fail", out), ["CHK08"]);
  out = evaluate({ ...BASE, console_errors: [] });
  assert.deepEqual(idsOf("pass", out), ["CHK01", "CHK03", "CHK08", "CHK09"]);
});

test("CHK09：load_ms ≤ max_load_sec×1000 pass / 超阈值恰 fail（≤2.0s 默认口径）", async () => {
  const { evaluate } = await checksModule();
  let out = evaluate({ ...BASE, load_ms: 1900, max_load_sec: 2 });
  assert.deepEqual(idsOf("pass", out), ["CHK01", "CHK03", "CHK08", "CHK09"]);
  out = evaluate({ ...BASE, load_ms: 2100, max_load_sec: 2 });
  assert.deepEqual(idsOf("fail", out), ["CHK09"]);
});

test("CHK10：required 全缺 skip；未命中/钩子缺/从未可见/素材未对账 恰 fail；齐备 pass", async () => {
  const { evaluate } = await checksModule();
  let out = evaluate({ ...BASE, required_texts: [], required_sprites: [] });
  assert.deepEqual(idsOf("skip", out),
    ["CHK02", "CHK04", "CHK05", "CHK06", "CHK07", "CHK10"]);
  // 文案未命中（子串口径）
  out = evaluate({ ...BASE, required_texts: ["通关"], required_sprites: [],
    page_texts: ["得分 120"], text_states_hook: true,
    text_states: [{ text: "得分 120", everVisible: true }], asset_audit: [] });
  assert.deepEqual(idsOf("fail", out), ["CHK10"]);
  // textStates 钩子缺失 → 从严 fail（可见性无证据）
  out = evaluate({ ...BASE, required_texts: ["得分"], required_sprites: [],
    page_texts: ["得分 120"], text_states_hook: false,
    text_states: [], asset_audit: [] });
  assert.deepEqual(idsOf("fail", out), ["CHK10"]);
  // 登记过但从未 active+visible → 从严 fail（自证补强语义，oracle never_visible）
  out = evaluate({ ...BASE, required_texts: ["得分"], required_sprites: [],
    page_texts: ["得分 120"], text_states_hook: true,
    text_states: [{ text: "得分 120", everVisible: false }], asset_audit: [] });
  assert.deepEqual(idsOf("fail", out), ["CHK10"]);
  // 素材未上报对账
  out = evaluate({ ...BASE, required_texts: [], required_sprites: ["piece-0"],
    page_texts: [], text_states_hook: true, text_states: [], asset_audit: [] });
  assert.deepEqual(idsOf("fail", out), ["CHK10"]);
  // 素材对账未通过
  out = evaluate({ ...BASE, required_texts: [], required_sprites: ["piece-0"],
    page_texts: [], text_states_hook: true, text_states: [],
    asset_audit: [{ texKey: "gem-0", spriteKey: "piece-0", mad: 33, replaced: false }] });
  assert.deepEqual(idsOf("fail", out), ["CHK10"]);
  // 齐备 → pass（子串命中 + everVisible 证据 + replaced=true）
  out = evaluate({ ...BASE, required_texts: ["得分"], required_sprites: ["piece-0"],
    page_texts: ["得分 120", "通关啦！"], text_states_hook: true,
    text_states: [{ text: "得分 120", everVisible: true },
      { text: "通关啦！", everVisible: true }],
    asset_audit: [{ texKey: "gem-0", spriteKey: "piece-0", mad: 0, replaced: true }] });
  assert.deepEqual(idsOf("pass", out),
    ["CHK01", "CHK03", "CHK08", "CHK09", "CHK10"]);
});

test("CHK02：文件数 ≤ 上限 pass / 超限恰 fail（伴生清单入文案）/ 规则库无上限 skip", async () => {
  const { evaluate } = await checksModule();
  let out = evaluate({ ...BASE, channel_max_files: 1, file_count: 1, file_count_extras: [] });
  assert.deepEqual(idsOf("pass", out), ["CHK01", "CHK02", "CHK03", "CHK08", "CHK09"]);
  const chk02 = out.find((c) => c.id === "CHK02");
  assert.ok(chk02.detail.includes("入口 HTML + 0 个本地伴生文件"), chk02.detail);

  out = evaluate({ ...BASE, channel_max_files: 1, file_count: 2,
    file_count_extras: ["/mut06-extra.js"] });
  assert.deepEqual(idsOf("fail", out), ["CHK02"]);
  const f02 = out.find((c) => c.id === "CHK02");
  assert.ok(f02.detail.includes("2 个文件 > 上限 1")
    && f02.detail.includes("/mut06-extra.js"), f02.detail);

  out = evaluate({ ...BASE, channel_max_files: null, file_count: 5, file_count_extras: [] });
  assert.equal(out.find((c) => c.id === "CHK02").status, "skip",
    "规则库无上限 → skip（不假定）");
});

test("CHK06：结束页 CTA 点击 + 退出接口记账齐备 pass（传/不传 URL 两型）；缺钩子/未调用/参数不符 恰 fail；未达结束页/未开 autoplay/规则库缺失 skip", async () => {
  const { evaluate } = await checksModule();
  // 齐备基座：autoplay 真达结束页（CHK07 同 pass）+ 传 URL 协议 + 参数精确一致
  const base = {
    ...BASE, variance_threshold: 30, autoplay_timeout_sec: 45,
    viewport_shots: { portrait: { has_canvas: true, variance: 90 },
      landscape: { has_canvas: true, variance: 90 } },
    exit_protocol: "window-open", exit_call: "window.open(url)",
    exit_cta_hook: true, exit_cta_gestures: 1,
    require_exit_url: "https://example.com/lp",
    autoplay_enabled: true,
    autoplay: { qcHooksPresent: true, pfEndFired: true, pfEndMs: 9000, pfEndWin: true,
      reachedState: "end", endScreenVisible: true, gestures: 3 },
    exit_calls: [{ fn: "window.open", url: "https://example.com/lp", at: 9100 }],
  };
  let out = evaluate({ ...base });
  assert.ok(idsOf("pass", out).includes("CHK06"));
  assert.deepEqual(idsOf("fail", out), [], "齐备基座零 fail");
  const ok06 = out.find((c) => c.id === "CHK06");
  assert.ok(ok06.detail.includes("window.open") && ok06.detail.includes("https://example.com/lp"),
    ok06.detail);

  // 无参协议（meta 型）：调用恰发生即 pass，URL 不参与判定
  out = evaluate({ ...base, exit_protocol: "fb-playable", exit_call: "FbPlayableAd.onComplete()",
    require_exit_url: null,
    exit_calls: [{ fn: "FbPlayableAd.onComplete", url: null, at: 9100 }] });
  assert.equal(out.find((c) => c.id === "CHK06").status, "pass");

  // 传 URL 协议参数不符（实得 null/别址）→ 恰 fail
  out = evaluate({ ...base, exit_calls: [{ fn: "window.open", url: null, at: 9100 }] });
  assert.deepEqual(idsOf("fail", out), ["CHK06"]);
  out = evaluate({ ...base, require_exit_url: null,
    exit_calls: [{ fn: "window.open", url: "javascript:void(0)", at: 9100 }] });
  assert.deepEqual(idsOf("fail", out), ["CHK06"], "无 require 时期望绝对 http(s)");
  out = evaluate({ ...base, require_exit_url: "https://example.com/other",
    exit_calls: [{ fn: "window.open", url: "https://example.com/lp", at: 9100 }] });
  assert.deepEqual(idsOf("fail", out), ["CHK06"], "精确匹配口径");

  // 调用面不符（协议期望 mraid.open，实得别的函数）→ 恰 fail
  out = evaluate({ ...base, exit_protocol: "mraid", exit_call: "mraid.open(url)",
    exit_calls: [{ fn: "window.open", url: "https://example.com/lp", at: 9100 }] });
  assert.deepEqual(idsOf("fail", out), ["CHK06"]);

  // CTA 调用发生但退出接口记账为空 → 恰 fail（文案含期望调用名）
  out = evaluate({ ...base, exit_calls: [] });
  assert.deepEqual(idsOf("fail", out), ["CHK06"]);
  const miss = out.find((c) => c.id === "CHK06");
  assert.ok(miss.detail.includes("window.open 未被调用"), miss.detail);

  // 钩子缺失：有 --require-exit-url 要求 → 从严 fail；无要求 → skip（显式未测）
  out = evaluate({ ...base, exit_cta_hook: false });
  assert.deepEqual(idsOf("fail", out), ["CHK06"]);
  out = evaluate({ ...base, exit_cta_hook: false, require_exit_url: null });
  assert.equal(out.find((c) => c.id === "CHK06").status, "skip",
    "无判定要求且无取证钩子 → skip（不假定）");
  out = evaluate({ ...base, exit_cta_gestures: 0 });
  assert.deepEqual(idsOf("fail", out), ["CHK06"]);

  // 未达结束页 / 未开 autoplay / 规则库无退出配置 / 未登记协议 → skip
  out = evaluate({ ...base, autoplay: { ...base.autoplay, reachedState: "playing",
    pfEndFired: false } });
  assert.equal(out.find((c) => c.id === "CHK06").status, "skip");
  out = evaluate({ ...base, autoplay_enabled: false });
  assert.equal(out.find((c) => c.id === "CHK06").status, "skip");
  out = evaluate({ ...base, exit_protocol: null, exit_call: null });
  assert.equal(out.find((c) => c.id === "CHK06").status, "skip");
  out = evaluate({ ...base, exit_protocol: "mystery", exit_calls: [{ fn: "x", url: null }] });
  assert.equal(out.find((c) => c.id === "CHK06").status, "skip",
    "未登记协议形态 → skip（不假定）");
});

test("MUT 构造算法：锚点注入逐字节符合 §8 表；MUT-04 pad 精确到 maxBytes+4096；MUT-05 剥除外呼 / MUT-06 注入伴生引用", async () => {
  const { MUTANTS, buildMutantSource, oversizeLimitBytes, readTextUniversal,
    materializeMutants } = await import("./mutations.mjs");
  // Python read_text 的 universal-newline 语义：CRLF 夹具按 LF 参与锚点匹配。
  const base = readTextUniversal(FIXTURE_MINI);
  const marker = "  <script>\n    // QC 桥接桩";
  assert.ok(base.includes(marker), "夹具含 QC 桥接桩锚点");

  const limit = oversizeLimitBytes(RULES_PATH);
  assert.equal(limit, 3145728, "meta 渠道 maxBytes=3MB（规则库）");

  const mut01 = await buildMutantSource(MUTANTS[0], base, limit);
  assert.ok(mut01.html.includes(
    '<img src="https://cdn.example.com/mut01-external.png" alt="" width="1" height="1">',
  ), "MUT-01 注入外链 img");
  const mut02 = await buildMutantSource(MUTANTS[1], base, limit);
  assert.ok(mut02.html.includes(
    '<audio autoplay src="data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEA'
    + 'RKwAAIhYAQACABAAZGF0YQAAAAA="></audio>'), "MUT-02 注入未静音 audio");
  // 注入行插在 QC 桥接桩锚点行之前（构造算法：marker → `  {inject}\n{marker}`）
  for (const m of [mut01, mut02]) {
    const html = m.html.toString("utf8");
    const at = html.indexOf(marker);
    assert.ok(at > 1 && html[at - 1] === "\n", "注入与锚点行以换行相接");
    const lineStart = html.lastIndexOf("\n", at - 2) + 1;
    const injectLine = html.slice(lineStart, at - 1);
    assert.ok(injectLine.startsWith("  ")
      && (injectLine.includes("<img") || injectLine.includes("<audio")),
    "注入行在锚点前一行");
  }
  const mut04 = await buildMutantSource(MUTANTS[2], base, limit);
  assert.equal(mut04.html.length, limit + 4096, "MUT-04 总字节 = maxBytes+4096");
  assert.ok(mut04.html.toString("utf8").includes("--></body>"), "MUT-04 注释填充闭合");

  // MUT-05：退出外呼行被剥除为空操作（CHK06 实装第二波；基座 mini-exit.html）
  const miniExit = readTextUniversal(join(FACTORY_ROOT,
    "qacore", "tests", "fixtures", "mini-exit.html"));
  const mut05 = await buildMutantSource(MUTANTS[3], miniExit, limit);
  const html05 = mut05.html.toString("utf8");
  assert.ok(!html05.includes('window.__pfRouteExit("https://example.com/mini-exit-landing")'),
    "MUT-05 应剥除外呼行");
  assert.ok(html05.includes("void 0; /* MUT-05: 退出接口外呼已剥除 */"), "MUT-05 空操作替换");
  assert.ok(html05.includes("__pfRouteExit = function"), "路由函数本体保留（只剥调用）");
  assert.ok(miniExit.includes("__PF_QC__") && miniExit.includes("cta:"), "基座含 cta 取证钩子");

  // MUT-06：本地伴生 <script src> 注入 + 伴生文件落盘（CHK02 计数口径）
  const mut06 = await buildMutantSource(MUTANTS[4], base, limit);
  assert.ok(mut06.html.toString("utf8").includes('<script src="mut06-extra.js"></script>'),
    "MUT-06 注入本地伴生引用");
  const materialized = await materializeMutants(join(dirname(FIXTURE_MINI), "_mut-eval"),
    RULES_PATH, FIXTURE_MINI);
  try {
    assert.equal(materialized.length, 5, "恰五个已实装 mutant");
    const extraPath = join(dirname(FIXTURE_MINI), "_mut-eval", "mut06-extra.js");
    assert.ok(readFileSync(extraPath, "utf8").includes("MUT-06"), "伴生文件已落盘");
  } finally {
    rmSync(join(dirname(FIXTURE_MINI), "_mut-eval"), { recursive: true, force: true });
  }

  // 夹具只读：构造过程不落盘到夹具
  assert.equal(readTextUniversal(FIXTURE_MINI), base, "夹具未被改动");
});

test("pngvar：确定性合成 PNG 的灰度方差向量（>30 非空白 / =0 纯色空白）", async () => {
  const { grayscaleVariance } = await pngvarModule();
  const zlib = await import("node:zlib");
  function makePng(width, height, pixelAt) {
    const table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    const crc32 = (buf) => {
      let c = 0xffffffff;
      for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
      return (c ^ 0xffffffff) >>> 0;
    };
    function chunk(type, data) {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(body));
      return Buffer.concat([len, body, crc]);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // color type RGB
    const raw = Buffer.alloc(height * (1 + width * 3));
    let o = 0;
    for (let y = 0; y < height; y++) {
      raw[o++] = 0; // filter none
      for (let x = 0; x < width; x++) {
        const [r, g, b] = pixelAt(x, y);
        raw[o++] = r; raw[o++] = g; raw[o++] = b;
      }
    }
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", zlib.deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  }

  // 纯色图 → 灰度恒定 → 方差 0（空白判定的干净负样本）
  const solid = makePng(64, 64, () => [128, 128, 128]);
  assert.equal(grayscaleVariance(solid), 0);
  // 棋盘图 → 高方差（空白判定的干净正样本）
  const checker = makePng(64, 64, (x, y) => ((x + y) % 2 ? [255, 255, 255] : [0, 0, 0]));
  const vChecker = grayscaleVariance(checker);
  assert.ok(vChecker > 30, `棋盘方差 ${vChecker} 应远超阈值 30`);
  // 半分屏 → 高方差
  const half = makePng(64, 64, (x) => (x < 32 ? [16, 16, 16] : [240, 240, 240]));
  assert.ok(grayscaleVariance(half) > 30);
  // 确定性：同输入两次同值
  assert.equal(grayscaleVariance(checker), vChecker);
});
