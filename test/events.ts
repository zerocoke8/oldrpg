/* 3단계 이벤트 재렌더링 테스트. CLAUDE.md 의 다섯 단계를 그 순서대로 검증한다.
 *
 *   1. 엔진이 플래그를 켠다
 *   2. 미리 써둔 문장을 즉시 브로드캐스트한다
 *   3. 그 플래그를 sensitive_flags 에 선언한 방'만' 큐에 넣는다
 *   4. 워커가 하나씩 재생성해 DB 에 기록한다
 *   5. 새 텍스트는 '다음 입장부터' 적용한다
 *
 * ★ 5번이 가장 틀리기 쉽다: 지금 그 방에 서 있는 플레이어의 화면을
 *   갈아치우면 안 된다 (charter 63줄). log.replace 가 오면 실패다. */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { boot } from "../server/index";
import { PROTOCOL_VERSION, type ServerMsg } from "../shared/protocol";
import type { RoomTextRequest } from "../shared/narration";
import type { Dir } from "../shared/ids";
import { SENSITIVE, REGION } from "../server/engine/map";

const PORT = 8904;
const DB = join(tmpdir(), `mud-events-${process.pid}.db`);

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

/** 생성된 문장에 '그때의 플래그 상태' 를 박아 둔다 — 옛 텍스트와 새 텍스트를
 *  눈으로 구별하기 위해서다. */
const fakeLlm = async (req: RoomTextRequest) => {
  await sleep(20);
  const on = req.flags.some(([k, v]) => k === "guardian_slain" && v === true);
  return {
    text: `[${on ? "이후" : "이전"}] ${req.seed}.`,
    source: "llm" as const,
    model: "fake",
    promptVersion: "room.v1.ko",
  };
};

class Client {
  ws!: WebSocket;
  inbox: ServerMsg[] = [];
  token: string | null = null;
  seq = 0;
  constructor(
    readonly label: string,
    readonly port: number = PORT,
  ) {}
  async connect(token: string | null = null): Promise<void> {
    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
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
  act(action: unknown): number {
    const seq = ++this.seq;
    this.ws.send(JSON.stringify({ t: "action", seq, action }));
    return seq;
  }
  move(dir: Dir): number {
    return this.act({ type: "move", dir });
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
  /** 목적지 방의 묘사가 도착할 때까지 이동한다. */
  async walk(dirs: Dir[]): Promise<void> {
    for (const d of dirs) {
      const seq = this.move(d);
      await this.until((m) => m.t === "ack" && m.seq === seq);
      await sleep(30);
    }
  }
  of<T extends ServerMsg["t"]>(t: T): Extract<ServerMsg, { t: T }>[] {
    return this.inbox.filter((m) => m.t === t) as Extract<ServerMsg, { t: T }>[];
  }
  logs(kind?: string): Extract<ServerMsg, { t: "log" }>[] {
    return this.of("log").filter((m) => !kind || m.kind === kind);
  }
  /** 클라이언트 리듀서와 '같은' 규칙으로 화면에 남는 최종 문장을 계산한다.
   *  log 만 보면 2단계의 log.replace 로 갈아끼워진 내용을 놓친다. */
  finalTextFor(logId: string): string | undefined {
    let text: string | undefined;
    for (const m of this.inbox) {
      if (m.t === "log" && m.id === logId) text = m.text;
      if (m.t === "log.replace" && m.id === logId) text = m.text;
    }
    return text;
  }
  /** 화면에 남아 있는 마지막 방 묘사. */
  lastNarr(): string | undefined {
    const last = this.logs("narr").at(-1);
    return last && this.finalTextFor(last.id);
  }
  clear(): void {
    this.inbox = [];
  }
  close(): void {
    this.ws.close();
  }
}

async function main() {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
  const server = boot(DB, PORT, { llm: "off", llmRenderer: fakeLlm, queue: { concurrency: 3 } });
  const ev = server.events;

  const AFFECTED = new Set(
    Object.entries(SENSITIVE)
      .filter(([, flags]) => flags.includes("guardian_slain"))
      .map(([k]) => `${REGION}:${k}`),
  );

  // ── 준비: Alice 는 영향받는 방으로, Bob 은 스폰에 남는다 ─────────────
  section("준비 — Alice 는 영향권(b1:1,4), Bob 은 비영향권(b1:3,3)");
  const alice = new Client("alice");
  const bob = new Client("bob");
  await alice.connect(null);
  await bob.connect(null);
  await alice.walk(["west", "west", "south"]); // (3,3)->(2,3)->(1,3)->(1,4)
  await sleep(150);
  const aliceRoom = alice.of("room.describe").at(-1)?.room.roomId;
  check("Alice 가 b1:1,4 에 있다", aliceRoom === "b1:1,4", String(aliceRoom));
  check("b1:1,4 는 guardian_slain 을 선언한 방이다", AFFECTED.has("b1:1,4"));
  check("b1:3,3 은 선언하지 않은 방이다", !AFFECTED.has("b1:3,3"));

  await server.upgrades.idle();
  await sleep(80);
  const beforeText = alice.lastNarr();
  check("Alice 화면의 묘사는 '이전' 상태로 확정돼 있다 (폴백 -> 승급 완료)",
    Boolean(beforeText?.startsWith("[이전]")), String(beforeText));
  const upgradedDuringSetup = alice.of("log.replace").length;
  check("그 확정은 2단계의 log.replace 로 이루어졌다", upgradedDuringSetup > 0,
    `${upgradedDuringSetup}건`);

  // ── 플래그를 켠다 ───────────────────────────────────────────────────
  section("① 엔진이 플래그를 켠다 / ② 미리 써둔 문장을 즉시");
  alice.clear();
  bob.clear();
  const t0 = Date.now();
  const res = ev.setFlag("guardian_slain", true);
  const sync = Date.now() - t0;
  check("setFlag 이 즉시 돌아온다 (재생성을 기다리지 않는다)", sync < 20, `${sync}ms`);
  check("값이 바뀌었다고 보고한다", res.changed);
  await sleep(60);

  const nearLine = alice.logs("world")[0];
  const farLine = bob.logs("world")[0];
  check("영향권의 Alice 는 near 문장을 받았다",
    nearLine?.text === "주변의 공기가 달라졌다. 지나온 길이 예전 같지 않을 것이다.",
    String(nearLine?.text));
  check("비영향권의 Bob 은 far 문장을 받았다",
    farLine?.text === "멀리서 무언가 무너지는 소리가 길게 이어지다 잦아든다.",
    String(farLine?.text));
  check("두 문장이 서로 다르다 (거리에 따라 다르게 들린다)",
    nearLine?.text !== farLine?.text);
  check("kind 는 'world' 다", nearLine?.kind === "world" && farLine?.kind === "world");
  check("보고된 near/far 수가 맞다", res.near === 1 && res.far === 1, JSON.stringify(res));

  // ── ★ 5번: 서 있는 사람의 화면을 갈아치우지 않는다 ──────────────────
  section("⑤ 지금 그 방에 서 있는 플레이어의 화면을 갈아치우지 않는다");
  check("★ Alice 에게 log.replace 가 오지 않았다 (charter 63줄)",
    alice.of("log.replace").length === 0,
    JSON.stringify(alice.of("log.replace")));
  check("Bob 에게도 오지 않았다", bob.of("log.replace").length === 0);
  check("새 방 묘사(log{narr})도 밀어 넣지 않았다",
    alice.logs("narr").length === 0, JSON.stringify(alice.logs("narr").map((l) => l.text)));
  check("room.describe 도 밀어 넣지 않았다", alice.of("room.describe").length === 0);

  // 구조화 상태는 간다 — 그건 '문장 교체' 가 아니다
  const flagEv = alice.of("world.flag")[0];
  check("world.flag 는 두 사람 모두에게 갔다",
    Boolean(flagEv) && bob.of("world.flag").length === 1);
  check("값과 라벨이 실려 있다 (라벨은 서버가 만든다)",
    flagEv?.flag.value === true && flagEv?.flag.label === "파수꾼 처치됨",
    JSON.stringify(flagEv?.flag));

  // ── ③ 영향 범위 ────────────────────────────────────────────────────
  section("③ 그 플래그를 선언한 방'만' 큐에 들어간다");
  check(`선언한 방 ${AFFECTED.size}개가 큐에 들어갔다`, res.queued === AFFECTED.size,
    `${res.queued} vs ${AFFECTED.size}`);
  check("전체 19개 방이 아니다 (2^n 폭발 방지의 이유)", res.queued < 19);

  // ── ④ 워커가 재생성해 DB 에 기록 ────────────────────────────────────
  section("④ 워커가 하나씩 재생성해 DB 에 기록한다");
  await server.upgrades.idle();
  await sleep(120);
  let regenerated = 0;
  for (const roomId of AFFECTED) {
    const row = server.ctx.q.getRoomTextRow.get(roomId, server.ctx.world.stateHash(roomId));
    if (row?.source === "llm" && row.text.startsWith("[이후]")) regenerated++;
  }
  check(`영향받은 ${AFFECTED.size}개 방이 전부 새 상태로 재생성됐다`,
    regenerated === AFFECTED.size, `${regenerated}/${AFFECTED.size}`);

  const untouched = server.ctx.q.getRoomTextRow.get("b1:3,3", server.ctx.world.stateHash("b1:3,3"));
  check("비영향권 방의 텍스트는 건드리지 않았다",
    Boolean(untouched?.text.startsWith("[이전]")), String(untouched?.text));

  // 규칙 3: 옛 텍스트는 덮어쓰이지 않고 '다른 행' 으로 남는다
  server.ctx.q.setFlag.run("guardian_slain", "false", Date.now());
  server.ctx.world.applyFlag("guardian_slain", "false");
  const oldRow = server.ctx.q.getRoomTextRow.get("b1:1,4", server.ctx.world.stateHash("b1:1,4"));
  check("★ 옛 상태의 텍스트가 그대로 살아 있다 (규칙 3: 고쳐 쓰지 않는다)",
    Boolean(oldRow?.text.startsWith("[이전]")), String(oldRow?.text));
  server.ctx.q.setFlag.run("guardian_slain", "true", Date.now());
  server.ctx.world.applyFlag("guardian_slain", "true");

  // ── ⑤ '다음 입장부터' 적용 ──────────────────────────────────────────
  section("⑤' 새 텍스트는 다음 입장부터 — 그리고 즉시(사전 생성됐으므로)");
  alice.clear();
  await alice.walk(["north"]); // (1,4) -> (1,3), 비영향권
  await sleep(60);
  alice.clear();
  await alice.walk(["south"]); // 다시 (1,4), 영향권 — '다음 입장'
  const reentry = await alice.until<Extract<ServerMsg, { t: "log" }>>(
    (m) => m.t === "log" && m.kind === "narr" && m.roomId === "b1:1,4",
  );
  check("다시 들어가니 '이후' 상태의 묘사가 나온다", reentry.text.startsWith("[이후]"),
    reentry.text);
  check("★ 폴백을 거치지 않고 '처음부터' 확정본이다 (사전 생성의 효과)",
    reentry.source === "llm", String(reentry.source));
  check("따라서 교체(log.replace)도 필요 없었다", alice.of("log.replace").length === 0);

  // 살펴보기는 '요청' 이므로 새 텍스트를 준다
  section("⑤'' 살펴보기는 요청이므로 새 텍스트를 준다");
  alice.clear();
  alice.act({ type: "look" });
  const looked = await alice.until<Extract<ServerMsg, { t: "log" }>>(
    (m) => m.t === "log" && m.kind === "narr",
  );
  check("look 은 지금 상태의 묘사를 준다", looked.text.startsWith("[이후]"), looked.text);

  // ── 재접속: 세계의 상태가 복원된다 ─────────────────────────────────
  section("⑥ 접속 전에 일어난 일도 스냅샷이 복원해 준다");
  const carol = new Client("carol");
  await carol.connect(null);
  const snap = carol.of("snapshot")[0]!;
  check("스냅샷이 월드 플래그를 싣는다", snap.world.length === 1, JSON.stringify(snap.world));
  check("값과 라벨이 맞다",
    snap.world[0]?.key === "guardian_slain" &&
      snap.world[0]?.value === true &&
      snap.world[0]?.label === "파수꾼 처치됨",
    JSON.stringify(snap.world[0]));
  check("Carol 은 이벤트 문장을 받지 않았다 (이미 지난 일이다)",
    carol.logs("world").length === 0);

  // ── 멱등성 / 검증 ──────────────────────────────────────────────────
  section("⑦ 같은 값으로 다시 켜면 아무 일도 없다");
  alice.clear();
  const again = ev.setFlag("guardian_slain", true);
  await sleep(50);
  check("changed=false", !again.changed);
  check("큐에도 넣지 않는다", again.queued === 0);
  check("문장도 보내지 않는다", alice.logs("world").length === 0);

  let threw = false;
  try {
    ev.setFlag("존재하지않는플래그", true);
  } catch {
    threw = true;
  }
  check("선언되지 않은 플래그는 거절한다", threw);

  // ── 되돌림 (charter 51줄) ──────────────────────────────────────────
  section("⑧ 플래그를 되돌리면 옛 텍스트가 그대로 복구된다");
  alice.clear();
  const back = ev.setFlag("guardian_slain", false);
  check("되돌림도 이벤트다", back.changed);
  await sleep(80);
  alice.clear();
  await alice.walk(["north"]);
  await sleep(50);
  alice.clear();
  await alice.walk(["south"]); // 다시 (1,4)
  const restored = await alice.until<Extract<ServerMsg, { t: "log" }>>(
    (m) => m.t === "log" && m.kind === "narr" && m.roomId === "b1:1,4",
  );
  check("★ 옛 텍스트가 그대로 복구됐다 (재생성이 아니라 캐시 히트)",
    restored.text.startsWith("[이전]") && restored.source === "llm",
    `${restored.source} ${restored.text}`);
  check("라벨도 내려갔다",
    alice.of("world.flag").at(-1)?.flag.label === null ||
      carol.of("world.flag").at(-1)?.flag.label === null);

  // ── ⑨ 가장 미묘한 인터리브 ──────────────────────────────────────────
  // 2단계 승급이 '진행 중' 인 방에서 플래그가 바뀌면?
  // 그 줄은 '들어갔을 때의 상태(S0)' 묘사이므로 S0 확정본으로 교체되는 것이
  // 맞다. 새 상태(S1) 텍스트로 갈아치우면 charter 63줄 위반이다.
  //
  // 앞 절들이 방들을 이미 생성해 뒀으므로 깨끗한 DB 로 따로 세운다.
  section("⑨ 승급이 진행 중인 방에서 플래그가 바뀌면");
  const DB2 = `${DB}.race`;
  for (const f of [DB2, `${DB2}-wal`, `${DB2}-shm`]) rmSync(f, { force: true });
  const slow = boot(DB2, PORT + 1, {
    llm: "off",
    llmRenderer: async (req) => {
      await sleep(400); // 플래그를 뒤집을 시간을 벌어 준다
      const on = req.flags.some(([k, v]) => k === "guardian_slain" && v === true);
      return {
        text: `[${on ? "이후" : "이전"}] ${req.seed}.`,
        source: "llm" as const,
        model: "fake",
        promptVersion: "room.v1.ko",
      };
    },
  });
  const dave = new Client("dave", PORT + 1);
  await dave.connect(null);
  await dave.walk(["west", "west", "south"]); // (3,3)->(2,3)->(1,3)->(1,4), 영향권
  const daveNarr = await dave.until<Extract<ServerMsg, { t: "log" }>>(
    (m) => m.t === "log" && m.kind === "narr" && m.roomId === "b1:1,4",
  );
  check("들어간 순간에는 폴백이다 (아직 생성 전)", daveNarr.source === "fallback",
    String(daveNarr.source));
  check("그 줄의 승급이 아직 진행 중이다", slow.upgrades.stats().running > 0,
    JSON.stringify(slow.upgrades.stats()));

  // 승급이 해소되기 '전에' 플래그를 뒤집는다
  slow.events.setFlag("guardian_slain", true);
  await slow.upgrades.idle();
  await sleep(150);

  const daveFinal = dave.finalTextFor(daveNarr.id);
  check("★ 그 줄은 '들어갔을 때의 상태' 로 확정된다 (새 상태로 갈아치우지 않는다)",
    Boolean(daveFinal?.startsWith("[이전]")), String(daveFinal));
  check("새 상태의 텍스트도 DB 에 준비되어 있다 (다음 입장용)",
    slow.ctx.q.getRoomTextRow.get("b1:1,4", slow.ctx.world.stateHash("b1:1,4"))
      ?.text.startsWith("[이후]") === true);

  // ★ 더 조용한 쪽의 피해: 행의 키(state_hash)와 내용이 어긋나는 것.
  // flags_json 이 곧 state_hash 의 preimage 이므로 둘은 반드시 일치해야 한다.
  // 어긋나면 플래그를 되돌렸을 때 '엉뚱한 문장' 이 복구된다.
  slow.ctx.q.setFlag.run("guardian_slain", "false", Date.now());
  slow.ctx.world.applyFlag("guardian_slain", "false");
  const offHash = slow.ctx.world.stateHash("b1:1,4");
  const offRow = slow.ctx.q.getRoomTextRow.get("b1:1,4", offHash);
  check("★ 옛 상태의 행은 옛 상태의 문장을 담고 있다 (캐시가 오염되지 않았다)",
    offRow?.text.startsWith("[이전]") === true, String(offRow?.text));
  check("행의 flags_json 이 그 행을 키잉한 preimage 와 일치한다",
    offRow?.flags_json === '{"guardian_slain":false}', String(offRow?.flags_json));
  const onRow = slow.ctx.q.getRoomTextRow.get(
    "b1:1,4",
    (slow.ctx.world.applyFlag("guardian_slain", "true"),
      slow.ctx.world.stateHash("b1:1,4")),
  );
  check("새 상태의 행도 마찬가지다",
    onRow?.text.startsWith("[이후]") === true &&
      onRow?.flags_json === '{"guardian_slain":true}',
    `${onRow?.text} / ${onRow?.flags_json}`);
  dave.close();
  await slow.close();
  for (const f of [DB2, `${DB2}-wal`, `${DB2}-shm`]) rmSync(f, { force: true });

  // ── 정리 ────────────────────────────────────────────────────────────
  for (const c of [alice, bob, carol]) c.close();
  await server.close();
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} 검사 통과`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
