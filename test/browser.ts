/* 진짜 브라우저 두 개로 이번 단계의 목표를 눈으로 확인한다.
 *
 * "브라우저 두 개를 띄웠을 때 서로의 위치가 미니맵에 보이고,
 *  같은 방에 있으면 'OO가 들어왔다' 메시지가 뜨는 것"
 *
 * 실행: npm run test:browser   (스크린샷은 test/shots/ 에 남는다) */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { createServer as createVite } from "vite";
import { boot } from "../server/index";

const WS_PORT = 8901;
const WEB_PORT = 5199;
const DB = join(tmpdir(), `mud-browser-${process.pid}.db`);
const SHOTS = join(import.meta.dirname, "shots");

let failures = 0;
const check = (label: string, cond: boolean, detail = ""): void => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 화면에 실제로 렌더된 로그 줄들. DOM 에서 읽는다 — 와이어가 아니라. */
const logText = (p: Page) => p.locator("p").allInnerTexts();

/** 미니맵에서 '다른 플레이어' 테두리가 칠해진 칸의 인덱스. */
async function otherCells(p: Page): Promise<number[]> {
  return p.evaluate(() => {
    const grid = document.querySelector('div[style*="grid-template-columns"]');
    if (!grid) return [];
    const out: number[] = [];
    [...grid.children].forEach((el, i) => {
      // C.other = #7fd0e8 — 다른 플레이어가 있는 칸의 outline
      const o = getComputedStyle(el as HTMLElement).outlineColor;
      const w = getComputedStyle(el as HTMLElement).outlineStyle;
      if (w === "solid" && o === "rgb(127, 208, 232)") out.push(i);
    });
    return out;
  });
}

async function main() {
  rmSync(DB, { force: true });
  rmSync(`${DB}-wal`, { force: true });
  rmSync(`${DB}-shm`, { force: true });
  mkdirSync(SHOTS, { recursive: true });

  const server = boot(DB, WS_PORT);
  const vite = await createVite({
    root: "client",
    server: { port: WEB_PORT, strictPort: true },
    define: { "import.meta.env.VITE_MUD_WS": JSON.stringify(`ws://127.0.0.1:${WS_PORT}`) },
    logLevel: "warn",
  });
  await vite.listen();

  /* 이 이미지에는 크로미움이 미리 깔려 있다. playwright 버전이 다른 빌드를
     기대할 수 있으므로, 있으면 그 실행 파일을 직접 가리킨다 (다운로드 금지). */
  const preinstalled = [
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    "/opt/pw-browsers/chromium/chrome-linux/chrome",
  ].find((p) => existsSync(p));
  const browser = await chromium.launch(preinstalled ? { executablePath: preinstalled } : {});
  // 브라우저 컨텍스트를 나눌 필요조차 없다: 토큰 슬롯(?as=)이 탭을 가른다.
  const ctx = await browser.newContext({ viewport: { width: 600, height: 820 } });
  const a = await ctx.newPage();
  const b = await ctx.newPage();

  console.log("\n① 브라우저 두 개를 띄운다 (?as=a / ?as=b)");
  await a.goto(`http://127.0.0.1:${WEB_PORT}/?as=a`);
  await a.waitForSelector("text=석조 교차로", { timeout: 15_000 });
  check("A 창에 방 묘사가 렌더됐다", true);

  await b.goto(`http://127.0.0.1:${WEB_PORT}/?as=b`);
  await b.waitForSelector("text=석조 교차로", { timeout: 15_000 });
  await sleep(500);

  console.log("\n② 같은 방 — 'OO 님이 ... 나타났다'");
  const aLog = await logText(a);
  const entered = aLog.find((t) => t.includes("나타났다"));
  check("A 화면에 입장 메시지가 떴다", Boolean(entered), JSON.stringify(aLog));
  console.log(`       "${entered ?? ""}"`);

  const bLog = await logText(b);
  check("B 화면에 로스터 줄이 떴다", bLog.some((t) => t.includes("서 있다")), JSON.stringify(bLog));

  console.log("\n③ 미니맵에 서로가 보인다");
  const aCells = await otherCells(a);
  const bCells = await otherCells(b);
  // 스폰 (3,3) -> 7칸 격자에서 인덱스 3*7+3 = 24
  check("A 미니맵의 (3,3) 칸에 상대 표시", aCells.includes(24), `cells=${JSON.stringify(aCells)}`);
  check("B 미니맵의 (3,3) 칸에 상대 표시", bCells.includes(24), `cells=${JSON.stringify(bCells)}`);
  await a.screenshot({ path: join(SHOTS, "1-같은방.png") });

  console.log("\n④ B 가 서쪽으로 이동 -> A 미니맵의 점이 따라 움직인다");
  await b.keyboard.press("ArrowLeft");
  await sleep(500);
  const aCells2 = await otherCells(a);
  check("A 미니맵의 상대 점이 (2,3) 으로 옮겨졌다", aCells2.includes(23) && !aCells2.includes(24),
    `cells=${JSON.stringify(aCells2)}`);
  const aLog2 = await logText(a);
  check("A 화면에 '서쪽으로 사라졌다'", aLog2.some((t) => t.includes("서쪽으로 사라졌다")));
  const bLog2 = await logText(b);
  check("B 화면에 새 방의 묘사가 떴다 (Phase B)", bLog2.some((t) => t.includes("물방울")));
  await a.screenshot({ path: join(SHOTS, "2-A가본-이동.png") });
  await b.screenshot({ path: join(SHOTS, "3-B가본-새방.png") });

  console.log("\n⑤ B 가 되돌아옴 -> 'OO 님이 서쪽에서 들어왔다'");
  await b.keyboard.press("ArrowRight");
  await sleep(500);
  const aLog3 = await logText(a);
  check("A 화면에 '서쪽에서 들어왔다'", aLog3.some((t) => t.includes("서쪽에서 들어왔다")),
    JSON.stringify(aLog3.slice(-4)));
  console.log(`       "${aLog3.find((t) => t.includes("서쪽에서 들어왔다")) ?? ""}"`);
  await a.screenshot({ path: join(SHOTS, "4-들어왔다.png") });

  console.log("\n⑥ 벽 — 화면에는 문장만, 위치는 그대로");
  await b.keyboard.press("ArrowUp"); // (3,2) 는 벽
  await sleep(400);
  const bLog4 = await logText(b);
  check("'단단한 벽이 앞을 막는다.'", bLog4.some((t) => t.includes("단단한 벽")));
  const aCells3 = await otherCells(a);
  check("벽에 막혔으므로 A 미니맵의 점은 (3,3) 그대로", aCells3.includes(24));

  console.log("\n⑦ B 새로고침 — A 화면은 조용해야 한다 (유예)");
  const beforeReload = (await logText(a)).length;
  await b.reload();
  await b.waitForSelector("text=석조 교차로", { timeout: 15_000 });
  await sleep(800);
  const afterReload = await logText(a);
  check("A 로그에 새 줄이 늘지 않았다 (나갔다/들어왔다 없음)",
    afterReload.length === beforeReload,
    `${beforeReload} -> ${afterReload.length}: ${JSON.stringify(afterReload.slice(beforeReload))}`);
  const aCellsR = await otherCells(a);
  check("새로고침 후에도 A 미니맵에 B 가 남아 있다 (에폭 가드)", aCellsR.includes(24),
    `cells=${JSON.stringify(aCellsR)}`);
  const bLogR = await logText(b);
  check("B 는 새로고침 후 자기 안개를 서버에서 복원받았다",
    bLogR.some((t) => t.includes("서 있다")), JSON.stringify(bLogR));
  await a.screenshot({ path: join(SHOTS, "5-새로고침후-A.png") });

  await browser.close();
  await vite.close();
  await server.close();
  rmSync(DB, { force: true });
  rmSync(`${DB}-wal`, { force: true });
  rmSync(`${DB}-shm`, { force: true });

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — 스크린샷: test/shots/`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
