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

/** 상태창이 말하는 지금 좌표. 화면에서 읽는다 — 와이어가 아니라. */
async function posOf(p: Page): Promise<string> {
  const t = await p.locator("body").innerText();
  const m = /지하 1층 · (\d+),(\d+)/.exec(t);
  return m ? `${m[1]},${m[2]}` : "?";
}

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
    llm: "off", // 주입한 가짜만 쓴다 — 키가 있는 기계에서도 네트워크로 나가지 않는다
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
    /* NPC 대사에도 같은 지연을 준다 — 규칙 4가 대사에서도 지켜지는지,
       그리고 교체된 뒤에도 화자("제단지기: ")가 남는지를 화면에서 본다. */
    llmNpcRenderer: async (req) => {
      await sleep(LLM_MS);
      const calm = req.flags.some(([k, v]) => k === "guardian_slain" && v === true)
        ? "이제는 말해도 괜찮다는 듯 목소리가 낮아진다."
        : "말끝을 흐린다."; // 폴백 꼬리("그 이상은 말하지 않는다")와 눈으로 구별된다
      return {
        text: `${req.seed}. ${calm}`,
        source: "llm" as const,
        model: "fake-model",
        promptVersion: "npc.v1.ko",
      };
    },
    queue: { concurrency: 2 },
  });
  const vite = await createVite({
    root: "client",
    server: { port: WEB_PORT, strictPort: true },
    define: { "import.meta.env.VITE_MUD_WS": JSON.stringify(`ws://127.0.0.1:${WS_PORT}/ws`) },
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

  console.log("\n⑨ 4a단계 — 실시간 전투 (진짜 시계로)");
  /* c 를 적이 있는 방으로. (3,4) 는 벽이라 (5,4) 로 돌아가야 한다:
       (4,3) -> (5,3) -> (5,4) -> (5,5) -> (4,5) -> (3,5) */
  for (const k of ["ArrowRight", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowLeft"]) {
    await c.keyboard.press(k);
    await sleep(300);
  }
  await sleep(600);
  const atEnemy = await logText(c);
  check("적이 있는 방에 도착했다",
    atEnemy.some((t) => t.includes("이쪽을 향해 서 있다")), JSON.stringify(atEnemy.slice(-3)));
  check("커맨드 창에 '싸우기' 가 떴다 (방에 적이 있다)",
    (await c.locator("button:has-text('싸우기')").count()) > 0);

  // 5단계: 명령은 전부 커맨드 창 한 곳에 있다. 싸우기 -> 공격.
  await c.locator("button:has-text('싸우기')").first().click();
  await sleep(150);
  await c.locator("button:has-text('공격')").first().click();
  await sleep(200);
  check("전투 패널이 떴다", (await c.locator("text=그림자 파수꾼").count()) > 0);
  const skillCount = await c
    .locator("button:has-text('강타'), button:has-text('응급 치료'), button:has-text('방어 태세')")
    .count();
  check("교전이 시작되자 스킬이 같은 창에 나타났다 (메뉴는 상태의 함수)",
    skillCount === 3, String(skillCount));

  // ★ 한 번만 눌렀는데 계속 오가는가 — 진짜 시계로 2.5초 지켜본다
  const linesAfterEngage = (await logText(c)).length;
  await sleep(2500);
  const linesLater = (await logText(c)).length;
  check("★ 명령 한 번에 공방이 계속 오갔다 (턴제가 아니다)",
    linesLater > linesAfterEngage, `${linesAfterEngage} -> ${linesLater}`);
  check("★ 전투 로그가 접혀 있다 (연속된 combat 줄)",
    (await c.locator("text=공방이 오갔다").count()) > 0,
    JSON.stringify((await logText(c)).slice(-4)));
  await c.screenshot({ path: join(SHOTS, "10-실시간-전투.png") });

  // 스킬이 다음 스윙에 나가는가
  await c.locator("button:has-text('강타')").first().click();
  await sleep(900);
  const afterSkill = await logText(c);
  check("스킬이 발동했다 (접히지 않고 드러난다)",
    afterSkill.some((t) => t.includes("강타!")), JSON.stringify(afterSkill.slice(-4)));
  check("쿨다운이 버튼에 표시된다",
    await c.locator("button:has-text('강타')").first().isDisabled());
  await c.screenshot({ path: join(SHOTS, "11-스킬.png") });

  // 접힌 로그를 펼쳐 본다
  await c.locator("text=공방이 오갔다").first().click();
  await sleep(150);
  check("접힌 로그를 펼칠 수 있다", (await c.locator("text=접기").count()) > 0);
  await c.screenshot({ path: join(SHOTS, "12-로그-펼침.png") });

  // 방을 벗어나 교전을 끊는다. (2,5) 도 guardian_slain 영향권이라
  // 다음 절에서 C 는 'near' 를 받는다.
  await c.keyboard.press("ArrowLeft");
  await sleep(400);
  check("걸어 나가니 전투 패널이 사라졌다",
    (await c.locator("button:has-text('물러나기')").count()) === 0);
  check("★ 서 있던 커맨드 경로도 최상위로 되돌아갔다 (가지가 사라졌다)",
    (await c.locator("button:has-text('살펴보기')").count()) > 0);

  console.log("\n⑩ 4b단계 — NPC 대화 (말을 걸어야 나온다)");
  /* B 는 스폰(3,3). 제단지기의 방(3,1)까지: 좌 좌 상 상 우 우.
     (3,2) 가 벽이라 서쪽으로 돌아 올라간다. */
  for (const k of ["ArrowLeft", "ArrowLeft", "ArrowUp", "ArrowUp", "ArrowRight", "ArrowRight"]) {
    await b.keyboard.press(k);
    await sleep(280);
  }
  await sleep(LLM_MS + 500);
  /** 화면에 남아 있는 대사 줄. 앞에 '새로 생성됨' 뱃지가 붙을 수 있다. */
  const npcLines = async () => (await logText(b)).filter((t) => t.includes("제단지기: "));
  /** badges() 는 c 의 화면을 센다. B 의 화면에는 이쪽을 쓴다. */
  const bBadges = () => b.locator("text=새로 생성됨").count();

  const atNpc = await logText(b);
  check("NPC 가 '있다' 고만 알린다",
    atNpc.some((t) => t.includes("제단지기이(가) 이곳에 있다")), JSON.stringify(atNpc.slice(-3)));
  check("★ 말을 걸기 전에는 대사가 없다", (await npcLines()).length === 0);
  check("커맨드 창에 '대화' 가 떴다", (await b.locator("button:has-text('대화')").count()) > 0);
  await b.screenshot({ path: join(SHOTS, "13-NPC-있음.png") });

  const badgesBeforeTalk = await bBadges();
  await b.locator("button:has-text('대화')").first().click();
  await sleep(150);
  check("말 걸 상대가 목록에 있다", (await b.locator("button:has-text('제단지기')").count()) > 0);
  // 들어가는 것이 곧 말을 거는 것이다 (talk 액션 + 주제 목록으로 하강).
  await b.locator("button:has-text('제단지기')").first().click();
  await sleep(250);
  const greetLine = (await npcLines())[0];
  check("말을 거니 인사가 나온다", Boolean(greetLine), JSON.stringify(await logText(b)));
  check("★ 폴백이 '즉시' 나왔다 — 모델을 기다리지 않았다 (규칙 4)",
    Boolean(greetLine?.includes("낯선 이를 흘깃")) && (await bBadges()) === badgesBeforeTalk,
    String(greetLine));
  check("주제 버튼이 떴다", (await b.locator("button:has-text('파수꾼에 대해')").count()) > 0);
  check("★ 아직 잠긴 주제는 화면에 없다 (그 존재 자체가 스포일러다)",
    (await b.locator("button:has-text('봉인된 문에 대해')").count()) === 0);
  await b.screenshot({ path: join(SHOTS, "14-대화창.png") });

  const linesBeforeUpgrade = (await logText(b)).length;
  await sleep(LLM_MS + 600);
  const upgraded = (await npcLines())[0];
  check("★ 확정본으로 조용히 교체됐다 (줄 수는 그대로, 내용만)",
    Boolean(upgraded?.includes("말끝을 흐린다")) &&
      !upgraded?.includes("그 이상은 말하지 않는다") &&
      (await logText(b)).length === linesBeforeUpgrade,
    `${linesBeforeUpgrade} 줄 / ${upgraded}`);
  check("★ 교체된 뒤에도 화자가 남아 있다",
    Boolean(upgraded?.includes("제단지기: ")), String(upgraded));
  check("'새로 생성됨' 뱃지가 대사에도 켜졌다", (await bBadges()) > badgesBeforeTalk);

  await b.locator("button:has-text('파수꾼에 대해')").first().click();
  await sleep(LLM_MS + 600);
  check("주제를 물으면 그 이야기가 나온다",
    (await npcLines()).some((t) => t.includes("그림자 파수꾼")),
    JSON.stringify(await npcLines()));
  await b.screenshot({ path: join(SHOTS, "15-주제-물음.png") });

  console.log("\n⑪ 3단계 — 세계가 바뀌어도 서 있는 화면을 갈아치우지 않는다");
  // c 는 (3,5) 에 있다 — guardian_slain 을 선언한 방(영향권)이다.
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
  const bAfter = await logText(b);
  check("영향권의 A 는 '주변의 공기가 달라졌다'",
    aAfter.some((t) => t.includes("주변의 공기가 달라졌다")), JSON.stringify(aAfter.slice(-2)));
  check("같은 영향권의 C 도 '주변의 공기가 달라졌다'",
    cAfter.some((t) => t.includes("주변의 공기가 달라졌다")), JSON.stringify(cAfter.slice(-2)));
  check("비영향권의 B(제단지기의 방)는 '멀리서 무언가 무너지는 소리'",
    bAfter.some((t) => t.includes("멀리서 무언가 무너지는")), JSON.stringify(bAfter.slice(-2)));
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

  console.log("\n⑫ 4a -> 3단계 -> 4b — 파수꾼이 사라지자 새 이야기가 열린다");
  // 사전 생성이 끝날 때까지 기다린다 — 백그라운드 큐와 경주하면 이 절이
  // 무엇을 확인하는지가 시계에 달리게 된다.
  await server.upgrades.idle();
  await sleep(200);

  /* B 는 아직 제단지기 옆에 서 있고 주제 목록을 펼친 채다. 새 주제는
     '다시 말을 걸어야' 나타난다 — 서 있는 화면을 갈아치우지 않는 것과 같은
     규칙이다. 한 단계 나갔다가 다시 들어간다. */
  check("열려 있던 목록은 아직 옛 상태다 (화면을 갈아치우지 않는다)",
    (await b.locator("button:has-text('봉인된 문에 대해')").count()) === 0);
  await b.locator('button[aria-label="뒤로"]').first().click();
  await sleep(120);
  await b.locator("button:has-text('제단지기')").first().click();
  await sleep(300);
  check("★ 봉인된 문 이야기가 열렸다",
    (await b.locator("button:has-text('봉인된 문에 대해')").count()) > 0);
  await b.locator("button:has-text('봉인된 문에 대해')").first().click();
  await sleep(400);
  check("이제 답한다",
    (await logText(b)).some((t) => t.includes("제단지기: ") && t.includes("봉인된 문")),
    JSON.stringify((await logText(b)).slice(-2)));
  check("★ 폴백을 거치지 않고 처음부터 확정본이다 (사전 생성의 효과)",
    (await logText(b)).some((t) => t.includes("봉인된 문") && t.includes("목소리가 낮아진다")),
    JSON.stringify((await logText(b)).slice(-2)));
  await b.screenshot({ path: join(SHOTS, "16-새-주제.png") });

  // 방을 벗어나면 대화창이 닫힌다 — 서버가 '닫아라' 를 보내서가 아니라
  // "그 방에 그 NPC 가 없다" 는 구조화 사실에서 파생된다.
  /* ★ 방금 주제 버튼을 눌렀으므로 포커스가 버튼에 있다. App 은 버튼에
     포커스가 있을 때 화살표를 가로채지 않는다(접근성) — 사람이라면 화면을
     한 번 누르고 걷는다. 테스트도 같은 일을 한다. */
  await b.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await b.keyboard.press("ArrowLeft");
  await sleep(400);
  check("방을 벗어나니 대화창이 닫혔다",
    (await b.locator("button:has-text('파수꾼에 대해')").count()) === 0);

  console.log("\n⑬ 5단계 — 커맨드 창을 키보드만으로 (charter 의 화살표/Enter/Esc)");
  /* A 는 (1,4). 적도 NPC 도 없으므로 최상위는 살펴보기 / 말하기 둘이다. */
  await a.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const fieldHint = await a.locator("text=Esc 커맨드").count();
  check("탐색 모드에서는 '화살표 이동' 안내가 보인다", fieldHint > 0);

  await a.keyboard.press("Escape");
  await sleep(120);
  check("★ Esc 로 커맨드 모드에 들어갔다 (charter 의 Esc 가 드디어 일한다)",
    (await a.locator("text=Enter 확정").count()) > 0);
  const firstRow = await a.locator("button:has-text('살펴보기')").first().innerText();
  check("커서가 첫 항목에 있다", firstRow.includes("▶"), firstRow);

  await a.keyboard.press("ArrowDown");
  await sleep(100);
  check("★ 화살표가 이동이 아니라 커서가 됐다",
    (await a.locator("button:has-text('말하기')").first().innerText()).includes("▶"));
  /* ★ 로그가 스무 줄 넘게 쌓인 지금이 레이아웃의 진짜 시험대다.
     로그가 자기 내용만큼 자라면 커맨드 창이 화면 밖으로 밀린다. */
  const grown = await a.evaluate(() => ({
    over: document.documentElement.scrollHeight - window.innerHeight,
    log: Math.round(document.querySelector('[data-mud="log"]')!.getBoundingClientRect().height),
  }));
  const cmdBottom = await a.locator("button:has-text('살펴보기')").first().boundingBox();
  check("★ 로그가 길어져도 커맨드 창은 첫 화면에 남는다 (자라는 것이 아니라 스크롤한다)",
    grown.over <= 0 && Boolean(cmdBottom && cmdBottom.y + cmdBottom.height <= 820),
    `${JSON.stringify(grown)} cmd=${JSON.stringify(cmdBottom)}`);
  await a.screenshot({ path: join(SHOTS, "17-커맨드-모드.png") });
  const posInMenu = await posOf(a);

  await a.keyboard.press("Enter");
  await sleep(150);
  check("Enter 로 '말하기' 를 골랐다 — 입력창에 접두사가 채워졌다",
    (await a.locator('input[aria-label="명령 입력"]').inputValue()) === "말하기 ");
  check("커맨드 모드 동안 캐릭터는 한 칸도 움직이지 않았다",
    (await posOf(a)) === posInMenu, posInMenu);

  console.log("\n⑭ 5단계 — 자유 텍스트 한 줄 (1단계부터 있던 parse() 가 이어졌다)");
  await a.locator('input[aria-label="명령 입력"]').fill("말하기 여기 누구 있나");
  await a.keyboard.press("Enter");
  await sleep(200);
  check("'말하기 …' 가 say 액션으로 수렴했다",
    (await logText(a)).some((t) => t.includes("여기 누구 있나")),
    JSON.stringify((await logText(a)).slice(-2)));

  const posBeforeTyped = await posOf(a);
  await a.locator('input[aria-label="명령 입력"]').fill("북");
  await a.keyboard.press("Enter");
  await sleep(250);
  check("★ '북' 이 화살표와 같은 move 액션이 됐다 (같은 Action 으로 수렴)",
    (await posOf(a)) !== posBeforeTyped, `${posBeforeTyped} -> ${await posOf(a)}`);

  await a.locator('input[aria-label="명령 입력"]').fill("춤춰");
  await a.keyboard.press("Enter");
  await sleep(200);
  check("★ 해석 못 한 것은 클라이언트가 판정하지 않고 그대로 서버로 간다",
    (await logText(a)).some((t) => t.includes("무엇을 하려는지 알 수 없다")),
    JSON.stringify((await logText(a)).slice(-2)));

  // 입력창을 벗어나야 화살표가 다시 이동이 된다 (전역 핸들러는 타이핑을 가로채지 않는다)
  await a.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const posBeforeArrow = await posOf(a);
  await a.keyboard.press("ArrowDown");
  await sleep(250);
  check("입력창을 나오면 화살표가 다시 이동이다",
    (await posOf(a)) !== posBeforeArrow, `${posBeforeArrow} -> ${await posOf(a)}`);
  await a.screenshot({ path: join(SHOTS, "18-자유-입력.png") });

  console.log("\n⑮ 아이템 — 가방이 커맨드 창에 선다");
  /* 전리품 판정 자체는 test/items.ts 가 검증한다. 여기서는 '화면에서
     어떻게 보이고 눌리는가' 만 본다. 서버가 직접 넣는다. */
  for (const sess of server.ctx.reg.all()) {
    server.ctx.inventory.award([
      { playerId: sess.playerId, itemId: "minor_potion", qty: 2 },
      { playerId: sess.playerId, itemId: "warden_shard", qty: 1 },
    ]);
    server.ctx.q.setPlayerHp.run(22, Date.now(), sess.playerId); // 다치게 해 둔다
    sess.hp = 22;
  }
  await sleep(300);
  await a.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  check("가방 커맨드가 생겼다", (await a.locator("button:has-text('가방')").count()) > 0);

  await a.locator("button:has-text('가방')").first().click();
  await sleep(200);
  check("가진 것이 이름으로 보인다 (클라이언트가 id 로 문구를 조립하지 않는다)",
    (await a.locator("button:has-text('낡은 물약')").count()) > 0);
  check("수량이 표시된다", (await a.locator("button:has-text('낡은 물약')").first().innerText()).includes("x2"),
    await a.locator("button:has-text('낡은 물약')").first().innerText());
  check("★ 쓸 수 없는 전리품은 비활성이다 (숨기지는 않는다)",
    (await a.locator("button:has-text('파수꾼의 파편')").count()) > 0 &&
      (await a.locator("button:has-text('파수꾼의 파편')").first().isDisabled()));
  await a.screenshot({ path: join(SHOTS, "22-가방.png") });

  const beforeDrink = await logText(a);
  await a.locator("button:has-text('낡은 물약')").first().click();
  await sleep(400);
  const afterDrink = await logText(a);
  check("마시면 문장이 온다",
    afterDrink.some((t) => t.includes("낡은 물약") && t.includes("비웠다")),
    JSON.stringify(afterDrink.slice(-2)));
  check("로그가 늘었다 (교체가 아니라 새 줄)", afterDrink.length > beforeDrink.length);
  check("수량이 하나 줄어 표시에서 사라진다 (x1 은 표시하지 않는다)",
    !(await a.locator("button:has-text('낡은 물약')").first().innerText()).includes("x2"),
    await a.locator("button:has-text('낡은 물약')").first().innerText());
  check("상태창의 HP 가 올랐다", (await a.locator("body").innerText()).includes("36/40"),
    (await a.locator("body").innerText()).match(/\d+\/40/)?.[0] ?? "?");
  await a.screenshot({ path: join(SHOTS, "23-마신-뒤.png") });

  console.log("\n⑯ 5단계 — 모바일: 세로 화면 · 스와이프 · 미니맵 탭");
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 3,
  });
  const m = await phone.newPage();
  await m.goto(`http://127.0.0.1:${WEB_PORT}/`);
  await m.waitForSelector("text=화살표로 이동", { timeout: 8000 });
  await sleep(LLM_MS + 400);

  const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("가로 스크롤이 없다 (390px 세로 화면)", overflow <= 0, `${overflow}px`);
  const cmdBox = await m.locator("button:has-text('살펴보기')").first().boundingBox();
  check("커맨드 창이 첫 화면 안에 들어온다",
    Boolean(cmdBox && cmdBox.y + cmdBox.height <= 844), JSON.stringify(cmdBox));
  const padBox = await m.locator('button[aria-label="서쪽으로"]').first().boundingBox();
  check("D패드가 손가락 크기다 (44px 이상)",
    Boolean(padBox && padBox.width >= 44 && padBox.height >= 44), JSON.stringify(padBox));
  await m.screenshot({ path: join(SHOTS, "19-모바일.png") });

  /* 스와이프: 로그 창을 왼쪽으로 쓸면 서쪽으로 한 칸.
     Playwright 에 스와이프 API 가 없어 진짜 TouchEvent 를 만들어 보낸다. */
  const swipe = (dx: number, dy: number) =>
    m.evaluate(
      // ★ 이 함수 안에 이름 붙은 내부 함수를 두지 말 것. esbuild(tsx)가
      //   keepNames 로 __name(...) 호출을 끼워 넣는데, 브라우저에는 그 헬퍼가
      //   없어서 ReferenceError 로 죽는다.
      ([ddx, ddy]) => {
        const el = document.querySelector('[data-mud="log"]');
        if (!el) throw new Error("로그 창을 찾지 못했다");
        const from = new Touch({ identifier: 1, target: el, clientX: 200, clientY: 400 });
        const to = new Touch({
          identifier: 1,
          target: el,
          clientX: 200 + ddx!,
          clientY: 400 + ddy!,
        });
        el.dispatchEvent(
          new TouchEvent("touchstart", { touches: [from], bubbles: true, cancelable: true }),
        );
        el.dispatchEvent(
          new TouchEvent("touchend", { changedTouches: [to], bubbles: true, cancelable: true }),
        );
      },
      [dx, dy],
    );

  const phonePos = await posOf(m);
  await swipe(-90, 0);
  await sleep(300);
  check("★ 스와이프가 D패드와 같은 move 액션이 됐다",
    (await posOf(m)) !== phonePos, `${phonePos} -> ${await posOf(m)}`);

  const beforeTap = await posOf(m);
  await swipe(0, 12); // 임계값 아래 — 탭이지 스와이프가 아니다
  await sleep(200);
  check("짧게 스치는 것은 스와이프가 아니다 (탭과 부딪히지 않는다)",
    (await posOf(m)) === beforeTap, `${beforeTap} -> ${await posOf(m)}`);

  /* 미니맵의 '붙어 있는' 칸을 누르면 그쪽으로 한 칸. 지금 (2,3) 이므로
     인덱스 (y*7 + x) 로 (3,3) = 24 를 누른다. */
  const here = await posOf(m);
  const [hx, hy] = here.split(",").map(Number);
  const cells = m.locator('div[style*="grid-template-columns"] > div');
  await cells.nth(hy! * 7 + hx! + 1).click(); // 동쪽 칸
  await sleep(300);
  check("★ 미니맵의 옆 칸을 누르면 그쪽으로 한 칸 간다",
    (await posOf(m)) !== here, `${here} -> ${await posOf(m)}`);

  await m.screenshot({ path: join(SHOTS, "20-모바일-이동.png") });

  /* 더 작은 화면(360x640). 로그가 줄어들면서 커맨드 창과 입력줄은 남아야 한다 —
     "명령을 못 누르는 것보다 로그가 짧은 편이 낫다" 를 숫자로 잰다.
     ★ setViewportSize 로 줄이지 않고 새 창을 연다: 모바일 에뮬레이션에서
       100dvh 가 리사이즈에 다시 계산되지 않아, 레이아웃이 아니라 에뮬레이션의
       성질을 재게 된다. */
  const tiny = await browser.newContext({
    viewport: { width: 360, height: 640 },
    hasTouch: true,
    isMobile: true,
  });
  const s360 = await tiny.newPage();
  await s360.goto(`http://127.0.0.1:${WEB_PORT}/`);
  await s360.waitForSelector("text=화살표로 이동", { timeout: 8000 });
  await sleep(400);
  const small = await s360.evaluate(() => ({
    over: document.documentElement.scrollHeight - window.innerHeight,
    log: Math.round(document.querySelector('[data-mud="log"]')!.getBoundingClientRect().height),
  }));
  check("360x640 에서도 페이지가 세로로 넘치지 않는다", small.over <= 0, JSON.stringify(small));
  const inputBox = await s360.locator('input[aria-label="명령 입력"]').boundingBox();
  check("★ 줄어드는 것은 로그다 — 입력줄과 커맨드 창은 첫 화면에 남는다",
    Boolean(inputBox && inputBox.y + inputBox.height <= 640) && small.log < 300,
    `${JSON.stringify(inputBox)} log=${small.log}`);
  await s360.screenshot({ path: join(SHOTS, "21-모바일-작은-화면.png") });
  await tiny.close();
  await phone.close();

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
