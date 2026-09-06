/* 길드 등급. 마이그레이션 004 로 붙은 players.rank 와 그 위의 규칙 전부.
 *
 * 확인하는 것:
 *   저장   등급이 DB 에 남고 재접속해도 그대로다
 *   판정   engine/guild.ts 가 아무것도 바꾸지 않고 '무엇을 내야 하는지' 만 낸다
 *   원자성 아이템은 냈는데 등급이 안 오르는(또는 그 반대의) 상태가 없다
 *   경계   길드 업무를 보지 않는 NPC 에게는 신청할 수 없다
 *   문     등급이 모자라면 못 지나가고, 와이어에서는 벽과 구별되지 않는다
 *
 * ★ 등급이 세계 플래그가 아니라 '그 사람의 값' 이라는 것을 두 명으로 검사한다.
 *   한 명이 올랐는데 다른 한 명도 오르면 그건 플래그를 쓴 것이다. */

import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { boot } from "../server/index";
import { FIXTURE_WORLD, FIXTURE_BALANCE, FIXTURE_MOODS } from "./fixture";
import { resolvePromote, nextRank, rankName } from "../server/engine/guild";
import { PROTOCOL_VERSION, type ServerMsg } from "../shared/protocol";

const FIXTURE = { world: FIXTURE_WORLD, balance: FIXTURE_BALANCE, moods: FIXTURE_MOODS } as const;
const sha256 = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
const PORT = 8912;
const DB = join(tmpdir(), `mud-guild-${process.pid}.db`);

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
  token: string | null = null;
  seq = 0;
  id = "";
  /* 클라이언트가 아는 등급은 '와이어가 알려 준 것' 이다. 스냅샷으로 받고
   * self.patch 로 갱신한다 — inbox 를 비워도 남아 있어야 진짜 클라이언트다. */
  seen: { level: number; name: string | null } = { level: -1, name: null };
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
      if (m.t === "welcome") this.token = m.token;
      if (m.t === "snapshot") {
        this.id = m.self.id;
        this.seen = m.self.rank;
      }
      if (m.t === "self.patch" && m.rank) this.seen = m.rank;
      if (m.t === "ping") this.ws.send(JSON.stringify({ t: "pong", nonce: m.nonce }));
    });
    this.seq = 0;
    this.ws.send(JSON.stringify({ t: "hello", pv: PROTOCOL_VERSION, token, name: null }));
    await this.until((m) => m.t === "snapshot");
  }
  async act(action: unknown): Promise<void> {
    const seq = ++this.seq;
    this.ws.send(JSON.stringify({ t: "action", seq, action }));
    await this.until((m) => m.t === "ack" && m.seq === seq);
    await sleep(40);
  }
  async until<T extends ServerMsg>(pred: (m: ServerMsg) => boolean, ms = 3000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = this.inbox.find(pred);
      if (hit) return hit as T;
      if (Date.now() > deadline) throw new Error(`${this.label}: timeout`);
      await sleep(5);
    }
  }
  of<T extends ServerMsg["t"]>(t: T): Extract<ServerMsg, { t: T }>[] {
    return this.inbox.filter((m) => m.t === t) as Extract<ServerMsg, { t: T }>[];
  }
  sys(): string {
    return this.of("log").filter((m) => m.kind === "sys").at(-1)?.text ?? "";
  }
  rank(): { level: number; name: string | null } {
    return this.seen;
  }
  clear(): void {
    this.inbox = [];
  }
  close(): void {
    this.ws.close();
  }
}

async function main() {
  // ── ① 엔진: 판정은 아무것도 바꾸지 않는다 ───────────────────────────
  section("① 판정은 순수하다 — 무엇을 내야 하는지만 돌려준다");
  const B = FIXTURE_BALANCE;
  check("0 다음은 1", nextRank(0, B)?.level === 1);
  check("이름은 사다리가 소유한다", rankName(1, B) === "시험 1급" && rankName(0, B) === null);

  const none = () => 0;
  const r1 = resolvePromote(0, B, none);
  check("등록은 아무것도 안 내고 오른다", r1.ok && r1.to.level === 1 && r1.spend.length === 0,
    JSON.stringify(r1));
  const r2 = resolvePromote(1, B, none);
  check("★ 모자라면 '무엇이 몇 개' 인지 말해 준다",
    !r2.ok && r2.reason === "short" && r2.missing[0]?.itemId === "warden_shard" && r2.missing[0]?.qty === 1,
    JSON.stringify(r2));
  const r3 = resolvePromote(1, B, (id) => (id === "warden_shard" ? 1 : 0));
  check("가진 것이 충분하면 낼 것을 돌려준다",
    r3.ok && r3.to.level === 2 && r3.spend[0]?.qty === 1, JSON.stringify(r3));
  check("꼭대기면 더 오를 수 없다", !resolvePromote(2, B, none).ok &&
    (resolvePromote(2, B, none) as { reason: string }).reason === "max");

  // ── ② 서버 ──────────────────────────────────────────────────────────
  section("② 신청 — 접수원 앞에서만, 그리고 서버가 다시 본다");
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
  const server = boot(DB, PORT, { ...FIXTURE, llm: "off" });

  const a = new Client("alice");
  await a.connect(null);
  check("새 캐릭터는 미등록이다", a.rank().level === 0 && a.rank().name === null,
    JSON.stringify(a.rank()));

  /* 접수원은 b1:1,1 에 있다. 스폰(3,3)에서 서·서·북·북 */
  a.clear();
  await a.act({ type: "promote", npcId: "clerk" });
  check("★ 같은 방이 아니면 신청할 수 없다", a.sys().includes("이곳에 없다"), a.sys());
  check("등급은 그대로다", a.rank().level === 0);

  for (const dir of ["west", "west", "north", "north"]) await a.act({ type: "move", dir });
  /* 청소부는 접수원과 같은 방(1,1)에 서 있다. 방 검사로는 걸러지지 않으므로
     '길드 업무를 보는가' 를 실제로 묻는 것은 이 한 줄뿐이다. */
  a.clear();
  await a.act({ type: "promote", npcId: "sweeper" });
  check("★ 같은 방이어도 길드 업무를 안 보는 NPC 에게는 신청할 수 없다",
    a.sys().includes("길드 업무"), a.sys());
  check("등급은 그대로다 (청소부)", a.rank().level === 0);

  a.clear();
  await a.act({ type: "promote", npcId: "clerk" });
  check("등록이 됐다", a.rank().level === 1 && a.rank().name === "시험 1급", JSON.stringify(a.rank()));
  check("문장으로 알려 준다", a.sys().includes("시험 1급"), a.sys());

  a.clear();
  await a.act({ type: "promote", npcId: "clerk" });
  check("★ 모자라면 무엇이 필요한지 말해 준다",
    a.sys().includes("파수꾼의 파편") && a.sys().includes("1개"), a.sys());
  check("등급은 오르지 않았다", a.rank().level === 1);

  // ── ③ 차감은 원자적이다 ─────────────────────────────────────────────
  section("③ 아이템은 냈는데 등급이 안 오르는 상태가 없다");
  server.ctx.inventory.award([{ playerId: a.id, itemId: "warden_shard", qty: 1 }]);
  await sleep(80);
  a.clear();
  await a.act({ type: "promote", npcId: "clerk" });
  check("승급했다", a.rank().level === 2, JSON.stringify(a.rank()));
  const bag = a.of("self.patch").filter((m) => m.items).at(-1)?.items ?? [];
  check("★ 낸 만큼 정확히 사라졌다 (행이 지워졌다)",
    !bag.some((i) => i.id === "warden_shard"), JSON.stringify(bag));
  check("DB 의 등급과 가방이 맞다",
    server.ctx.q.playerByTokenHash.get(sha256(a.token!))?.rank === 2 &&
      server.ctx.q.itemsOf.all(a.id).every((r) => r.item_id !== "warden_shard"));
  a.clear();
  await a.act({ type: "promote", npcId: "clerk" });
  check("꼭대기에서는 더 오르지 않는다", a.sys().includes("더 오를 등급이 없다"), a.sys());

  // ── ④ 등급은 '그 사람의 값' 이다 ────────────────────────────────────
  section("④ 등급은 세계 플래그가 아니다");
  const bob = new Client("bob");
  await bob.connect(null);
  check("★ 다른 사람은 여전히 미등록이다 (한 명이 올라도 전원이 오르지 않는다)",
    bob.rank().level === 0, JSON.stringify(bob.rank()));
  check("스냅샷이 자기 등급을 싣는다", bob.of("snapshot")[0]!.self.rank.level === 0);

  // ── ⑤ 재접속 ────────────────────────────────────────────────────────
  section("⑤ 등급은 남는다");
  a.close();
  await sleep(60);
  const a2 = new Client("alice2");
  await a2.connect(a.token);
  check("★ 재접속해도 등급이 그대로다", a2.rank().level === 2 && a2.rank().name === "시험 2급",
    JSON.stringify(a2.rank()));

  // ── ⑥ 등급이 문을 연다 ──────────────────────────────────────────────
  section("⑥ 등급이 모자라면 못 지나간다 — 와이어에서는 벽과 같다");
  /* 픽스처의 문에 등급을 걸어 다시 부팅한다. 콘텐츠(minRank)만 바뀌고
     코드는 그대로라는 것이 이 검사의 요점이다. */
  const gated = {
    ...FIXTURE_WORLD,
    regions: FIXTURE_WORLD.regions.map((r) =>
      r.id === "b1"
        ? { ...r, exits: r.exits.map((e) => ({ ...e, minRank: 2, requires: null })) }
        : r,
    ),
  };
  const DB2 = `${DB}.2`;
  for (const f of [DB2, `${DB2}-wal`, `${DB2}-shm`]) rmSync(f, { force: true });
  const srv2 = boot(DB2, PORT + 1, { ...FIXTURE, world: gated, llm: "off" });
  /* 캐럴은 새 포트에 붙으므로 Client 를 쓰지 않고 직접 연결한다 */
  const ws = new WebSocket(`ws://127.0.0.1:${PORT + 1}/ws`);
  const inbox: ServerMsg[] = [];
  await new Promise<void>((res, rej) => {
    ws.once("open", () => res());
    ws.once("error", rej);
  });
  ws.on("message", (d) => inbox.push(JSON.parse(String(d)) as ServerMsg));
  ws.send(JSON.stringify({ t: "hello", pv: PROTOCOL_VERSION, token: null, name: null }));
  for (let i = 0; i < 200 && !inbox.some((m) => m.t === "snapshot"); i++) await sleep(10);
  let seq = 0;
  const move = async (dir: string): Promise<void> => {
    ws.send(JSON.stringify({ t: "action", seq: ++seq, action: { type: "move", dir } }));
    await sleep(90);
  };
  // 스폰(3,3) -> (5,5) 의 문 앞
  for (const d of ["east", "east", "south", "south"]) await move(d);
  inbox.length = 0;
  await move("east");
  const ack = inbox.find((m) => m.t === "ack") as Extract<ServerMsg, { t: "ack" }> | undefined;
  check("등급이 모자라면 거절된다", ack?.ok === false, JSON.stringify(ack));
  check("★ 와이어의 이유는 벽과 같은 \"blocked\" 다 (등급 문의 존재가 새지 않는다)",
    ack?.reason === "blocked", String(ack?.reason));
  const logs = inbox.filter((m) => m.t === "log") as Extract<ServerMsg, { t: "log" }>[];
  const line = logs.filter((m) => m.kind === "sys").at(-1)?.text ?? "";
  check("문장은 무엇이 필요한지 말해 준다 (자격은 감출 이유가 없다)",
    line.includes("시험 2급"), line);

  ws.close();
  a2.close();
  bob.close();
  await srv2.close();
  await server.close();
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`, DB2, `${DB2}-wal`, `${DB2}-shm`]) {
    rmSync(f, { force: true });
  }

  section(failures === 0 ? `PASS — ${checks}/${checks} 검사 통과` : `FAIL — ${failures}/${checks} 실패`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
