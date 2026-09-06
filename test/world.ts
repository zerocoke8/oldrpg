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

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { loadWorld } from "../server/content/world";
import { makeMap, seedIdOf, type MapData } from "../server/engine/map";
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
    !("id" in (JSON.parse(readFileSync("content/world/regions/b1.json", "utf8")) as object)));

  section("② 씨앗은 한 글자도 바뀌지 않았다 (규칙 3)");
  /* seed_id 는 내용 파생이다. 아래 값들은 JSON 으로 옮기기 '전' 의 코드에서
     뽑은 것이다 — 하나라도 어긋나면 그 방의 생성된 텍스트가 전부 날아간다.
     그래서 이 표는 갱신하는 것이 아니라, 어긋나면 씨앗을 되돌리는 것이다. */
  const FROZEN: Record<string, [string, string]> = {
    "b1:1,1": ["13ff4dbc", "e3b0c442"],
    "b1:3,3": ["b2c1e416", "e3b0c442"],
    "b1:5,5": ["51d68edd", "7e6abfd6"],
    "b2:1,3": ["1104d66b", "e3b0c442"],
    "b2:3,3": ["2b762458", "e3b0c442"],
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
  const keeper = map.npc("altar_keeper");
  check("NPC 가 지역 파일에서 실렸다", keeper?.region === "b1" && keeper?.roomId === "b1:3,1",
    JSON.stringify([keeper?.region, keeper?.roomId]));
  const FROZEN_NPC: Record<string, string> = {
    greet: "4128f090",
    warden: "3b499c52",
    altar: "c9861dd3",
    sealed_door: "91ffd8be",
  };
  for (const [topicId, want] of Object.entries(FROZEN_NPC)) {
    const t = keeper?.topics.find((x) => x.id === topicId);
    const got = t && npcSeedId(keeper!, t);
    check(`제단지기/${topicId} 의 seed_id 가 그대로다`, got === want, `${String(got)} != ${want}`);
  }
  check("주제 순서가 그대로다 (대화 메뉴의 순서다)",
    keeper?.topics.map((t) => t.id).join(",") === "greet,warden,altar,sealed_door",
    String(keeper?.topics.map((t) => t.id)));

  section("③ 틀린 세계는 '부팅에서' 죽는다");
  const cases: [string, string | null][] = [
    ["줄 길이가 제각각인 타일",
      refuses(broken("regions/b2.json", (d) => { (d.tiles as string[])[1] = "#..E##"; }))],
    ['타일에 모르는 글자',
      refuses(broken("regions/b2.json", (d) => { (d.tiles as string[])[1] = "#..X#"; }))],
    ['좌표 키가 "x,y" 가 아님',
      refuses(broken("regions/b2.json", (d) => {
        (d.seeds as Record<string, string>)["1, 1"] = "공백이 들어간 키";
      }))],
    ["빈 씨앗",
      refuses(broken("regions/b2.json", (d) => { (d.seeds as Record<string, string>)["1,1"] = ""; }))],
    ["모르는 필드 (오타 방지)",
      refuses(broken("regions/b2.json", (d) => { d.sensitiveFlags = {}; }))],
    ["모르는 방향의 출구",
      refuses(broken("regions/b2.json", (d) => {
        (d.exits as Record<string, unknown>[])[0]!.dir = "up";
      }))],
    ["NPC id 가 지역을 넘어 겹침",
      refuses((() => {
        const d = mkdtempSync(join(tmpdir(), "world-"));
        cpSync("content/world", d, { recursive: true });
        const p2 = join(d, "regions", "b2.json");
        const b1 = JSON.parse(readFileSync(join(d, "regions", "b1.json"), "utf8")) as {
          npcs: Record<string, unknown>;
        };
        const b2 = JSON.parse(readFileSync(p2, "utf8")) as Record<string, unknown>;
        b2.npcs = { altar_keeper: { ...(b1.npcs.altar_keeper as object), at: "1,3" } };
        writeFileSync(p2, JSON.stringify(b2, null, 2));
        return d;
      })())],
    ["같은 주제 id 가 두 번",
      refuses(broken("regions/b1.json", (d) => {
        const n = (d.npcs as Record<string, { topics: unknown[] }>).altar_keeper!;
        n.topics.push({ ...(n.topics[0] as object) });
      }))],
    ["NPC id 에 ':' (승급 큐 키의 구분자)",
      refuses(broken("regions/b1.json", (d) => {
        const npcs = d.npcs as Record<string, unknown>;
        npcs["altar:keeper"] = npcs.altar_keeper;
        delete npcs.altar_keeper;
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
    (cases[0]![1] ?? "").includes("b2.json"), String(cases[0]![1]).split("\n")[0]);

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
    !raw.includes("석조 교차로") && !raw.includes("봉인된"), "b1/b2 의 씨앗이 보인다");

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
