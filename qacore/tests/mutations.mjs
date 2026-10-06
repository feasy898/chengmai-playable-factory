/**
 * 质检变异样本构造（防"永远绿灯"假质检）——oracle scripts/gate_phase0.py
 * 门项 6 `_build_mutant_source` 构造算法**逐条照搬**（qacore spec §8，冻结）：
 *
 * | 样本 | 构造算法（对 mini.html 的最小变异）           | 必须命中 |
 * | MUT-01 外链资源 | QC 桥接桩锚点（`  <script>\n    // QC 桥接桩`）前注入
 * |                 | `<img src="https://cdn.example.com/mut01-external.png" ...>` | CHK03 |
 * | MUT-02 未静音   | 同锚点注入未静音 `<audio autoplay src="data:audio/wav;base64,...">` | CHK04 |
 * | MUT-04 超体积   | `</body>` → `<!--` + "x"×pad + `--></body>`，
 * |                 | pad 使总字节 = 渠道 maxBytes+4096（meta 3MB 压线） | CHK01 |
 * | MUT-05 退出缺失 | 基座 = mini-exit.html（仓自有取证夹具，mini.html 受 REUSED-ASSETS
 * |                 | 字节登记不可改）：把结束页 CTA 的退出外呼行（`__pfRouteExit("…")`）
 * |                 | 替换为空操作——CHK06 实装第二波（spec §8"退出接口缺失→CHK06 实装后"） | CHK06 |
 * | MUT-06 伴生文件 | 基座 = mini.html：QC 桥接桩锚点前注入本地 `<script src="mut06-extra.js">`
 * |                 | 并在产物旁写出该文件（200 应答、非桩）——单文件交付被打破 | CHK02 |
 *
 * 通用纪律：样本写 tmp/（先清旧产物再跑，报告存在=本次真事实）；
 * 夹具本身只读、永不被改；恰命中断言 = exit 1 且 fail 集合恰为 {期望 CHK}。
 * MUT-03（结束页不可达）与 mutation-test 独立子命令仍列 M8 全量里程碑。
 */
import { readFileSync } from "node:fs";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_DIR = fileURLToPath(new URL("..", import.meta.url));
export const FIXTURE_MINI = join(PKG_DIR, "tests", "fixtures", "mini.html");
/** MUT-05 基座：仓自有取证夹具（mini.html 的 CHK06 扩展版，factory 自有不入登记册）。 */
export const FIXTURE_MINI_EXIT = join(PKG_DIR, "tests", "fixtures", "mini-exit.html");

const MUT_AUDIO_DATA_URI = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEA"
  + "RKwAAIhYAQACABAAZGF0YQAAAAA=";
export const MUTATION_OVERSIZE_CHANNEL = "meta"; // 规则库中该渠道上限 3MB，压线样本用它
const MUT_EXTERNAL_IMG = '<img src="https://cdn.example.com/mut01-external.png"'
  + ' alt="" width="1" height="1">';
const MUT_UNMUTED_AUDIO = `<audio autoplay src="${MUT_AUDIO_DATA_URI}"></audio>`;
/** MUT-05 锚点：夹具结束页 CTA 的退出外呼行（fixtures/mini-exit.html 原文）。 */
const MUT_EXIT_ANCHOR = 'window.__pfRouteExit("https://example.com/mini-exit-landing");';
/** MUT-06 注入的本地伴生脚本引用与文件内容（本地 200 应答、非桩）。 */
const MUT_EXTRA_REF = '<script src="mut06-extra.js"></script>';
const MUT_EXTRA_JS = "/* pf-qacore MUT-06：本地伴生文件（非容器桩，CHK02 计数口径） */\n";

export const MUTANTS = [
  {
    name: "MUT-01-external-img", inject: MUT_EXTERNAL_IMG,
    channel: "preview", expect: "CHK03",
    desc: "外链 <img>（qacore abort 拦截并记账，CHK08 不受扰）",
  },
  {
    name: "MUT-02-unmuted-audio", inject: MUT_UNMUTED_AUDIO,
    channel: "preview", expect: "CHK04",
    desc: "未静音 <audio autoplay>（媒体探针重采样捕获）",
  },
  {
    name: "MUT-04-oversize", inject: "PADDING",
    channel: MUTATION_OVERSIZE_CHANNEL, expect: "CHK01",
    desc: `包体压过 ${MUTATION_OVERSIZE_CHANNEL} 渠道 maxBytes 的注释填充`,
  },
  {
    name: "MUT-05-exit-missing", replaceExit: true, fixture: "mini-exit",
    channel: "preview", expect: "CHK06",
    desc: "结束页 CTA 的渠道退出外呼被剥除（退出桩记账为空；基座 mini-exit）",
  },
  {
    name: "MUT-06-extra-local-file", inject: MUT_EXTRA_REF,
    extraFiles: { "mut06-extra.js": MUT_EXTRA_JS },
    channel: "preview", expect: "CHK02",
    desc: "本地伴生 <script src>（file_count 2 > 上限 1，CHK03/08 不受扰）",
  },
];

/** 变异基座名 → 夹具绝对路径（默认 oracle 字节复用 mini.html）。 */
function fixtureFor(mutant) {
  return mutant.fixture === "mini-exit" ? FIXTURE_MINI_EXIT : FIXTURE_MINI;
}

/** 规则库 meta 渠道上限；规则库不可读时内部从严线 3MB（与 oracle 门禁同值）。 */
export function oversizeLimitBytes(rulesPath) {
  const FALLBACK = 3_145_728;
  try {
    const rules = JSON.parse(readFileSync(rulesPath, "utf8"));
    return Number(rules.channels[MUTATION_OVERSIZE_CHANNEL].maxBytes) || FALLBACK;
  } catch {
    return FALLBACK;
  }
}

/**
 * Python Path.read_text 的 universal-newline 语义（\r\n → \n）：oracle 门禁以
 * read_text 读夹具，Windows 检出为 CRLF 的夹具在其实现里按 LF 参与锚点匹配与
 * 变异写回——本移植同规格归一，保证 mutant 字节与 oracle 门禁产物一致。
 */
export function readTextUniversal(p) {
  return readFileSync(p, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * 按变异方式构造 mutant 源字节（oracle _build_mutant_source 逐条照搬）。
 * @returns {Promise<{name: string, expect: string, channel: string, html: Buffer}>}
 */
export async function buildMutantSource(mutant, base, limitBytes) {
  if (mutant.inject === "PADDING") {
    const baseBytes = Buffer.from(base, "utf8");
    const target = limitBytes + 4096;
    const pad = target - baseBytes.length - Buffer.byteLength("<!---->", "utf8");
    if (pad <= 0) throw new Error(`填充量异常：${pad}`);
    const filler = Buffer.concat([
      Buffer.from("<!--", "utf8"), Buffer.alloc(pad, 0x78), Buffer.from("--></body>", "utf8"),
    ]);
    const idx = baseBytes.indexOf("</body>");
    if (idx < 0) throw new Error("夹具缺少 </body>，超体积变异注入位置失效");
    return {
      name: mutant.name, expect: mutant.expect, channel: mutant.channel,
      html: Buffer.concat([baseBytes.subarray(0, idx), filler, baseBytes.subarray(idx + 7)]),
    };
  }
  // MUT-05：剥除结束页 CTA 的退出外呼行（替换为空操作；外呼记账必空 → CHK06 fail）。
  if (mutant.replaceExit === true) {
    if (!base.includes(MUT_EXIT_ANCHOR)) {
      throw new Error("夹具缺少退出外呼行，MUT-05 变异位置失效");
    }
    return {
      name: mutant.name, expect: mutant.expect, channel: mutant.channel,
      html: Buffer.from(base.replace(MUT_EXIT_ANCHOR, "void 0; /* MUT-05: 退出接口外呼已剥除 */"), "utf8"),
    };
  }
  const marker = "  <script>\n    // QC 桥接桩";
  if (!base.includes(marker)) {
    throw new Error("夹具缺少 QC 桥接桩锚点，变异注入位置失效");
  }
  return {
    name: mutant.name, expect: mutant.expect, channel: mutant.channel,
    html: Buffer.from(base.replace(marker, `  ${mutant.inject}\n${marker}`), "utf8"),
  };
}

/**
 * 在 outDir 现场构造全部变异样本（先清旧目录再生成——"先清后跑"纪律）。
 * @returns {Promise<Array<{name, expect, channel, path}>>}
 */
export async function materializeMutants(outDir, rulesPath, fixturePath = FIXTURE_MINI) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const limitBytes = oversizeLimitBytes(rulesPath);
  const bases = new Map(); // 夹具路径 → universal-newline 归一文本（同基座只读一次）
  const out = [];
  for (const mutant of MUTANTS) {
    const basePath = fixtureFor(mutant);
    if (!bases.has(basePath)) bases.set(basePath, readTextUniversal(basePath));
    const built = await buildMutantSource(mutant, bases.get(basePath), limitBytes);
    const p = join(outDir, `${built.name}.html`);
    await writeFile(p, built.html);
    // 伴生文件随产物落盘（MUT-06：本地真实文件，伺服 200 应答、非容器桩）。
    for (const [name, content] of Object.entries(mutant.extraFiles ?? {})) {
      await writeFile(join(outDir, name), content);
    }
    out.push({ name: built.name, expect: built.expect, channel: built.channel, path: p });
  }
  return out;
}

export function sha256File(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}
