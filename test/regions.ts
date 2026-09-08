/* 지역 다중화 테스트.
 *
 * 지역은 세 가지를 동시에 하는 단위다. 셋이 전부 이 파일의 검사 대상이다.
 *   ① 관심영역   — canSee 가 지역 동일성이므로 지역 하나가 곧 팬아웃의 상한
 *   ② 서버측 안개 — 스냅샷은 '지금 있는 지역' 의 타일만 싣는다
 *   ③ 진행       — 문이 플래그로 잠기므로 지역이 '얻는 것' 이 된다
 *
 * ★ 가장 틀리기 쉬운 것은 ② 다. 다른 지역의 격자가 한 번이라도 와이어에
 *   실리면 안개는 그 순간 장식이 된다 — 클라이언트가 전부 알고 있으면서
 *   안 그리는 것뿐이니까. 그래서 '나가지 않았다' 를 문자열 수준에서 본다. */

import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { boot } from "../server/index";
import { FIXTURE_WORLD, FIXTURE_BALANCE, FIXTURE_MOODS } from "./fixture";

/** 지역 메커니즘(문·안개·관심영역) 검사다 — 게임 내용과 무관해야 한다. */
const FIXTURE = { world: FIXTURE_WORLD, balance: FIXTURE_BALANCE, moods: FIXTURE_MOODS } as const;
import { PROTOCOL_VERSION, type ServerMsg } from "../shared/protocol";
import type { Dir } from "../shared/ids";
import { makeMap, type MapData } from "../server/engine/map";
import type { Balance } from "../server/engine/enemies";

/** 실제 content/world/ 를 읽은 맵. 테스트는 서버가 부팅에서 쓰는 것과
 *  같은 데이터를 봐야 한다 — 별도의 테스트 세계를 만들면 검사는 통과하는데
 *  운영 데이터는 틀린 상황이 생긴다. */
const map = makeMap(FIXTURE_WORLD);
import { assertWorldData } from "../server/db/seed";

/** DB 는 토큰의 sha256 만 갖는다 (server/net/handlers.ts 와 같은 공식). */
const sha256 = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

const PORT = 8907;
const DB = join(tmpdir(), `mud-regions-${process.pid}.db`);

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

class Client {
  ws!: WebSocket;
  inbox: ServerMsg[] = [];
  raw: string[] = [];
  token: string | null = null;
  seq = 0;
  constructor(readonly label: string) {}
  async connect(token: string | null = null): Promise<void> {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    await new Promise<void>((res, rej) => {
      this.ws.once("open", () => res());
      this.ws.once("error", rej);
    });
    this.ws.on("message", (d) => {
      const s = String(d);
      this.raw.push(s);
      const m = JSON.parse(s) as ServerMsg;
      this.inbox.push(m);
      if (m.t === "welcome") this.token = m.token;
      if (m.t === "ping") this.ws.send(JSON.stringify({ t: "pong", nonce: m.nonce }));
    });
    this.seq = 0;
    this.ws.send(JSON.stringify({ t: "hello", pv: PROTOCOL_VERSION, token, name: null }));
    await this.until((m) => m.t === "snapshot");
  }
  act(action: unknown): number {
    const seq = ++this.seq;
    this.ws.send(JSON.stringify({ t: "action", seq, action }));
    return seq;
  }
  /** 한 칸 이동하고 그 액션의 ack 를 돌려준다 (성공이든 거절이든). */
  async step(dir: Dir): Promise<Extract<ServerMsg, { t: "ack" }>> {
    const seq = this.act({ type: "move", dir });
    const ack = await this.until<Extract<ServerMsg, { t: "ack" }>>(
      (m) => m.t === "ack" && m.seq === seq,
    );
    await sleep(25);
    return ack;
  }
  async walk(dirs: Dir[]): Promise<void> {
    for (const d of dirs) await this.step(d);
  }
  async until<T extends ServerMsg>(pred: (m: ServerMsg) => boolean, ms = 3000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = this.inbox.find(pred);
      if (hit) return hit as T;
      if (Date.now() > deadline)
        throw new Error(`${this.label}: timeout; inbox=${JSON.stringify(this.inbox.map((m) => m.t))}`);
      await sleep(5);
    }
  }
  of<T extends ServerMsg["t"]>(t: T): Extract<ServerMsg, { t: T }>[] {
    return this.inbox.filter((m) => m.t === t) as Extract<ServerMsg, { t: T }>[];
  }
  logs(kind?: string): Extract<ServerMsg, { t: "log" }>[] {
    return this.of("log").filter((m) => !kind || m.kind === kind);
  }
  clear(): void {
    this.inbox = [];
    this.raw = [];
  }
  close(): void {
    this.ws.close();
  }
}

async function main() {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
  const server = boot(DB, PORT, { ...FIXTURE, llm: "off" });
  const ev = server.events;
  const balance = FIXTURE_BALANCE;

  // ── ① 지역 데이터 자체 ──────────────────────────────────────────────
  section("① 지역 정의 — 부팅 검증이 실제로 무엇을 잡는가");
  check("지역이 둘 이상이다 (단일 지역 가정이 코드에 남아 있지 않다)",
    map.regions().length >= 2, String(map.regions().length));
  check("지역 id 는 파일 이름에서 온다 (값 안에 다시 적지 않는다)",
    map.regions().every((r) => Boolean(r.id) && map.region(r.id) === r));
  check("모든 지역의 모든 걷는 칸에 씨앗이 있다 (부팅 검증이 통과했다)", true);

  /* 같은 좌표가 지역마다 다른 방이다 — 좌표만으로 방을 식별하는 코드가
     남아 있으면 여기서 두 지역이 서로의 캐시를 덮어쓴다. */
  const b1 = map.region("b1")!;
  const b2 = map.region("b2")!;
  check("두 지역이 같은 좌표를 쓴다 (roomId 가 지역을 포함해야만 구별된다)",
    Boolean(b1.seeds["1,3"]) && Boolean(b2.seeds["1,3"]) && b1.seeds["1,3"] !== b2.seeds["1,3"]);
  check("같은 적을 다른 지역에도 배치할 수 있다 ('정의' 와 '배치' 가 갈라져 있다)",
    b1.enemies["5,2"] === "rusted_watcher" && b2.enemies["3,1"] === "rusted_watcher");

  // 부팅 검증기의 각 조항이 '진짜로 던지는가'. 통과만 보면 검증기가
  // 비어 있어도 초록불이라 아무것도 증명하지 못한다.
  const throws = (label: string, mutate: () => () => void): void => {
    const undo = mutate();
    let threw = false;
    try {
      assertWorldData(map, balance);
    } catch {
      threw = true;
    }
    undo();
    check(label, threw);
    // 되돌린 뒤에는 다시 통과해야 한다 — 아니면 다음 검사가 거짓 양성이 된다.
    assertWorldData(map, balance);
  };
  const exits = b2.exits as { at: string; dir: Dir; to: { region: string; x: number; y: number }; requires: string | null; minRank: number; oneWay: boolean }[];
  throws("★ 짝 없는 왕복 출구를 부팅이 거절한다 (들어가면 못 나오는 지역)", () => {
    const saved = exits.splice(0, exits.length);
    return () => exits.push(...saved);
  });
  throws("★ 없는 지역을 가리키는 출구를 부팅이 거절한다", () => {
    const saved = { ...exits[0]! };
    exits[0] = { ...saved, to: { region: "없는지역", x: 1, y: 1 } };
    return () => (exits[0] = saved);
  });
  throws("★ 벽으로 나가는 출구를 부팅이 거절한다", () => {
    const saved = { ...exits[0]! };
    exits[0] = { ...saved, to: { region: "b1", x: 0, y: 0 } };
    return () => (exits[0] = saved);
  });
  throws("★ 선언되지 않은 플래그로 잠근 문을 부팅이 거절한다", () => {
    const saved = { ...exits[0]! };
    exits[0] = { ...saved, requires: "존재하지않는플래그" };
    return () => (exits[0] = saved);
  });
  /* 임무는 세 파일을 한꺼번에 가리킨다 — NPC(지역), 적·보수(밸런스),
     게시 플래그(world.json). 어느 한 파일의 zod 도 이걸 못 본다. */
  type M = {
    id: string; npcId: string; minRank: number; requires: string | null;
    goal: { kind: "slay"; enemyId: string; count: number };
    reward: { itemId: string; qty: number }[];
  };
  const missions = FIXTURE_WORLD.missions as unknown as M[];
  const patchMission = (patch: Record<string, unknown>) => {
    const saved = { ...missions[0]! };
    missions[0] = { ...saved, ...patch } as typeof saved;
    return () => (missions[0] = saved);
  };
  throws("★ 없는 NPC 가 게시하는 임무를 부팅이 거절한다", () =>
    patchMission({ npcId: "없는사람" }));
  throws("★ 길드 업무를 안 보는 사람이 게시하면 거절한다 (말을 걸어도 목록이 빈다)", () =>
    patchMission({ npcId: "altar_keeper" }));
  throws("★ 선언되지 않은 플래그로 게시되는 임무를 거절한다", () =>
    patchMission({ requires: "존재하지않는플래그" }));
  throws("★ 사다리에 없는 등급을 요구하는 임무를 거절한다 (영영 못 받는다)", () =>
    patchMission({ minRank: 99 }));
  throws("★ 없는 적을 목표로 두면 거절한다", () =>
    patchMission({ goal: { kind: "slay", enemyId: "없는적", count: 1 } }));
  /* 정의는 있는데 어디에도 배치되지 않은 적. 배치를 지워서 그 상황을 만든다 —
     "밸런스에 없다" 와 다른 조항이고, 증상도 다르다 (부팅이 아니라 영영 0/1). */
  throws("★ 어디에도 배치되지 않은 적을 목표로 두면 거절한다 (영영 0/1 이다)", () => {
    const undoGoal = patchMission({ goal: { kind: "slay", enemyId: "shadow_warden", count: 1 } });
    const enemies = b1.enemies as Record<string, string>;
    const spot = Object.entries(enemies).find(([, id]) => id === "shadow_warden")![0];
    delete enemies[spot];
    return () => {
      enemies[spot] = "shadow_warden";
      undoGoal();
    };
  });
  throws("★ 없는 아이템을 보수로 두면 거절한다", () =>
    patchMission({ reward: [{ itemId: "없는아이템", qty: 1 }] }));

  /* ── 도달 가능성 ────────────────────────────────────────────────────
     여기까지의 조항은 '한 조각이 스스로 말이 되는가' 를 본다. 아래 넷은
     세계를 스폰에서 뻗는 그래프로 본다 — 조각이 전부 멀쩡해도 갈 수 없으면
     세계가 아니다. 증상이 전부 '조용함' 이라 지역이 늘면 눈으로 못 잡는다.

     ★ 제자리 변형(throws)이 아니라 세계를 통째로 다시 만든다. 지역을 '더하는'
       검사는 makeMap 이 한 번만 조립하므로 제자리로는 할 수 없고, 무엇보다
       기존 문을 지우는 방식으로는 짝 검사가 먼저 걸려서 도달 가능성 조항이
       실제로는 검사되지 않는다 — 처음에 그렇게 짰다가 검증기를 통째로 빼도
       초록불이었다. */
  const rebuilt = (patch: (d: MapData) => MapData, bal: Balance = balance): boolean => {
    try {
      assertWorldData(makeMap(patch(structuredClone(FIXTURE_WORLD) as MapData)), bal);
      return false;
    } catch {
      return true;
    }
  };
  check("★ 어디에서도 갈 수 없는 지역을 부팅이 거절한다 (지역 통째로 유령)",
    rebuilt((d) => ({
      ...d,
      /* 스스로는 멀쩡하다 — 안이 이어져 있고 문이 없어 짝 검사에 걸릴 것도
         없다. 오직 '아무도 가리키지 않는다' 는 이유로만 틀렸다. */
      regions: [...d.regions, {
        id: "orphan", name: "고아 지역",
        tiles: ["#####", "#...#", "#####"],
        seeds: { "1,1": "가", "2,1": "나", "3,1": "다" },
        sensitive: {}, enemies: {}, npcs: {}, exits: [],
      } as unknown as (typeof d.regions)[number]],
    })));

  /* ★ 위의 '고아 지역' 은 사실 방 연결성 조항도 함께 잡는다 (들어오는 자리가
     없으니 모든 칸이 섬이다). 지역 그래프 조항만이 잡을 수 있는 모양은 이것 —
     **서로는 이어져 있는데 세계와 안 이어진 지역 둘.** 각자 상대의 문을
     들어오는 자리로 가지므로 방 연결성도, 짝 검사도 통과한다.
     지역을 스무 개로 늘리면 이게 제일 흔한 실수다. */
  check("★ 서로만 이어진 지역 둘을 거절한다 (짝도 맞고 안도 이어졌지만 섬이다)",
    rebuilt((d) => ({
      ...d,
      regions: [...d.regions,
        {
          id: "isleA", name: "섬 A",
          tiles: ["#####", "#...#", "#####"],
          seeds: { "1,1": "가", "2,1": "나", "3,1": "다" },
          sensitive: {}, enemies: {}, npcs: {},
          exits: [{ at: "3,1", dir: "east", to: { region: "isleB", x: 1, y: 1 },
                    requires: null, minRank: 0, oneWay: false }],
        },
        {
          id: "isleB", name: "섬 B",
          tiles: ["#####", "#...#", "#####"],
          seeds: { "1,1": "라", "2,1": "마", "3,1": "바" },
          sensitive: {}, enemies: {}, npcs: {},
          exits: [{ at: "1,1", dir: "west", to: { region: "isleA", x: 3, y: 1 },
                    requires: null, minRank: 0, oneWay: false }],
        },
      ] as unknown as typeof d.regions,
    })));

  check("★ 통로와 끊긴 방을 거절한다 (아무도 못 보는데 생성 비용은 나간다)",
    rebuilt((d) => ({
      ...d,
      regions: d.regions.map((r) => {
        if (r.id !== "b1") return r;
        /* 격자에 열을 둘 붙이고 그중 한 칸만 뚫는다. 사방이 벽이라 섬이 된다.
           기존 칸을 건드리지 않으므로 'E 타일에 적이 없다' 같은 다른 조항이
           먼저 걸리지 않는다. */
        const tiles = r.tiles.map((t) => `${t}##`);
        tiles[1] = `${r.tiles[1]!}#.`;
        return { ...r, tiles, seeds: { ...r.seeds, "8,1": "아무도 닿을 수 없는 칸" } };
      }),
    })));

  check("★ 켤 방법이 없는 플래그로 잠긴 문을 거절한다 (영영 안 열린다)",
    rebuilt((d) => ({
      ...d,
      /* 선언은 돼 있고 문이 읽기도 한다 — 다만 켜는 적이 세계에 없다.
         '아무도 안 읽는다' 조항이 아니라 '켤 수 없다' 조항이 걸려야 한다. */
      flags: { ...d.flags, sealed_forever: { default: "false", broadcast: false } },
      regions: d.regions.map((r) =>
        r.id === "b1"
          ? { ...r, exits: r.exits.map((e) => ({ ...e, requires: "sealed_forever" })) }
          : r,
      ),
    })));

  /* ★ 위의 '잠긴 문' 은 사실 지역 그래프 조항도 함께 잡는다 (문 너머가 통째로
     못 가는 곳이 되므로). 플래그 조항만이 잡을 수 있는 모양은 **문이 아닌 것**
     을 잠그는 경우다 — 대사 주제·임무·방의 sensitive. 지역은 멀쩡히 다 갈 수
     있고, 그저 그 이야기가 영영 안 열릴 뿐이라 아무 조항도 눈치채지 못한다. */
  check("★ 켤 방법이 없는 플래그로 열리는 '주제' 를 거절한다 (지역은 멀쩡한데 이야기가 안 열린다)",
    rebuilt((d) => ({
      ...d,
      flags: { ...d.flags, 영영_안_켜진다: { default: "false", broadcast: false } },
      regions: d.regions.map((r) =>
        r.id !== "b1"
          ? r
          : {
              ...r,
              npcs: {
                ...r.npcs,
                altar_keeper: {
                  ...r.npcs.altar_keeper!,
                  topics: [
                    ...r.npcs.altar_keeper!.topics,
                    { id: "never", label: "영영", seed: "영영 안 열리는 이야기", requires: "영영_안_켜진다" },
                  ],
                },
              },
            },
      ),
    })));

  check("★ 읽지도 켜지도 않는 플래그 선언을 거절한다 (오타의 흔적)",
    rebuilt((d) => ({
      ...d,
      flags: { ...d.flags, 아무도_안_쓴다: { default: "false", broadcast: false } },
    })));
  /* ★ 켜기만 하는 플래그는 멀쩡하다. 세계가 사건을 기록하되 아직 아무도
     반응하지 않는 상태이고, 저작 중에 늘 지나가는 단계다 — 여기를 거절하면
     'ashen_pages 가 죽으면 플래그를 켠다' 만 써 두고 반응할 방을 나중에 쓰는
     순서가 불가능해진다. 한때 그렇게 짰다가 멀쩡한 세계가 거절당했다. */
  const balWithSetter: Balance = {
    ...balance,
    enemies: {
      ...balance.enemies,
      ashen_pages: { ...balance.enemies.ashen_pages!, slainFlag: "기록만_된다" },
    },
  };
  check("켜기만 하고 아무도 안 읽는 플래그는 통과한다 (저작 중에 늘 지나가는 단계)",
    !rebuilt((d) => ({
      ...d,
      flags: { ...d.flags, 기록만_된다: { default: "false", broadcast: false } },
    }), balWithSetter));

  check("멀쩡한 세계는 그대로 통과한다 (위 넷이 거짓 양성이 아니다)",
    !rebuilt((d) => d));

  throws("★ 사다리에 없는 등급을 요구하는 문을 부팅이 거절한다 (영영 안 열린다)", () => {
    const saved = { ...exits[0]! };
    exits[0] = { ...saved, minRank: 99 };
    return () => (exits[0] = saved);
  });
  throws("★ 걸을 수 있는 칸을 향한 출구를 부팅이 거절한다 (한 칸 이동과 뜻이 겹친다)", () => {
    const saved = { ...exits[0]! };
    // b2 (1,3) 에서 east 는 (2,3) — 걸을 수 있는 칸이다.
    exits[0] = { ...saved, dir: "east" };
    return () => (exits[0] = saved);
  });

  /* NPC 검사는 지역 데이터를 고쳐 '다른 맵' 을 만들어 본다. makeMap 이 부팅에서
     한 번 NPC 목록을 조립하므로, 위의 in-place 방식으로는 검사할 수 없다 —
     그 조립이 한 번뿐이라는 것 자체가 이 파일이 지키는 성질이다. */
  const withNpc = (patch: Record<string, unknown>) => {
    const regions = map.regions().map((r) =>
      r.id === "b1"
        /* ★ 나머지 NPC 를 남긴다. 통째로 갈아끼우면 임무를 게시하는 접수원이
             사라져서 assertMissions 가 먼저 던지고, 이 검사가 무엇을 봤는지
             알 수 없게 된다 (전부 '거절됨' 이 되어 초록불처럼 보인다). */
        ? { ...r, npcs: { ...r.npcs, altar_keeper: { ...r.npcs.altar_keeper!, ...patch } } }
        : r,
    );
    let threw = false;
    try {
      assertWorldData(makeMap({ regions, spawn: map.spawn, flags: FIXTURE_WORLD.flags, missions: FIXTURE_WORLD.missions }), balance);
    } catch {
      threw = true;
    }
    return threw;
  };
  check("★ NPC 가 벽에 서 있으면 부팅이 거절한다 (아니면 FK 에러로 죽는다)",
    withNpc({ at: "0,0" }));
  check("★ 선언되지 않은 플래그에 반응하는 NPC 를 거절한다",
    withNpc({ sensitiveFlags: ["없는플래그"] }));
  check("★ 선언되지 않은 플래그로 열리는 주제를 거절한다",
    withNpc({ topics: [{ id: "x", label: null, seed: "씨앗", requires: "없는플래그" }] }));
  check("멀쩡한 NPC 는 통과한다", !withNpc({}));

  // ── ② 잠긴 문 ───────────────────────────────────────────────────────
  section("② 잠긴 문 — 지역이 '얻는 것' 이다");
  const alice = new Client("alice");
  await alice.connect(null);
  const snap0 = alice.of("snapshot")[0]!;
  check("스폰은 b1 이다", snap0.self.pos.region === "b1", snap0.self.pos.region);
  check("스냅샷의 격자는 b1 하나뿐이다", snap0.region.id === "b1", snap0.region.id);

  await alice.walk(["east", "east", "south", "south"]); // (3,3)->(5,3)->(5,5)
  const at = alice.of("room.describe").at(-1)?.room.roomId;
  check("문 앞(b1:5,5)에 섰다", at === "b1:5,5", String(at));
  check("그 칸 east 에 문이 선언돼 있다", Boolean(map.exitAt({ region: "b1", x: 5, y: 5 }, "east")));
  check("문 자리는 지도상 벽이다 (미니맵에 문이 그려지지 않는다)",
    !map.walkable("b1", 6, 5));

  alice.clear();
  const sealedAck = await alice.step("east");
  check("잠긴 문은 ack{ok:false} 다 (error 가 아니다 — 세계의 진실이지 계약 위반이 아니다)",
    sealedAck.ok === false);
  check("★ 거절 이유는 벽과 같은 \"blocked\" 다 (와이어에서 문의 존재가 새지 않는다)",
    sealedAck.reason === "blocked", String(sealedAck.reason));
  check("위치는 그대로다", sealedAck.pos.region === "b1" && sealedAck.pos.x === 5 && sealedAck.pos.y === 5);
  const sealedLine = alice.logs("sys").at(-1)?.text ?? "";
  check("문장은 벽과 다르다 (문의 존재를 아는 유일한 경로)",
    sealedLine.includes("봉인된 문"), sealedLine);
  check("잠겨 있는 동안 b2 의 격자는 오지 않았다",
    !alice.raw.some((r) => r.includes("봉인된 서고")));

  // 진짜 벽도 눌러 본다 — 두 문장이 실제로 갈리는지.
  alice.clear();
  const wallAck = await alice.step("south");
  check("벽도 같은 모양의 거절이다", wallAck.ok === false && wallAck.reason === "blocked");
  check("문장만 다르다", (alice.logs("sys").at(-1)?.text ?? "").includes("단단한 벽"));

  // ── ③ 플래그가 문을 연다 ────────────────────────────────────────────
  section("③ 플래그가 문을 연다 — 지역 이동");
  ev.setFlag("guardian_slain", true);
  await sleep(60);
  alice.clear();
  const ack = await alice.step("east");
  check("이제 지나간다", ack.ok === true);
  check("★ ack 의 pos 가 다른 지역이다 (권위는 서버, 클라이언트는 방향만 보냈다)",
    ack.pos.region === "b2" && ack.pos.x === 1 && ack.pos.y === 3,
    JSON.stringify(ack.pos));

  const patch = alice.of("self.patch").find((m) => m.region !== undefined);
  check("★ 새 지역의 격자가 self.patch 로 온다", Boolean(patch));
  check("스냅샷이 아니다 (스냅샷은 pending 큐를 비우는 부수효과가 있다)",
    alice.of("snapshot").length === 0);
  check("그 격자는 b2 다", patch?.region?.id === "b2", String(patch?.region?.id));
  check("격자에 이름이 실린다", patch?.region?.name === "봉인된 서고", String(patch?.region?.name));
  check("크기도 b2 의 것이다",
    patch?.region?.height === b2.tiles.length && patch?.region?.width === b2.tiles[0]!.length);

  /* 순서: 격자가 방 묘사보다 먼저 와야 한다. 뒤집히면 한 프레임 동안
     옛 격자 위에 새 좌표가 찍혀 점이 벽 안에 박힌다. */
  const iPatch = alice.inbox.findIndex((m) => m.t === "self.patch" && m.region !== undefined);
  const iDesc = alice.inbox.findIndex((m) => m.t === "room.describe");
  check("★ 격자가 room.describe 보다 먼저 온다", iPatch >= 0 && iPatch < iDesc, `${iPatch} < ${iDesc}`);

  const desc = alice.of("room.describe").at(-1)!;
  check("방 id 에 지역이 들어 있다", desc.room.roomId === "b2:1,3", desc.room.roomId);

  // ── ④ 서버측 안개 ───────────────────────────────────────────────────
  section("④ 서버측 안개 — 다른 지역의 지도는 아예 가지 않는다");
  alice.clear();
  await alice.connect(alice.token); // 재접속: 스냅샷을 새로 받는다
  const snap1 = alice.of("snapshot").at(-1)!;
  check("재접속해도 b2 에 있다", snap1.self.pos.region === "b2");
  check("스냅샷의 격자는 b2 하나뿐이다", snap1.region.id === "b2");
  check("★ b1 의 씨앗 문자열이 와이어에 없다",
    !alice.raw.some((r) => r.includes("무너진 서고의 서쪽 끝")));
  check("★ b1 의 격자가 와이어에 없다", !alice.raw.some((r) => r.includes("#..TE.#")));
  /* seen 은 지역을 넘어 누적된다 (roomId 에 지역이 들어 있으므로 섞이지 않는다).
     지도가 없으니 안개도 없는 것 아니냐 — 아니다. seen 은 b1 의 것도 들고 있고,
     b1 으로 돌아가면 그때 격자가 오면서 그대로 복원된다. */
  check("seen 에 두 지역의 방이 섞여 있다",
    snap1.self.seen.some((r) => r.startsWith("b1:")) &&
      snap1.self.seen.some((r) => r.startsWith("b2:")));

  /* ④' 미니맵이 '적이 나오는 자리' 를 그린다. 그 좌표가 어디서 오는가.

     ★ 안개는 걷었다. 안개가 사는 이유는 '무엇이 기다리는지 모른다' 는
       긴장인데, 이 게임에서 그 긴장은 방에 들어갔을 때의 묘사와 전투가
       만든다. 지도가 감추던 것은 긴장이 아니라 같은 길을 두 번 걷게 하는
       불편이었다. 그래서 클라이언트는 이제 seen 을 지도에 쓰지 않는다.

     ★ 대신 '여기서 적이 나온다' 를 싣는다. **살아 있는 적이 아니라 배치**다:
       살아 있는지는 전투·리스폰으로 시시각각 변해서 밀어 주는 경로가 새로
       필요하지만, 배치는 지역 데이터라 스냅샷 한 번이면 끝난다. 그리고
       지도가 말할 성질도 그쪽이다 — '지금 서 있는가' 는 방에 들어가면 안다. */
  const noFoes: MapData = {
    ...FIXTURE_WORLD,
    regions: FIXTURE_WORLD.regions.map((r) => (r.id === "b2" ? { ...r, enemies: {} } : r)),
  };
  const withFoes = makeMap(FIXTURE_WORLD);
  const cleared = makeMap(noFoes);
  const b2def = FIXTURE_WORLD.regions.find((r) => r.id === "b2")!;
  check("★ 적이 배치된 칸이 그대로 실린다",
    JSON.stringify(withFoes.view("b2").foes) === JSON.stringify(Object.keys(b2def.enemies).sort()),
    JSON.stringify([withFoes.view("b2").foes, Object.keys(b2def.enemies).sort()]));
  check("★ 배치를 비우면 실리는 것도 없다 (지어내지 않는다)",
    cleared.view("b2").foes.length === 0, JSON.stringify(cleared.view("b2").foes));
  check("다른 지역은 그대로다 (지역마다 따로 싣는다)",
    cleared.view("b1").foes.length > 0 && cleared.view("b3").foes.length > 0);
  /* ★ 좌표만 나간다. 적의 id 가 실리면 그건 '무엇이 기다리는가' 를 지도가
     말해 주는 것이고, 방에 들어가기 전에 알 일이 아니다. */
  const ids = new Set(Object.values(b2def.enemies));
  check("★ 적의 정체는 실리지 않는다 (좌표뿐이다)",
    !withFoes.view("b2").foes.some((k) => ids.has(k)) &&
      ![...ids].some((id) => JSON.stringify(withFoes.view("b2")).includes(id)),
    JSON.stringify([...ids]));
  /* ★ 안개를 걷는 것이 '더 보낸다' 는 뜻이면 안 된다. 격자는 전에도 전부
     실려 있었고(그게 '한 지역 = 관심영역' 이라는 서버측 안개다), 안개는
     클라이언트가 칠하던 것이다. 프로토콜이 나르는 것이 늘면 불변식 2 가 흔들린다. */
  check("★ 타일은 두 경우가 글자 그대로 같다 (더 보내는 것이 아니다)",
    JSON.stringify(cleared.view("b2").tiles) === JSON.stringify(withFoes.view("b2").tiles));

  /* ④'' 다른 지역으로 나가는 길을 지도가 찍는다.
     ★ 없으면 '다음 지역에 어떻게 가는가' 를 아는 방법이 벽에 부딪혀 보는 것
       뿐이다. 열 칸짜리 지역에서는 그게 놀이지만 마흔 칸짜리에서는 막막함이다.
     ★ 싣는 것은 '서는 칸' 이다 — 출구는 걷는 칸에서 벽 쪽으로 나가므로
       문 자체는 격자에 칸이 없다. 사람이 알아야 하는 것도 어디에 서는가다. */
  const gateCells = withFoes.view("b2").gates;
  const wantGates = [...new Set(b2def.exits.map((e) => e.at))].sort();
  check("★ 출구가 있는 칸이 그대로 실린다",
    JSON.stringify(gateCells.map((g) => g.at)) === JSON.stringify(wantGates),
    JSON.stringify([gateCells, wantGates]));
  check("★ 그 칸은 전부 걷는 칸이다 (벽을 찍으면 갈 수 없는 곳을 가리킨다)",
    gateCells.every((g) => {
      const [x, y] = g.at.split(",").map(Number);
      return withFoes.walkable("b2", x!, y!);
    }), JSON.stringify(gateCells));
  /* ★ 방향이 실린다. 이것이 없으면 미니맵은 '이 칸에서 나간다' 까지만 알고
     '어느 쪽으로' 를 모른다 — 그리고 격자로는 유도할 수 없다(아래 검사). */
  check("★ 칸마다 방향이 하나 이상 실린다",
    gateCells.length > 0 && gateCells.every((g) => g.dirs.length > 0),
    JSON.stringify(gateCells));
  check("★ 실리는 방향이 그 칸의 출구와 정확히 같다",
    gateCells.every((g) => {
      const want = [...new Set(b2def.exits.filter((e) => e.at === g.at).map((e) => e.dir))].sort();
      return JSON.stringify([...g.dirs].sort()) === JSON.stringify(want);
    }), JSON.stringify(gateCells));
  /* ★ 그 방향의 이웃은 벽이다 — 출구는 걷는 칸에서 벽 쪽으로 난다.
     막대를 그 변에 그리는 것이 '벽에 난 문' 으로 읽히는 근거다. */
  const STEP: Record<string, [number, number]> = {
    north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0],
  };
  check("★ 그 방향의 이웃 칸은 벽이다 (문은 벽 자리에 있다)",
    gateCells.every((g) => {
      const [x, y] = g.at.split(",").map(Number);
      return g.dirs.every((d) => !withFoes.walkable("b2", x! + STEP[d]![0], y! + STEP[d]![1]));
    }), JSON.stringify(gateCells));
  /* ★ 어디로 이어지는지도, 무엇이 필요한지도 안 싣는다. 지도가 미리 말하면
     그건 진행을 지도에 적어 두는 것이다 — 가 보면 서버가 문장으로 답한다. */
  const slice = JSON.stringify(withFoes.view("b2"));
  check("★ 목적지 지역도 잠금 조건도 실리지 않는다 (좌표뿐이다)",
    !b2def.exits.some((e) => slice.includes(e.to.region) || (e.requires ? slice.includes(e.requires) : false)),
    slice.slice(0, 200));

  // ── ⑤ 관심영역 ─────────────────────────────────────────────────────
  section("⑤ 관심영역 — 다른 지역의 사람은 보이지 않는다");
  alice.clear();
  const bob = new Client("bob");
  await bob.connect(null); // b1 스폰
  await sleep(80);
  check("다른 지역 사람이 접속해도 presence.join 이 오지 않는다",
    alice.of("presence.join").length === 0, String(alice.of("presence.join").length));
  const bSnap = bob.of("snapshot")[0]!;
  check("반대쪽도 마찬가지다 — Bob(b1) 의 스냅샷에 Alice(b2) 가 없다",
    bSnap.presence.length === 0, JSON.stringify(bSnap.presence));
  await bob.walk(["east", "east"]); // b1 안에서 움직인다
  await sleep(80);
  check("★ 다른 지역 사람의 presence.move 가 오지 않는다",
    alice.of("presence.move").length === 0, String(alice.of("presence.move").length));
  check("다른 지역 사람의 좌표가 와이어에 아예 없다", alice.of("presence.join").length === 0);
  check("Bob 의 이름조차 나가지 않았다", !alice.raw.some((r) => r.includes(bSnap.self.name)));

  /* ★ 외침의 상한이 곧 canSee 다. 지역이 '관심영역의 상한' 이라는 결정이
     여기서 두 번째 값을 낸다 — 지역 채널을 만들면서 팬아웃 경계를 새로
     정할 필요가 없었다. 그 경계가 진짜인지는 와이어에서만 확인된다. */
  alice.clear();
  const yellSeq = bob.act({ type: "yell", text: "지역을-넘지-않는다" });
  await bob.until((m) => m.t === "ack" && m.seq === yellSeq);
  await sleep(120);
  check("★ 다른 지역의 외침은 들리지 않는다",
    alice.logs("yell").length === 0, JSON.stringify(alice.logs("yell").map((l) => l.text)));
  check("그 문자열이 와이어에 아예 없다 (안개 검사와 같은 수준)",
    !alice.raw.some((r) => r.includes("지역을-넘지-않는다")));
  check("(대조) 외친 사람 자신은 들었다 — 팬아웃이 죽은 것이 아니라 경계에서 끊겼다",
    bob.logs("yell").some((l) => l.text === "지역을-넘지-않는다"));

  // Bob 이 문을 지나 같은 지역으로 오면 그때 보인다.
  alice.clear();
  await bob.walk(["south", "south", "east"]); // (5,3)->(5,5)->b2(1,3)
  await sleep(120);
  check("★ 같은 지역으로 들어오면 그때 보인다", alice.of("presence.join").length >= 1);
  check("방까지 같으면 room.enter 도 온다", alice.of("room.enter").length >= 1);

  // ── ⑥ 돌아가기 ─────────────────────────────────────────────────────
  section("⑥ 돌아가기 — 왕복 출구");
  alice.clear();
  const backAck = await alice.step("west");
  check("반대편 문으로 돌아간다", backAck.ok === true && backAck.pos.region === "b1");
  check("정확히 들어왔던 칸이다", backAck.pos.x === 5 && backAck.pos.y === 5);
  const backPatch = alice.of("self.patch").find((m) => m.region !== undefined);
  check("b1 의 격자가 다시 온다", backPatch?.region?.id === "b1");
  check("돌아오는 문에는 조건이 없다 (한 번 열린 길은 닫히지 않는다)",
    map.exitAt({ region: "b2", x: 1, y: 3 }, "west")?.requires === null);

  // ── ⑦ seen 쓰기 조건화 ─────────────────────────────────────────────
  section("⑦ 이미 밟은 칸으로 가는 걸음은 seen 을 다시 쓰지 않는다");
  alice.clear();
  await alice.step("north"); // b1:5,4 — 이미 밟았다
  check("★ 이미 아는 칸이면 self.patch{seen} 이 오지 않는다",
    alice.of("self.patch").every((m) => m.seen === undefined));
  const seenRow = server.ctx.q.playerByTokenHash.get(sha256(alice.token!))?.seen ?? "[]";
  check("그래도 DB 의 seen 은 온전하다",
    (JSON.parse(seenRow) as string[]).includes("b1:5,4"), seenRow);

  alice.close();
  bob.close();
  await server.close();

  section(failures === 0 ? `PASS — ${checks}/${checks} 검사 통과` : `FAIL — ${failures}/${checks} 실패`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
