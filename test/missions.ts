/* 임무. 마이그레이션 005 로 붙은 player_missions 와 그 위의 규칙 전부.
 *
 * 확인하는 것:
 *   판정   engine/missions.ts 가 아무것도 바꾸지 않고 '무엇을' 만 낸다
 *   게시   플래그가 안 켜진 임무는 목록에도 없고 id 로 찔러도 안 열린다
 *   공로   진행은 전리품과 '같은 목록' 으로 오른다 — 피해를 준 사람 전원
 *   원자성 보수는 나갔는데 완료가 안 찍히는(또는 그 반대의) 상태가 없다
 *   저장   일지가 DB 에 남고 재접속해도 그대로다
 *
 * ★ 임무가 세계 플래그가 아니라 '그 사람의 값' 이라는 것을 두 명으로 검사한다.
 *   한 명이 맡았는데 다른 한 명도 맡고 있으면 그건 플래그를 쓴 것이다. */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { boot } from "../server/index";
import { FIXTURE_WORLD, FIXTURE_BALANCE, FIXTURE_MOODS } from "./fixture";
import {
  resolveAccept,
  resolveTurnIn,
  slayCredit,
  isPosted,
  isComplete,
  type MissionDef,
  type MissionState,
} from "../server/engine/missions";
import { PROTOCOL_VERSION, type ServerMsg, type MissionView } from "../shared/protocol";
import type { Dir } from "../shared/ids";

const FIXTURE = { world: FIXTURE_WORLD, balance: FIXTURE_BALANCE, moods: FIXTURE_MOODS } as const;
const PORT = 8914;
const DB = join(tmpdir(), `mud-missions-${process.pid}.db`);

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
  /** ★ 스냅샷에서 다시 세지 않고 증분으로 들고 있는다 — clear() 가 스냅샷을
   *  지우면 거기서 파생하는 계산이 전부 빈 배열이 된다 (items.ts 의 함정). */
  curLog: MissionView[] = [];
  curBag: { id: string; qty: number }[] = [];
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
        this.curLog = m.self.missions ?? [];
        this.curBag = m.self.items ?? [];
      }
      if (m.t === "self.patch") {
        if (m.missions !== undefined) this.curLog = m.missions;
        if (m.items !== undefined) this.curBag = m.items;
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
    await sleep(30);
  }
  async walk(dirs: Dir[]): Promise<void> {
    for (const d of dirs) await this.actAndWait({ type: "move", dir: d });
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
  texts(kind?: string): string[] {
    return this.of("log").filter((m) => !kind || m.kind === kind).map((l) => l.text);
  }
  sys(): string {
    return this.of("log").filter((m) => m.kind === "sys").at(-1)?.text ?? "";
  }
  log(id: string): MissionView | undefined {
    return this.curLog.find((m) => m.id === id);
  }
  qty(itemId: string): number {
    return this.curBag.find((i) => i.id === itemId)?.qty ?? 0;
  }
  /** 마지막 대화창의 임무 목록. */
  offers(): { id: string; state: string; progress: number; goal: number }[] {
    return this.of("npc.dialogue").at(-1)?.dialogue.missions ?? [];
  }
  clear(): void {
    this.inbox = [];
  }
  close(): void {
    this.ws.close();
  }
}

const MISSIONS = FIXTURE_WORLD.missions;
const def = (id: string): MissionDef => MISSIONS.find((m) => m.id === id)!;
const st = (progress: number, done = false): MissionState => ({ missionId: "x", progress, done });

async function main() {
  // ── ① 판정은 순수하다 ───────────────────────────────────────────────
  section("① 판정은 아무것도 바꾸지 않는다");
  const pages = def("m_pages");
  const watcher = def("m_watcher");
  const after = def("m_after");
  const on = (k: string) => k === "guardian_slain";
  const off = () => false;

  check("플래그가 없는 임무는 언제나 게시된다", isPosted(pages, off));
  check("★ 플래그가 걸린 임무는 켜지기 전엔 게시되지 않는다", !isPosted(after, off));
  check("켜지면 게시된다", isPosted(after, on));

  check("아무나 받는다", resolveAccept(pages, 0, null, off).ok);
  const rk = resolveAccept(watcher, 0, null, off);
  check("★ 등급이 모자라면 이유가 'rank' 이고 얼마가 필요한지 말한다",
    !rk.ok && rk.reason === "rank" && rk.need === 2, JSON.stringify(rk));
  /* ★ 게시 조건과 자격이 둘 다 걸린 임무로 순서를 검사한다. 하나만 걸린
     임무로는 순서를 바꿔도 답이 같아서 아무것도 증명하지 못한다. */
  const sealed = def("m_sealed");
  const un = resolveAccept(sealed, 0, null, off);
  check("★ 게시 안 된 것은 자격도 모자라도 'unposted' 다 (게시를 먼저 본다)",
    !un.ok && un.reason === "unposted", JSON.stringify(un));
  check("게시되면 그때 자격을 본다",
    !resolveAccept(sealed, 0, null, on).ok &&
      (resolveAccept(sealed, 0, null, on) as { reason: string }).reason === "rank",
    JSON.stringify(resolveAccept(sealed, 0, null, on)));
  check("이미 맡았으면 'taken'",
    !resolveAccept(pages, 0, st(1), off).ok &&
      (resolveAccept(pages, 0, st(1), off) as { reason: string }).reason === "taken");
  check("★ 이미 끝냈으면 'done' 이다 ('taken' 이 아니다)",
    !resolveAccept(pages, 0, st(2, true), off).ok &&
      (resolveAccept(pages, 0, st(2, true), off) as { reason: string }).reason === "done");

  check("목표인 적이면 1 오른다", slayCredit(pages, st(0), "ashen_pages") === 1);
  check("★ 다른 적은 0 이다", slayCredit(pages, st(0), "rusted_watcher") === 0);
  check("★ 이미 다 채웠으면 더 안 오른다 (2/2 에서 3/2 가 되지 않는다)",
    slayCredit(pages, st(2), "ashen_pages") === 0);
  check("끝낸 임무는 안 오른다", slayCredit(pages, st(2, true), "ashen_pages") === 0);
  check("완료 판정", isComplete(pages, st(2)) && !isComplete(pages, st(1)));

  const short = resolveTurnIn(pages, st(1));
  check("★ 모자라면 몇/몇 인지 말한다",
    !short.ok && short.reason === "short" && short.have === 1 && short.need === 2,
    JSON.stringify(short));
  const paid = resolveTurnIn(pages, st(2));
  check("채웠으면 보수를 돌려준다",
    paid.ok && paid.reward[0]?.itemId === "minor_potion" && paid.reward[0]?.qty === 2,
    JSON.stringify(paid));
  check("맡은 적 없으면 'not_taken'",
    !resolveTurnIn(pages, null).ok &&
      (resolveTurnIn(pages, null) as { reason: string }).reason === "not_taken");
  check("★ 이미 낸 것은 다시 못 낸다",
    !resolveTurnIn(pages, st(2, true)).ok &&
      (resolveTurnIn(pages, st(2, true)) as { reason: string }).reason === "done");

  // ── ② 서버 ──────────────────────────────────────────────────────────
  section("② 게시 — 접수원 앞에서만, 그리고 서버가 다시 본다");
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
  const server = boot(DB, PORT, {
    ...FIXTURE,
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

  const a = new Client("alice");
  await a.connect(null);
  check("새 캐릭터의 일지는 비어 있다", a.curLog.length === 0);
  check("스냅샷이 일지를 싣는다", Array.isArray(a.of("snapshot")[0]?.self.missions));

  a.clear();
  await a.actAndWait({ type: "accept_mission", npcId: "clerk", missionId: "m_pages" });
  check("★ 같은 방이 아니면 받을 수 없다", a.sys().includes("이곳에 없다"), a.sys());
  check("일지는 그대로다", a.curLog.length === 0);

  /* 접수원은 b1:1,1 에 있다. 스폰(3,3)에서 서·서·북·북 */
  await a.walk(["west", "west", "north", "north"]);
  a.clear();
  await a.actAndWait({ type: "talk", npcId: "clerk" });
  const offers = a.offers();
  check("대화가 임무 목록을 싣는다", offers.length > 0, JSON.stringify(offers));
  check("★ 게시 안 된 임무는 목록에 아예 없다 (스포일러)",
    !offers.some((o) => o.id === "m_after"), JSON.stringify(offers.map((o) => o.id)));
  check("★ 자격이 모자란 것은 목록에 있되 locked 다 (할 일은 감추지 않는다)",
    offers.find((o) => o.id === "m_watcher")?.state === "locked",
    JSON.stringify(offers));
  check("받을 수 있는 것은 open", offers.find((o) => o.id === "m_pages")?.state === "open");

  a.clear();
  await a.actAndWait({ type: "accept_mission", npcId: "clerk", missionId: "m_after" });
  check("★ 게시 안 된 임무는 id 로 찔러도 안 열린다",
    a.sys().includes("게시돼 있지 않다"), a.sys());
  check("일지는 그대로다", a.curLog.length === 0);

  a.clear();
  await a.actAndWait({ type: "accept_mission", npcId: "clerk", missionId: "m_watcher" });
  check("★ 자격이 모자라면 무엇이 필요한지 말한다",
    a.sys().includes("시험 2급"), a.sys());

  /* 중개인은 접수원과 같은 방(1,1)에 서 있고 자기 임무를 따로 게시한다.
     방 검사로도 '게시를 안 한다' 검사로도 걸러지지 않으므로, "그 사람이
     게시하는 것인가" 를 실제로 묻는 것은 이 한 줄뿐이다. */
  a.clear();
  await a.actAndWait({ type: "accept_mission", npcId: "broker", missionId: "m_pages" });
  check("★ 같은 방이어도 남이 게시한 임무를 그 사람에게서 받을 수 없다",
    a.sys().includes("게시돼 있지 않다"), a.sys());
  check("일지는 그대로다 (중개인)", a.curLog.length === 0);

  a.clear();
  await a.actAndWait({ type: "accept_mission", npcId: "clerk", missionId: "m_pages" });
  check("맡았다", a.log("m_pages")?.goal === 2 && a.log("m_pages")?.progress === 0,
    JSON.stringify(a.curLog));
  check("문장으로 알려 준다", a.sys().includes("0/2"), a.sys());

  a.clear();
  await a.actAndWait({ type: "accept_mission", npcId: "clerk", missionId: "m_pages" });
  check("★ 두 번 맡을 수 없다", a.sys().includes("이미 맡고 있다"), a.sys());

  a.clear();
  await a.actAndWait({ type: "turn_in", npcId: "clerk", missionId: "m_pages" });
  check("★ 끝나지 않았으면 못 낸다", a.sys().includes("(0/2)"), a.sys());
  check("보수는 안 나갔다", a.qty("minor_potion") === 0);

  // ── ③ 진행은 전리품과 '같은 목록' 으로 오른다 ───────────────────────
  section("③ 진행 — 피해를 준 사람 전원");
  const b = new Client("bob");
  await b.connect(null);
  check("★ 다른 사람의 일지는 비어 있다 (한 명이 맡아도 전원이 맡지 않는다)",
    b.curLog.length === 0, JSON.stringify(b.curLog));
  await b.walk(["west", "west", "north", "north"]);
  await b.actAndWait({ type: "accept_mission", npcId: "clerk", missionId: "m_pages" });
  check("밥도 따로 맡았다", b.log("m_pages")?.progress === 0);

  /* 재의 낱장은 b1:4,1 에 있다. 접수원(1,1)에서 동·동·동 */
  for (const c of [a, b]) await c.walk(["east", "east", "east"]);

  /* 둘이 함께 한 마리를 잡는다. 리스폰을 '시간' 으로 기다리지 않고 방의
     hasEnemy 가 다시 켜질 때까지 기다린다 — 시간으로 재면 이 검사가
     respawnMs 를 건드리는 순간 조용히 무의미해진다 (공격이 거절돼도
     루프가 그냥 돌고, 실패는 엉뚱한 줄에서 난다). */
  async function killTogether(who: Client[]): Promise<boolean> {
    for (let i = 0; i < 200; i++) {
      if (who[0]!.of("room.describe").at(-1)?.room.hasEnemy !== false) break;
      await advance(500);
    }
    for (const c of who) c.clear();
    for (const c of who) await c.actAndWait({ type: "attack" });
    for (let i = 0; i < 300; i++) {
      if (who[0]!.texts().some((t) => t.includes("흩어진다") || t.includes("쓰러뜨렸다"))) return true;
      await advance(500);
    }
    return false;
  }

  check("함께 쓰러뜨렸다", await killTogether([a, b]), JSON.stringify(a.texts().slice(-3)));
  check("★ 막타를 넣은 사람만이 아니라 둘 다 올랐다 (전리품과 같은 목록)",
    a.log("m_pages")?.progress === 1 && b.log("m_pages")?.progress === 1,
    `a=${a.log("m_pages")?.progress} b=${b.log("m_pages")?.progress}`);
  check("진행 문장이 온다", a.texts("sys").some((t) => t.includes("1/2")),
    JSON.stringify(a.texts("sys")));

  check("둘째도 함께 쓰러뜨렸다", await killTogether([a, b]), JSON.stringify(a.texts().slice(-3)));
  check("둘째도 세었다", a.log("m_pages")?.progress === 2, JSON.stringify(a.curLog));
  check("★ 다 채우면 '돌아가 보고할 것' 이라고 말한다",
    a.texts("sys").some((t) => t.includes("보고")), JSON.stringify(a.texts("sys")));
  check("일지가 done 으로 바뀐다", a.log("m_pages")?.done === true);

  /* 세 번째를 잡아도 2/2 를 넘지 않아야 한다. */
  check("셋째도 쓰러뜨렸다", await killTogether([a, b]), JSON.stringify(a.texts().slice(-3)));
  check("★ 목표를 넘겨 세지 않는다 (3/2 가 되지 않는다)",
    a.log("m_pages")?.progress === 2, JSON.stringify(a.curLog));
  check("DB 의 진행도도 상한을 넘지 않았다",
    server.ctx.q.missionOf.get(a.id, "m_pages")?.progress === 2,
    JSON.stringify(server.ctx.q.missionOf.get(a.id, "m_pages")));

  // ── ④ 제출 ──────────────────────────────────────────────────────────
  section("④ 보수는 나갔는데 완료가 안 찍히는 상태가 없다");
  await a.walk(["west", "west", "west"]);
  a.clear();
  /* ★ 잡은 것에서 물약이 떨어질 수도 있으므로(재의 낱장의 드랍이 0.5다)
     절대량이 아니라 '증분' 으로 잰다. 절대량으로 재면 밸런스 파일의 드랍
     확률이 이 검사를 흔든다 — 그건 결합이지 회귀가 아니다. */
  const before = a.qty("minor_potion");
  await a.actAndWait({ type: "turn_in", npcId: "clerk", missionId: "m_pages" });
  check("완료 문장이 온다", a.texts("good").some((t) => t.includes("완료")),
    JSON.stringify(a.texts("good")));
  check("보수를 받았다", a.qty("minor_potion") === before + 2,
    `${before} -> ${a.qty("minor_potion")}`);
  check("★ 일지에서 사라진다 (일지는 '할 일' 이지 이력이 아니다)",
    a.log("m_pages") === undefined, JSON.stringify(a.curLog));
  check("DB 에 done_at 이 찍혔다",
    server.ctx.q.missionOf.get(a.id, "m_pages")?.done_at !== null,
    JSON.stringify(server.ctx.q.missionOf.get(a.id, "m_pages")));

  const afterOnce = a.qty("minor_potion");
  a.clear();
  await a.actAndWait({ type: "turn_in", npcId: "clerk", missionId: "m_pages" });
  check("★ 두 번 내도 보수는 한 번만 나간다", a.qty("minor_potion") === afterOnce,
    `${afterOnce} -> ${a.qty("minor_potion")}`);
  check("'이미 끝낸 일'", a.sys().includes("이미 끝낸"), a.sys());

  a.clear();
  await a.actAndWait({ type: "accept_mission", npcId: "clerk", missionId: "m_pages" });
  check("★ 끝낸 임무는 다시 맡을 수 없다", a.sys().includes("이미 끝낸"), a.sys());

  a.clear();
  await a.actAndWait({ type: "talk", npcId: "clerk" });
  check("끝낸 임무는 게시 목록에서도 사라진다",
    !a.offers().some((o) => o.id === "m_pages"), JSON.stringify(a.offers()));

  // ── ⑤ 남는다 ────────────────────────────────────────────────────────
  section("⑤ 일지는 남는다");
  check("밥의 것은 아직 진행 중이다 (2/2 지만 안 냈다)",
    server.ctx.q.missionOf.get(b.id, "m_pages")?.done_at === null);
  b.close();
  await sleep(60);
  const b2 = new Client("bob2");
  await b2.connect(b.token);
  check("★ 재접속해도 일지가 그대로다",
    b2.log("m_pages")?.progress === 2 && b2.log("m_pages")?.done === true,
    JSON.stringify(b2.curLog));
  check("★ 앨리스가 낸 것이 밥의 것을 닫지 않았다 (임무는 세계 플래그가 아니다)",
    b2.log("m_pages") !== undefined);

  // ── ⑥ 플래그가 임무를 연다 ──────────────────────────────────────────
  section("⑥ 세계가 바뀌면 임무가 게시된다");
  server.events.setFlag("guardian_slain", true);
  await sleep(120);
  a.clear();
  await a.actAndWait({ type: "talk", npcId: "clerk" });
  check("★ 플래그가 켜지자 목록에 나타났다",
    a.offers().some((o) => o.id === "m_after"), JSON.stringify(a.offers().map((o) => o.id)));
  a.clear();
  await a.actAndWait({ type: "accept_mission", npcId: "clerk", missionId: "m_after" });
  check("이제 받을 수 있다", a.log("m_after")?.goal === 1, JSON.stringify(a.curLog));

  // ── ⑦ 경합은 SQL 이 막는다 ──────────────────────────────────────────
  section("⑦ 두 번째 방어선 — 판정을 우회해도 표가 막는다");
  /* ★ ③④ 는 이걸 검사하지 못한다. engine/missions.ts 가 '이미 끝났다' 와
     '이미 다 채웠다' 를 먼저 걸러 내므로, 와이어를 통과하는 어떤 순서로도
     SQL 의 방어선에 닿지 않는다. 그런데 그 방어선이 막는 것은 순서가 아니라
     '동시' 다 — 같은 틱에 두 마리가 죽으면 둘 다 progress=1 을 읽고 둘 다
     +1 해서 3/2 가 된다. 그래서 질의를 직접 두들긴다. */
  const q = server.ctx.q;
  const pid = a.id;
  const M = "m_sql";
  q.acceptMission.run({ player_id: pid, mission_id: M, now: 1 });
  q.advanceMission.run({ player_id: pid, mission_id: M, by: 1, cap: 2 });
  check("한 번 올라간다", q.missionOf.get(pid, M)?.progress === 1);

  /* 같은 진행도를 읽은 두 갱신이 겹친 상황을 그대로 재현한다. */
  q.advanceMission.run({ player_id: pid, mission_id: M, by: 1, cap: 2 });
  q.advanceMission.run({ player_id: pid, mission_id: M, by: 1, cap: 2 });
  check("★ 상한을 넘지 않는다 (MIN 이 없으면 3/2 가 된다)",
    q.missionOf.get(pid, M)?.progress === 2,
    JSON.stringify(q.missionOf.get(pid, M)));

  check("★ 다시 맡아도 진행도가 0 으로 돌아가지 않는다 (DO NOTHING)",
    q.acceptMission.run({ player_id: pid, mission_id: M, now: 2 }).changes === 0 &&
      q.missionOf.get(pid, M)?.progress === 2,
    JSON.stringify(q.missionOf.get(pid, M)));

  check("첫 제출은 1행이다",
    q.completeMission.run({ player_id: pid, mission_id: M, now: 3 }).changes === 1);
  check("★ 두 번째 제출은 0행이다 (이 0행이 보수 지급을 막는다)",
    q.completeMission.run({ player_id: pid, mission_id: M, now: 4 }).changes === 0);
  check("★ 끝낸 임무는 더 안 오른다 (done_at IS NULL 조건)",
    q.advanceMission.run({ player_id: pid, mission_id: M, by: 1, cap: 5 }).changes === 0 &&
      q.missionOf.get(pid, M)?.progress === 2);

  a.close();
  b2.close();
  await server.close();
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });

  section(failures === 0 ? `PASS — ${checks}/${checks} 검사 통과` : `FAIL — ${failures}/${checks} 실패`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
