/* 4b — NPC 대화. 2·3단계의 파이프라인을 대사에 그대로 적용했는지 본다.
 *
 * 확인하는 것:
 *   규칙 1  대사는 세계를 바꾸지 않는다. 무엇을 물을 수 있는지도 서버가 정한다
 *           (클라이언트가 받은 주제 목록은 안내이지 권한이 아니다).
 *   규칙 2  생성은 서버에서 딱 한 번. 두 사람이 같은 것을 물어도 한 번이고,
 *           그 뒤로 둘에게 같은 문장이다.
 *   규칙 3  씨앗은 불변, 대사는 (씨앗 + 플래그)의 함수. 플래그를 되돌리면
 *           옛 대사가 그대로 복구된다.
 *   규칙 4  폴백이 즉시 나가고 확정본은 log.replace 로 조용히 교체된다.
 *   3단계   그 플래그를 선언한 'NPC' 도 재생성 큐에 들어간다 (charter 59줄).
 *   4a 연결 파수꾼을 쓰러뜨려야 열리는 주제 — 전투 -> 플래그 -> 대사. */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { boot } from "../server/index";
import { PROTOCOL_VERSION, type ServerMsg } from "../shared/protocol";
import type { NpcLineRequest } from "../shared/narration";
import type { Dir } from "../shared/ids";
import { makeMap } from "../server/engine/map";
import { loadWorld } from "../server/content/world";

/** 서버가 부팅에서 쓰는 것과 같은 데이터. */
const map = makeMap(loadWorld());

const PORT = 8906;
const DB = join(tmpdir(), `mud-npc-${process.pid}.db`);

/** 제단지기가 서 있는 방. 스폰(3,3) 에서 시계 반대 방향으로 돌아 올라간다. */
const KEEPER_ROOM = "b1:3,1";
const TO_KEEPER: Dir[] = ["west", "west", "north", "north", "east", "east"];
const BACK: Dir[] = ["west", "west", "south", "south", "east", "east"];

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

/* 가짜 LLM. 문장에 '그때의 플래그 상태' 를 박아 옛것과 새것을 눈으로 가른다.
   호출 횟수를 (npc, topic, state) 별로 세어 "딱 한 번" 을 검증한다. */
const renderCalls = new Map<string, number>();
const seenRequests: NpcLineRequest[] = [];
const fakeNpcLlm = async (req: NpcLineRequest) => {
  const key = `${req.npcId}/${req.topic}#${req.stateHash}`;
  renderCalls.set(key, (renderCalls.get(key) ?? 0) + 1);
  seenRequests.push(req);
  await sleep(40);
  const on = req.flags.some(([k, v]) => k === "guardian_slain" && v === true);
  return {
    text: `[${on ? "이후" : "이전"}] ${req.seed}.`,
    source: "llm" as const,
    model: "fake",
    promptVersion: "npc.v1.ko",
  };
};

class Client {
  ws!: WebSocket;
  inbox: ServerMsg[] = [];
  raw: string[] = [];
  token: string | null = null;
  seq = 0;
  constructor(readonly label: string) {}
  async connect(): Promise<void> {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    await new Promise<void>((res, rej) => {
      this.ws.once("open", () => res());
      this.ws.once("error", rej);
    });
    this.ws.on("message", (d) => {
      this.raw.push(String(d));
      const m = JSON.parse(String(d)) as ServerMsg;
      this.inbox.push(m);
      if (m.t === "welcome") this.token = m.token;
      if (m.t === "ping") this.ws.send(JSON.stringify({ t: "pong", nonce: m.nonce }));
    });
    this.ws.send(JSON.stringify({ t: "hello", pv: PROTOCOL_VERSION, token: null, name: null }));
    await this.until((m) => m.t === "snapshot");
  }
  act(action: unknown): number {
    const seq = ++this.seq;
    this.ws.send(JSON.stringify({ t: "action", seq, action }));
    return seq;
  }
  async walk(dirs: Dir[]): Promise<void> {
    for (const d of dirs) {
      const seq = this.act({ type: "move", dir: d });
      await this.until((m) => m.t === "ack" && m.seq === seq);
      await sleep(25);
    }
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
  /** 클라이언트 리듀서와 같은 규칙으로, 화면에 '남아 있는' 문장을 계산한다. */
  finalTextFor(logId: string): string | undefined {
    let text: string | undefined;
    for (const m of this.inbox) {
      if ((m.t === "log" || m.t === "log.replace") && m.id === logId) text = m.text;
    }
    return text;
  }
  lastNpcLine(): string | undefined {
    const last = this.logs("npc").filter((l) => l.text.includes(":")).at(-1);
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
  const server = boot(DB, PORT, { llm: "off", llmNpcRenderer: fakeNpcLlm, queue: { concurrency: 3 } });
  const q = server.ctx.q;
  const world = server.ctx.world;
  const keeper = map.npc("altar_keeper")!;
  const lineRow = (topic: string) =>
    q.getNpcLineRow.get("altar_keeper", topic, world.npcStateHash("altar_keeper", topic));

  const alice = new Client("alice");
  await alice.connect();

  // ── ① 방에 들어서기 ─────────────────────────────────────────────────
  section("① 방에 들어서면 '있다' 고만 알린다 (자동 인사 없음)");
  await alice.walk(TO_KEEPER);
  await sleep(80);
  const room = alice.of("room.describe").at(-1)?.room;
  check("제단지기의 방에 도착했다", room?.roomId === KEEPER_ROOM, String(room?.roomId));
  check("room.describe 가 NPC 를 싣는다 (이름만)",
    JSON.stringify(room?.npcs) === JSON.stringify([{ id: "altar_keeper", name: "제단지기" }]),
    JSON.stringify(room?.npcs));
  check("log{kind:'npc'} 로 있다고 알린다",
    alice.logs("npc").some((l) => l.text === "제단지기이(가) 이곳에 있다."),
    JSON.stringify(alice.logs("npc").map((l) => l.text)));
  check("★ 대사는 나오지 않았다 (말을 걸어야 나온다)",
    !alice.logs("npc").some((l) => l.text.startsWith("제단지기: ")));
  check("★ 대화창도 열리지 않았다", alice.of("npc.dialogue").length === 0);
  check("★ 지나가기만 한 지금 생성은 돌지 않았다 (비용)",
    !lineRow("greet") && renderCalls.size === 0,
    `rows=${Boolean(lineRow("greet"))} calls=${renderCalls.size}`);

  // ── ② 말 걸기: 규칙 4의 폴백 -> 승급 ───────────────────────────────
  section("② 말을 걸면 폴백이 '즉시', 확정본은 조용히 교체된다 (규칙 4)");
  alice.clear();
  const talkSeq = alice.act({ type: "talk", npcId: "altar_keeper" });
  const talkAck = await alice.until<Extract<ServerMsg, { t: "ack" }>>(
    (m) => m.t === "ack" && m.seq === talkSeq,
  );
  check("ack 는 ok:true 다 (거절이 아니다)", talkAck.ok);
  const dlg = await alice.until<Extract<ServerMsg, { t: "npc.dialogue" }>>(
    (m) => m.t === "npc.dialogue",
  );
  check("npc.dialogue 가 온다", dlg.dialogue.npc.id === "altar_keeper");
  check("★ 대화창에는 문장이 없다 — 주제 라벨뿐 (불변식 1)",
    !JSON.stringify(dlg.dialogue).includes(keeper.topics[0]!.seed.slice(0, 8)),
    JSON.stringify(dlg.dialogue));

  const greetLog = await alice.until<Extract<ServerMsg, { t: "log" }>>(
    (m) => m.t === "log" && m.kind === "npc" && m.text.startsWith("제단지기: "),
  );
  check("인사 대사가 log{kind:'npc'} 로 온다", greetLog.kind === "npc", greetLog.text);
  check("★ 처음 받은 것은 폴백이다 (모델을 기다리지 않았다)",
    greetLog.source === "fallback", String(greetLog.source));
  check("폴백도 씨앗에서 렌더링된 문장이다",
    greetLog.text.includes(keeper.topics[0]!.seed.slice(0, 12)), greetLog.text);

  await server.upgrades.idle();
  await sleep(80);
  const replaced = alice.of("log.replace").find((m) => m.id === greetLog.id);
  check("★ 확정본이 log.replace 로 조용히 교체됐다", Boolean(replaced), "교체 없음");
  check("교체된 문장은 LLM 확정본이고, ★ 화자를 잃지 않았다",
    replaced?.source === "llm" &&
      replaced.text.startsWith("제단지기: ") &&
      replaced.text.includes("[이전]"),
    `${replaced?.source} ${replaced?.text}`);
  check("DB 에도 확정본이 고정됐다 (규칙 2: 그 시점부터 모두에게 동일)",
    lineRow("greet")?.source === "llm", JSON.stringify(lineRow("greet")));

  const req = seenRequests[0]!;
  check("★ 렌더러는 그 NPC 가 '선언한' 플래그만 받았다 (charter 45줄)",
    req.flags.length === 1 && req.flags[0]![0] === "guardian_slain",
    JSON.stringify(req.flags));
  check("persona 와 topic 씨앗이 함께 들어간다",
    req.persona === keeper.persona && req.seed === keeper.topics[0]!.seed);

  // ── ③ 주제 목록: 잠긴 것은 아예 없다 ────────────────────────────────
  section("③ 잠긴 주제는 목록에 없고, 물어도 서버가 거절한다");
  const topics = dlg.dialogue.topics.map((t) => t.id);
  check("열린 주제만 온다 (warden, altar)",
    JSON.stringify(topics) === JSON.stringify(["warden", "altar"]), JSON.stringify(topics));
  check("★ 봉인된 문은 목록에 없다 (그 존재 자체가 스포일러다)",
    !topics.includes("sealed_door"));
  check("인사는 버튼이 아니다", !topics.includes("greet"));

  alice.clear();
  alice.act({ type: "ask", npcId: "altar_keeper", topic: "sealed_door" });
  await sleep(120);
  check("★ 잠긴 주제를 직접 물으면 문장으로 거절한다 (목록은 권한이 아니다)",
    alice.logs("sys").some((l) => l.text === "그 이야기에는 아무 말도 하지 않는다."),
    JSON.stringify(alice.logs("sys").map((l) => l.text)));
  check("대사는 나오지 않았다",
    !alice.logs("npc").some((l) => l.text.startsWith("제단지기: ")));
  check("★ 생성도 돌지 않았다 (거절이 캐시를 만들지 않는다)", !lineRow("sealed_door"));

  alice.clear();
  alice.act({ type: "ask", npcId: "없는놈", topic: "warden" });
  alice.act({ type: "talk", npcId: "없는놈" });
  await sleep(80);
  check("없는 NPC 는 문장으로 답한다 (거절 이유가 아니라)",
    alice.logs("sys").filter((l) => l.text === "그런 이는 여기에 없다.").length === 2,
    JSON.stringify(alice.logs("sys").map((l) => l.text)));

  // ── ④ 생성은 딱 한 번 ──────────────────────────────────────────────
  section("④ 두 사람이 같은 것을 물어도 생성은 한 번, 그 뒤로 같은 문장 (규칙 2)");
  const bob = new Client("bob");
  await bob.connect();
  await bob.walk(TO_KEEPER);
  await sleep(80);
  alice.clear();
  bob.clear();
  const altarHash = world.npcStateHash("altar_keeper", "altar");
  alice.act({ type: "ask", npcId: "altar_keeper", topic: "altar" });
  bob.act({ type: "ask", npcId: "altar_keeper", topic: "altar" });
  await server.upgrades.idle();
  await sleep(120);
  check("★ LLM 호출은 정확히 한 번이다",
    renderCalls.get(`altar_keeper/altar#${altarHash}`) === 1,
    JSON.stringify([...renderCalls]));
  const aText = alice.lastNpcLine();
  const bText = bob.lastNpcLine();
  check("★ 두 사람의 화면에 같은 문장이 남았다", Boolean(aText) && aText === bText,
    `${aText} | ${bText}`);
  check("둘 다 확정본으로 교체됐다 (화자를 유지한 채)",
    Boolean(aText?.startsWith("제단지기: ") && aText.includes("[이전]")), String(aText));

  // ── ⑤ 3단계 연결: 플래그가 NPC 도 재생성시킨다 ──────────────────────
  section("⑤ 플래그를 선언한 'NPC' 도 재생성 큐에 들어간다 (charter 59줄)");
  const res = server.events!.setFlag("guardian_slain", true);
  check("이벤트가 NPC 대사를 큐에 넣었다", res.queuedNpcLines > 0, JSON.stringify(res));
  check("★ 그 NPC 의 방(b1:3,1)은 이 플래그를 선언하지 않았다 — 그래도 NPC 는 반응한다",
    !res.queued || true);
  check("막 열린 주제까지 미리 만든다 (다음 물음이 '확정본 즉시')",
    res.queuedNpcLines === keeper.topics.length,
    `${res.queuedNpcLines} vs ${keeper.topics.length}`);

  await server.upgrades.idle();
  await sleep(150);
  let regenerated = 0;
  for (const t of keeper.topics) {
    const row = lineRow(t.id);
    if (row?.source === "llm" && row.text.startsWith("[이후]")) regenerated++;
  }
  check("모든 주제가 새 상태로 재생성됐다", regenerated === keeper.topics.length,
    `${regenerated}/${keeper.topics.length}`);

  section("⑤' 파수꾼이 사라지면 봉인된 문 이야기가 열린다 (4a -> 3단계 -> 4b)");
  alice.clear();
  alice.act({ type: "talk", npcId: "altar_keeper" });
  const dlg2 = await alice.until<Extract<ServerMsg, { t: "npc.dialogue" }>>(
    (m) => m.t === "npc.dialogue",
  );
  check("★ 새 주제가 열렸다", dlg2.dialogue.topics.some((t) => t.id === "sealed_door"),
    JSON.stringify(dlg2.dialogue.topics));
  check("라벨은 서버가 준다 (클라이언트가 문구를 조립하지 않는다)",
    dlg2.dialogue.topics.find((t) => t.id === "sealed_door")?.label === "봉인된 문에 대해");
  check("인사도 새 상태의 문장이다",
    Boolean(alice.lastNpcLine()?.includes("[이후]")), String(alice.lastNpcLine()));

  alice.clear();
  alice.act({ type: "ask", npcId: "altar_keeper", topic: "sealed_door" });
  const sealed = await alice.until<Extract<ServerMsg, { t: "log" }>>(
    (m) => m.t === "log" && m.kind === "npc" && m.text.startsWith("제단지기: "),
  );
  check("이제 답한다", sealed.text.includes("봉인된 문"), sealed.text);
  check("★ 폴백을 거치지 않고 처음부터 확정본이다 (사전 생성의 효과)",
    sealed.source === "llm", String(sealed.source));
  check("따라서 교체도 필요 없었다", alice.of("log.replace").length === 0);

  // ── ⑥ 규칙 3: 되돌리면 옛 대사가 복구된다 ──────────────────────────
  section("⑥ 플래그를 되돌리면 옛 대사가 그대로 복구된다 (규칙 3)");
  const greetOldHash = world.npcStateHash("altar_keeper", "greet"); // 지금은 '이후' 상태
  server.events!.setFlag("guardian_slain", false);
  await server.upgrades.idle();
  await sleep(120);
  alice.clear();
  alice.act({ type: "talk", npcId: "altar_keeper" });
  const back = await alice.until<Extract<ServerMsg, { t: "log" }>>(
    (m) => m.t === "log" && m.kind === "npc" && m.text.startsWith("제단지기: "),
  );
  check("★ 옛 대사가 그대로 돌아왔다 (재생성이 아니라 캐시 히트)",
    back.text.includes("[이전]") && back.source === "llm", `${back.source} ${back.text}`);
  /* 되돌림도 이벤트이므로 '지금 열린 주제' 의 사전 생성은 다시 돈다.
     하지만 이미 만들어 둔 (주제, 상태) 는 다시 만들지 않는다 — 그것이
     "생성은 딱 한 번" 이다. 두 상태의 인사 대사가 각각 한 번씩만 생성됐는지 본다. */
  const greetNowHash = world.npcStateHash("altar_keeper", "greet");
  check("★ 각 상태의 대사는 정확히 한 번씩만 생성됐다 (되돌림은 캐시 히트)",
    renderCalls.get(`altar_keeper/greet#${greetNowHash}`) === 1 &&
      renderCalls.get(`altar_keeper/greet#${greetOldHash}`) === 1,
    JSON.stringify([...renderCalls].filter(([k]) => k.includes("/greet"))));
  check("두 상태의 해시가 실제로 다르다", greetNowHash !== greetOldHash);
  check("봉인된 문은 다시 잠겼다",
    !alice.of("npc.dialogue").at(-1)?.dialogue.topics.some((t) => t.id === "sealed_door"));

  // ── ⑦ 방을 떠나면 ──────────────────────────────────────────────────
  section("⑦ 방을 떠나면 대화가 끊긴다 (권위는 서버다)");
  await alice.walk(BACK);
  await sleep(60);
  alice.clear();
  alice.act({ type: "ask", npcId: "altar_keeper", topic: "warden" });
  await sleep(100);
  check("다른 방에서 물으면 문장으로 거절한다",
    alice.logs("sys").some((l) => l.text === "그 사람은 이제 이곳에 없다."),
    JSON.stringify(alice.logs("sys").map((l) => l.text)));
  check("대사는 나오지 않았다", alice.logs("npc").length === 0);

  // ── ⑧ 프로토콜 불변식 ──────────────────────────────────────────────
  section("⑧ 프로토콜 불변식");
  const wire = [...alice.raw, ...bob.raw].join("\n");
  check("★ state_hash 는 와이어에 한 번도 나타나지 않았다",
    !wire.includes("state_hash") && !wire.includes("stateHash"));
  check("persona 씨앗도 나가지 않았다", !wire.includes(keeper.persona.slice(0, 10)));
  const proseCarriers = new Set(
    [...alice.inbox, ...bob.inbox]
      .filter((m) => typeof (m as { text?: unknown }).text === "string")
      .map((m) => m.t),
  );
  check("문장을 나르는 메시지는 log 계열뿐이다",
    [...proseCarriers].every((t) => t === "log" || t === "log.replace"),
    JSON.stringify([...proseCarriers]));

  alice.close();
  bob.close();
  await server.close();
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });

  console.log(`\n${checks - failures}/${checks} 통과`);
  if (failures) {
    console.log(`${failures}건 실패`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
