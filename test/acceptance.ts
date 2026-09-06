/* 1단계 인수 테스트. 진짜 서버, 진짜 WebSocket 두 개, 진짜 SQLite.
 *
 * 이번 단계의 목표를 글자 그대로 검증한다:
 *   "브라우저 두 개를 띄웠을 때 서로의 위치가 미니맵에 보이고,
 *    같은 방에 있으면 'OO가 들어왔다' 메시지가 뜨는 것"
 *
 * 그리고 설계에서 '가장 틀리기 쉽다' 고 지목된 것들:
 *   - 새로고침이 조용한가 (유예)
 *   - 새로고침이 상대 미니맵에서 나를 지우지 않는가 (connId 에폭 가드)
 *   - 벽 부딪힘이 error 가 아니라 ack 인가
 *   - 거절된 액션도 pending 을 비우는가 (ack 가 항상 pos 를 싣는가)
 *   - state_hash 캐시가 진짜로 도는가 (조회 -> 생성 -> 기록) */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { boot } from "../server/index";
import { PROTOCOL_VERSION, type ServerMsg } from "../shared/protocol";
import { GRACE_MS } from "../server/net/session";
import { SEEDS, SPAWN, walkable } from "../server/engine/map";
import type { Dir } from "../shared/ids";

const PORT = 8899;
const DB = join(tmpdir(), `mud-acceptance-${process.pid}.db`);

let failures = 0;
let checks = 0;
function check(label: string, cond: boolean, detail = ""): void {
  checks++;
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}
const section = (s: string) => console.log(`\n${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 최소한의 테스트 클라이언트. 클라이언트 재조정 로직과 '같은' 규칙을 쓴다. */
class Client {
  ws!: WebSocket;
  inbox: ServerMsg[] = [];
  token: string | null = null;
  seq = 0;
  constructor(readonly label: string) {}

  async connect(token: string | null = this.token): Promise<void> {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    await new Promise<void>((res, rej) => {
      this.ws.once("open", () => res());
      this.ws.once("error", rej);
    });
    this.ws.on("message", (d) => {
      const m = JSON.parse(String(d)) as ServerMsg;
      this.inbox.push(m);
      if (m.t === "welcome") this.token = m.token;
      if (m.t === "ping") this.ws.send(JSON.stringify({ t: "pong", nonce: m.nonce }));
    });
    this.seq = 0;
    this.ws.send(JSON.stringify({ t: "hello", pv: PROTOCOL_VERSION, token, name: null }));
    await this.until((m) => m.t === "snapshot");
  }

  send(action: unknown): number {
    const seq = ++this.seq;
    this.ws.send(JSON.stringify({ t: "action", seq, action }));
    return seq;
  }
  move(dir: Dir): number {
    return this.send({ type: "move", dir });
  }

  /** 특정 메시지가 올 때까지 기다린다. */
  async until<T extends ServerMsg>(pred: (m: ServerMsg) => boolean, ms = 2000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = this.inbox.find(pred);
      if (hit) return hit as T;
      if (Date.now() > deadline) throw new Error(`${this.label}: timeout waiting; inbox=${JSON.stringify(this.inbox.map((m) => m.t))}`);
      await sleep(5);
    }
  }
  /** ack 를 기다린다 — 성공이든 거절이든. */
  ack(seq: number) {
    return this.until((m) => m.t === "ack" && m.seq === seq);
  }
  of<T extends ServerMsg["t"]>(t: T): Extract<ServerMsg, { t: T }>[] {
    return this.inbox.filter((m) => m.t === t) as Extract<ServerMsg, { t: T }>[];
  }
  logs(kind?: string): Extract<ServerMsg, { t: "log" }>[] {
    return this.of("log").filter((m) => !kind || m.kind === kind);
  }
  clear(): void {
    this.inbox = [];
  }
  close(): void {
    this.ws.close();
  }
}

async function main() {
  rmSync(DB, { force: true });
  rmSync(`${DB}-wal`, { force: true });
  rmSync(`${DB}-shm`, { force: true });
  // llm:"off" — 이 스위트는 렌더러를 하나도 안 꽂는다. 그것이 곧 실물 호출이면 안 된다.
  const server = boot(DB, PORT, { llm: "off" });

  const alice = new Client("alice");
  const bob = new Client("bob");

  // ── ① 접속 ──────────────────────────────────────────────────────────
  section("① 두 클라이언트 접속 (스폰 b1:3,3)");
  await alice.connect(null);
  const aSnap = await alice.until<Extract<ServerMsg, { t: "snapshot" }>>((m) => m.t === "snapshot");
  check("Alice 스냅샷이 스폰 좌표", aSnap.self.pos.x === 3 && aSnap.self.pos.y === 3);
  check("Alice 혼자이므로 presence 비어 있음", aSnap.presence.length === 0);
  check("맵 전체(7x7)를 받았다", aSnap.region.tiles.length === 7 && aSnap.region.width === 7);
  check("Phase B 방 묘사가 도착했다 (씨앗 기반)",
    alice.logs("narr").some((l) => l.text.includes("석조 교차로")),
    JSON.stringify(alice.logs("narr").map((l) => l.text)));
  check("방 묘사에 source='fallback' 이 실려 있다",
    alice.logs("narr")[0]?.source === "fallback");

  /* ★ 회귀: 모든 플레이어의 '첫 문장' 이 옆의 미니맵과 맞아야 한다.
     스폰 씨앗이 "네 방향으로 통로가 뻗은" 이라고 주장했는데 실제 출구는
     동·서 둘뿐이었다 — 새 플레이어가 위로 한 번 누르면 "단단한 벽이 앞을
     막는다" 를 듣는다. 자연어를 전부 검사할 수는 없지만, 그 거짓 주장의
     모양만큼은 기계로 잡을 수 있다. */
  const spawnExits = ([[0, -1], [0, 1], [1, 0], [-1, 0]] as const).filter(([dx, dy]) =>
    walkable(SPAWN.x + dx, SPAWN.y + dy),
  ).length;
  check("스폰의 실제 출구는 둘이다 (동·서)", spawnExits === 2, String(spawnExits));
  const spawnSeed = SEEDS[`${SPAWN.x},${SPAWN.y}`] ?? "";
  check("★ 스폰 씨앗이 네 방향을 주장하지 않는다 (맵과 어긋나면 안 된다)",
    !spawnSeed.includes("네 방향") && !spawnSeed.includes("사방"), spawnSeed);
  check("무너진 남북 통로를 문장이 설명한다",
    alice.logs("narr").some((l) => l.text.includes("동서로만")),
    JSON.stringify(alice.logs("narr").map((l) => l.text)));

  alice.clear();
  await bob.connect(null);

  // ── ② 인수 조건 2: "OO가 들어왔다" ──────────────────────────────────
  section("② 같은 방 입장 -> Alice 화면에 presence 메시지");
  const enter = await alice.until<Extract<ServerMsg, { t: "room.enter" }>>((m) => m.t === "room.enter");
  const bobName = enter.player.name;
  check("Alice 가 room.enter 를 받았다", enter.player.id.length > 0);
  check(`Alice 로그에 "${bobName} 님이 ... 나타났다"`,
    alice.logs("presence").some((l) => l.text.includes(bobName) && l.text.includes("나타났다")),
    JSON.stringify(alice.logs("presence").map((l) => l.text)));

  // ── ①' 인수 조건 1: 미니맵에 상대가 보인다 ──────────────────────────
  section("②' 미니맵 presence");
  const join = await alice.until<Extract<ServerMsg, { t: "presence.join" }>>((m) => m.t === "presence.join");
  check("Alice 가 Bob 의 presence.join 을 좌표와 함께 받았다",
    join.pos.x === 3 && join.pos.y === 3);
  const bSnap = bob.of("snapshot")[0]!;
  check("Bob 의 스냅샷에 Alice 가 이미 들어 있다 (join 없이도)",
    bSnap.presence.length === 1 && bSnap.presence[0]!.pos.x === 3);
  check("Bob 의 room.occupants 와 snapshot.presence 가 일치한다",
    bSnap.room.occupants.length === bSnap.presence.length);
  check("Bob 이 로스터 줄을 Phase A 에서 받았다",
    bob.logs("presence").some((l) => l.text.includes("서 있다")));

  // ── ③ 벽 (거절 경로) ────────────────────────────────────────────────
  section("③ 벽 부딪힘 — error 가 아니라 ack");
  alice.clear();
  bob.clear();
  const wallSeq = bob.move("north"); // (3,2) 는 벽
  const wallAck = await bob.ack(wallSeq);
  check("ack{ok:false, reason:'blocked'}",
    wallAck.t === "ack" && wallAck.ok === false && wallAck.reason === "blocked");
  check("거절인데도 ack 가 권위 pos 를 싣는다 (롤백 분기 불필요)",
    wallAck.t === "ack" && wallAck.pos.x === 3 && wallAck.pos.y === 3);
  check("error 는 오지 않았다", bob.of("error").length === 0);
  check("벽 문장은 log{sys} 로 왔다",
    bob.logs("sys").some((l) => l.text.includes("벽")));
  await sleep(60);
  check("벽 부딪힘은 남에게 아무것도 보내지 않았다", alice.inbox.length === 0,
    JSON.stringify(alice.inbox.map((m) => m.t)));

  // ── ④ 이동: 미니맵 갱신 + 퇴장 ──────────────────────────────────────
  section("④ Bob 이 서쪽으로 이동 (3,3) -> (2,3)");
  alice.clear();
  bob.clear();
  const wSeq = bob.move("west");
  const wAck = await bob.ack(wSeq);
  check("ack{ok:true} 에 새 좌표", wAck.t === "ack" && wAck.ok && wAck.pos.x === 2);
  check("self.patch 로 안개(seen)가 갱신됐다",
    bob.of("self.patch").some((p) => p.seen?.includes("b1:2,3")));
  check("Bob 이 room.describe 를 받았다 (프로즈 없음)",
    bob.of("room.describe")[0]?.room.roomId === "b1:2,3");

  const move = await alice.until<Extract<ServerMsg, { t: "presence.move" }>>((m) => m.t === "presence.move");
  check("Alice 미니맵의 Bob 점이 (2,3) 으로 옮겨졌다", move.pos.x === 2 && move.pos.y === 3);
  check("Alice 가 room.leave 를 받았다 (toDir=west)",
    alice.of("room.leave")[0]?.toDir === "west");
  check("Alice 로그: '서쪽으로 사라졌다'",
    alice.logs("presence").some((l) => l.text.includes("서쪽") && l.text.includes("사라졌다")));

  const aIdx = alice.inbox.findIndex((m) => m.t === "presence.move");
  const lIdx = alice.inbox.findIndex((m) => m.t === "room.leave");
  check("순서 규칙: presence.move 가 room.leave 보다 먼저",
    aIdx >= 0 && lIdx >= 0 && aIdx < lIdx, `presence.move@${aIdx} room.leave@${lIdx}`);

  await bob.until((m) => m.t === "log" && m.kind === "narr" && m.roomId === "b1:2,3");
  check("Phase B: 새 방의 묘사가 뒤이어 도착했다",
    bob.logs("narr").some((l) => l.text.includes("물방울")));

  // ── ⑤ 되돌아오기: "OO가 들어왔다" (방향 포함) ───────────────────────
  section("⑤ Bob 이 되돌아옴 -> Alice 화면에 '서쪽에서 들어왔다'");
  alice.clear();
  bob.clear();
  const eSeq = bob.move("east");
  await bob.ack(eSeq);
  const reEnter = await alice.until<Extract<ServerMsg, { t: "room.enter" }>>((m) => m.t === "room.enter");
  check("room.enter 의 fromDir 이 'west' (이동 방향의 반대)", reEnter.fromDir === "west");
  check(`Alice 로그: "${bobName} 님이 서쪽에서 들어왔다."`,
    alice.logs("presence").some((l) => l.text === `${bobName} 님이 서쪽에서 들어왔다.`),
    JSON.stringify(alice.logs("presence").map((l) => l.text)));
  check("Bob 은 다시 Alice 의 로스터 줄을 받았다",
    bob.logs("presence").some((l) => l.text.includes("서 있다")));

  // ── ⑥ say: 방 단위 팬아웃 ───────────────────────────────────────────
  section("⑥ say — 방 단위 팬아웃과 speaker 분리");
  alice.clear();
  bob.clear();
  const sSeq = bob.send({ type: "say", text: "여기 뭐 있냐" });
  await bob.ack(sSeq);
  const heard = await alice.until<Extract<ServerMsg, { t: "log" }>>((m) => m.t === "log" && m.kind === "say");
  check("Alice 가 같은 방에서 발화를 들었다", heard.text === "여기 뭐 있냐");
  check("화자가 구조화 필드로 분리되어 있다 (문장 합성 아님)",
    heard.speaker?.id === enter.player.id);
  check("발화자 자신도 받는다", bob.logs("say").length === 1);

  // ── ⑦ 새로고침이 조용한가 (유예) ────────────────────────────────────
  section("⑦ Bob 새로고침 — 유예 안에서는 아무 일도 없어야 한다");
  alice.clear();
  const bobToken = bob.token;
  bob.close();
  await sleep(300); // 유예(8초)보다 훨씬 짧게
  check("Alice 에게 presence.leave 가 오지 않았다", alice.of("presence.leave").length === 0);
  check("Alice 에게 room.leave 가 오지 않았다", alice.of("room.leave").length === 0);
  check("Alice 로그에 '사라졌다' 가 없다",
    !alice.logs("presence").some((l) => l.text.includes("사라졌다")),
    JSON.stringify(alice.logs("presence").map((l) => l.text)));

  const bob2 = new Client("bob2");
  await bob2.connect(bobToken);
  await sleep(200);
  check("Bob 이 같은 캐릭터로 돌아왔다", bob2.of("welcome")[0]?.self.id === enter.player.id);
  check("돌아온 좌표가 (3,3) 로 보존됐다",
    bob2.of("snapshot")[0]?.self.pos.x === 3 && bob2.of("snapshot")[0]?.self.pos.y === 3);
  check("Alice 에게 재입장 알림도 오지 않았다 (완전히 조용하다)",
    alice.of("presence.join").length === 0 && alice.of("room.enter").length === 0,
    JSON.stringify(alice.inbox.map((m) => m.t)));

  // ★ 에폭 가드: 옛 소켓의 늦은 close 가 '새' 세션을 지우면 안 된다
  section("⑦' connId 에폭 가드 — 새로고침이 나를 미니맵에서 지우지 않는가");
  await sleep(GRACE_MS + 500); // 옛 소켓의 유예가 만료될 시간을 지나서
  check("유예 만료 후에도 Alice 에게 leave 가 오지 않았다 (입양됐으므로)",
    alice.of("presence.leave").length === 0,
    JSON.stringify(alice.inbox.map((m) => m.t)));
  alice.clear();
  const stillSeq = bob2.move("west");
  await bob2.ack(stillSeq);
  const stillMove = await alice.until<Extract<ServerMsg, { t: "presence.move" }>>((m) => m.t === "presence.move");
  check("새로고침한 Bob 이 여전히 Alice 미니맵에서 움직인다", stillMove.pos.x === 2);

  // ── ⑧ 두 번째 탭 = 같은 토큰 -> 교체 ────────────────────────────────
  section("⑧ 같은 토큰의 두 번째 소켓 — 새 소켓이 이긴다");
  const bob3 = new Client("bob3");
  await bob3.connect(bobToken);
  const replaced = await bob2.until<Extract<ServerMsg, { t: "error" }>>((m) => m.t === "error");
  check("옛 소켓이 error{replaced} 를 받았다", replaced.code === "replaced");
  check("reconnect:false (무한 강퇴 핑퐁 방지)", replaced.reconnect === false);

  // ── ⑨ 유예 만료 -> 진짜 퇴장 ────────────────────────────────────────
  // 두 계열이 '다른 수신자 집합' 을 갖는다는 것을 여기서 실증한다:
  //   presence.* -> 나를 볼 수 있는 모두 (미니맵)
  //   room.*     -> 그 방의 재실자만   (서사)
  section("⑨-a 다른 방에서 접속 종료 — 미니맵 점만 사라지고 서사는 없다");
  alice.clear();
  bob3.close(); // bob3 는 (2,3), alice 는 (3,3)
  await sleep(GRACE_MS + 800);
  check("유예가 지나자 presence.leave 가 왔다", alice.of("presence.leave").length === 1);
  check("다른 방이므로 room.leave 는 오지 않는다 (두 계열의 수신자가 다르다)",
    alice.of("room.leave").length === 0);
  check("따라서 서사 로그도 없다",
    !alice.logs("presence").some((l) => l.text.includes("사라졌다")),
    JSON.stringify(alice.logs("presence").map((l) => l.text)));

  section("⑨-b 같은 방에서 접속 종료 — presence + room + 로그 전부");
  const carol = new Client("carol");
  await carol.connect(null); // 스폰 = (3,3) = Alice 와 같은 방
  const carolName = (await alice.until<Extract<ServerMsg, { t: "room.enter" }>>(
    (m) => m.t === "room.enter",
  )).player.name;
  alice.clear();
  carol.close();
  await sleep(GRACE_MS + 800);
  check("presence.leave 가 왔다", alice.of("presence.leave").length === 1);
  check("같은 방이므로 room.leave 도 왔다 (toDir=null)",
    alice.of("room.leave")[0]?.toDir === null);
  check(`로그: "${carolName} 님이 어둠 속으로 사라졌다."`,
    alice.logs("presence").some((l) => l.text === `${carolName} 님이 어둠 속으로 사라졌다.`),
    JSON.stringify(alice.logs("presence").map((l) => l.text)));

  // ── ⑩ 프로토콜 방어 ─────────────────────────────────────────────────
  section("⑩ 적대적 클라이언트");
  alice.clear();
  const before = alice.of("ack").length;
  alice.ws.send(JSON.stringify({ t: "action", seq: ++alice.seq, action: { type: "move", dir: "__proto__" } }));
  const badDir = await alice.until<Extract<ServerMsg, { t: "ack" }>>((m) => m.t === "ack" && alice.of("ack").length > before);
  check("dir:'__proto__' 가 ack{bad_args} 로 거절됐다 (error 아님)",
    badDir.ok === false && badDir.reason === "bad_args");
  check("거절도 pos 를 실어 pending 을 비운다", badDir.pos.x === 3);

  // 이 서버가 구현하지 않은 동사. (4단계에서 attack 이 '진짜' 가 됐으므로
  //  앞으로도 구현될 일이 없을 이름을 쓴다 — 이 검사의 요점은 '옛 서버가
  //  새 클라이언트를 만나도 크래시하지 않는다' 이지 특정 동사가 아니다.)
  const unkSeq = alice.send({ type: "cast_fireball", targetId: "x" });
  const unk = await alice.ack(unkSeq);
  check("모르는 액션은 ack{unknown_action} (크래시도 error 도 아님)",
    unk.t === "ack" && unk.reason === "unknown_action");
  // 아는 동사에 모르는 필드를 끼워 넣으면 bad_args 다 (strict 스키마).
  const strictSeq = alice.send({ type: "attack", targetId: "x" });
  const strict = await alice.ack(strictSeq);
  check("아는 동사 + 모르는 필드는 ack{bad_args}",
    strict.t === "ack" && strict.reason === "bad_args", String(strict.t === "ack" && strict.reason));

  const longSeq = alice.send({ type: "say", text: "가".repeat(500) });
  const long = await alice.ack(longSeq);
  check("너무 긴 say 는 자르지 않고 ack{too_long} 으로 거절",
    long.t === "ack" && long.reason === "too_long");

  // 좌표를 '주장' 하려는 시도 — 액션 타입에 좌표 필드가 아예 없다
  const spoofSeq = alice.send({ type: "move", dir: "north", x: 99, y: 99 });
  const spoof = await alice.ack(spoofSeq);
  check("좌표 필드를 끼워 넣은 move 는 strict 스키마가 거절",
    spoof.t === "ack" && spoof.reason === "bad_args");

  // seq 역행 -> 치명적, 연결 종료
  const closed = new Promise<void>((r) => alice.ws.once("close", () => r()));
  alice.ws.send(JSON.stringify({ t: "action", seq: 1, action: { type: "look" } }));
  const seqErr = await alice.until<Extract<ServerMsg, { t: "error" }>>((m) => m.t === "error");
  check("seq 역행은 error{bad_seq}", seqErr.code === "bad_seq");
  await closed;
  check("error 는 연결을 끊는다 (그래서 pending 이 살아남을 수 없다)", true);

  // ── ⑪ state_hash 캐시가 진짜로 돌았는가 ─────────────────────────────
  section("⑪ 캐시 조회 -> 생성 -> 기록 이 진짜로 돌았는가");
  const rows = server.ctx.q.getRoomText.get("b1:3,3", server.ctx.world.stateHash("b1:3,3"));
  check("걸어간 방의 room_text 행이 기록되어 있다", Boolean(rows));
  check("1단계 출처는 fallback", rows?.source === "fallback");
  const visited = server.ctx.q.getRoomText.get("b1:2,3", server.ctx.world.stateHash("b1:2,3"));
  check("두 번째로 걸어간 방도 lazy 기록됐다", Boolean(visited));
  const unvisited = server.ctx.q.getRoomText.get("b1:5,5", server.ctx.world.stateHash("b1:5,5"));
  check("아무도 안 간 방은 기록되지 않았다 (부팅 프리시드 없음)", unvisited === undefined);

  const hash = server.ctx.world.stateHash("b1:5,4");
  check("state_hash 는 세 조각이다 (seedId.declHash.valueDigest)", hash.split(".").length === 3);
  const noFlagRoom = server.ctx.world.stateHash("b1:3,3");
  check("플래그를 선언하지 않은 방도 같은 형식으로 계산된다 (특례 없음)",
    noFlagRoom.split(".").length === 3);

  // ── ⑫ 캐릭터 생성 예산 (형식만 맞는 토큰으로 우회되지 않아야 한다) ───
  section("⑫ 캐릭터 생성 예산 — 가짜 토큰으로 우회 불가");
  // 알 수 없는 토큰은 (오라클이 되지 않으려고) '신규 생성' 으로 흡수된다.
  // 따라서 예산을 "token 이 null 인가" 에 물리면 형식만 맞는 아무 64자리 hex
  // 로 무제한 players 행을 만들 수 있다. 예산은 '행을 만드는가' 에 물려야 한다.
  const bogus = (n: number) => String(n).padStart(64, "0");
  const tryHello = (token: string | null) =>
    new Promise<{ ok: boolean; code?: string }>((resolve) => {
      const w = new WebSocket(`ws://127.0.0.1:${PORT}`);
      let settled = false;
      const done = (r: { ok: boolean; code?: string }) => {
        if (settled) return;
        settled = true;
        resolve(r);
        try {
          w.close();
        } catch {
          /* 이미 닫힘 */
        }
      };
      w.on("open", () =>
        w.send(JSON.stringify({ t: "hello", pv: PROTOCOL_VERSION, token, name: null })),
      );
      w.on("message", (d) => {
        const m = JSON.parse(String(d)) as ServerMsg;
        if (m.t === "error") done({ ok: false, code: m.code });
        if (m.t === "snapshot") done({ ok: true });
      });
      w.on("close", () => done({ ok: false, code: "closed" }));
      setTimeout(() => done({ ok: false, code: "timeout" }), 3000);
    });

  // 지금까지 이 IP 로 만든 신규 캐릭터: alice, bob, carol = 3. 예산은 5.
  const r4 = await tryHello(bogus(4));
  const r5 = await tryHello(bogus(5));
  check("가짜 토큰도 '신규 생성' 으로 흡수된다 (토큰 존재 오라클 없음)", r4.ok && r5.ok);
  const r6 = await tryHello(bogus(6));
  check("예산을 넘기면 가짜 토큰도 거절된다 (우회 불가)",
    !r6.ok && r6.code === "flooding", JSON.stringify(r6));
  const r7 = await tryHello(null);
  check("token:null 경로의 거절 모양이 동일하다 (오라클 아님)",
    !r7.ok && r7.code === "flooding", JSON.stringify(r7));

  // ── ⑬ 종료 경로 (적대적 리뷰가 재현시킨 결함들의 회귀 테스트) ───────
  section("⑬ 종료");
  // (a) hello 를 보내지 않은 소켓이 있어도 종료가 멈추지 않아야 한다.
  //     reg.all() 만 순회하면 이런 소켓은 Session 이 없어 영원히 안 닫히고,
  //     업그레이드된 소켓이 http 서버의 연결 수에 잡혀 wss.close() 콜백이
  //     영영 호출되지 않는다.
  const silent = new WebSocket(`ws://127.0.0.1:${PORT}`);
  await new Promise<void>((res, rej) => {
    silent.once("open", () => res());
    silent.once("error", rej);
  });
  // (b) 살아 있는 세션이 있는 채로 닫아도 uncaughtException 이 나면 안 된다.
  //     (db.close() 뒤에 도착하는 소켓 close 이벤트가 닫힌 핸들을 만진다)
  // 기존 토큰으로 붙는다 — ⑫ 가 신규 생성 예산을 이미 다 썼고,
  // 여기서 확인하려는 것은 '살아 있는 세션을 둔 채로 닫기' 이지 생성이 아니다.
  const lively = new Client("lively");
  await lively.connect(bobToken);

  let uncaught: unknown = null;
  const onUncaught = (e: unknown) => (uncaught = e);
  process.once("uncaughtException", onUncaught);

  const closeRace = await Promise.race([
    server.close().then(() => "closed" as const),
    sleep(5000).then(() => "hung" as const),
  ]);
  check("hello 를 안 보낸 소켓이 있어도 종료가 완료된다", closeRace === "closed", String(closeRace));

  await sleep(300); // 소켓 close 이벤트가 도착할 시간
  process.removeListener("uncaughtException", onUncaught);
  check("살아 있는 세션을 두고 닫아도 uncaughtException 이 없다", uncaught === null,
    uncaught instanceof Error ? uncaught.message : String(uncaught));

  // ── 정리 ────────────────────────────────────────────────────────────
  alice.close();
  try {
    silent.terminate();
  } catch {
    /* 이미 닫힘 */
  }
  rmSync(DB, { force: true });
  rmSync(`${DB}-wal`, { force: true });
  rmSync(`${DB}-shm`, { force: true });

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} 검사 통과`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
