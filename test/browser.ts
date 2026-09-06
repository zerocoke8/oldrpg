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
import type { RoomTextRequest } from "../shared/narration";

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

  /* 가짜 LLM 을 700ms 지연으로 꽂는다. 규칙 4가 화면에서 어떻게 보이는지를
     확인하려는 것이다: 폴백이 먼저 뜨고, 그 '줄이' 조용히 교체된다. */
  const LLM_MS = 700;
  const server = boot(DB, WS_PORT, {
    llmRenderer: async (req: RoomTextRequest) => {
      await sleep(LLM_MS);
      const calm = req.flags.some(([k, v]) => k === "guardian_slain" && v === true)
        ? " 공기가 한결 가벼워졌다."
        : "";
      return {
        text: `${req.seed}. 어딘가에서 물방울이 떨어지는 소리가 길게 이어진다.${calm}`,
        source: "llm" as const,
        model: "fake-model",
        promptVersion: "room.v1.ko",
      };
    },
    queue: { concurrency: 2 },
  });
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

  console.log("\n⑧ 규칙 4 — 폴백이 먼저 뜨고 그 '줄이' 조용히 교체된다");
  const c = await ctx.newPage();
  await c.goto(`http://127.0.0.1:${WEB_PORT}/?as=c`);
  await c.waitForSelector("text=석조 교차로", { timeout: 15_000 });
  await sleep(300);

  // 아무도 가 본 적 없는 방으로 간다 — (4,3). 앞 절들이 (3,3)/(2,3) 만 밟았다.
  // 이미 확정된 방으로 가면 처음부터 생성본이 오므로 (그것도 정상이다)
  // '폴백 -> 교체' 를 볼 수 없다.
  const badges = () => c.locator("text=새로 생성됨").count();
  const badgesBefore = await badges();
  await c.keyboard.press("ArrowRight");
  await c.waitForSelector("text=부서진 갑옷 조각", { timeout: 5000 });
  const early = await logText(c);
  const earlyLines = early.length;
  check("모델을 기다리지 않고 새 방 묘사가 먼저 떴다",
    early.some((t) => t.includes("부서진 갑옷 조각")));
  check("그 줄에는 아직 '새로 생성됨' 뱃지가 없다 (폴백이다)",
    (await badges()) === badgesBefore, `${badgesBefore} -> ${await badges()}`);
  await c.screenshot({ path: join(SHOTS, "6-폴백-먼저.png") });

  await sleep(LLM_MS + 900);
  const late = await logText(c);
  check("교체 후에도 로그 '줄 수' 가 늘지 않았다 (append 가 아니라 replace)",
    late.length === earlyLines, `${earlyLines} -> ${late.length}`);
  check("그 줄의 내용이 생성본으로 바뀌었다",
    late.some((t) => t.includes("갑옷") && t.includes("물방울이 떨어지는 소리가 길게 이어진다")),
    JSON.stringify(late));
  check("'새로 생성됨' 뱃지가 켜졌다", (await badges()) > badgesBefore);
  await c.screenshot({ path: join(SHOTS, "7-교체-후.png") });

  console.log("\n⑨ 3단계 — 세계가 바뀌어도 서 있는 화면을 갈아치우지 않는다");
  // c 는 (4,3) 에 있다 — guardian_slain 을 선언하지 '않은' 방.
  // a 를 영향권으로 보낸다: (3,3) -> (2,3) -> (1,3) -> (1,4)
  for (const k of ["ArrowLeft", "ArrowLeft", "ArrowDown"]) {
    await a.keyboard.press(k);
    await sleep(250);
  }
  await sleep(LLM_MS + 600);
  const aBefore = await logText(a);
  const aBeforeLines = aBefore.length;
  check("A 가 영향권(좁고 가파른 내리막)에 있다",
    aBefore.some((t) => t.includes("좁고 가파른 내리막")), JSON.stringify(aBefore.slice(-2)));

  server.events.setFlag("guardian_slain", true);
  await sleep(600);

  const aAfter = await logText(a);
  const cAfter = await logText(c);
  check("영향권의 A 는 '주변의 공기가 달라졌다'",
    aAfter.some((t) => t.includes("주변의 공기가 달라졌다")), JSON.stringify(aAfter.slice(-2)));
  check("비영향권의 C 는 '멀리서 무언가 무너지는 소리'",
    cAfter.some((t) => t.includes("멀리서 무언가 무너지는")), JSON.stringify(cAfter.slice(-2)));
  check("★ A 의 방 묘사는 그대로다 — 이벤트 한 줄만 늘었다",
    aAfter.length === aBeforeLines + 1, `${aBeforeLines} -> ${aAfter.length}`);
  check("상태창에 '파수꾼 처치됨' 이 떴다",
    (await a.locator("text=파수꾼 처치됨").count()) > 0);
  await a.screenshot({ path: join(SHOTS, "8-세계가-바뀌었다.png") });

  // 다음 입장부터 새 묘사
  await a.keyboard.press("ArrowUp");
  await sleep(300);
  await a.keyboard.press("ArrowDown");
  await sleep(500);
  const aReentry = await logText(a);
  check("다시 들어가니 새 상태의 묘사가 나온다",
    aReentry.some((t) => t.includes("좁고 가파른 내리막") && t.includes("가벼")),
    JSON.stringify(aReentry.slice(-3)));
  await a.screenshot({ path: join(SHOTS, "9-다음-입장부터.png") });

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
