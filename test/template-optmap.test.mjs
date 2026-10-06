// test/template-optmap.test.mjs — 四模板 PF_ASSET_OPTMAP 接线 eval（真实执行 build.mjs）：
// - 命中：optmap 声明串精确匹配 → 内联优化产物字节 + 旁车 source=assetkit
//   （originalBytes/optimizedBytes 如实记账）；
// - 未命中：optmap 缺该键 → 回退原素材（行为与无 optmap 一致，旁车无 source 键）；
// - 无 optmap：不设环境变量 → 原素材内联（tmpl-match3 既有行为回归 + 三模板同形）。
// 对应根 README「已接通」素材管线项与 docs/specs/assetkit.md §2：四模板全部接线。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TEMPLATES = [
  { name: "match3", pkg: "tmpl-match3", spriteKey: "piece-0" },
  { name: "merge", pkg: "tmpl-merge", spriteKey: "tier-1" },
  { name: "pullpin", pkg: "tmpl-pullpin", spriteKey: "pin" },
  { name: "sort", pkg: "tmpl-sort", spriteKey: "piece" },
];

/** 最小可构建 spec（构建脚本只消费 assets.sprites / meta.title / i18n.defaultLocale）。 */
function miniSpec(spriteKey, rel) {
  return {
    specVersion: "1.0.0",
    meta: { projectId: "optmap-eval", title: "optmap eval", seed: 7 },
    game: { template: "t", params: {}, difficulty: { targetLevel: 0.4 },
      attract: { nearWin: false, failBait: false, firstClickSucceed: true },
      durationBudgetSec: { target: 20, max: 30 } },
    flow: { tutorial: { enabled: false, gesture: "tap", maxSec: 1 },
      endScreen: { showScore: false, ctaKey: "cta", landingUrl: "https://example.com/x" } },
    assets: { background: null, sprites: { [spriteKey]: rel }, audio: {} },
    i18n: { defaultLocale: "en", locales: ["en"], strings: { en: {} }, rtl: [] },
    channels: { targets: ["preview"], orientation: "portrait", overrides: {} },
    qc: { maxLoadSec: 2, autoplayTimeoutSec: 45 },
  };
}

async function pngBytes(width, height, rgb) {
  const sharp = (await import("sharp")).default;
  return sharp({
    create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } },
  }).png().toBuffer();
}

function buildTemplate(pkg, specPath, outPath, env) {
  const proc = spawnSync(process.execPath,
    [join(REPO_ROOT, "packages", "templates", pkg, "build.mjs"),
      "--spec", specPath, "--out", outPath],
    { cwd: REPO_ROOT, timeout: 300_000, encoding: "utf8", windowsHide: true,
      env: env ?? process.env });
  assert.equal(proc.status, 0,
    `${pkg} build exit=${proc.status}\n${proc.stdout}\n${proc.stderr}`);
  assert.ok(existsSync(outPath), `${pkg} 产物未产出`);
  assert.ok(existsSync(`${outPath}.assets.json`), `${pkg} 旁车清单未产出`);
  return {
    html: readFileSync(outPath, "utf8"),
    sidecar: JSON.parse(readFileSync(`${outPath}.assets.json`, "utf8")),
  };
}

for (const t of TEMPLATES) {
  test(`optmap 接线 ${t.pkg}：命中内联优化产物 + 旁车 source=assetkit；未命中回退原素材`, async () => {
    const dir = mkdtempSync(join(tmpdir(), `pf-optmap-${t.name}-`));
    try {
      // 原素材（大、红）与"优化产物"（小、蓝）字节可区分；内联判定不依赖 sharp 细节。
      const orig = await pngBytes(96, 96, [200, 30, 30]);
      const opt = await pngBytes(48, 48, [30, 30, 200]);
      writeFileSync(join(dir, "orig.png"), orig);
      mkdirSync(join(dir, "opt"), { recursive: true });
      writeFileSync(join(dir, "opt", "orig.opt.webp"), opt);

      const specPath = join(dir, "spec.json");
      writeFileSync(specPath, JSON.stringify(miniSpec(t.spriteKey, "orig.png")), "utf8");

      const optmapPath = join(dir, "asset-optmap.json");
      writeFileSync(optmapPath, JSON.stringify({
        version: 1, outDir: join(dir, "opt"),
        entries: [{ key: "orig.png", src: join(dir, "orig.png"), out: "orig.opt.webp",
          kind: "image", encoding: "webp-lossy",
          originalBytes: orig.length, optimizedBytes: opt.length }],
      }), "utf8");

      const outHit = join(dir, "hit.html");
      const hit = buildTemplate(t.pkg, specPath, outHit,
        { ...process.env, PF_ASSET_OPTMAP: optmapPath });
      const optB64 = `data:image/webp;base64,${opt.toString("base64")}`;
      const origB64 = `data:image/png;base64,${orig.toString("base64")}`;
      assert.ok(hit.html.includes(optB64), `${t.pkg}: 命中时应内联优化产物字节`);
      assert.ok(!hit.html.includes(origB64), `${t.pkg}: 命中时不应再内联原素材`);
      assert.deepEqual(hit.sidecar.sprites, [{
        spriteKey: t.spriteKey, path: "orig.png", bytes: opt.length,
        source: "assetkit", originalBytes: orig.length, optimizedBytes: opt.length,
      }], `${t.pkg}: 旁车应记 source=assetkit + 前后字节`);

      // 未命中：optmap 无该键 → 回退原素材（旁车无 source 键，行为与无 optmap 一致）
      const optmapMiss = join(dir, "asset-optmap-miss.json");
      writeFileSync(optmapMiss, JSON.stringify({ version: 1, outDir: join(dir, "opt"), entries: [] }), "utf8");
      const outMiss = join(dir, "miss.html");
      const miss = buildTemplate(t.pkg, specPath, outMiss,
        { ...process.env, PF_ASSET_OPTMAP: optmapMiss });
      assert.ok(miss.html.includes(origB64), `${t.pkg}: 未命中应回退原素材`);
      assert.deepEqual(miss.sidecar.sprites,
        [{ spriteKey: t.spriteKey, path: "orig.png", bytes: orig.length }],
        `${t.pkg}: 未命中旁车不应有 source 键`);

      // 无 optmap：不设环境变量 → 同回退形态（match3 既有行为回归 + 三模板同形）
      const outNone = join(dir, "none.html");
      const noneEnv = { ...process.env };
      delete noneEnv.PF_ASSET_OPTMAP;
      const none = buildTemplate(t.pkg, specPath, outNone, noneEnv);
      assert.ok(none.html.includes(origB64), `${t.pkg}: 无 optmap 应内联原素材`);
      assert.deepEqual(none.sidecar.sprites, miss.sidecar.sprites,
        `${t.pkg}: 无 optmap 与未命中旁车同形`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
