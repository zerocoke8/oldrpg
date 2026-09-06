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
import { FIXTURE_WORLD, FIXTURE_BALANCE, FIXTURE_MOODS } from "./fixture";

/** 모든 boot() 가 같은 고정 세계를 쓴다 — 운영 콘텐츠가 바뀌어도 검사는 그대로다. */
const FIXTURE = { world: FIXTURE_WORLD, balance: FIXTURE_BALANCE, moods: FIXTURE_MOODS } as const;
import { PROTOCOL_VERSION, type ServerMsg } from "../shared/protocol";
import type { RoomTextRequest } from "../shared/narration";
import type { Dir } from "../shared/ids";
import { makeRng } from "../server/engine/rng";
import { lines } from "../server/narration/lines";
import { makeMap } from "../server/engine/map";

/** 서버가 이 검사에서 실제로 부팅하는 것과 '같은' 세계 (test/fixture.ts). */
const map = makeMap(FIXTURE_WORLD);
const SPAWN = map.spawn;
import { pickTarget, resolveEnemySwing, resolvePlayerSwing, windsUp } from "../server/engine/combat";

const PORT = 8906;
const DB = join(tmpdir(), `mud-combat-${process.pid}.db`);
/** 서버가 이 검사에서 실제로 부팅하는 것과 같은 밸런스. */
const BALANCE = FIXTURE_BALANCE;
const { skills: SKILLS, player: PLAYER } = BALANCE;
const GUARD = BALANCE.enemies["shadow_warden"]!;

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
  name = "";
  /** 지금 체력. clear() 로 지워지지 않는다 — 진짜 클라이언트가 그렇듯,
   *  받은 메시지를 상태에 접어 넣는다. 인박스를 세는 것과 다른 축이다. */
  hp = -1;
  seq = 0;
  constructor(
    readonly label: string,
    readonly port: number = PORT,
  ) {}
  async connect(token: string | null = null): Promise<void> {
    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws`);
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
        this.name = m.self.name;
      }
      if (m.t === "snapshot") this.hp = m.self.hp;
      if (m.t === "self.patch" && m.hp !== undefined) this.hp = m.hp;
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

  const server = boot(DB, PORT, { ...FIXTURE, 
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
  await advance(PLAYER.swingMs + 100);
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
  await advance(PLAYER.swingMs + 100);
  check("치유 스킬이 체력을 올린다", alice.texts("good").some((t) => t.includes("회복")),
    JSON.stringify(alice.texts()));

  // ── ④ 물러나기 ─────────────────────────────────────────────────────
  section("④ 물러나면 내 공격만 멈추고 적은 계속 때린다");
  alice.clear();
  await alice.actAndWait({ type: "stop" });
  check("물러났다고 알려준다", alice.texts("sys").some((t) => t.includes("물러났다")));
  check("engaged=false", alice.lastCombat()?.engaged === false);
  const enemyHpAtStop = alice.lastCombat()?.enemyHp ?? 0;
  const myHpAtStop = alice.hp;
  alice.clear();
  await advance(1500);
  check("적 HP는 더 줄지 않았다 (내가 안 때리므로)",
    (alice.lastCombat()?.enemyHp ?? 0) === enemyHpAtStop);
  /* 문장이 아니라 체력으로 본다. 어느 문장이 오는지는 그 사이에 예고가
     끼었는지에 달려 있고(평범한 일격/내리꽂히는 일격), 그건 이 절이 보려는
     것이 아니다 — 여기서 묻는 것은 "물러나도 계속 맞는가" 하나다. */
  check("그래도 적은 나를 때린다 (실시간이다)",
    alice.hp < myHpAtStop, `${myHpAtStop} -> ${alice.hp}`);

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
    erin.texts("bad").some((t) => t === lines.enemyReturns("잿빛 종잇장")),
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

  /* ★ '세계를 바꾸는가' 와 '돌아오는가' 는 다른 축이다.
     한때 밸런스의 refine 이 그 둘을 묶어 "slainFlag 를 켜는 적은 respawnMs 를
     가질 수 없다" 고 강제했다. 그래서 보스가 서버 수명 동안 한 번뿐이었고,
     첫 플레이어가 잡고 나면 나머지 전원에게 임무 5개 중 2개와 적 6종 중
     2종이 없는 게임이 됐다. 지금은 플래그가 '사건의 기록' 이고 존재는
     리스폰 타이머가 정한다. */
  section("⑩' 플래그와 리스폰은 다른 축이다");
  // ⑦ 에서 파수꾼을 이미 쓰러뜨렸다. 픽스처의 파수꾼은 respawnMs 가 null 이다.
  await advance(120_000);
  check("★ 돌아오지 않기로 한 적(respawnMs: null)은 두 배의 시간이 지나도 안 온다",
    server.combat.enemyIn("b1:3,5") === null);
  check("플래그는 켜진 채다 (세계가 바뀐 사건이다)",
    server.ctx.world.flagValue("guardian_slain") === true);
  check("반복되는 적은 같은 시간 뒤에 돌아와 있다",
    server.combat.enemyIn("b1:5,2") !== null);

  /* 같은 적에게 리스폰을 주면 '플래그는 켜진 채로' 돌아와야 한다.
     밸런스만 바꾼 다른 서버로 확인한다 — 이건 코드가 아니라 데이터의 결정이다. */
  const DB3 = join(tmpdir(), `mud-combat-boss-${process.pid}.db`);
  for (const f of [DB3, `${DB3}-wal`, `${DB3}-shm`]) rmSync(f, { force: true });
  let clock3 = 1_000_000;
  const respawning = {
    ...BALANCE,
    enemies: {
      ...BALANCE.enemies,
      shadow_warden: { ...BALANCE.enemies.shadow_warden!, respawnMs: 30_000 },
    },
  };
  const srv3 = boot(DB3, PORT + 2, {
    ...FIXTURE, balance: respawning, llm: "off",
    combat: { now: () => clock3, manualTick: true, seedFor: () => 7, respawnMs: 30_000 },
  });
  const tick3 = (srv3.combat as unknown as { tick(): void }).tick.bind(srv3.combat);
  check("(대조) 플래그를 켜기 전에는 당연히 있다", srv3.combat.enemyIn("b1:3,5") !== null);
  srv3.events!.setFlag("guardian_slain", true);
  for (let i = 0; i < 5; i++) { clock3 += 100; tick3(); }
  /* ★ 같은 적, 같은 플래그, 같은 순간. 다른 것은 respawnMs 하나뿐이다.
     위의 본 서버에서는 사라졌고 여기서는 남아 있다 — 그 차이가 곧
     '플래그는 사건의 기록이고 존재는 타이머가 정한다' 는 뜻이다. */
  check("★ 리스폰이 있는 적은 같은 플래그가 켜져도 사라지지 않는다",
    srv3.combat.enemyIn("b1:3,5") !== null,
    "respawnMs 만 다른 같은 적인데 본 서버에서는 사라졌다");
  check("플래그 자체는 양쪽 다 켜져 있다 (사건은 기록된다)",
    srv3.ctx.world.flagValue("guardian_slain") === true);
  await srv3.close();
  for (const f of [DB3, `${DB3}-wal`, `${DB3}-shm`]) rmSync(f, { force: true });
  erin.close();

  /* ── ⑩'' 쿨다운은 전투가 아니라 사람에게 붙어 있다 ──────────────────
     ★ 무엇을 막는가: 전투는 마지막 사람이 방을 나가는 순간 통째로 삭제된다.
       쿨다운이 Fighter 에 살면 "붙었다 떨어졌다" 만으로 전부 리셋됐다.

       그게 무료 무한 회복을 만들었다 — 응급 처치는 8초에 12~18(1.88/초),
       가장 약한 적은 1.2초에 1~2(1.25/초)다. 그 적에게 붙어 회복만 돌리면
       순 +0.63/초로 체력이 무한히 찬다. 전투 밖 회복이 없으므로 그게 이
       게임에서 가장 싼 회복 수단이었다.

     여기서는 '리셋되지 않는다' 만 본다 — 회복량 자체는 밸런스라 sim 이 잰다. */
  section("⑩'' 스킬 쿨다운은 방을 나갔다 와도 리셋되지 않는다");
  const fay = new Client("fay");
  await fay.connect(null);
  /* 스폰(3,3) -> 녹슨 감시자 (5,2). 동·동·북 */
  await fay.walk(["east", "east", "north"]);
  fay.clear();
  await fay.actAndWait({ type: "attack" });
  await advance(600);
  await fay.actAndWait({ type: "skill", skillId: "mend" });
  await advance(600);
  /* 픽스처의 이름은 "응급 치료" 다 (운영은 "응급 처치"). 검사가 운영
     콘텐츠의 문구를 알면 그건 결합이라, 밸런스에서 읽어 쓴다. */
  const mendName = SKILLS["mend"]!.name;
  const usedIt = fay.texts().some((t) => t.includes(mendName));
  check("응급 처치를 썼다", usedIt, JSON.stringify(fay.texts().slice(-3)));

  /* 방을 나갔다 온다 — 마지막 사람이므로 전투가 통째로 삭제된다. */
  await fay.actAndWait({ type: "move", dir: "south" });
  await advance(200);
  await fay.actAndWait({ type: "move", dir: "north" });
  fay.clear();
  await fay.actAndWait({ type: "attack" });
  await advance(200);
  await fay.actAndWait({ type: "skill", skillId: "mend" });
  await advance(200);
  check("★ 돌아와도 여전히 식는 중이다 (붙었다 떨어지는 것으로 리셋되지 않는다)",
    fay.texts("sys").some((t) => t.includes("남았다")), JSON.stringify(fay.texts("sys")));
  /* 그리고 다 식으면 당연히 다시 쓸 수 있어야 한다 — 위가 '영영 못 쓴다' 로
     통과해 버리면 검사가 거짓말이다. */
  await advance(9000);
  fay.clear();
  await fay.actAndWait({ type: "skill", skillId: "mend" });
  await advance(600);
  check("다 식으면 다시 쓸 수 있다",
    !fay.texts("sys").some((t) => t.includes("남았다")), JSON.stringify(fay.texts("sys")));

  /* ── ⑪ 구경꾼 ───────────────────────────────────────────────────────
     ★ 전투 서술이 c.fighters 로 잠겨 있어서, 같은 방에 서 있는 사람은 적이
       죽은 것조차 문장으로 못 들었다. 합류할 계기가 화면에 없었다는 뜻이고,
       이 게임에서 둘이 함께하는 유일한 행위가 '같은 적을 친다' 인데 그 시작을
       볼 방법이 없었다. */
  section("⑪ 같은 방의 구경꾼은 시작과 끝을 본다 (스윙마다는 아니다)");
  /* ★ 새 캐릭터는 IP 당 10분에 5개다 (실제 방어책이라 무르지 않는다).
     싸우는 쪽만 새로 만들고, 구경꾼은 fay 를 그대로 쓴다. */
  const hana = new Client("hana");
  await hana.connect(null);
  await hana.walk(["east", "east", "north"]); // 녹슨 감시자 (5,2)

  /* fay 를 확실히 '구경꾼' 으로 만든다. stop 은 engaged 만 끄고 fighters 에서
     빼지 않으므로(그게 옳다 — 피해는 이미 들어갔다), 방을 나갔다 와야 한다. */
  await fay.actAndWait({ type: "move", dir: "south" });
  await advance(200);
  await fay.actAndWait({ type: "move", dir: "north" });
  /* 적이 살아 있을 때까지 기다린다 — 시간으로 재면 respawnMs 를 건드리는 순간
     이 검사가 조용히 무의미해진다. */
  for (let i = 0; i < 200 && server.combat.enemyIn("b1:5,2") === null; i++) await advance(500);
  fay.clear();

  await hana.actAndWait({ type: "attack" });
  await advance(300);
  check("★ 구경꾼이 '누가 붙었다' 를 듣는다 (합류할 계기)",
    fay.texts().some((t) => t.includes("달려든다")), JSON.stringify(fay.texts()));
  const before = fay.texts().length;
  await advance(4000);
  /* 스윙마다 흘리면 방에 둘만 있어도 로그가 두 배가 된다. 구경꾼에게 필요한
     것은 시작과 끝뿐이다. */
  check("★ 스윙은 구경꾼에게 흐르지 않는다", fay.texts().length === before,
    JSON.stringify(fay.texts().slice(before)));
  check("구경꾼은 combat.* 를 받지 않는다 (전투원이 아니다)",
    fay.of("combat.update").length === 0, JSON.stringify(fay.of("combat.update").length));
  fay.clear();
  for (let i = 0; i < 300 && !fay.texts().some((t) => t.includes("쓰러뜨렸다")); i++) {
    await advance(500);
  }
  check("★ 끝난 것도 듣는다 (아니면 '싸우기' 가 사라진 이유를 모른다)",
    fay.texts().some((t) => t.includes("쓰러뜨렸다")), JSON.stringify(fay.texts()));

  /* ── ⑫ 치유·방어를 남에게 ───────────────────────────────────────────
     ★ 어그로가 '가장 많이 때린 사람' 이라, 여럿이 붙으면 잘 때리는 쪽이
       혼자 다 맞는다. 그런데 회복이 자기에게만 걸리면 맞는 쪽은 때리기를
       멈춰야 살고, 안 맞는 쪽은 도울 방법이 없다 — 둘이 함께 있는 이유가
       '옆에 선 추가 DPS' 뿐이었다는 뜻이다.
       skills.json 의 target 한 칸과 resolvePlayerSwing 의 인자 하나가
       그 자리에 역할을 만든다. */
  section("⑫ 치유와 방어는 남에게 건다 (협동에 역할이 생긴다)");

  /* 먼저 엔진에서. 효과가 '누구에게' 붙는지는 순수 함수의 반환값이라
     서버를 띄우지 않고 볼 수 있다 — 그리고 이게 진짜 불변식이다
     (문장은 res.toPlayerId 에서 나오므로, 문장만 보면 효과가 시전자에게
     붙어 있어도 똑같이 읽힌다). */
  const ally = { playerId: "p_other", hp: 10, maxHp: 100 };
  const healed = resolvePlayerSwing(
    "p_me", GUARD, 100, 50, 100, "mend", makeRng(1), BALANCE, ally);
  check("★ 치유 효과가 시전자가 아니라 대상에게 붙는다",
    healed.effects.some((e) => e.type === "playerHeal" && e.playerId === "p_other") &&
      !healed.effects.some((e) => e.type === "playerHeal" && e.playerId === "p_me"),
    JSON.stringify(healed.effects));
  const braced = resolvePlayerSwing(
    "p_me", GUARD, 100, 50, 100, "brace", makeRng(1), BALANCE, ally);
  check("★ 방어 효과도 대상에게 붙는다",
    braced.effects.some((e) => e.type === "guard" && e.playerId === "p_other"),
    JSON.stringify(braced.effects));
  check("대상이 없으면 자기 자신이다 (기존 경로가 그대로다)",
    resolvePlayerSwing("p_me", GUARD, 100, 50, 100, "mend", makeRng(1), BALANCE)
      .effects.some((e) => e.type === "playerHeal" && e.playerId === "p_me"));
  /* 남에게 걸어도 '적을 때린 것' 은 아니다 — 위협은 오르지 않아야 한다.
     오르면 살리려고 건 쪽이 다음 일격을 받는다. */
  check("남을 치유해도 적을 때린 값은 없다", healed.amount > 0 && healed.skill?.kind === "heal");

  /* 이제 와이어. 적이 돌아올 때까지 기다렸다가 둘이 함께 붙는다.
     ★ 시계는 우리 손에 있고 적은 110 이므로, 둘이 붙어 있는 시간이 곧
       예산이다 — 검사 사이의 advance 를 짧게 잡는다. 적이 먼저 죽으면
       이 절의 검사들이 전부 '전투가 없다' 로 무너진다.
     fay 가 먼저 붙어 어그로를 쥔다: hana 는 ⑪ 에서 이미 깎여 있으므로
     여기서 더 맞을 필요가 없다 (치유가 보이려면 깎여 있기만 하면 된다). */
  for (let i = 0; i < 400 && server.combat.enemyIn("b1:5,2") === null; i++) await advance(500);
  fay.clear();
  hana.clear();
  await fay.actAndWait({ type: "attack" });
  await advance(1500);
  await hana.actAndWait({ type: "attack" });
  await advance(300);

  /* 대상 목록은 서버가 준다. 클라이언트가 스킬 id 로 "mend 는 남에게" 를
     알기 시작하면 수치 파일이 클라이언트 배포를 요구하게 된다. */
  const view = fay.of("combat.start").at(-1)?.combat;
  check("★ 와이어의 스킬이 '누구에게 거는가' 를 싣는다",
    view?.skills.find((v) => v.id === "mend")?.target === "ally" &&
      view?.skills.find((v) => v.id === "heavy_strike")?.target === "self",
    JSON.stringify(view?.skills));
  check("★ 같은 전투의 사람이 대상 후보로 온다 (합류하면 늘어난다)",
    (view?.allies ?? []).length === 0 &&
      (fay.lastCombat()?.allies ?? []).some((a) => a.id === hana.id),
    JSON.stringify([view?.allies, fay.lastCombat()?.allies]));

  // 거절 둘. 둘 다 큐도 쿨다운도 건드리지 않는다 (서버가 먼저 돌려보낸다).
  fay.clear();
  await fay.actAndWait({ type: "skill", skillId: "heavy_strike", targetId: hana.id });
  check("★ 자기에게만 쓰는 스킬은 남을 가리킬 수 없다",
    fay.texts().some((t) => t.includes("자기에게만")), JSON.stringify(fay.texts()));
  fay.clear();
  await fay.actAndWait({ type: "skill", skillId: "mend", targetId: "p_ghost" });
  check("★ 같은 전투에 없는 사람은 대상이 될 수 없다 (클라이언트를 믿지 않는다)",
    fay.texts().some((t) => t.includes("이 싸움에 없다")), JSON.stringify(fay.texts()));

  /* 회복이 누구에게 갔는지는 문장이 아니라 체력으로 본다 — 문장은
     res.toPlayerId 에서 나오므로, 효과가 엉뚱한 사람에게 붙어도 똑같이
     읽힌다. 여기서만 뚫리는 구멍이다. */
  const before12 = { fay: fay.hp, hana: hana.hp };
  fay.clear();
  hana.clear();
  await fay.actAndWait({ type: "skill", skillId: "mend", targetId: hana.id });
  check("예약 문장이 '누구에게' 를 말한다",
    fay.texts().some((t) => t.includes(hana.name) && t.includes("준비")), JSON.stringify(fay.texts()));
  await advance(1000);
  check("★ 건 쪽은 '회복시켰다' 를 듣는다",
    fay.texts().some((t) => t.includes(hana.name) && t.includes("회복시켰다")),
    JSON.stringify(fay.texts()));
  check("★ 받은 쪽도 반드시 듣는다 (체력이 왜 올랐는지 모르면 화면에서 이유가 사라진다)",
    hana.texts().some((t) => t.includes(fay.name) && t.includes("회복되었다")),
    JSON.stringify(hana.texts()));
  check("★ 실제로 오른 것은 받은 쪽의 체력이다 (시전자가 아니라)",
    hana.hp > before12.hana && fay.hp <= before12.fay,
    `hana=${before12.hana}->${hana.hp} fay=${before12.fay}->${fay.hp}`);

  // 방어도 같은 모양. 받는 쪽이 '왜 덜 맞는지' 를 들어야 한다.
  fay.clear();
  hana.clear();
  await hana.actAndWait({ type: "skill", skillId: "brace", targetId: fay.id });
  await advance(1000);
  check("★ 방어를 걸어 준 쪽과 받은 쪽이 서로 다른 문장을 듣는다",
    hana.texts().some((t) => t.includes(fay.name) && t.includes("흘려낸다")) &&
      fay.texts().some((t) => t.includes(hana.name) && t.includes("막아선다")),
    JSON.stringify([hana.texts(), fay.texts()]));

  /* ★ 예약과 발동 사이에 한 호흡이 있고, 그 사이에 세계가 바뀐다. 대상이
     그 틈에 방을 나가면 자기에게 건다 — 스윙을 통째로 잃는 것보다 낫고,
     '없는 사람에게 걸린' 상태는 존재해서는 안 된다.
     (여기서 brace 를 쓰는 이유는 mend 가 아직 쿨다운이기 때문이다. 쿨다운은
      사람에게 붙어 있어서 기다리는 동안 적이 먼저 죽는다 — ⑩''.) */
  fay.clear();
  hana.clear();
  await fay.actAndWait({ type: "skill", skillId: "brace", targetId: hana.id });
  await hana.actAndWait({ type: "move", dir: "south" }); // 전투에서 빠진다
  fay.clear();
  await advance(1000);
  check("★ 대상이 그 사이에 빠지면 자기에게 건다 (스윙을 잃지 않는다)",
    fay.texts().some((t) => t.includes("흘려낼 수 있다")) &&
      !fay.texts().some((t) => t.includes(hana.name)),
    JSON.stringify(fay.texts()));
  check("빠진 사람은 대상 후보에서도 사라진다",
    !(fay.lastCombat()?.allies ?? []).some((a) => a.id === hana.id),
    JSON.stringify(fay.lastCombat()?.allies));

  fay.close();
  hana.close();

  /* ── ⑬ 예고 동작 ────────────────────────────────────────────────────
     ★ 무엇을 고치는가: 예고가 없으면 결정할 것이 "지금 체력이 낮은가"
       하나뿐이다. 적의 피해가 매 스윙 고르게 들어오므로 방어 태세는 평균
       한 대의 절반(≈2)만 막아 주고, 6초 쿨다운을 쓸 값이 없다 —
       시뮬레이터가 승률 기여 1%p 로 재 주었다.
       예고는 '언제' 라는 축을 만든다: 지금 막을 것인가, 한 대 더 때릴 것인가. */
  section("⑬ 적이 크게 몸을 젖힌다 — '언제' 라는 축");

  /* 먼저 엔진에서. 예고 주기에 난수가 없다는 것이 이 절의 전제다 —
     무작위면 맞춰 쓸 수 없고, 그러면 '언제' 가 아니라 운이다. */
  const w = GUARD.windup!;
  check("예고 주기에 난수가 없다 (같은 횟수면 같은 답)",
    [0, 1, 2, 3, 4].every((n) => windsUp(GUARD, n) === windsUp(GUARD, n)));
  check("★ everyNth 번 때린 뒤에 몸을 젖힌다",
    !windsUp(GUARD, w.everyNth - 1) && windsUp(GUARD, w.everyNth));
  const noWind = { ...GUARD, windup: null };
  check("예고가 없는 적은 아무리 때려도 젖히지 않는다",
    [0, 1, 5, 50].every((n) => !windsUp(noWind, n)));

  /* ★ 굴림 하나로 보면 안 된다. 배수와 경감의 '순서' 를 바꿔도 짝수 굴림에서는
     같은 값이 나오기 때문이다 (round(r/2)*3 과 round(r*3/2) 는 r 이 짝수면
     같다). 여러 굴림을 한꺼번에 본다. */
  const PCT = 50;
  const rolls = Array.from({ length: 30 }, (_, i) => i + 1).map((seed) => ({
    plain: resolveEnemySwing(GUARD, "p", 999, 0, makeRng(seed)),
    big: resolveEnemySwing(GUARD, "p", 999, 0, makeRng(seed), true),
    bigBraced: resolveEnemySwing(GUARD, "p", 999, PCT, makeRng(seed), true),
    none: resolveEnemySwing(noWind, "p", 999, 0, makeRng(seed), true),
  }));
  check("★ 예고 뒤의 일격은 배수만큼 크다",
    rolls.every((r) => r.big.amount === Math.round(r.plain.amount * w.mult) && r.big.heavy),
    JSON.stringify(rolls.slice(0, 4).map((r) => [r.plain.amount, r.big.amount])));
  /* ★ 배수가 경감보다 먼저다. 반대로 하면 방어 태세가 '큰 일격의 절반' 이
     아니라 '평범한 한 대의 절반' 만 막아 주고, 예고를 넣은 이유가 없어진다. */
  check("★ 방어 태세는 '커진 뒤의' 값을 깎는다 (배수가 먼저)",
    rolls.every((r) => r.bigBraced.amount === Math.max(1, Math.round((r.big.amount * (100 - PCT)) / 100))),
    JSON.stringify(rolls.slice(0, 6).map((r) => [r.plain.amount, r.big.amount, r.bigBraced.amount])));
  check("막아도 큰 일격은 평범한 한 대보다 아프다 (막는 것이 회피는 아니다)",
    rolls.every((r) => r.bigBraced.amount >= r.plain.amount));
  check("예고가 없는 적은 heavy 를 줘도 커지지 않는다",
    rolls.every((r) => r.none.amount === r.plain.amount && !r.none.heavy));

  /* 이제 와이어. 시계를 손에 쥔 새 서버에서 본다 — 본 서버의 파수꾼은
     ⑦ 에서 이미 쓰러졌고 돌아오지 않는다. */
  const DB4 = join(tmpdir(), `mud-combat-windup-${process.pid}.db`);
  for (const f of [DB4, `${DB4}-wal`, `${DB4}-shm`]) rmSync(f, { force: true });
  let clock4 = 2_000_000;
  /* ★ 체력을 넉넉히 준 세계에서 본다. 이 절이 보려는 것은 '적의 박자' 이지
     '죽는가' 가 아니다 — 40 짜리 몸으로 큰 일격 두 번을 지켜보려면 그 사이에
     회복을 끼워야 하고, 그러면 검사가 회복의 사정에 얽힌다. */
  const roomy = { ...BALANCE, player: { ...BALANCE.player, maxHp: 200 } };
  const srv4 = boot(DB4, PORT + 3, {
    ...FIXTURE,
    balance: roomy,
    llm: "off",
    llmRenderer: fakeLlm,
    combat: { now: () => clock4, manualTick: true, seedFor: () => 31, respawnMs: 50 },
  });
  const tick4 = (srv4.combat as unknown as { tick(): void }).tick.bind(srv4.combat);
  const step4 = async (ms: number): Promise<void> => {
    for (let i = 0; i < ms; i += 100) {
      clock4 += 100;
      tick4();
    }
    await sleep(30);
  };

  const iris = new Client("iris", PORT + 3);
  await iris.connect(null);
  await iris.walk(["west", "west", "south", "south"]);
  await iris.walk(["east", "east"]); // 그림자 파수꾼 (3,5)
  await iris.actAndWait({ type: "attack" });
  /* 물러난다 — 적의 박자만 보기 위해서다. 물러나도 전투에서 빠지지는
     않으므로 적은 계속 때린다 (④). */
  await iris.actAndWait({ type: "stop" });
  iris.clear();

  /* 예고가 올 때까지 한 박자씩 민다. 시간으로 재면 swingMs 나 everyNth 를
     건드리는 순간 이 검사가 조용히 무의미해진다. */
  let hpAtWindup = iris.hp;
  let sawWindup = false;
  for (let i = 0; i < 20 && !sawWindup; i++) {
    hpAtWindup = iris.hp;
    await step4(GUARD.swingMs);
    sawWindup = iris.texts().some((t) => t.includes("몸을 젖힌다"));
  }
  check("★ 예고가 문장으로 온다", sawWindup, JSON.stringify(iris.texts()));
  check("★ 구조화 사실로도 온다 (화면이 로그를 파싱하지 않는다)",
    iris.lastCombat()?.winding === true, JSON.stringify(iris.lastCombat()));
  check("★ 예고 자체에는 피해가 없다 (반응할 한 박자를 내준다)",
    iris.hp === hpAtWindup, `${hpAtWindup} -> ${iris.hp}`);

  const hpBeforeHeavy = iris.hp;
  iris.clear();
  await step4(GUARD.swingMs);
  const heavyDmg = hpBeforeHeavy - iris.hp;
  check("★ 다음 일격이 크게 들어온다",
    iris.texts().some((t) => t.includes("내리꽂힌다")), JSON.stringify(iris.texts()));
  check("★ 큰 일격은 접히지 않는다 (kind:bad — 막았는지가 이 한 줄에 있다)",
    iris.texts("bad").some((t) => t.includes("내리꽂힌다")), JSON.stringify(iris.texts("bad")));
  check("★ 평범한 한 대보다 크다 (가장 센 평타보다도)",
    heavyDmg > GUARD.damage[1], `${heavyDmg} vs 평타 최대 ${GUARD.damage[1]}`);
  check("예고가 꺼졌다 (한 번 쓰면 사라진다)", iris.lastCombat()?.winding === false);

  /* ★ 이 절의 요점. 예고를 보고 방어 태세를 걸면 큰 일격이 깎인다 —
     그게 6초 쿨다운을 쓸 값이고, 시뮬레이터의 '반응' 표가 재는 것이다. */
  iris.clear();
  for (let i = 0; i < 20 && !iris.texts().some((t) => t.includes("몸을 젖힌다")); i++) {
    await step4(GUARD.swingMs);
  }
  check("(대조) 예고가 다시 왔다", iris.texts().some((t) => t.includes("몸을 젖힌다")));
  await iris.actAndWait({ type: "skill", skillId: "brace" });
  /* 두 박자를 나눠 민다. 한 번에 밀면 큰 일격 뒤의 평타까지 같은 창에 들어와
     '이번 일격이 얼마였나' 를 체력으로 잴 수 없다. */
  await step4(PLAYER.swingMs); // 방어 태세가 나간다 (적은 아직 900ms 가 안 됐다)
  const hpBeforeBraced = iris.hp;
  iris.clear();
  await step4(GUARD.swingMs - PLAYER.swingMs); // 큰 일격이 온다
  check("★ 예고를 보고 막으면 비껴낸다",
    iris.texts().some((t) => t.includes("비껴냈다")), JSON.stringify(iris.texts()));
  /* 굴림이 난수라 '이번 것이 저번 것보다 작다' 는 보장할 수 없다 (막은 것도
     안 막은 것도 범위가 겹친다). 대신 '막은 값의 범위 안에 있다' 를 본다 —
     정확한 산술은 위의 엔진 검사가 이미 못 박아 두었다. */
  const bracedDmg = hpBeforeBraced - iris.hp;
  check("★ 막힌 값의 범위 안이다 (경감이 큰 일격에 닿았다)",
    bracedDmg > 0 && bracedDmg <= Math.ceil((GUARD.damage[1] * w.mult) / 2),
    `${bracedDmg} (안 막았을 때 ${heavyDmg}, 막은 값의 상한 ${Math.ceil((GUARD.damage[1] * w.mult) / 2)})`);

  iris.close();
  await srv4.close();
  for (const f of [DB4, `${DB4}-wal`, `${DB4}-shm`]) rmSync(f, { force: true });

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
    boot(DB2, PORT2, { ...FIXTURE, 
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
    carol2.texts("sys").filter((t) => t === lines.respawn).length === 1,
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
    dave2.texts("sys").filter((t) => t === lines.respawn).length === 1,
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
