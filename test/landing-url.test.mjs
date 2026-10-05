// test/landing-url.test.mjs — 自定义 landingUrl 回归（模板默认填充链零外链修复）。
//
// 背景：四模板 normalizeSpec（packages/templates/*/src/spec.ts）曾内联字面量默认
// "https://example.com/playable-lp"，该字面量随 bundle 打进**每份**产物 JS——spec
// 换自定义落地页时，打包器白名单（spec.flow.endScreen.landingUrl + 规则库惰性串，
// 见 docs/specs/packager.md §3.5"外链白名单唯一前缀"）不含它，即触发零外链红线：
//   index.html 存在白名单外链接（零外链红线）: https://example.com/playable-lp
// 修复：模板缺省改空串（schema 必填 landingUrl，走校验的流水线恒有值），产物只含
// spec 传导的落地页 URL，字面量不再残留。
//
// 本件真实执行构建链（AGENTS.md 纪律）：golden spec 改落地页 → 模板 build.mjs
// 真实 esbuild 构建 → 打包器 applovin 单 HTML 打包，断言：
//   正向（match3 + sort 双模板）：build 成功；产物 CTA 目标
//     （window.PF_SPEC.endScreen.landingUrl，运行期 pf.open 的唯一来源）为自定义
//     URL；产物零字面量默认残留（出现即失败）。
//   负向：自定义 landingUrl spec 下，dist 混入白名单外真外链 → 仍被拒绝（红线不弱化）。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PACKAGER_BIN = join(ROOT, "packages", "packager", "bin.mjs");

const CUSTOM_URL = "https://example.com/store";
const DEFAULT_LITERAL = "https://example.com/playable-lp";

function buildAndPack(template, specPath, dir) {
  const distDir = join(dir, "dist");
  const distIndex = join(distDir, "en", "index.html");
  const buildScript = join(ROOT, "packages", "templates", `tmpl-${template}`, "build.mjs");
  const build = spawnSync(process.execPath, [buildScript, "--spec", specPath, "--out", distIndex, "--locale", "en"], {
    cwd: ROOT, encoding: "utf8", timeout: 120_000, windowsHide: true,
  });
  return { distDir, distIndex, build };
}

function pack(specPath, distDir, outDir) {
  const r = spawnSync(process.execPath, [
    PACKAGER_BIN, "build",
    "--spec", specPath, "--dist", distDir,
    "--channel", "applovin", "--locale", "en", "--out", outDir,
  ], { cwd: ROOT, encoding: "utf8", timeout: 120_000, windowsHide: true });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** 产物内 CTA 目标断言：提取 window.PF_SPEC JSON（运行期 pf.open 的唯一来源）。 */
function pfSpecOf(html) {
  const m = html.match(/window\.PF_SPEC=(\{.+?\});window\.PF_LOCALE=/);
  assert.ok(m, "产物含 window.PF_SPEC 内联");
  return JSON.parse(m[1]);
}

for (const template of ["match3", "sort"]) {
  test(`自定义 landing_url（${template}）→ 模板构建 + applovin 打包成功，CTA 指向自定义 URL，产物零字面量默认`, () => {
    const dir = mkdtempSync(join(tmpdir(), `pf-landing-url-${template}-`));
    try {
      // golden spec 只改落地页参数（自定义 landing_url 的最小构造）。
      const golden = JSON.parse(readFileSync(join(ROOT, "specs-eval", `golden-${template}.json`), "utf8"));
      assert.equal(golden.flow.endScreen.landingUrl, DEFAULT_LITERAL, "golden 夹具基线含字面量默认");
      golden.flow.endScreen.landingUrl = CUSTOM_URL;
      const specPath = join(dir, "spec-custom-lp.json");
      writeFileSync(specPath, JSON.stringify(golden), "utf8");

      const { distDir, distIndex, build } = buildAndPack(template, specPath, dir);
      assert.equal(build.status, 0, `模板构建 exit 0\nstdout=${build.stdout}\nstderr=${build.stderr}`);
      assert.ok(existsSync(distIndex));

      const outDir = join(dir, "out");
      const packRes = pack(specPath, distDir, outDir);
      assert.equal(packRes.code, 0, `applovin 打包 exit 0\nstdout=${packRes.stdout}\nstderr=${packRes.stderr}`);

      const artifact = join(outDir, golden.meta.projectId, "applovin", "en", "index.html");
      assert.ok(existsSync(artifact), `产物存在: ${artifact}`);
      const html = readFileSync(artifact, "utf8");
      // CTA 目标 = spec 传导的自定义 URL（PF_SPEC.endScreen.landingUrl，CTA 点击
      // 时经 normalizeSpec 原样透传给 PF.open）。
      const pfSpec = pfSpecOf(html);
      assert.equal(pfSpec.flow.endScreen.landingUrl, CUSTOM_URL, "CTA 目标为自定义落地页");
      assert.ok(html.includes(CUSTOM_URL), "产物含自定义落地页 URL");
      // 字面量默认零残留（出现即失败——本修复的自洽口径）。
      assert.doesNotMatch(html, /playable-lp/, "产物不再残留字面量默认落地页");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("负向：自定义 landingUrl spec 下，dist 混入白名单外真外链 → 打包器仍拒绝（零外链红线不弱化）", () => {
  const dir = mkdtempSync(join(tmpdir(), "pf-landing-url-neg-"));
  try {
    const golden = JSON.parse(readFileSync(join(ROOT, "specs-eval", "golden-match3.json"), "utf8"));
    golden.flow.endScreen.landingUrl = CUSTOM_URL;
    const specPath = join(dir, "spec-custom-lp.json");
    writeFileSync(specPath, JSON.stringify(golden), "utf8");

    const { distDir, build } = buildAndPack("match3", specPath, dir);
    assert.equal(build.status, 0);
    // 混入真外链（不在白名单：白名单只含自定义 landingUrl + 规则库惰性串）。
    const injected = join(dir, "dist-leak");
    cpSync(distDir, injected, { recursive: true });
    const leakIndex = join(injected, "en", "index.html");
    writeFileSync(leakIndex, readFileSync(leakIndex, "utf8").replace("</head>", '  <img src="https://cdn.example.com/leak.png">\n</head>'), "utf8");

    const packRes = pack(specPath, injected, join(dir, "out"));
    assert.notEqual(packRes.code, 0, "真外链仍被拒绝");
    // 两道红线关卡任一拦截均可：dist 解析层（外链禁止）或产物文本扫描层（零外链红线）。
    assert.match(packRes.stderr, /外链禁止|零外链红线/);
    assert.match(packRes.stderr, /cdn\.example\.com\/leak\.png/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
