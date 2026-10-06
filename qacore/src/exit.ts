/**
 * 渠道退出接口取证（CHK06，2026-10-06 实装）：按规则库 `exit.protocol` 在页面导航前
 * 注入渠道退出桩（渠道容器替身——投放时由渠道容器提供的全局，本地质检时容器不在场，
 * 与 runtime_stubs 同一立场：桩模拟的是环境、不是被测物；产品代码真实加载）。
 *
 * 桩把调用记账进 `window.__pfexit.calls`（{fn, url, at}）；QC 在自动试玩到达结束页后
 * 点击模板 `__PF_QC__.cta()` 上报的 CTA 热区中心（真实 pointer 事件，与 hint 手势同一
 * 语义），再读回记账做判定（判定在 checks.evaluate，本模块只采集）。
 *
 * 分型断言依据（channel-adapters §3 修正候选）：传 URL 渠道（mraid 形/preview）
 * 断言"调用一次且参数=landingUrl"（landingUrl 经 CLI --require-exit-url 传入）；
 * 不传 URL 渠道（meta/google/tiktok）断言"调用恰一次 + 触发时机=结束页 CTA 点击"。
 */
import type { Page } from "playwright";

import { ev } from "./ev.ts";

export interface ExitCall {
  fn: string;
  url: string | null;
  at: number | null;
}

/** 各退出协议记账的函数名（与桩注入的调用面一一对应）。 */
export const EXIT_FN_BY_PROTOCOL: Record<string, string> = {
  "mraid": "mraid.open",
  "fb-playable": "FbPlayableAd.onComplete",
  "exit-api": "ExitApi.exit",
  "js-sdk": "openAppStore",
  "window-open": "window.open",
};

/**
 * 构建渠道退出桩 init script（导航前注入，双趟各一次；重复注入会重复包装
 * window.open，故与探针同纪律：只在 wire 装配段注入一次/页面）。
 * protocol 未知（规则库未登记的形态）→ 只注入记账器、不注入任何全局替身。
 */
export function exitStubScript(protocol: string | null): string {
  const rec = "window.__pfexit={calls:[]};"
    + "window.__pfexit.record=function(fn,url){"
    + "window.__pfexit.calls.push({fn:fn,url:(typeof url==='string')?url:null,"
    + "at:(typeof performance!=='undefined'&&performance.now)?performance.now():null});};";
  switch (protocol) {
    case "mraid":
      // mraid 形替身：getState=loaded（桥就绪判定立即放行）、音量探测面、open 记账。
      return rec
        + "window.mraid={getState:function(){return 'loaded';},"
        + "addEventListener:function(){},removeEventListener:function(){},"
        + "getAudioVolume:function(){return 1.0;},"
        + "open:function(u){window.__pfexit.record('mraid.open',u);}};";
    case "fb-playable":
      return rec
        + "window.FbPlayableAd={onComplete:function(){"
        + "window.__pfexit.record('FbPlayableAd.onComplete',null);}};";
    case "exit-api":
      return rec
        + "window.ExitApi={exit:function(){window.__pfexit.record('ExitApi.exit',null);}};";
    case "js-sdk":
      return rec
        + "window.openAppStore=function(){window.__pfexit.record('openAppStore',null);};";
    case "window-open":
      // preview 退出面：覆写 window.open（记账后不放行弹窗——本地质检无投放跳转目标）。
      return rec
        + "window.open=function(u){window.__pfexit.record('window.open',u);return null;};";
    default:
      return rec;
  }
}

/** 读回退出调用记账（页面未注入/未记账 → []）。 */
export async function readExitCalls(page: Page): Promise<ExitCall[]> {
  let v: unknown;
  try {
    v = await ev(page,
      "() => (window.__pfexit && Array.isArray(window.__pfexit.calls))"
      + " ? window.__pfexit.calls : []",
    );
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  const calls: ExitCall[] = [];
  for (const x of v) {
    if (x !== null && typeof x === "object") {
      const c = x as Record<string, unknown>;
      calls.push({
        fn: typeof c.fn === "string" ? c.fn : "",
        url: typeof c.url === "string" ? c.url : null,
        at: typeof c.at === "number" ? c.at : null,
      });
    }
  }
  return calls;
}
