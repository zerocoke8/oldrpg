/* 세계(지역)가 '데이터' 라는 것을 지킨다. test/balance.ts 와 같은 모양이다.
 *
 * 확인하는 것:
 *   계약   content/world/ 가 실제로 읽히고, 틀린 값이면 '부팅에서' 죽는다
 *   불변   JSON 으로 옮기면서 씨앗이 한 글자도 바뀌지 않았다 (규칙 3)
 *   주입   다른 세계를 넘기면 서버가 그 세계로 돈다 (= 코드가 맵을 들고 있지 않다)
 *   경계   engine/ 은 파일을 읽지 않는다 — 읽는 것은 content/, 주는 것은 index.ts
 *
 * ★ '불변' 이 이 파일의 핵심이다. 씨앗 한 글자가 바뀌면 seed_id 가 바뀌고,
 *   그 방의 생성된 텍스트가 전부 캐시 미스가 된다. 형식을 옮기는 작업에서
 *   가장 조용히 일어날 수 있는 사고가 그것이다. */

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { loadWorld, loadBrief } from "../server/content/world";
import { openDb } from "../server/db/open";
import { makeMap, seedIdOf, type MapData } from "../server/engine/map";
import { loadMoods, loadTones, loadVoice } from "../server/narration/prompts";
import { lines } from "../server/narration/lines";
import { npcSeedId } from "../server/engine/npcs";
import { boot } from "../server/index";
import { PROTOCOL_VERSION, type ServerMsg } from "../shared/protocol";

const PORT = 8911;
const DB = join(tmpdir(), `mud-world-${process.pid}.db`);

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

/** 진짜 디렉터리를 복사해 한 군데만 망가뜨린 임시 디렉터리. */
function broken(rel: string, mutate: (data: Record<string, unknown>) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "world-"));
  cpSync("content/world", dir, { recursive: true });
  const path = join(dir, rel);
  const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  mutate(data);
  writeFileSync(path, JSON.stringify(data, null, 2));
  return dir;
}
/** 그 디렉터리로 loadWorld 를 부르면 죽는가. 죽으면 이유를 돌려준다. */
function refuses(dir: string): string | null {
  try {
    loadWorld(dir);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* 두 방짜리 세계. 주입이 진짜인지 보려면 '진짜와 다른' 세계여야 한다.
 *
 * ★ 지역 id 가 진짜와 겹치지 않는다는 것이 이번 이동의 성과다. 전에는
 *   NPC 가 코드에 있고 "b1:3,1" 을 하드코딩으로 가리켜서, 주입된 세계에도
 *   b1 과 그 방이 있어야 npcs 표의 외래키가 살았다. 이제 NPC 가 지역 파일
 *   안에 있으므로 세계에 NPC 가 하나도 없어도 된다. */
const TINY: MapData = {
  /* 임무가 없는 세계다. 임무는 NPC 와 적을 함께 가리키므로, NPC 도 적도 없는
     세계에서는 있을 수 없다 — 빈 배열이 그 사실의 표현이다. */
  missions: [],
  /* 지역은 두 방뿐이지만 플래그는 실제 밸런스가 요구하는 것을 선언해야 한다 —
     적의 slainFlag 가 선언되지 않았으면 부팅이 거절한다 (아래 ⑤' 에서 본다). */
  flags: {
    journal_recovered: { default: "false", broadcast: true },
    proliferant_slain: { default: "false", broadcast: true },
  },
  spawn: { region: "t1", x: 1, y: 1 },
  regions: [
    {
      id: "t1",
      name: "시험장",
      tiles: ["####", "#..#", "####"],
      seeds: { "1,1": "시험용 첫 칸", "2,1": "시험용 둘째 칸" },
      sensitive: {},
      enemies: {},
      npcs: {},
      exits: [],
    },
  ],
};

async function main() {
  section("① 진짜 파일이 읽히고 검증을 통과한다");
  const data = loadWorld();
  const map = makeMap(data);
  check("지역이 둘 이상 실렸다", map.regions().length >= 2, String(map.regions().length));
  check("스폰 지역이 실재한다", Boolean(map.region(map.spawn.region)));
  check("모든 방에 씨앗이 있다 (rooms() 가 던지지 않는다)", map.rooms().length > 0,
    String(map.rooms().length));
  check("지역 id 가 파일 이름에서 왔다 (JSON 안에 id 필드가 없다)",
    !("id" in (JSON.parse(readFileSync("content/world/regions/ue001.json", "utf8")) as object)));

  /* ── 지역의 톤 ──────────────────────────────────────────────────────
     톤 파일 이름이 곧 지역 id 다. 오타가 나면 그 지역은 조용히 전역 꼬리로
     떨어지고 아무 데도 안 적힌다 — 부팅도 안 죽고 화면도 안 비어서, 톤을
     써 놓고 안 쓰이는 것을 알 방법이 없다. */
  section("①' 지역의 톤 — 파일 이름이 실재하는 지역인가");
  const tones = loadTones();
  const ids = new Set(map.regions().map((r) => r.id));
  for (const rid of tones.keys()) {
    check(`tones/${rid}.md 가 실재하는 지역을 가리킨다`, ids.has(rid),
      `regions/ 에 ${rid} 가 없다 — 오타면 그 톤은 영영 안 쓰인다`);
  }
  /* 전부 갖출 필요는 없다 (톤은 덧칠이다). 다만 하나도 없으면 이 기능이
     배선되지 않았다는 뜻이라, 그건 검사가 말해 줘야 한다. */
  check("★ 톤이 실제로 배선돼 있다 (하나 이상)", tones.size > 0, String(tones.size));
  for (const [rid, t] of tones) {
    check(`  ${rid}: 톤 지시가 비어 있지 않다`, t.prompt.trim().length > 0);
    check(`  ${rid}: 꼬리 후보가 둘 이상이다 (하나면 그 지역 방이 전부 같은 문장으로 끝난다)`,
      t.room.length >= 2, String(t.room.length));
  }

  /* ── 세계의 목소리 ──────────────────────────────────────────────────
     charter 139줄: 코드에 프로즈를 박아 두면 세계관을 갈아끼울 때 그 문장만
     옛 세계에 남는다. 실제로 그랬다 — 세계관을 바꾼 뒤에도 부활 문장은
     "차가운 돌바닥의 감촉에 정신이 든다. 입구로 끌려와 있었다" 였는데,
     부활 지점은 대공동 6구역의 광장이다. */
  section("①″ 세계가 자기에 대해 쓰는 문장은 파일에 있다");
  /* 주석은 뺀다 — 왜 이 문장들이 여기 없어야 하는지 설명하려면 그 문장을
     인용해야 하고, 인용까지 금지하면 그 이유를 적을 수 없다. */
  const src = readFileSync("server/narration/lines.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  for (const ghost of ["차가운 돌바닥", "어둠 속에서", "어둠 속으로", "길이 무너져", "입구로 끌려와"]) {
    check(`★ lines.ts 의 코드에 옛 세계의 프로즈가 없다: "${ghost}"`, !src.includes(ghost));
  }
  check("voice.ko.md 가 읽힌다", loadVoice().respawn.length > 0);

  /* 무드도 지역 톤과 같다: 후보가 하나면 그 플래그를 선언한 방이 전부 같은
     문장으로 끝난다. 격리 구역 열두 방을 다 돌면 같은 한 줄을 열두 번 읽었다. */
  const realMoods = loadMoods();
  check("★ 무드가 실제로 배선돼 있다", realMoods.size > 0, String(realMoods.size));
  for (const [flag, m] of realMoods) {
    check(`moods/${flag}: 방 꼬리 후보가 둘 이상이다`, m.fallback.length >= 2,
      String(m.fallback.length));
    check(`moods/${flag}: 대사 지시가 방 지시와 다르다`, m.npcPrompt !== m.prompt,
      "같으면 대사 작가가 방 묘사용 지시를 받는다 — 사람이 나레이션을 한다");
  }
  check("★ 치환이 실제로 된다", lines.enemyHere("증식체").includes("증식체") &&
    !lines.enemyHere("증식체").includes("{{"), lines.enemyHere("증식체"));

  /* ── 브리프의 개요 ──────────────────────────────────────────────────
     개요는 방 씨앗을 쓸 때 참고할 '공통의 사실' 이다. 없으면 방을 더 뚫는
     순간 기존 방들과 서로를 모르는 문장이 나온다. 여섯 개가 전부 null 이었다. */
  section("①‴ 지역마다 개요가 있다 (방을 더 뚫어도 같은 장소로 이어진다)");
  for (const r of map.regions()) {
    const b = loadBrief(r.id);
    check(`${r.id}: 브리프에 개요가 있다`, (b.overview ?? "").trim().length >= 100,
      `${(b.overview ?? "").length}자 — 없으면 authorRegion 이 모델로 새로 만든다`);
  }
  /* ①⁗ 미니맵이 '적이 나오는 자리' 를 찍는다 (test/regions.ts ④' 가 규칙
     자체를 본다). 여기서 보는 것은 **운영 세계가 그 규칙과 실제로 맞물리는가**
     다 — 규칙이 맞아도 세계에 배치가 하나도 없으면 이 기능은 죽은 코드다. */
  const marked = map.regions().reduce((n, r) => n + map.view(r.id).foes.length, 0);
  check("★ 지도에 찍을 적 자리가 실제로 있다 (없으면 이 기능은 죽은 코드다)",
    marked > 0, `${marked}자리`);
  for (const r of map.regions()) {
    const placed = Object.keys(r.enemies).sort();
    check(`${r.id}: 실리는 좌표가 배치와 같다 (${placed.length}자리)`,
      JSON.stringify(map.view(r.id).foes) === JSON.stringify(placed),
      JSON.stringify([map.view(r.id).foes, placed]));
  }
  /* 나가는 길도 같다. 지역마다 최소 하나는 있어야 한다 — 없는 지역은
     들어가면 못 나오는 곳이고, 그건 오타로 만들어진다 (부팅 검증이 왕복
     짝을 보지만, '지도에 찍힌다' 는 여기서만 확인된다). */
  for (const r of map.regions()) {
    const want = [...new Set(r.exits.map((e) => e.at))].sort();
    const got = map.view(r.id).gates;
    check(`${r.id}: 나가는 길이 지도에 실린다 (${want.length}곳)`,
      want.length > 0 && JSON.stringify(got.map((g) => g.at)) === JSON.stringify(want),
      JSON.stringify([got, want]));
  }
  /* ★ 방향을 와이어에 싣는 결정의 근거를 여기서 잰다.
     "출구는 벽 자리에만 있으니 클라이언트가 격자로 유도하면 되지 않나" —
     안 된다. 유도하려면 '벽인 이웃' 이 하나여야 하는데, 운영 세계의 출구 칸은
     그렇지 않다. 이 수치가 바뀌면(유도 가능한 세계가 되면) 그때 다시 판단할
     수 있도록, 산문이 아니라 검사로 남긴다. */
  const STEP: Record<string, [number, number]> = {
    north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0],
  };
  let ambiguous = 0;
  let total = 0;
  for (const r of map.regions()) {
    for (const g of map.view(r.id).gates) {
      total++;
      const [x, y] = g.at.split(",").map(Number);
      const walls = Object.values(STEP).filter(([dx, dy]) => !map.walkable(r.id, x! + dx, y! + dy));
      if (walls.length > 1) ambiguous++;
    }
  }
  check(`★ 방향은 격자로 유도할 수 없다 — 출구 ${total}곳 중 ${ambiguous}곳이 벽 이웃 둘 이상`,
    total > 0 && ambiguous === total,
    `유도 가능한 칸이 ${total - ambiguous}곳 있다 — 그러면 이 필드의 근거가 약해진다`);

  section("② 씨앗은 한 글자도 바뀌지 않았다 (규칙 3)");
  /* seed_id 는 내용 파생이다 — 하나라도 어긋나면 그 방의 생성된 텍스트가
     전부 날아간다.

     ★ 이 표를 갱신하는 것은 기본값이 아니다. 어긋났으면 먼저 '왜' 를 묻고,
       실수라면 씨앗을 되돌린다. 갱신은 **의도적이고 리뷰를 거친 씨앗 변경**과
       같은 커밋에서만 하고, 그 커밋이 이유를 적는다. 그게 아니면 이 표는
       그냥 도장을 찍어 주는 종이가 된다.

     갱신 기록:
       ue001b:2,5  5a3d15a4 -> 2fce7695
         "증식이 멈추지 않은 중심. …계속 자라고 있었다" 는 proliferant_slain 이
         켜진 뒤에는 거짓이 된다. sensitive 를 선언한 방의 씨앗은 그 플래그의
         두 값 모두에서 참이어야 한다 — 씨앗은 불변이고 무드는 뒤에 붙을 뿐,
         씨앗을 대체하지 않기 때문이다. */
  const FROZEN: Record<string, [string, string]> = {
    "d6:2,1": ["a3b5dc04", "e3b0c442"],
    "d6:5,3": ["aa823088", "e3b0c442"],
    "ue001:4,1": ["e368ee21", "313a815a"],
    "ue001:2,10": ["6b8eb017", "4078be97"],
    "ue001b:2,5": ["2fce7695", "313a815a"],
  };
  const byId = new Map(map.rooms().map((r) => [r.id, r]));
  for (const [id, [seedId, declHash]] of Object.entries(FROZEN)) {
    const r = byId.get(id);
    check(`${id} 의 state_hash 앞 두 조각이 그대로다`,
      r?.seedId === seedId && r?.flagsDeclHash === declHash,
      `${String(r?.seedId)}.${String(r?.flagsDeclHash)} != ${seedId}.${declHash}`);
  }
  check("seedIdOf 는 여전히 내용 파생이다 (A -> B -> A 가 복구된다)",
    seedIdOf("어떤 씨앗") === seedIdOf("어떤 씨앗") && seedIdOf("어떤 씨앗") !== seedIdOf("다른 씨앗"));

  section("②' NPC 도 같은 표에 얼어붙어 있다");
  /* npc_lines 의 seed_id 는 persona + topic.seed 파생이다. 이동하면서 한
     글자라도 바뀌면 이미 만든 대사가 전부 캐시 미스가 된다. */
  const keeper = map.npc("observer");
  check("NPC 가 지역 파일에서 실렸다", keeper?.region === "ue001" && keeper?.roomId === "ue001:3,3",
    JSON.stringify([keeper?.region, keeper?.roomId]));
  const FROZEN_NPC: Record<string, string> = {
    greet: "0a673c43",
    darkness: "ce994a8e",
    lab: "d1425257",
    journal: "7a2d3f23",
    isolation: "ffd69168",
    after: "f6f715ce",
  };
  for (const [topicId, want] of Object.entries(FROZEN_NPC)) {
    const t = keeper?.topics.find((x) => x.id === topicId);
    const got = t && npcSeedId(keeper!, t);
    check(`관측자/${topicId} 의 seed_id 가 그대로다`, got === want, `${String(got)} != ${want}`);
  }
  check("주제 순서가 그대로다 (대화 메뉴의 순서다)",
    keeper?.topics.map((t) => t.id).join(",") === "greet,darkness,lab,journal,isolation,after",
    String(keeper?.topics.map((t) => t.id)));

  section("③ 틀린 세계는 '부팅에서' 죽는다");
  const cases: [string, string | null][] = [
    ["줄 길이가 제각각인 타일",
      refuses(broken("regions/ue001b.json", (d) => { (d.tiles as string[])[1] = "#.####x"; }))],
    ['타일에 모르는 글자',
      refuses(broken("regions/ue001b.json", (d) => { (d.tiles as string[])[1] = "#..X#"; }))],
    ['좌표 키가 "x,y" 가 아님',
      refuses(broken("regions/ue001b.json", (d) => {
        (d.seeds as Record<string, string>)["1, 1"] = "공백이 들어간 키";
      }))],
    ["빈 씨앗",
      refuses(broken("regions/ue001b.json", (d) => { (d.seeds as Record<string, string>)["1,1"] = ""; }))],
    ["모르는 필드 (오타 방지)",
      refuses(broken("regions/ue001b.json", (d) => { d.sensitiveFlags = {}; }))],
    ["모르는 방향의 출구",
      refuses(broken("regions/ue001b.json", (d) => {
        (d.exits as Record<string, unknown>[])[0]!.dir = "up";
      }))],
    ["NPC id 가 지역을 넘어 겹침",
      refuses((() => {
        const d = mkdtempSync(join(tmpdir(), "world-"));
        cpSync("content/world", d, { recursive: true });
        const p2 = join(d, "regions", "ue001b.json");
        const b1 = JSON.parse(readFileSync(join(d, "regions", "ue001.json"), "utf8")) as {
          npcs: Record<string, unknown>;
        };
        const b2 = JSON.parse(readFileSync(p2, "utf8")) as Record<string, unknown>;
        b2.npcs = { observer: { ...(b1.npcs.observer as object), at: "1,1" } };
        writeFileSync(p2, JSON.stringify(b2, null, 2));
        return d;
      })())],
    ["같은 주제 id 가 두 번",
      refuses(broken("regions/ue001.json", (d) => {
        const n = (d.npcs as Record<string, { topics: unknown[] }>).observer!;
        n.topics.push({ ...(n.topics[0] as object) });
      }))],
    ["NPC id 에 ':' (승급 큐 키의 구분자)",
      refuses(broken("regions/ue001.json", (d) => {
        const npcs = d.npcs as Record<string, unknown>;
        npcs["obser:ver"] = npcs.observer;
        delete npcs.observer;
      }))],
    ["모르는 필드가 world.json 에",
      refuses(broken("world.json", (d) => { d.모르는것 = 1; }))],
    ["플래그 선언이 아예 없음",
      refuses(broken("world.json", (d) => { delete d.flags; }))],
    ["플래그 이름에 대문자",
      refuses(broken("world.json", (d) => {
        (d.flags as Record<string, unknown>).BadFlag = { default: "false", broadcast: true };
      }))],
    ["없는 지역을 스폰으로",
      refuses(broken("world.json", (d) => {
        d.spawn = { region: "없는지역", x: 1, y: 1 };
      }))],
  ];
  for (const [label, why] of cases) {
    check(`★ ${label} 을 거절한다`, why !== null, "통과해 버렸다");
  }
  check("거절 메시지가 어느 파일인지 말해 준다",
    (cases[0]![1] ?? "").includes("ue001b.json"), String(cases[0]![1]).split("\n")[0]);

  section("④ 지역이 하나도 없으면 죽는다");
  const empty = mkdtempSync(join(tmpdir(), "world-"));
  cpSync("content/world", empty, { recursive: true });
  rmSync(join(empty, "regions"), { recursive: true, force: true });
  check("★ regions/ 가 없으면 거절한다", refuses(empty) !== null);

  section("⑤ 주입 — 다른 세계를 넘기면 서버가 그 세계로 돈다");
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
  const server = boot(DB, PORT, { llm: "off", world: TINY });
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const inbox: ServerMsg[] = [];
  await new Promise<void>((res, rej) => {
    ws.once("open", () => res());
    ws.once("error", rej);
  });
  ws.on("message", (d) => inbox.push(JSON.parse(String(d)) as ServerMsg));
  ws.send(JSON.stringify({ t: "hello", pv: PROTOCOL_VERSION, token: null, name: null }));
  for (let i = 0; i < 200 && !inbox.some((m) => m.t === "snapshot"); i++) await sleep(10);
  const snap = inbox.find((m) => m.t === "snapshot") as Extract<ServerMsg, { t: "snapshot" }>;
  check("★ 주입한 세계에서 시작한다 (코드가 맵도 NPC 도 들고 있지 않다)",
    snap.self.pos.region === "t1" && snap.self.pos.x === 1 && snap.self.pos.y === 1,
    JSON.stringify(snap.self.pos));
  check("격자도 주입한 것이다", snap.region.name === "시험장" && snap.region.height === 3,
    JSON.stringify([snap.region.name, snap.region.width, snap.region.height]));
  check("rooms 표도 그 세계의 것이다 (2방)",
    server.ctx.q.allRooms.all().length === 2, String(server.ctx.q.allRooms.all().length));
  check("★ NPC 가 하나도 없는 세계로도 부팅된다", server.ctx.map.npcs().length === 0,
    String(server.ctx.map.npcs().length));

  /* 주입된 세계에는 b1 이 없다 — 그러니 b1 의 씨앗이 와이어에 있을 수 없다.
     '코드가 진짜 맵을 어딘가에 들고 있다' 를 배제하는 검사다. */
  ws.send(JSON.stringify({ t: "action", seq: 1, action: { type: "move", dir: "east" } }));
  await sleep(200);
  const raw = JSON.stringify(inbox);
  check("★ 진짜 세계의 문장이 한 줄도 새지 않았다",
    !raw.includes("게시벽") && !raw.includes("연구"), "b1/b2 의 씨앗이 보인다");

  /* ⑤' 플래그가 데이터가 됐으니, 세계와 밸런스가 어긋나는 것도 부팅이 잡는다. */
  let crossErr = "";
  try {
    const bad = boot(`${DB}.x`, PORT + 1, { llm: "off", world: { ...TINY, flags: {} } });
    await bad.close();
  } catch (e) {
    crossErr = e instanceof Error ? e.message : String(e);
  }
  check("★ 밸런스가 켜는 플래그를 세계가 선언 안 하면 거절한다",
    crossErr.includes("선언되지 않은 플래그"), crossErr || "통과해 버렸다");

  /* ★ 거절이 '깨끗한' 거절인가 — boot() 이 자기가 연 DB 를 닫고 던졌는가.
     이 검사가 없으면 이 결함은 리눅스에서 영원히 안 보인다. POSIX unlink 는
     열린 파일도 지우므로 아무 검사도 안 물고, 실제로 그래서 살아남았다.
     윈도우에서만 EBUSY 로 드러났다 (test/balance.ts 와 이 파일의 rmSync) —
     OS 가 다르면 증상이 다를 뿐, 누수는 양쪽 모두에서 진짜다.

     그래서 파일이 아니라 **잠금** 에 묻는다. journal_mode 를 바꾸는 것은 배타
     잠금을 요구하므로 다른 연결이 살아 있으면 SQLITE_BUSY 다 — 같은 프로세스의
     두 연결에도 성립하고 OS 에 무관하다.

     opened 가드: 나중에 boot 이 openDb '앞' 에서 거절하도록 바뀌면 이 탐침은
     아무것도 못 보게 된다. 그때 조용히 초록이 되면 검사가 스스로 조건을 만든
     것이므로, 그 경우를 실패로 말한다. */
  const opened = existsSync(`${DB}.x`);
  let leak = "";
  if (!opened) {
    leak = "boot() 이 openDb 앞에서 던졌다 — 이 탐침은 더 이상 누수를 못 본다";
  } else {
    const probe = openDb(`${DB}.x`);
    probe.pragma("busy_timeout = 100"); // openDb 의 5초를 기다려 줄 이유가 없다
    try {
      probe.pragma("journal_mode = DELETE");
    } catch (e) {
      leak = e instanceof Error ? e.message : String(e);
    } finally {
      probe.close();
    }
  }
  check("★ 부팅이 거절해도 DB 연결을 남기지 않는다", leak === "",
    leak || "SQLITE_BUSY — boot() 이 던질 때 자기가 연 연결을 닫지 않았다");
  for (const f of [`${DB}.x`, `${DB}.x-wal`, `${DB}.x-shm`]) rmSync(f, { force: true });

  ws.close();
  await server.close();
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });

  section(failures === 0 ? `PASS — ${checks}/${checks} 검사 통과` : `FAIL — ${failures}/${checks} 실패`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
