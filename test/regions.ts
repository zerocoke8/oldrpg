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
import { PROTOCOL_VERSION, type ServerMsg } from "../shared/protocol";
import type { Dir } from "../shared/ids";
import { makeMap } from "../server/engine/map";
import { loadWorld } from "../server/content/world";

/** 실제 content/world/ 를 읽은 맵. 테스트는 서버가 부팅에서 쓰는 것과
 *  같은 데이터를 봐야 한다 — 별도의 테스트 세계를 만들면 검사는 통과하는데
 *  운영 데이터는 틀린 상황이 생긴다. */
const map = makeMap(loadWorld());
import { assertWorldData } from "../server/db/seed";
import { loadBalance } from "../server/content/balance";

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
  const server = boot(DB, PORT, { llm: "off" });
  const ev = server.events;
  const balance = loadBalance();

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
  const exits = b2.exits as { at: string; dir: Dir; to: { region: string; x: number; y: number }; requires: string | null; oneWay: boolean }[];
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
        ? { ...r, npcs: { altar_keeper: { ...r.npcs.altar_keeper!, ...patch } } }
        : r,
    );
    let threw = false;
    try {
      assertWorldData(makeMap({ regions, spawn: map.spawn }), balance);
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
