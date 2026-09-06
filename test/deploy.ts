/* 배포 배관. "친구가 링크를 열면 실제로 게임이 뜨는가" 를 확인한다.
 *
 * 확인하는 것:
 *   한 포트   정적 파일과 ws 업그레이드가 같은 오리진에서 처리된다
 *             (HTTPS 에서 ws:// 가 mixed content 로 차단되는 것을 막는 유일한 길)
 *   경로 탈출 dist/ 밖의 파일은 절대 나가지 않는다
 *   IP 예산   프록시 뒤에서 무너지지 않고, 거절이 카운터를 영구히 적립하지 않는다
 *   선생성    운영 시작 전에 초기 문장을 전부 박아 둘 수 있고, 여러 번 돌려도 안전하다 */

import { mkdirSync, rmSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { chromium } from "playwright";
import { build } from "vite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { boot } from "../server/index";
import { FIXTURE_WORLD, FIXTURE_BALANCE, FIXTURE_MOODS } from "./fixture";

/** 모든 boot() 가 같은 고정 세계를 쓴다 — 운영 콘텐츠가 바뀌어도 검사는 그대로다. */
const FIXTURE = { world: FIXTURE_WORLD, balance: FIXTURE_BALANCE, moods: FIXTURE_MOODS } as const;
import { runPregen } from "../server/tools/pregen";
import { PROTOCOL_VERSION, type ServerMsg } from "../shared/protocol";
import type { NpcLineRequest, RoomTextRequest } from "../shared/narration";

const PORT = 8909;
const DB = join(tmpdir(), `mud-deploy-${process.pid}.db`);
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
let checks = 0;
function check(label: string, cond: boolean, detail = ""): void {
  checks++;
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}
const section = (s: string) => console.log(`\n${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** hello 까지 마친 소켓 하나. */
async function connect(path = "/ws"): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`);
  await new Promise<void>((res, rej) => {
    ws.once("open", () => res());
    ws.once("error", rej);
  });
  return ws;
}

async function main() {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });

  /* ★ 이 테스트는 dist/ 를 통째로 소유한다. 이미 있으면 치워 두고, 앞 절들은
     '아는 내용' 의 가짜 dist 로 돌고, ⑦ 에서만 진짜로 빌드한다. 그러지 않으면
     앞선 빌드가 남아 있느냐에 따라 결과가 달라진다 (실제로 그렇게 깨졌다). */
  const stashed = existsSync("dist") ? "dist.bak-test" : null;
  if (stashed) {
    rmSync(stashed, { recursive: true, force: true });
    renameSync("dist", stashed);
  }
  mkdirSync("dist/assets", { recursive: true });
  writeFileSync("dist/index.html", "<!doctype html><title>지하 1층</title><div id=root></div>");
  writeFileSync("dist/assets/index-TEST123.js", "console.log('bundle')");
  writeFileSync("secret-not-served.txt", "이 파일은 dist 밖에 있다");

  const server = boot(DB, PORT, { ...FIXTURE,  llm: "off" });

  section("① 정적 파일과 ws 가 같은 포트에서 산다");
  const index = await fetch(`${BASE}/`);
  check("/ 가 index.html 을 준다", index.status === 200, String(index.status));
  check("HTML 로 준다", (index.headers.get("content-type") ?? "").includes("text/html"),
    String(index.headers.get("content-type")));
  check("★ index.html 은 캐시하지 않는다 (캐시되면 배포해도 옛 번들을 부른다)",
    (index.headers.get("cache-control") ?? "").includes("no-cache"),
    String(index.headers.get("cache-control")));

  const asset = await fetch(`${BASE}/assets/index-TEST123.js`);
  check("해시 박힌 자산을 준다", asset.status === 200);
  check("그건 영구 캐시한다", (asset.headers.get("cache-control") ?? "").includes("immutable"),
    String(asset.headers.get("cache-control")));
  check("자바스크립트로 준다",
    (asset.headers.get("content-type") ?? "").includes("javascript"),
    String(asset.headers.get("content-type")));

  const health = await fetch(`${BASE}/healthz`);
  check("헬스체크가 산다 (배포 플랫폼이 이걸 본다)",
    health.status === 200 && (await health.text()) === "ok");

  const spa = await fetch(`${BASE}/아무거나/새로고침`);
  check("모르는 경로도 index.html (새로고침이 404 가 되지 않는다)", spa.status === 200);

  section("② dist/ 밖은 절대 나가지 않는다");
  for (const evil of [
    "/../secret-not-served.txt",
    "/../../etc/passwd",
    "/..%2fsecret-not-served.txt",
    "/assets/../../secret-not-served.txt",
  ]) {
    const r = await fetch(`${BASE}${evil}`);
    const body = await r.text();
    check(`경로 탈출을 막는다: ${evil}`,
      !body.includes("dist 밖에 있다") && !body.includes("root:x:"),
      `${r.status} ${body.slice(0, 40)}`);
  }

  section("③ ws 는 /ws 에서만 받는다");
  const ok = await connect("/ws");
  check("/ws 로는 붙는다", ok.readyState === WebSocket.OPEN);
  ok.close();
  let rejected = false;
  try {
    const bad = await connect("/nope");
    bad.close();
  } catch {
    rejected = true;
  }
  check("다른 경로의 업그레이드는 거절한다", rejected);

  section("④ IP 예산 — 거절이 카운터를 영구히 적립하지 않는다");
  /* 예전에는 상한 검사에서 return 한 뒤 한참 아래에서 close 리스너를 달았다.
     그래서 거절될 때마다 +1 이 영구히 남았고, 프록시 뒤에서는 모두가 한 버킷이라
     누적 거절이 상한에 닿는 순간 서버가 '모두를' 영영 거부했다. */
  const many: WebSocket[] = [];
  for (let i = 0; i < 25; i++) {
    try {
      many.push(await connect());
    } catch {
      /* 거절됨 */
    }
  }
  await sleep(200);
  const refused = many.filter((w) => w.readyState !== WebSocket.OPEN).length;
  check("상한(20)을 넘으면 거절한다", many.length - refused <= 20, `열림 ${many.length - refused}`);
  for (const w of many) w.terminate();
  await sleep(400);

  // 전부 닫았으니 카운터가 0 으로 돌아와야 한다 — 다시 붙을 수 있어야 한다.
  let reconnected = 0;
  const after: WebSocket[] = [];
  for (let i = 0; i < 5; i++) {
    try {
      const w = await connect();
      after.push(w);
      reconnected++;
    } catch {
      /* 여전히 거절 */
    }
  }
  check("★ 전부 끊은 뒤에는 다시 붙을 수 있다 (누수가 없다)", reconnected === 5,
    `${reconnected}/5`);
  for (const w of after) w.terminate();
  await sleep(200);

  section("⑤ 종료가 두 서버를 함께 닫는다");
  await server.close();
  let httpDead = false;
  try {
    await fetch(`${BASE}/healthz`);
  } catch {
    httpDead = true;
  }
  check("http 도 함께 닫힌다 (wss.close 는 http 를 닫지 않는다)", httpDead);

  section("⑥ 선생성 — 운영 시작 전에 초기 문장을 박는다");
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
  let roomCalls = 0;
  let npcCalls = 0;
  const fakeRoom = async (req: RoomTextRequest) => {
    roomCalls++;
    return { text: `[생성] ${req.seed}.`, source: "llm" as const, model: "fake", promptVersion: "room.v1.ko" };
  };
  const fakeNpc = async (req: NpcLineRequest) => {
    npcCalls++;
    return { text: `[생성] ${req.seed}.`, source: "llm" as const, model: "fake", promptVersion: "npc.v1.ko" };
  };
  const quiet = () => {};

  const first = await runPregen(DB, { ...FIXTURE, llm: "off", llmRenderer: fakeRoom, llmNpcRenderer: fakeNpc }, quiet);
  check(`모든 방(${first.rooms})을 큐에 넣었다`, first.queuedRooms === first.rooms,
    `${first.queuedRooms}/${first.rooms}`);
  check("열린 주제도 전부", first.queuedLines === first.lines, `${first.queuedLines}/${first.lines}`);
  check("★ 폴백이 하나도 남지 않았다 (첫 입장이 진짜 문장을 본다)",
    first.leftoverFallback === 0, `${first.leftoverFallback}행`);
  check("실패·포기가 없다", first.failed === 0 && first.givenUp === 0);
  check(`LLM 을 방마다 한 번씩 불렀다 (${roomCalls}회)`, roomCalls === first.rooms,
    `${roomCalls} vs ${first.rooms}`);

  section("⑥' 다시 돌려도 안전하다 (지역을 추가하고 다시 돌리는 경우)");
  const callsBefore = roomCalls + npcCalls;
  const again = await runPregen(DB, { ...FIXTURE, llm: "off", llmRenderer: fakeRoom, llmNpcRenderer: fakeNpc }, quiet);
  check("★ 이미 확정된 것은 다시 만들지 않는다", roomCalls + npcCalls === callsBefore,
    `${callsBefore} -> ${roomCalls + npcCalls}`);
  check("큐에 아무것도 넣지 않았다", again.queuedRooms === 0 && again.queuedLines === 0,
    JSON.stringify([again.queuedRooms, again.queuedLines]));
  check("폴백은 여전히 0", again.leftoverFallback === 0);

  section("⑥'' 선생성된 세계에 들어가면 폴백을 거치지 않는다");
  const live = boot(DB, PORT, { ...FIXTURE,  llm: "off" });
  const ws = await connect();
  ws.send(JSON.stringify({ t: "hello", pv: PROTOCOL_VERSION, token: null, name: null }));
  const seen: ServerMsg[] = [];
  ws.on("message", (d) => seen.push(JSON.parse(String(d)) as ServerMsg));
  await sleep(500);
  const logs = seen.filter((m): m is Extract<ServerMsg, { t: "log" }> => m.t === "log");
  const narr = logs.filter((m) => m.kind === "narr");
  check("방 묘사가 도착했다", narr.length > 0, JSON.stringify(seen.map((m) => m.t)));
  check("★ 처음부터 확정본이다 — 폴백이 아니다",
    narr.every((m) => m.source === "llm"), JSON.stringify(narr.map((m) => m.source)));
  check("교체(log.replace)도 필요 없었다", !seen.some((m) => m.t === "log.replace"));
  ws.terminate();
  await live.close();

  section("⑦ 진짜 브라우저로 — 빌드된 클라이언트가 같은 오리진의 /ws 로 붙는다");
  /* ★ 이게 이번 작업의 진짜 시험대다. 브라우저 테스트(test/browser.ts)는
     vite 개발 서버 + VITE_MUD_WS 주입으로 돌아서, 방금 만든 '정적 서빙 +
     같은 오리진 /ws' 경로를 한 번도 지나지 않는다. 여기서만 확인된다. */
  rmSync("dist", { recursive: true, force: true });
  /* ★ root 를 인자로 넘기면 vite 가 설정 파일을 그 root 안에서 찾는다 —
     client/vite.config.ts 는 없으므로 설정 없이(플러그인도 outDir 도 없이)
     빌드된다. 저장소의 설정을 그대로 쓰려면 인자 없이 부른다. */
  await build({ logLevel: "error" });
  check("빌드가 저장소 루트의 dist/ 에 나온다 (client/dist 가 아니라)",
    existsSync("dist/index.html"), "vite 의 기본 outDir 은 root/dist 다");

  const prod = boot(DB, PORT, { ...FIXTURE,  llm: "off" });
  const pre = [
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    "/opt/pw-browsers/chromium/chrome-linux/chrome",
  ].find((p) => existsSync(p));
  const browser = await chromium.launch(pre ? { executablePath: pre } : {});
  const page = await browser.newPage();
  const wsUrls: string[] = [];
  page.on("websocket", (w) => wsUrls.push(w.url()));
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${BASE}/`);
  await page.waitForSelector("text=화살표로 이동", { timeout: 10000 });

  check("★ 빌드된 페이지가 뜨고 게임에 접속된다", true);
  check("★ 같은 오리진의 /ws 로 붙었다 (별도 포트가 아니라)",
    wsUrls.some((u) => u === `ws://127.0.0.1:${PORT}/ws`), JSON.stringify(wsUrls));
  check("자바스크립트 오류가 없다", errors.length === 0, JSON.stringify(errors));
  check("선생성된 확정본이 화면에 보인다",
    (await page.locator("body").innerText()).includes("[생성]"),
    (await page.locator("body").innerText()).slice(0, 120));

  await page.keyboard.press("ArrowLeft");
  await sleep(400);
  check("실제로 움직인다", (await page.locator("body").innerText()).includes("2,3"),
    (await page.locator("body").innerText()).match(/지하 1층 · \d+,\d+/)?.[0] ?? "?");
  await page.screenshot({ path: join("test", "shots", "24-배포-모드.png") });
  await browser.close();
  await prod.close();

  // ── 정리 ────────────────────────────────────────────────────────────
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
  rmSync("secret-not-served.txt", { force: true });
  if (stashed) {
    rmSync("dist", { recursive: true, force: true });
    renameSync(stashed, "dist");
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} 검사 통과`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
