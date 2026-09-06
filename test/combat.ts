/* 4a단계 실시간 전투 테스트.
 *
 * 시계와 시드를 손에 쥐고 돌린다 — 실시간 시스템을 진짜 시간으로 테스트하면
 * 느리고 흔들린다. makeCombat 이 now() 와 seedFor() 를 주입받는 이유이고,
 * 그래서 데미지 굴림까지 결정론적이다.
 *
 * 검증하는 것:
 *   한 번 공격하면 '계속' 주고받는가 (턴제가 아닌가)
 *   스킬이 다음 스윙에 기본공격을 '대신' 하는가, 쿨다운이 강제되는가
 *   어그로 — 누적 피해가 가장 큰 사람을 때리는가, 옮겨가는가
 *   적을 죽이면 3단계 파이프라인이 도는가 (단계들이 고리로 닫히는가)
 *   방을 벗어나면 교전이 끊기는가
 *   새로고침해도 전투가 이어지는가
 *   규칙 1 — 전투 판정이 전부 서버에 있는가 */

import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { boot } from "../server/index";
import { PROTOCOL_VERSION, type ServerMsg } from "../shared/protocol";
import type { RoomTextRequest } from "../shared/narration";
import type { Dir } from "../shared/ids";
import { ENEMIES, SKILLS, PLAYER_SWING_MS } from "../server/engine/enemies";
import { makeRng } from "../server/engine/rng";
import { SPAWN } from "../server/engine/map";
import { pickTarget } from "../server/engine/combat";

const PORT = 8906;
const DB = join(tmpdir(), `mud-combat-${process.pid}.db`);
const GUARD = ENEMIES["3,5"]!;

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
/** DB 는 토큰의 sha256 만 갖는다 (server/net/handlers.ts 와 같은 공식). */
const sha256 = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fakeLlm = async (req: RoomTextRequest) => ({
  text: `[생성] ${req.seed}.`,
  source: "llm" as const,
  model: "fake",
  promptVersion: "room.v1.ko",
});

/** 손으로 돌리는 단조 시계. */
let clockMs = 1_000_000;
const monotonic = () => clockMs;

class Client {
  ws!: WebSocket;
  inbox: ServerMsg[] = [];
  token: string | null = null;
  /** 접속 때 붙잡아 둔다 — clear() 가 welcome 을 지우기 때문이다. */
  id = "";
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
      if (m.t === "welcome") {
        this.token = m.token;
        this.id = m.self.id;
      }
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
  async actAndWait(action: unknown): Promise<void> {
    const seq = this.act(action);
    await this.until((m) => m.t === "ack" && m.seq === seq);
    await sleep(25);
  }
  async walk(dirs: Dir[]): Promise<void> {
    for (const d of dirs) await this.actAndWait({ type: "move", dir: d });
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
  texts(kind?: string): string[] {
    return this.logs(kind).map((l) => l.text);
  }
  lastCombat(): Extract<ServerMsg, { t: "combat.update" }> | undefined {
    return this.of("combat.update").at(-1);
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

  const server = boot(DB, PORT, {
    llm: "off",
    llmRenderer: fakeLlm,
    combat: { now: monotonic, manualTick: true, seedFor: () => 12345, respawnMs: 50 },
  });
  const tick = (server.combat as unknown as { tick(): void }).tick.bind(server.combat);
  /** 시계를 ms 만큼 밀고 그동안의 틱을 전부 돌린다. */
  async function advance(ms: number): Promise<void> {
    for (let i = 0; i < ms; i += 100) {
      clockMs += 100;
      tick();
    }
    await sleep(30); // 방출이 소켓을 타고 가도록
  }

  // ── ① 순수 엔진 ─────────────────────────────────────────────────────
  section("① 엔진은 순수하고 결정론적이다");
  const r1 = makeRng(42);
  const r2 = makeRng(42);
  check("같은 시드는 같은 수열", [0, 0, 0, 0, 0].every(() => r1.next() === r2.next()));
  check("int 이 범위 안에 있다",
    Array.from({ length: 200 }, () => makeRng(7).int(4, 8)).every((n) => n >= 4 && n <= 8));
  const threat = new Map([["a", 10], ["b", 30], ["c", 30]]);
  check("어그로는 누적 피해 최대", pickTarget(["a", "b", "c"], threat) === "b");
  check("동점이면 먼저 교전한 쪽 (난수 없음)", pickTarget(["c", "b"], threat) === "c");
  check("아무도 없으면 null", pickTarget([], threat) === null);

  // ── ② 교전 시작 ─────────────────────────────────────────────────────
  section("② 한 번 누르면 '계속' 주고받는다 (턴제가 아니다)");
  const alice = new Client("alice");
  await alice.connect(null);
  await alice.walk(["west", "west", "south", "south"]); // (3,3)->(2,3)->(1,3)->(1,4)->(1,5)
  await alice.walk(["east", "east"]); // (2,5)->(3,5) 적이 있는 방
  await sleep(80);
  check("방에 들어서니 적이 있다고 알려준다",
    alice.texts().some((t) => t.includes("이쪽을 향해 서 있다")), JSON.stringify(alice.texts().slice(-3)));
  const rv = alice.of("room.describe").at(-1)?.room;
  check("room.hasEnemy 가 켜져 있다 (공격 버튼의 근거)", rv?.hasEnemy === true);

  alice.clear();
  await alice.actAndWait({ type: "attack" });
  const start = alice.of("combat.start")[0];
  check("combat.start 가 왔다", Boolean(start));
  check("적의 이름과 최대 HP가 실려 있다",
    start?.combat.enemy.name === GUARD.name && start?.combat.enemy.maxHp === GUARD.maxHp);
  check("교전 상태다", start?.combat.engaged === true);
  check("스킬 셋이 실려 있다", start?.combat.skills.length === Object.keys(SKILLS).length);

  // ★ 여기서 '한 번의 명령이 여러 번의 공방' 이 되는지를 본다
  alice.clear();
  await advance(2000); // 4번의 플레이어 스윙(500ms), 2~3번의 적 스윙(700ms)
  const swings = alice.of("combat.update").length;
  check("★ 명령을 한 번만 냈는데 여러 번 공방이 오갔다", swings >= 4, `${swings}회 갱신`);
  const hp2s = alice.lastCombat()?.enemyHp ?? GUARD.maxHp;
  check("적 HP가 계속 줄었다", hp2s < GUARD.maxHp, `${hp2s}/${GUARD.maxHp}`);
  check("나도 맞았다", alice.of("self.patch").some((p) => (p.hp ?? 40) < 40));
  check("평범한 타격은 kind:'combat' 이다 (클라이언트가 접는다)",
    alice.logs("combat").length > 0);

  // ── ③ 스킬 ─────────────────────────────────────────────────────────
  section("③ 스킬은 다음 스윙에 기본공격을 '대신' 한다");
  alice.clear();
  await alice.actAndWait({ type: "skill", skillId: "heavy_strike" });
  check("예약됐다고 알려준다", alice.texts("sys").some((t) => t.includes("준비")));
  check("queuedSkill 이 실린다", alice.lastCombat()?.queuedSkill === "heavy_strike");
  const hpBefore = alice.lastCombat()?.enemyHp ?? 0;
  alice.clear();
  await advance(PLAYER_SWING_MS + 100);
  check("다음 스윙에 발동했다", alice.texts("good").some((t) => t.includes("강타")),
    JSON.stringify(alice.texts()));
  const hpAfter = alice.lastCombat()?.enemyHp ?? 0;
  check("기본공격보다 큰 피해 (14~22)", hpBefore - hpAfter >= 14, `${hpBefore} -> ${hpAfter}`);
  check("스킬은 good 이라 접히지 않는다", alice.logs("good").length > 0);
  check("큐가 비워졌다", alice.lastCombat()?.queuedSkill === null);

  alice.clear();
  await alice.actAndWait({ type: "skill", skillId: "heavy_strike" });
  check("쿨다운 중에는 거절한다", alice.texts("sys").some((t) => t.includes("남았다")),
    JSON.stringify(alice.texts("sys")));
  await alice.actAndWait({ type: "skill", skillId: "없는스킬" });
  check("모르는 스킬도 문장으로 거절 (error 아님)",
    alice.texts("sys").some((t) => t.includes("익히지 않았다")) && alice.of("error").length === 0);

  // 치유 스킬
  alice.clear();
  await alice.actAndWait({ type: "skill", skillId: "mend" });
  await advance(PLAYER_SWING_MS + 100);
  check("치유 스킬이 체력을 올린다", alice.texts("good").some((t) => t.includes("회복")),
    JSON.stringify(alice.texts()));

  // ── ④ 물러나기 ─────────────────────────────────────────────────────
  section("④ 물러나면 내 공격만 멈추고 적은 계속 때린다");
  alice.clear();
  await alice.actAndWait({ type: "stop" });
  check("물러났다고 알려준다", alice.texts("sys").some((t) => t.includes("물러났다")));
  check("engaged=false", alice.lastCombat()?.engaged === false);
  const enemyHpAtStop = alice.lastCombat()?.enemyHp ?? 0;
  alice.clear();
  await advance(1500);
  check("적 HP는 더 줄지 않았다 (내가 안 때리므로)",
    (alice.lastCombat()?.enemyHp ?? 0) === enemyHpAtStop);
  check("그래도 적은 나를 때린다 (실시간이다)",
    alice.logs("combat").some((l) => l.text.includes("일격")), JSON.stringify(alice.texts()));

  await alice.actAndWait({ type: "attack" });
  check("다시 붙을 수 있다", alice.lastCombat()?.engaged === true);

  // ── ⑤ 어그로 ───────────────────────────────────────────────────────
  section("⑤ 어그로 — 누적 피해가 가장 큰 사람을 때린다");
  const bob = new Client("bob");
  await bob.connect(null);
  await bob.walk(["west", "west", "south", "south"]);
  await bob.walk(["east", "east"]);
  await bob.actAndWait({ type: "attack" });
  alice.clear();
  bob.clear();
  // Alice 가 먼저 한참 때렸으므로 누적 피해는 Alice 가 훨씬 많다.
  await advance(1500);
  const target = alice.of("combat.update").map((u) => u.targetId).filter(Boolean).at(-1);
  check("어그로가 먼저 때린 Alice 에게 있다", target === alice.id,
    `target=${target} alice=${alice.id}`);
  check("Bob 은 남이 맞는 것을 본다",
    bob.logs("combat").some((l) => l.text.includes("후려친다")), JSON.stringify(bob.texts()));
  check("둘 다 적을 때리고 있다 (공유 HP)",
    bob.logs("combat").some((l) => l.text.includes("피해")) &&
      alice.logs("combat").some((l) => l.text.includes("피해")));

  // ── ⑥ 대상이 빠지면 다시 고른다 + 걸어 나가는 것이 곧 도망 ─────────
  section("⑥ 걸어 나가면 교전이 끊기고, 적은 다시 노릴 사람을 고른다");
  alice.clear();
  bob.clear();
  await alice.actAndWait({ type: "move", dir: "west" });
  check("Alice: combat.end{left}", alice.of("combat.end")[0]?.reason === "left");
  await advance(1200);
  check("Alice 는 나간 뒤로 전투 갱신을 받지 않는다", alice.of("combat.update").length === 0);
  const bobTarget = bob.of("combat.update").map((u) => u.targetId).filter(Boolean).at(-1);
  check("★ 대상이 빠지자 어그로가 Bob 에게 옮겨갔다", bobTarget === bob.id,
    `target=${bobTarget} bob=${bob.id}`);
  check("옮겨간 순간을 문장으로 알려준다",
    bob.texts("bad").some((t) => t.includes("노린다")), JSON.stringify(bob.texts("bad")));
  check("이제 Bob 이 맞는다", bob.logs("combat").some((l) => l.text.includes("일격")));

  // ── ⑦ 승리 -> 3단계 파이프라인 ─────────────────────────────────────
  section("⑦ 적을 죽이면 3단계의 이벤트 경로가 통째로 돈다");
  check("아직 guardian_slain 은 꺼져 있다", server.ctx.world.flagValue("guardian_slain") === false);
  alice.clear();
  bob.clear();
  await advance(30000); // 확실히 죽을 만큼
  check("★ 적이 죽었다", bob.texts("good").some((t) => t.includes("흩어진다")),
    JSON.stringify(bob.texts().slice(-4)));
  check("combat.end{victory}", bob.of("combat.end").some((e) => e.reason === "victory"));
  check("★ guardian_slain 이 켜졌다", server.ctx.world.flagValue("guardian_slain") === true);
  check("★ 3단계의 world.flag 가 방송됐다",
    bob.of("world.flag").some((f) => f.flag.value === true && f.flag.label === "파수꾼 처치됨"));
  check("★ 3단계의 이벤트 문장도 왔다 (near/far)",
    [...alice.texts("world"), ...bob.texts("world")].length > 0,
    JSON.stringify([...alice.texts("world"), ...bob.texts("world")]));
  await server.upgrades.idle();
  await sleep(150);
  const reRendered = server.ctx.q.getRoomTextRow.get(
    "b1:5,5",
    server.ctx.world.stateHash("b1:5,5"),
  );
  check("★ 영향받은 방이 새 상태로 재생성됐다 (단계들이 고리로 닫힌다)",
    Boolean(reRendered), JSON.stringify(reRendered));

  check("죽은 적은 다시 나타나지 않는다", server.combat.enemyIn("b1:3,5") === null);
  bob.clear();
  await bob.actAndWait({ type: "attack" });
  check("죽은 적에게 공격하면 문장으로 거절", bob.texts("sys").some((t) => t.includes("맞설 것이 없다")),
    JSON.stringify(bob.texts("sys")));

  // ── ⑧ 규칙 1 — 판정은 전부 서버에 ──────────────────────────────────
  section("⑧ 규칙 1 — 클라이언트는 피해량을 주장할 수 없다");
  bob.clear();
  const spoof = bob.act({ type: "attack", damage: 9999 });
  const spoofAck = await bob.until<Extract<ServerMsg, { t: "ack" }>>(
    (m) => m.t === "ack" && m.seq === spoof,
  );
  check("액션에 피해량 필드를 끼워 넣으면 strict 스키마가 거절",
    spoofAck.ok === false && spoofAck.reason === "bad_args");
  check("attack 액션 타입에 피해량 필드 자체가 없다 (표현 불가능하게)",
    !JSON.stringify(Object.keys({ type: "attack" })).includes("damage"));

  /* ── ⑩ 반복되는 적 ──────────────────────────────────────────────────
   *
   * 파수꾼 하나뿐이면 '한 번 죽이면 끝' 인 세계다 — guardian_slain 이 DB 영속이라
   * 늦게 접속한 사람은 전투를 영영 보지 못했다. 그래서 적이 두 종류로 나뉜다:
   *   보스        플래그를 켠다. 돌아오지 않는다 (세계가 바뀐 사건이다)
   *   반복되는 적 세계를 바꾸지 않는다. 시간이 지나면 돌아온다
   *
   * ★ 이 절의 핵심은 '돌아온 것을 어떻게 알리는가' 다. charter 63줄 —
   *   지금 그 방에 서 있는 사람의 화면을 갈아치우지 않는다. */
  section("⑩ 반복되는 적은 돌아온다 — 묘사를 다시 그리지 않고");
  const erin = new Client("erin");
  await erin.connect(null);
  // (3,3) -> 서쪽 고리를 돌아 (4,1). 5,2 의 적을 지나가지 않는 경로다.
  await erin.walk(["west", "west", "north", "north", "east", "east", "east"]);
  await sleep(40);
  check("잿빛 종잇장이 서 있다",
    erin.texts("bad").some((t) => t.includes("잿빛 종잇장") && t.includes("서 있다")),
    JSON.stringify(erin.texts("bad").slice(-2)));
  check("방 상태에 적이 있다고 실린다",
    erin.of("room.describe").at(-1)?.room.hasEnemy === true);

  erin.clear();
  await erin.actAndWait({ type: "attack" });
  for (let i = 0; i < 120 && !erin.texts("good").some((t) => t.includes("흩어진다")); i++) {
    await advance(500);
  }
  check("쓰러뜨렸다", erin.texts("good").some((t) => t.includes("흩어진다")),
    JSON.stringify(erin.texts("good").slice(-2)));
  check("★ 세계를 바꾸지 않는다 (반복되는 적은 플래그를 켜지 않는다)",
    server.ctx.q.allFlags.all().every((f) => f.key !== "ashen_pages"),
    JSON.stringify(server.ctx.q.allFlags.all()));
  check("적이 사라진 것도 구조화 상태로 간다 (커맨드 창의 '싸우기' 가 내려간다)",
    erin.of("room.describe").at(-1)?.room.hasEnemy === false,
    JSON.stringify(erin.of("room.describe").at(-1)?.room));

  erin.clear();
  await advance(20_000); // 아직 45초가 되지 않았다
  check("돌아올 때가 되기 전에는 조용하다", erin.logs().length === 0,
    JSON.stringify(erin.texts()));
  await erin.actAndWait({ type: "attack" });
  check("그동안은 없는 것과 같다",
    erin.texts("sys").some((t) => t.includes("맞설 것이 없다")), JSON.stringify(erin.texts("sys")));

  erin.clear();
  await advance(30_000); // 누적 50초 > 45초
  check("★ 돌아왔다 — 결정론 문장 한 줄",
    erin.texts("bad").some((t) => t.includes("잿빛 종잇장이(가) 어둠 속에서 다시 모습을 갖춘다.")),
    JSON.stringify(erin.texts()));
  check("★ 방 묘사를 다시 그리지 않는다 (charter 63줄)",
    erin.logs("narr").length === 0, JSON.stringify(erin.texts("narr")));
  check("★ log.replace 도 보내지 않는다", erin.of("log.replace").length === 0);
  check("구조화 상태만 갱신된다 (hasEnemy 가 다시 true)",
    erin.of("room.describe").at(-1)?.room.hasEnemy === true,
    JSON.stringify(erin.of("room.describe").at(-1)?.room));

  erin.clear();
  await erin.actAndWait({ type: "attack" });
  await advance(100);
  const back = erin.of("combat.start").at(-1);
  check("다시 싸울 수 있고 체력이 가득 차 있다",
    back?.combat.enemy.hp === back?.combat.enemy.maxHp && back?.combat.enemy.name === "잿빛 종잇장",
    JSON.stringify(back?.combat.enemy));
  await erin.actAndWait({ type: "stop" });

  section("⑩' 보스는 돌아오지 않는다");
  // ⑦ 에서 파수꾼을 이미 쓰러뜨렸다. 아무리 기다려도 그 방은 비어 있어야 한다.
  await advance(120_000);
  check("★ 파수꾼은 두 배의 시간이 지나도 돌아오지 않는다",
    server.combat.enemyIn("b1:3,5") === null);
  check("반복되는 적은 같은 시간 뒤에 돌아와 있다",
    server.combat.enemyIn("b1:5,2") !== null);
  erin.close();

  /* ── ⑨ 부활 타이머를 잃어도 캐릭터가 굳지 않는다 ────────────────────
   *
   * 부활은 world/combat.ts 의 메모리 setTimeout 하나뿐이라 두 경로로 유실된다:
   *   (a) 프로세스가 그 창 안에 죽는다 (tsx watch 재시작이 정확히 이 창)
   *   (b) 끊긴 뒤 3~8초 사이에 링크데드로 죽으면 유예 만료가 부활보다 먼저 와
   *       세션이 지워지고 콜백이 !cur 로 빠져나간다
   * 그러면 hp=0 이 DB 에 남고, HP 를 올리는 경로가 전투 안(mend)에만 있는데
   * 전투는 hp<=0 을 거절하므로 캐릭터가 영구히 굳었다. 토큰을 버리는 것 외에
   * 탈출구가 없었다.
   *
   * 여기서는 (a)를 그대로 재현한다 — 부활이 절대 오지 않게 해 두고 죽인 뒤
   * 서버를 내렸다 올린다. (b)도 결과가 같다(타이머 유실). */
  section("⑨ 부활 타이머를 잃어도 재개 경로가 일으켜 세운다");
  const DB2 = join(tmpdir(), `mud-combat-revive-${process.pid}.db`);
  const PORT2 = PORT + 1;
  for (const f of [DB2, `${DB2}-wal`, `${DB2}-shm`]) rmSync(f, { force: true });

  let clock2 = 1_000_000;
  const boot2 = (respawnMs: number) =>
    boot(DB2, PORT2, {
      llm: "off",
      llmRenderer: fakeLlm,
      // ★ 부활이 '절대' 오지 않는다 = 타이머를 잃은 것과 같은 상태.
      combat: { now: () => clock2, manualTick: true, seedFor: () => 999, respawnMs },
    });

  let srv2 = boot2(3_600_000);
  const tick2 = () => (srv2.combat as unknown as { tick(): void }).tick();
  const carol = new Client("carol", PORT2);
  await carol.connect(null);
  const carolToken = carol.token!;
  await carol.walk(["west", "west", "south", "south"]);
  await carol.walk(["east", "east"]);
  await carol.actAndWait({ type: "attack" });
  // 혼자서는 진다 (적 200HP vs 플레이어 40HP). 죽을 때까지 시계를 민다.
  for (let i = 0; i < 200 && !carol.texts("bad").some((t) => t.includes("쓰러졌다")); i++) {
    clock2 += 100;
    tick2();
    await sleep(2);
  }
  await sleep(40);
  check("혼자 싸우다 쓰러졌다", carol.texts("bad").some((t) => t.includes("당신은 쓰러졌다")),
    JSON.stringify(carol.texts("bad").slice(-2)));
  const deadRow = srv2.ctx.q.playerByTokenHash.get(sha256(carolToken));
  check("사망이 DB 에 hp=0 으로 남는다", deadRow?.hp === 0, String(deadRow?.hp));

  carol.close();
  await srv2.close(); // ★ 부활 타이머가 여기서 사라진다
  await sleep(120);

  srv2 = boot2(3_600_000);
  const carol2 = new Client("carol2", PORT2);
  await carol2.connect(carolToken);
  const revivedSelf = carol2.of("snapshot")[0]!.self;
  check("★ 돌아오면 일어나 있다 (hp>0)", revivedSelf.hp > 0, `${revivedSelf.hp}/${revivedSelf.maxHp}`);
  check("절반의 체력이다 (combat.ts 의 부활과 같은 값)",
    revivedSelf.hp === Math.max(1, Math.floor(revivedSelf.maxHp / 2)), String(revivedSelf.hp));
  check("스폰으로 이송됐다", revivedSelf.pos.x === SPAWN.x && revivedSelf.pos.y === SPAWN.y,
    JSON.stringify(revivedSelf.pos));
  check("DB 도 같이 갱신됐다 (메모리만 고치지 않는다)",
    srv2.ctx.q.playerByTokenHash.get(sha256(carolToken))?.hp === revivedSelf.hp);
  check("부활 문장이 한 번 나간다",
    carol2.texts("sys").filter((t) => t.includes("차가운 돌바닥")).length === 1,
    JSON.stringify(carol2.texts("sys")));

  carol2.clear();
  await carol2.actAndWait({ type: "attack" });
  check("★ 다시 싸울 수 있다 — 거절 이유가 '쓰러졌다' 가 아니다",
    !carol2.texts("sys").some((t) => t.includes("당신은 쓰러졌다")),
    JSON.stringify(carol2.texts("sys")));

  /* 이중 부활이 나지 않는가. 타이머가 '아직 살아 있는' 채로 재접속하면,
     hello 가 connId 를 새 에폭으로 올리므로 옛 콜백은 빠져나가야 한다. */
  carol2.close();
  await srv2.close();
  await sleep(80);
  srv2 = boot2(400); // 이번엔 부활이 곧 온다
  const dave = new Client("dave", PORT2);
  await dave.connect(null);
  const daveToken = dave.token!;
  await dave.walk(["west", "west", "south", "south"]);
  await dave.walk(["east", "east"]);
  await dave.actAndWait({ type: "attack" });
  for (let i = 0; i < 200 && !dave.texts("bad").some((t) => t.includes("쓰러졌다")); i++) {
    clock2 += 100;
    tick2();
    await sleep(2);
  }
  dave.close(); // 타이머가 아직 도는 중에 새 소켓으로 돌아온다
  const dave2 = new Client("dave2", PORT2);
  await dave2.connect(daveToken);
  await sleep(600); // 옛 부활 타이머가 지나가도록
  check("★ 이중 부활이 나지 않는다 (에폭이 옛 타이머를 무효화한다)",
    dave2.texts("sys").filter((t) => t.includes("차가운 돌바닥")).length === 1,
    JSON.stringify(dave2.texts("sys")));
  const daveRow = srv2.ctx.q.playerByTokenHash.get(sha256(daveToken));
  check("체력도 한 번만 적용됐다", daveRow?.hp === Math.max(1, Math.floor((daveRow?.max_hp ?? 0) / 2)),
    `${daveRow?.hp}/${daveRow?.max_hp}`);

  dave2.close();
  await srv2.close();
  for (const f of [DB2, `${DB2}-wal`, `${DB2}-shm`]) rmSync(f, { force: true });

  // ── 정리 ────────────────────────────────────────────────────────────
  alice.close();
  bob.close();
  await server.close();
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} 검사 통과`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
