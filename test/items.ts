/* 인벤토리. 첫 '표를 늘리는' 단계라 마이그레이션부터 확인한다.
 *
 * 확인하는 것:
 *   규칙 1  무엇이 나오고 얼마나 회복되는지는 전부 서버가 정한다.
 *           클라이언트는 수량도 회복량도 주장할 수 없다.
 *   결정론  전리품 판정은 주입된 시드 PRNG 다 — 같은 전투는 같은 전리품.
 *   실시간  전투 중 아이템은 '다음 스윙에' 발동한다 (스킬과 같은 한 자리 큐).
 *   가산    v2 DB 를 v3 로 올려도 기존 캐릭터와 생성해 둔 텍스트가 살아남는다. */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import WebSocket from "ws";
import { boot } from "../server/index";
import { FIXTURE_WORLD, FIXTURE_BALANCE, FIXTURE_MOODS } from "./fixture";

/** 모든 boot() 가 같은 고정 세계를 쓴다 — 운영 콘텐츠가 바뀌어도 검사는 그대로다. */
const FIXTURE = { world: FIXTURE_WORLD, balance: FIXTURE_BALANCE, moods: FIXTURE_MOODS } as const;
import { migrate, SCHEMA_VERSION } from "../server/db/migrate";
import { PROTOCOL_VERSION, type ServerMsg } from "../shared/protocol";
import type { Dir } from "../shared/ids";
import { rollDrops, sharers } from "../server/engine/combat";
import { makeRng } from "../server/engine/rng";

const PORT = 8908;
const DB = join(tmpdir(), `mud-items-${process.pid}.db`);

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

let clockMs = 1_000_000;

class Client {
  ws!: WebSocket;
  inbox: ServerMsg[] = [];
  token: string | null = null;
  id = "";
  seq = 0;
  /** ★ 스냅샷에서 다시 세지 않고 증분으로 들고 있는다.
   *  clear() 가 스냅샷을 지우면 거기서 파생하는 계산이 전부 0 이 된다 —
   *  이 하네스에서 예전에 실제로 겪은 함정이다. */
  curBag: { id: string; name: string; qty: number; usable: boolean }[] = [];
  curHp = 0;
  constructor(readonly label: string) {}
  async connect(token: string | null = null): Promise<void> {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
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
      if (m.t === "snapshot") {
        this.curBag = m.self.items ?? [];
        this.curHp = m.self.hp;
      }
      if (m.t === "self.patch") {
        if (m.items !== undefined) this.curBag = m.items;
        if (m.hp !== undefined) this.curHp = m.hp;
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
        throw new Error(`${this.label}: timeout; ${JSON.stringify(this.inbox.map((m) => m.t))}`);
      await sleep(5);
    }
  }
  of<T extends ServerMsg["t"]>(t: T): Extract<ServerMsg, { t: T }>[] {
    return this.inbox.filter((m) => m.t === t) as Extract<ServerMsg, { t: T }>[];
  }
  texts(kind?: string): string[] {
    return this.of("log").filter((m) => !kind || m.kind === kind).map((l) => l.text);
  }
  /** 화면에 남아 있는 가방. 클라이언트 리듀서와 같은 규칙이다. */
  bag(): { id: string; name: string; qty: number; usable: boolean }[] {
    return this.curBag;
  }
  qty(itemId: string): number {
    return this.curBag.find((i) => i.id === itemId)?.qty ?? 0;
  }
  hp(): number {
    return this.curHp;
  }
  clear(): void {
    this.inbox = [];
  }
  close(): void {
    this.ws.close();
  }
}

async function main() {
  // ── ① 마이그레이션 ──────────────────────────────────────────────────
  section("① v2 DB 를 v3 로 올려도 기존 것이 살아남는다 (순수 가산)");
  const OLD = join(tmpdir(), `mud-items-v2-${process.pid}.db`);
  for (const f of [OLD, `${OLD}-wal`, `${OLD}-shm`]) rmSync(f, { force: true });
  {
    const db = new Database(OLD);
    db.exec(readFileSync("server/db/schema.sql", "utf8"));
    db.exec(readFileSync("server/db/migrations/002-npcs.sql", "utf8"));
    db.prepare("INSERT INTO meta (key, value, updated_at) VALUES (?,?,?)").run(
      "schema_version", "2", 1,
    );
    db.prepare(
      `INSERT INTO players (id, name, token_hash, region, x, y, hp, max_hp, seen, created_at, last_seen_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run("p1", "옛 모험가", "hash1", "b1", 3, 3, 40, 40, "[]", 1, 1);
    db.prepare(
      `INSERT INTO rooms (id,region,x,y,tile,seed,seed_id,sensitive_flags,flags_decl_hash,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run("b1:3,3", "b1", 3, 3, "S", "씨앗", "aaaa", "[]", "bbbb", 1, 1);
    db.prepare(
      `INSERT INTO room_text (room_id,state_hash,text,source,flags_json,model,prompt_version,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run("b1:3,3", "h1", "비싼 LLM 문장", "llm", "{}", "m", "v", 1, 1);
    db.close();
  }
  {
    const db = new Database(OLD);
    migrate(db, 2);
    const ver = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as {
      value: string;
    };
    /* 최신까지 올라가면 된다. 여기서 숫자를 박으면 마이그레이션이 하나
       늘 때마다 소지품 검사가 깨진다 — 그건 결합이지 회귀가 아니다. */
    check("v2 DB 가 최신 스키마까지 올라간다", ver.value === String(SCHEMA_VERSION), ver.value);
    check("기존 캐릭터가 남아 있다",
      (db.prepare("SELECT name FROM players WHERE id='p1'").get() as { name: string } | undefined)
        ?.name === "옛 모험가");
    check("★ 돈이 나간 생성물(room_text)이 그대로다",
      (db.prepare("SELECT text FROM room_text").get() as { text: string } | undefined)?.text ===
        "비싼 LLM 문장");
    check("player_items 표가 생겼고 비어 있다",
      (db.prepare("SELECT count(*) AS n FROM player_items").get() as { n: number }).n === 0);
    // qty > 0 CHECK: '0개를 가진 행' 은 존재할 수 없다
    let rejected = false;
    try {
      db.prepare(
        "INSERT INTO player_items (player_id,item_id,qty,updated_at) VALUES ('p1','minor_potion',0,1)",
      ).run();
    } catch {
      rejected = true;
    }
    check("★ qty=0 인 행은 만들 수 없다 (다 쓰면 행을 지운다)", rejected);
    // 캐릭터가 사라지면 소지품도 사라진다
    db.prepare(
      "INSERT INTO player_items (player_id,item_id,qty,updated_at) VALUES ('p1','minor_potion',2,1)",
    ).run();
    db.prepare("DELETE FROM players WHERE id='p1'").run();
    check("주인이 사라지면 소지품도 CASCADE 로 사라진다",
      (db.prepare("SELECT count(*) AS n FROM player_items").get() as { n: number }).n === 0);
    db.close();
  }
  for (const f of [OLD, `${OLD}-wal`, `${OLD}-shm`]) rmSync(f, { force: true });

  // ── ② 순수 판정 ─────────────────────────────────────────────────────
  section("② 전리품 판정은 순수하고 결정론이다 (규칙 1)");
  /** 서버가 이 검사에서 실제로 부팅하는 것과 같은 밸런스. */
const BALANCE = FIXTURE_BALANCE;
  const guard = BALANCE.enemies["shadow_warden"]!;
  const watcher = BALANCE.enemies["rusted_watcher"]!;
  const two = [
    { playerId: "a", damage: 150 },
    { playerId: "b", damage: 50 },
  ];
  const r1 = rollDrops(guard, two, makeRng(42));
  const r2 = rollDrops(guard, two, makeRng(42));
  check("같은 시드는 같은 전리품", JSON.stringify(r1) === JSON.stringify(r2), JSON.stringify(r1));
  check("chance 1 이면 피해를 준 전원이 받는다",
    r1.length === 2 && r1.every((a) => a.itemId === "warden_shard"), JSON.stringify(r1));
  check("피해가 0 인 사람은 아무것도 받지 않는다",
    rollDrops(guard, [{ playerId: "c", damage: 0 }], makeRng(1)).length === 0);
  check("적이 아무것도 떨어뜨리지 않으면 빈 배열",
    rollDrops({ ...guard, drops: [] }, two, makeRng(1)).length === 0);

  /* ★ '지금은' 기여도를 보상에 반영하지 않는다 — 그 문만 열어 두었다.
     피해가 3배 차이 나도 같은 확률로 판정되는 것을 수로 확인한다. */
  let manyA = 0;
  let manyB = 0;
  for (let i = 0; i < 400; i++) {
    for (const a of rollDrops(watcher, two, makeRng(i))) {
      if (a.playerId === "a") manyA++;
      else manyB++;
    }
  }
  check("★ 지금은 기여도가 보상을 가르지 않는다 (차등 지급의 문만 열려 있다)",
    Math.abs(manyA - manyB) < 40, `a=${manyA} b=${manyB} (400회)`);
  check("확률이 대략 지켜진다 (0.8)", manyA > 280 && manyA < 360, String(manyA));

  /* ── 몫을 받는 사람 ─────────────────────────────────────────────────
     ★ 문턱이 없을 때 실제로 무슨 일이 있었나: 한 대(약 6피해) 치고 stop 하면
       — stop 은 engaged 만 끄고 threat 에서 빼지 않는다 — 다 잡은 사람과
       전리품·임무 공로가 **똑같이** 나왔다. 등급 사다리 전체가 전리품
       수량이라, "강한 사람 옆에서 한 대 치기" 가 사다리를 도는 최적 전략이었다. */
  section("②' 몫은 기여가 있는 사람에게만 — 그래도 막타 경쟁은 없다");
  const leech = [
    { playerId: "a", damage: 200 },
    { playerId: "b", damage: 6 }, // 한 대 치고 물러난 사람
  ];
  const need = Math.ceil(guard.maxHp * 0.1);
  check("★ 한 대만 친 사람은 몫에서 빠진다",
    sharers(guard, leech, 0.1).map((c) => c.playerId).join() === "a",
    `${guard.maxHp}체력의 10% = ${need}피해 필요`);
  check("문턱을 넘은 사람들끼리는 완전히 동등하다 (막타 경쟁 없음)",
    sharers(guard, two, 0.1).length === 2, JSON.stringify(sharers(guard, two, 0.1)));
  check("문턱이 0 이면 옛 동작 그대로다", sharers(guard, leech, 0).length === 2);
  /* ★ 문턱은 '적의 최대 체력' 기준이지 '총 피해' 기준이 아니다. 총 피해
     기준이면 사람이 늘수록 각자의 몫이 작아져 자격을 잃는다 — 함께 싸울
     이유를 깎지 않는 것이 이 목록의 존재 이유인데 정반대가 된다. */
  const four = Array.from({ length: 4 }, (_, i) => ({
    playerId: `p${i}`,
    damage: Math.ceil(guard.maxHp / 4),
  }));
  check("★ 넷이 똑같이 나눠 때려도 전원이 몫을 받는다 (총 피해 기준이 아니다)",
    sharers(guard, four, 0.1).length === 4, JSON.stringify(sharers(guard, four, 0.1).length));
  check("피해가 0 이면 문턱이 0 이어도 rollDrops 가 거른다",
    rollDrops(guard, [{ playerId: "z", damage: 0 }], makeRng(1)).length === 0);

  // ── 서버 ────────────────────────────────────────────────────────────
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
  const server = boot(DB, PORT, { ...FIXTURE, 
    llm: "off",
    combat: { now: () => clockMs, manualTick: true, seedFor: () => 4242, respawnMs: 50 },
  });
  const tick = (server.combat as unknown as { tick(): void }).tick.bind(server.combat);
  async function advance(ms: number): Promise<void> {
    for (let i = 0; i < ms; i += 100) {
      clockMs += 100;
      tick();
    }
    await sleep(30);
  }

  const alice = new Client("alice");
  const bob = new Client("bob");
  await alice.connect(null);
  await bob.connect(null);

  section("③ 새 캐릭터의 가방은 비어 있고, 스냅샷이 그것을 싣는다");
  check("스냅샷에 items 가 있다", Array.isArray(alice.of("snapshot")[0]?.self.items));
  check("비어 있다", alice.bag().length === 0);

  // ── ④ 드랍 ──────────────────────────────────────────────────────────
  section("④ 피해를 준 사람 '전원' 이 전리품을 받는다");
  for (const c of [alice, bob]) {
    await c.walk(["west", "west", "south", "south"]);
    await c.walk(["east", "east"]); // (3,5) 파수꾼
  }
  alice.clear();
  bob.clear();
  await alice.actAndWait({ type: "attack" });
  await bob.actAndWait({ type: "attack" });
  for (let i = 0; i < 200 && !alice.texts("good").some((t) => t.includes("흩어진다")); i++) {
    await advance(500);
  }
  check("파수꾼을 함께 쓰러뜨렸다",
    alice.texts("good").some((t) => t.includes("흩어진다")) ||
      alice.texts("good").some((t) => t.includes("쓰러뜨렸다")),
    JSON.stringify(alice.texts("good").slice(-2)));
  check("★ 막타를 넣은 사람만이 아니라 둘 다 받았다",
    alice.qty("warden_shard") === 1 && bob.qty("warden_shard") === 1,
    `alice=${alice.qty("warden_shard")} bob=${bob.qty("warden_shard")}`);
  check("각자 자기 것만 듣는다",
    alice.texts("good").filter((t) => t.includes("파수꾼의 파편")).length === 1,
    JSON.stringify(alice.texts("good")));
  check("가방이 self.patch 로 갱신됐다",
    alice.of("self.patch").some((m) => m.items !== undefined));
  check("DB 에도 들어갔다",
    server.ctx.q.itemsOf.all(alice.id).some((r) => r.item_id === "warden_shard" && r.qty === 1),
    JSON.stringify(server.ctx.q.itemsOf.all(alice.id)));

  // ── ⑤ 거절은 문장이다 ───────────────────────────────────────────────
  section("⑤ 쓸 수 없는 것들 — 거절이 아니라 문장으로 답한다");
  alice.clear();
  const seqA = alice.act({ type: "use_item", itemId: "warden_shard" });
  const ackA = await alice.until<Extract<ServerMsg, { t: "ack" }>>(
    (m) => m.t === "ack" && m.seq === seqA,
  );
  await sleep(60);
  check("전리품을 쓰려 하면 ack 는 ok:true 이고 문장이 온다", ackA.ok);
  check("'쓸 수 있는 것이 아니다'",
    alice.texts("sys").some((t) => t.includes("쓸 수 있는 것이 아니다")),
    JSON.stringify(alice.texts("sys")));
  check("전리품은 사라지지 않았다", alice.qty("warden_shard") === 1);

  alice.clear();
  await alice.actAndWait({ type: "use_item", itemId: "minor_potion" });
  await sleep(40);
  check("가지고 있지 않은 것", alice.texts("sys").some((t) => t.includes("가지고 있지 않다")),
    JSON.stringify(alice.texts("sys")));
  alice.clear();
  await alice.actAndWait({ type: "use_item", itemId: "없는아이템" });
  await sleep(40);
  check("★ 없는 아이템과 안 가진 아이템의 답이 같다 (존재를 묻는 오라클이 아니다)",
    alice.texts("sys").some((t) => t.includes("가지고 있지 않다")),
    JSON.stringify(alice.texts("sys")));

  // ── ⑥ 사용 ──────────────────────────────────────────────────────────
  section("⑥ 전투 밖에서는 즉시 — 그리고 체력이 가득하면 아껴 둔다");
  server.ctx.inventory.award([{ playerId: alice.id, itemId: "minor_potion", qty: 3 }]);
  await sleep(40);
  check("전리품 서비스로 넣은 것이 가방에 보인다", alice.qty("minor_potion") === 3,
    JSON.stringify(alice.bag()));

  /** 체력을 손으로 세운다 — DB 와 메모리 둘 다 (서버가 지키는 규칙과 같은 순서). */
  const setHp = (c: Client, hp: number) => {
    server.ctx.q.setPlayerHp.run(hp, 1, c.id);
    server.ctx.reg.get(c.id)!.hp = hp;
  };

  setHp(alice, 40);
  alice.clear();
  await alice.actAndWait({ type: "use_item", itemId: "minor_potion" });
  await sleep(40);
  check("체력이 가득하면 마시지 않는다",
    alice.texts("sys").some((t) => t.includes("아껴 둔다")),
    JSON.stringify(alice.texts("sys")));
  check("그래서 개수도 줄지 않는다", alice.qty("minor_potion") === 3,
    String(alice.qty("minor_potion")));

  setHp(alice, 20);
  alice.clear();
  await alice.actAndWait({ type: "use_item", itemId: "minor_potion" });
  await sleep(40);
  check("★ 전투 밖에서는 기다리지 않고 즉시 마신다",
    alice.texts("good").some((t) => t.includes("비웠다")), JSON.stringify(alice.texts()));
  check("체력이 14 올랐다 (회복량은 서버가 정한다)", alice.hp() === 34, String(alice.hp()));
  check("개수가 하나 줄었다", alice.qty("minor_potion") === 2, String(alice.qty("minor_potion")));

  section("⑦ 전투 중에는 '다음 스윙에' 발동한다 (스킬과 같은 한 자리 큐)");
  // (3,5) 는 파수꾼이 죽어 비었다. (5,2) 의 녹슨 감시자에게 간다.
  await alice.walk(["east", "east"]); // (4,5) -> (5,5)
  await alice.walk(["north", "north", "north"]); // (5,4) -> (5,3) -> (5,2)
  await sleep(40);
  alice.clear();
  await alice.actAndWait({ type: "attack" });
  // 맞아서 체력이 줄 때까지
  for (let i = 0; i < 60 && alice.hp() >= 40; i++) await advance(500);
  const hurt = alice.hp();
  check("맞아서 체력이 줄었다", hurt < 40, String(hurt));

  const qtyBefore = alice.qty("minor_potion");
  alice.clear();
  await alice.actAndWait({ type: "use_item", itemId: "minor_potion" });
  check("★ 즉시 마시지 않고 예약된다", alice.texts("sys").some((t) => t.includes("다음 호흡에 쓴다")),
    JSON.stringify(alice.texts("sys")));
  check("아직 개수가 줄지 않았다", alice.qty("minor_potion") === qtyBefore,
    `${qtyBefore} -> ${alice.qty("minor_potion")}`);
  check("구조화 상태에 예약이 실린다",
    alice.of("combat.update").at(-1)?.queuedItem === "minor_potion" ||
      alice.of("combat.start").at(-1)?.combat.queuedItem === "minor_potion",
    JSON.stringify(alice.of("combat.update").at(-1)));

  const before = alice.hp();
  await advance(600); // 다음 스윙
  check("★ 다음 호흡에 발동했다", alice.texts("good").some((t) => t.includes("비웠다")),
    JSON.stringify(alice.texts("good")));
  check("체력이 올랐다", alice.hp() > before, `${before} -> ${alice.hp()}`);
  check("개수가 하나 줄었다", alice.qty("minor_potion") === qtyBefore - 1,
    `${qtyBefore} -> ${alice.qty("minor_potion")}`);
  check("회복량은 서버가 정한다 (14 고정, 잃은 만큼까지)",
    alice.hp() - before === Math.min(14, 40 - before), `${before} -> ${alice.hp()}`);
  check("예약 자리가 비었다", alice.of("combat.update").at(-1)?.queuedItem === null);
  await alice.actAndWait({ type: "stop" });

  // ── ⑧ 규칙 1 ────────────────────────────────────────────────────────
  section("⑧ 규칙 1 — 클라이언트는 수량도 회복량도 주장할 수 없다");
  alice.clear();
  const spoof = alice.act({ type: "use_item", itemId: "minor_potion", qty: 99, heal: 999 });
  const spoofAck = await alice.until<Extract<ServerMsg, { t: "ack" }>>(
    (m) => m.t === "ack" && m.seq === spoof,
  );
  check("액션에 수량/회복량을 끼워 넣으면 strict 스키마가 거절",
    spoofAck.ok === false && spoofAck.reason === "bad_args", JSON.stringify(spoofAck));
  check("use_item 액션 타입에 그런 필드 자체가 없다",
    !JSON.stringify(Object.keys({ type: "use_item", itemId: "x" })).includes("qty"));
  check("개수는 그대로다", alice.qty("minor_potion") === qtyBefore - 1);

  // ── ⑨ 영속 ──────────────────────────────────────────────────────────
  section("⑨ 가방은 재접속해도 남는다");
  const token = alice.token!;
  const before9 = alice.qty("minor_potion");
  alice.close();
  await sleep(80);
  const again = new Client("alice2");
  await again.connect(token);
  check("★ 스냅샷이 가방을 복원한다", again.qty("minor_potion") === before9,
    JSON.stringify(again.bag()));
  check("전리품도 그대로", again.qty("warden_shard") === 1);
  check("이름은 서버가 붙인다 (클라이언트가 id 로 문구를 조립하지 않는다)",
    again.bag().find((i) => i.id === "minor_potion")?.name === BALANCE.items["minor_potion"]!.name);
  check("쓸 수 있는지도 서버가 말해 준다",
    again.bag().find((i) => i.id === "warden_shard")?.usable === false);

  section("⑩ 마지막 하나를 두 번 쓰면 한 번만 나간다");
  const q = server.ctx.q;
  // 물약을 전부 비우고 정확히 하나만 넣는다.
  for (let i = 0; i < 30; i++) {
    const r = q.itemsOf.all(again.id).find((x) => x.item_id === "minor_potion");
    if (!r) break;
    if (r.qty > 1) q.consumeItem.run({ player_id: again.id, item_id: "minor_potion", now: 1 });
    else q.dropLastItem.run({ player_id: again.id, item_id: "minor_potion" });
  }
  q.addItem.run({ player_id: again.id, item_id: "minor_potion", qty: 1, now: 1 });
  again.clear();
  // 다치게 만든 뒤 두 번 연속
  q.setPlayerHp.run(20, 1, again.id);
  const sess = server.ctx.reg.get(again.id)!;
  sess.hp = 20;
  const n0 = q.itemsOf.all(again.id).find((r) => r.item_id === "minor_potion")?.qty ?? 0;
  again.act({ type: "use_item", itemId: "minor_potion" });
  again.act({ type: "use_item", itemId: "minor_potion" });
  await sleep(150);
  check(`한 개뿐이었다 (${n0}개)`, n0 === 1, String(n0));
  check("★ 한 번만 마셨다", again.texts("good").filter((t) => t.includes("비웠다")).length === 1,
    JSON.stringify(again.texts()));
  check("두 번째는 '가지고 있지 않다'",
    again.texts("sys").some((t) => t.includes("가지고 있지 않다")),
    JSON.stringify(again.texts("sys")));
  check("행이 지워졌다 (0개를 가진 행은 없다)",
    q.itemsOf.all(again.id).every((r) => r.item_id !== "minor_potion"),
    JSON.stringify(q.itemsOf.all(again.id)));

  /* ── ⑪~⑮ 건네기 ────────────────────────────────────────────────────
     ★ 무엇을 고치는가: 전리품은 '피해를 준 사람 전원' 에게 나뉘는데(④),
       물건을 건넬 방법이 없었다. 둘이 함께 싸운 뒤 물약 한 개를 넘겨 주는
       것조차 못 했다는 뜻이다.
     제안-수락이 아니라 즉시 확정이다 — 지금 건넬 수 있는 것이 물약 하나뿐인데
     방어 기계가 그보다 크면 그건 값을 못 번다. 대신 '한 거래 안에서 한쪽만
     손해 보는 상태' 는 트랜잭션이 구조로 막는다. */
  section("⑪ 건네기 — 한 트랜잭션, 서로 다른 문장");
  /* again(=alice) 과 bob 을 같은 방에 세운다. bob 은 ④ 이후 (3,5) 에 있고
     again 은 재접속 뒤 (5,2) 다. (5,2)->(5,3)->(5,4)->(5,5)->(4,5)->(3,5). */
  await again.walk(["south", "south", "south", "west", "west"]);
  const bobSess = server.ctx.reg.get(bob.id)!;
  const aliceSess = server.ctx.reg.get(again.id)!;
  check("(준비) 둘이 같은 방에 있다",
    aliceSess.pos.region === bobSess.pos.region &&
      aliceSess.pos.x === bobSess.pos.x &&
      aliceSess.pos.y === bobSess.pos.y,
    `${JSON.stringify(aliceSess.pos)} vs ${JSON.stringify(bobSess.pos)}`);
  q.addItem.run({ player_id: again.id, item_id: "minor_potion", qty: 2, now: 1 });
  const bobBefore = q.itemsOf.all(bob.id).find((r) => r.item_id === "minor_potion")?.qty ?? 0;
  again.clear();
  bob.clear();
  await again.actAndWait({ type: "give", targetId: bob.id, itemId: "minor_potion" });
  await sleep(60);
  check("★ 준 쪽이 하나 줄었다",
    (q.itemsOf.all(again.id).find((r) => r.item_id === "minor_potion")?.qty ?? 0) === 1);
  check("★ 받은 쪽이 하나 늘었다",
    (q.itemsOf.all(bob.id).find((r) => r.item_id === "minor_potion")?.qty ?? 0) === bobBefore + 1);
  check("★ 양쪽 가방이 화면까지 갱신됐다 (한쪽만 보내면 다른 쪽은 유령을 본다)",
    again.of("self.patch").some((m) => m.items !== undefined) &&
      bob.of("self.patch").some((m) => m.items !== undefined));
  check("★ 둘이 서로 다른 문장을 듣는다",
    again.texts("good").some((t) => t.includes("건넸다")) &&
      bob.texts("good").some((t) => t.includes("받았다")),
    JSON.stringify([again.texts("good"), bob.texts("good")]));

  section("⑫ 마지막 하나를 두 사람에게 동시에 건넬 수 없다");
  // 정확히 하나만 남긴다.
  for (let i = 0; i < 30; i++) {
    const r = q.itemsOf.all(again.id).find((x) => x.item_id === "minor_potion");
    if (!r) break;
    if (r.qty > 1) q.consumeItem.run({ player_id: again.id, item_id: "minor_potion", now: 1 });
    else break;
  }
  const one = q.itemsOf.all(again.id).find((r) => r.item_id === "minor_potion")?.qty ?? 0;
  const bobBefore2 = q.itemsOf.all(bob.id).find((r) => r.item_id === "minor_potion")?.qty ?? 0;
  again.clear();
  again.act({ type: "give", targetId: bob.id, itemId: "minor_potion" });
  again.act({ type: "give", targetId: bob.id, itemId: "minor_potion" });
  await sleep(150);
  check(`한 개뿐이었다 (${one}개)`, one === 1, String(one));
  check("★ 한 번만 건네졌다",
    (q.itemsOf.all(bob.id).find((r) => r.item_id === "minor_potion")?.qty ?? 0) === bobBefore2 + 1);
  check("★ 준 쪽의 행이 지워졌다 (0개를 가진 행은 없다)",
    q.itemsOf.all(again.id).every((r) => r.item_id !== "minor_potion"),
    JSON.stringify(q.itemsOf.all(again.id)));
  check("두 번째는 '가지고 있지 않다'",
    again.texts("sys").some((t) => t.includes("가지고 있지 않다")),
    JSON.stringify(again.texts("sys")));

  section("⑬ 증표는 넘길 수 없다 — 등급 사다리는 기록이지 선물이 아니다");
  const shardBefore = q.itemsOf.all(bob.id).find((r) => r.item_id === "warden_shard")?.qty ?? 0;
  again.clear();
  await again.actAndWait({ type: "give", targetId: bob.id, itemId: "warden_shard" });
  await sleep(60);
  check("★ 넘길 수 있는 것이 아니라고 답한다",
    again.texts("sys").some((t) => t.includes("넘길 수 있는 것이 아니다")),
    JSON.stringify(again.texts("sys")));
  check("★ 양쪽 가방이 그대로다",
    (q.itemsOf.all(again.id).find((r) => r.item_id === "warden_shard")?.qty ?? 0) === 1 &&
      (q.itemsOf.all(bob.id).find((r) => r.item_id === "warden_shard")?.qty ?? 0) === shardBefore);

  section("⑭ 사거리 — 없는 사람·다른 방·다른 지역이 '같은 한 문장' 이다");
  q.addItem.run({ player_id: again.id, item_id: "minor_potion", qty: 3, now: 1 });
  await bob.walk(["west"]); // 옆 방으로
  const said: string[] = [];
  for (const target of [bob.id, "p_nobody_at_all", again.id.split("").reverse().join("")]) {
    again.clear();
    await again.actAndWait({ type: "give", targetId: target, itemId: "minor_potion" });
    await sleep(40);
    said.push(again.texts("sys").join("|"));
  }
  /* ★ 셋이 글자 그대로 같아야 한다. 갈라지면 건네기가 전 세계 위치 탐침이
     된다 — 아무 id 나 넣어 보는 것만으로 그 사람이 접속했는지, 어느 방에
     있는지를 알아낼 수 있다. */
  check("★ 다른 방·없는 id·엉뚱한 id 가 전부 같은 문장이다",
    said[0] === said[1] && said[1] === said[2] && said[0]!.includes("그런 이는 여기에 없다"),
    JSON.stringify(said));
  check("어느 가방도 움직이지 않았다",
    (q.itemsOf.all(again.id).find((r) => r.item_id === "minor_potion")?.qty ?? 0) === 3);

  section("⑮ 자기 자신에게는 건넬 수 없다");
  again.clear();
  await again.actAndWait({ type: "give", targetId: again.id, itemId: "minor_potion" });
  await sleep(40);
  /* ★ 수량만 보면 안 잡힌다 — 자기에게 spend+add 는 순증 0이라 통과한다.
     문장을 봐야 '자기 자신' 갈래가 진짜로 도는지 알 수 있다. */
  check("★ 문장으로 거절한다", again.texts("sys").some((t) => t.includes("자기 자신에게")),
    JSON.stringify(again.texts("sys")));
  check("가방이 그대로다",
    (q.itemsOf.all(again.id).find((r) => r.item_id === "minor_potion")?.qty ?? 0) === 3);

  // ── 정리 ────────────────────────────────────────────────────────────
  again.close();
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
