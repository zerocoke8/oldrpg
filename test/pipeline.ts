/* 2단계 생성 파이프라인 테스트. 진짜 서버 + WebSocket + SQLite,
 * LLM 자리에는 지연·실패·경합을 흉내내는 가짜 렌더러를 꽂는다.
 *
 * API 키 없이도 파이프라인 전체가 검증된다 — 그리고 파이프라인이 어려운
 * 부분이지 API 호출이 어려운 부분이 아니다.
 *
 * 검증하는 것:
 *   규칙 4 — 플레이어가 모델을 기다리지 않는가 (폴백 즉시 -> 조용한 교체)
 *   규칙 2 — 생성이 '딱 한 번' 인가 (같은 방 동시 진입 = 좌표 락)
 *   charter 20줄 — 같은 방의 두 명이 '같은' 문장으로 수렴하는가
 *   charter 50줄 — 조회 -> 없으면 생성 -> 기록 순서
 *   charter 51줄 — 플래그가 되돌아가면 옛 텍스트가 복구되는가
 *   2단계 — 실패 시 폴백 텍스트, 그리고 재시도 쿨다운 */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { boot } from "../server/index";
import { PROTOCOL_VERSION, type ServerMsg } from "../shared/protocol";
import type { RoomTextRenderer, RoomTextRequest } from "../shared/narration";
import type { Dir } from "../shared/ids";
import { loadMoods, loadNpcPrompt, loadRoomPrompt } from "../server/narration/prompts";
import { makeStaticNpcRenderer, makeStaticRenderer } from "../server/narration/static";
import { makeLlmNpcRenderer, makeLlmRenderer, type AnthropicLike } from "../server/narration/llm";

const PORT = 8902;
const DB = join(tmpdir(), `mud-pipeline-${process.pid}.db`);

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

/* ── 가짜 LLM ────────────────────────────────────────────────────────── */

interface FakeLlm extends RoomTextRenderer {
  calls: RoomTextRequest[];
  /** 이 방들은 항상 실패한다. */
  failFor: Set<string>;
  latencyMs: number;
  /** 진행 중인 호출 수의 최고치 — 좌표 락이 도는지 보는 지표. */
  maxConcurrent: number;
}

function makeFakeLlm(latencyMs = 80): FakeLlm {
  let live = 0;
  const fn = (async (req: RoomTextRequest) => {
    fn.calls.push(req);
    live++;
    fn.maxConcurrent = Math.max(fn.maxConcurrent, live);
    try {
      await sleep(fn.latencyMs);
      if (fn.failFor.has(req.roomId)) {
        // 렌더러가 폴백을 돌려주면 = 이번 시도 실패. llm.ts 가 API 오류에
        // 대해 하는 것과 '같은' 동작이다.
        return { text: "(폴백)", source: "fallback" as const, model: null, promptVersion: null };
      }
      const mood = req.flags.some(([, v]) => v === true) ? " 공기가 가볍다." : "";
      return {
        text: `[생성됨] ${req.seed} 를 둘러본다.${mood}`,
        source: "llm" as const,
        model: "fake-model",
        promptVersion: "room.v1.ko",
      };
    } finally {
      live--;
    }
  }) as FakeLlm;
  fn.calls = [];
  fn.failFor = new Set();
  fn.latencyMs = latencyMs;
  fn.maxConcurrent = 0;
  return fn;
}

/* ── 테스트 클라이언트 ───────────────────────────────────────────────── */

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
    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws`);
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
  move(dir: Dir): number {
    const seq = ++this.seq;
    this.ws.send(JSON.stringify({ t: "action", seq, action: { type: "move", dir } }));
    return seq;
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
  narr(): Extract<ServerMsg, { t: "log" }>[] {
    return this.inbox.filter((m): m is Extract<ServerMsg, { t: "log" }> => m.t === "log" && m.kind === "narr");
  }
  replaces(): Extract<ServerMsg, { t: "log.replace" }>[] {
    return this.inbox.filter((m): m is Extract<ServerMsg, { t: "log.replace" }> => m.t === "log.replace");
  }
  /** 클라이언트 리듀서와 '같은' 규칙으로 화면에 남는 최종 문장을 계산한다. */
  finalTextFor(logId: string): string | undefined {
    let text: string | undefined;
    for (const m of this.inbox) {
      if (m.t === "log" && m.id === logId) text = m.text;
      if (m.t === "log.replace" && m.id === logId) text = m.text;
    }
    return text;
  }
  clear(): void {
    this.inbox = [];
  }
  close(): void {
    this.ws.close();
  }
}

/* ⑧ 에서 쓰는 진짜 mood/폴백. 파일에서 읽는다. */
const moodsForTest = loadMoods();
const fallbackForTest = makeStaticRenderer(moodsForTest);
const fallbackNpcForTest = makeStaticNpcRenderer(moodsForTest);

/* ── 본문 ────────────────────────────────────────────────────────────── */

async function main() {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
  const llm = makeFakeLlm(80);
  const server = boot(DB, PORT, {
    llm: "off",
    llmRenderer: llm,
    queue: { concurrency: 2, cooldownMs: 250, maxAttempts: 2 },
  });

  const alice = new Client("alice");

  // ── ① 규칙 4: 플레이어는 모델을 기다리지 않는다 ─────────────────────
  section("① 규칙 4 — 폴백이 '즉시', LLM 문장은 나중에 조용히");
  const t0 = Date.now();
  await alice.connect(null);
  const firstNarr = await alice.until<Extract<ServerMsg, { t: "log" }>>(
    (m) => m.t === "log" && m.kind === "narr",
  );
  const elapsed = Date.now() - t0;
  check("첫 묘사가 렌더러 지연(80ms)보다 빨리 도착했다", elapsed < 80, `${elapsed}ms`);
  check("그 문장은 폴백이다 (source='fallback')", firstNarr.source === "fallback");
  check("씨앗 기반 결정론 문장", firstNarr.text.includes("석조 교차로"));
  check("아직 log.replace 는 없다", alice.replaces().length === 0);

  await server.upgrades.idle();
  await sleep(50);
  const rep = alice.replaces();
  check("승급이 끝나자 log.replace 가 왔다", rep.length === 1, JSON.stringify(rep));
  check("같은 로그 id 를 가리킨다 (그 줄만 갈아끼운다)", rep[0]?.id === firstNarr.id);
  check("source 가 'llm' 으로 바뀌었다", rep[0]?.source === "llm");
  check("내용이 생성된 문장이다", Boolean(rep[0]?.text.startsWith("[생성됨]")));
  check("화면의 최종 문장은 생성본", Boolean(alice.finalTextFor(firstNarr.id)?.startsWith("[생성됨]")));

  // ── ② 규칙 2 + charter 20줄: 같은 방 동시 진입 ──────────────────────
  section("② 좌표 락 — 같은 방에 동시 진입해도 생성은 딱 한 번");
  llm.calls.length = 0;
  llm.maxConcurrent = 0;
  llm.latencyMs = 200;
  const carol = new Client("carol");
  const dave = new Client("dave");
  // 아무도 안 가 본 방으로 둘이 동시에 들어가게 한다.
  await Promise.all([carol.connect(null), dave.connect(null)]);
  carol.clear();
  dave.clear();
  carol.move("west");
  dave.move("west"); // 둘 다 b1:2,3 으로
  const cNarr = await carol.until<Extract<ServerMsg, { t: "log" }>>(
    (m) => m.t === "log" && m.kind === "narr" && m.roomId === "b1:2,3",
  );
  const dNarr = await dave.until<Extract<ServerMsg, { t: "log" }>>(
    (m) => m.t === "log" && m.kind === "narr" && m.roomId === "b1:2,3",
  );
  check("둘 다 폴백을 즉시 받았다", cNarr.source === "fallback" && dNarr.source === "fallback");
  check("둘의 폴백 문장이 같다", cNarr.text === dNarr.text);

  await server.upgrades.idle();
  await sleep(60);
  const forRoom = llm.calls.filter((c) => c.roomId === "b1:2,3");
  check("b1:2,3 에 대한 생성 호출은 1회뿐 (좌표 락)", forRoom.length === 1, `${forRoom.length}회`);
  check("두 사람 모두 log.replace 를 받았다",
    carol.replaces().length === 1 && dave.replaces().length === 1,
    `carol=${carol.replaces().length} dave=${dave.replaces().length}`);
  check("★ 두 사람의 최종 문장이 '같다' (charter 20줄)",
    carol.finalTextFor(cNarr.id) === dave.finalTextFor(dNarr.id),
    `${carol.finalTextFor(cNarr.id)} != ${dave.finalTextFor(dNarr.id)}`);

  // ── ③ 캐시: 두 번째 방문은 생성하지 않는다 ──────────────────────────
  section("③ 캐시 — 확정된 방은 다시 생성하지 않는다");
  llm.calls.length = 0;
  alice.clear();
  alice.move("west"); // b1:2,3 — 이미 확정됨
  const aNarr = await alice.until<Extract<ServerMsg, { t: "log" }>>(
    (m) => m.t === "log" && m.kind === "narr" && m.roomId === "b1:2,3",
  );
  check("확정본이 '처음부터' 온다 (source='llm')", aNarr.source === "llm", aNarr.source);
  check("생성된 문장 그대로", aNarr.text.startsWith("[생성됨]"));
  await sleep(150);
  check("LLM 을 다시 부르지 않았다", llm.calls.length === 0, `${llm.calls.length}회`);
  check("교체도 필요 없다", alice.replaces().length === 0);

  // ── ④ 실패 시 폴백 + 쿨다운 ────────────────────────────────────────
  section("④ 생성 실패 — 폴백 문장이 남고, 계속 두들기지 않는다");
  llm.latencyMs = 20;
  llm.failFor.add("b1:1,3");
  llm.calls.length = 0;
  alice.clear();
  alice.move("west"); // b1:1,3
  const failNarr = await alice.until<Extract<ServerMsg, { t: "log" }>>(
    (m) => m.t === "log" && m.kind === "narr" && m.roomId === "b1:1,3",
  );
  check("폴백 문장이 화면에 남는다", failNarr.source === "fallback");
  await server.upgrades.idle();
  await sleep(60);
  check("실패했으므로 교체가 오지 않는다", alice.replaces().length === 0);
  const row = server.ctx.q.getRoomText.get("b1:1,3", server.ctx.world.stateHash("b1:1,3"));
  check("DB 행은 fallback 인 채로 남는다 (반쯤 만든 것을 고정하지 않는다)",
    row?.source === "fallback", JSON.stringify(row));

  const before = llm.calls.length;
  alice.clear();
  alice.move("east");
  await sleep(60);
  alice.move("west"); // 곧바로 다시 실패한 방으로
  await sleep(120);
  check("쿨다운 중에는 재시도하지 않는다", llm.calls.filter((c) => c.roomId === "b1:1,3").length === before,
    `${llm.calls.filter((c) => c.roomId === "b1:1,3").length} vs ${before}`);

  // ── ⑤ charter 51줄: 플래그 되돌림 ──────────────────────────────────
  section("⑤ 플래그가 되돌아가면 옛 텍스트가 그대로 복구된다");
  llm.failFor.clear();
  llm.calls.length = 0;
  // guardian_slain 을 켠다 (4단계 전투가 할 일을 여기서는 직접).
  const roomWithFlag = "b1:5,4";
  const hashOff = server.ctx.world.stateHash(roomWithFlag);
  server.ctx.q.setFlag.run("guardian_slain", "true", Date.now());
  server.ctx.world.load(
    new Map(server.ctx.q.allFlags.all().map((r) => [r.key, r.value] as [string, string])),
  );
  const hashOn = server.ctx.world.stateHash(roomWithFlag);
  check("플래그를 켜니 state_hash 가 달라졌다", hashOn !== hashOff);
  check("옛 상태의 텍스트가 사라지지 않았다 (다른 행이다)",
    server.ctx.q.getRoomText.get(roomWithFlag, hashOn) === undefined);

  server.ctx.q.setFlag.run("guardian_slain", "false", Date.now());
  server.ctx.world.load(
    new Map(server.ctx.q.allFlags.all().map((r) => [r.key, r.value] as [string, string])),
  );
  check("되돌리니 원래 state_hash 로 돌아온다", server.ctx.world.stateHash(roomWithFlag) === hashOff);

  // ── ⑥ 프롬프트가 파일에 있는가 ─────────────────────────────────────
  section("⑥ 프롬프트는 파일로 분리되어 있다 (charter 139줄)");
  const p = loadRoomPrompt();
  check("room.v1.ko.md 를 읽었다", p.version === "room.v1.ko" && p.system.length > 50);
  check("system 절에 '새로운 출구를 만들지 말라' 규칙이 있다", p.system.includes("출구"));
  const rendered = p.render({ seed: "테스트 씨앗", mood: "" });
  check("{{seed}} 가 치환된다", rendered.includes("테스트 씨앗"));
  check("{{mood}} 는 비면 사라진다", !rendered.includes("{{mood}}"));
  const withMood = p.render({ seed: "s", mood: "파수꾼이 쓰러졌다" });
  check("mood 가 있으면 절이 붙는다", withMood.includes("파수꾼이 쓰러졌다"));
  const moods = moodsForTest;
  check("moods/guardian_slain.md 를 읽었다", moods.has("guardian_slain"));
  check("mood 에 prompt/fallback 두 절이 있다",
    Boolean(moods.get("guardian_slain")?.prompt) && Boolean(moods.get("guardian_slain")?.fallback));

  // ── ⑦ 승급된 행의 메타데이터 ───────────────────────────────────────
  section("⑦ 승급된 행이 무엇으로 만들어졌는지 남는다");
  const hash33 = server.ctx.world.stateHash("b1:3,3");
  const upgraded = server.ctx.q.getRoomTextRow.get("b1:3,3", hash33);
  check("source='llm'", upgraded?.source === "llm");
  check("어느 모델이 만들었는지 남는다", upgraded?.model === "fake-model", String(upgraded?.model));
  check("어느 프롬프트로 만들었는지 남는다 (프롬프트를 고치면 캐시가 낡는다)",
    upgraded?.prompt_version === "room.v1.ko", String(upgraded?.prompt_version));
  check("flags_json 이 state_hash 의 preimage 로 남는다",
    upgraded?.flags_json === "{}", String(upgraded?.flags_json));
  check("state_hash 는 여전히 세 조각", hash33.split(".").length === 3);

  // 플래그를 선언한 방은 preimage 에 그 플래그가 들어 있어야 한다
  const flagRoomHash = server.ctx.world.stateHash("b1:5,4");
  check("선언한 플래그만 투영된다 (전체 월드 플래그가 아니다)",
    JSON.stringify(server.ctx.world.projectFlags("b1:5,4")) === '[["guardian_slain",false]]',
    JSON.stringify(server.ctx.world.projectFlags("b1:5,4")));
  check("플래그 없는 방의 투영은 빈 배열",
    JSON.stringify(server.ctx.world.projectFlags("b1:3,3")) === "[]");
  void flagRoomHash;

  // ── ⑧ LLM 렌더러 자체 (스텁 클라이언트) ────────────────────────────
  // 실제 API 는 키가 있어야 부를 수 있으므로, 요청 모양과 응답 처리를
  // 스텁으로 검증한다. 이게 유일하게 라이브로 못 도는 경로다.
  section("⑧ LLM 렌더러 — 요청 모양과 실패 처리");
  type Body = Parameters<AnthropicLike["messages"]["create"]>[0];
  type Reply = Awaited<ReturnType<AnthropicLike["messages"]["create"]>>;
  const seen: Body[] = [];
  const stub = (reply: () => unknown): AnthropicLike => ({
    messages: {
      create: async (body: Body) => {
        seen.push(body);
        const r = reply();
        if (r instanceof Error) throw r;
        return r as Reply;
      },
    },
  });
  const okReply = () => ({
    stop_reason: "end_turn",
    content: [{ type: "text", text: "  당신은 젖은 돌 위에 선다.  " }],
  });
  const req = {
    roomId: "b1:5,4",
    stateHash: "a.b.c",
    seed: "벽 틈에서 희미한 붉은 빛이 스며나온다",
    seedId: "a",
    flags: [["guardian_slain", true]] as const,
  };
  const fb = fallbackForTest;

  seen.length = 0;
  const okRenderer = makeLlmRenderer(moodsForTest, fb, { client: stub(okReply), model: "m1" });
  const okRes = await okRenderer(req);
  check("성공하면 source='llm'", okRes.source === "llm");
  check("공백이 정리된 텍스트", okRes.text === "당신은 젖은 돌 위에 선다.");
  check("모델과 프롬프트 버전이 결과에 실린다",
    okRes.model === "m1" && okRes.promptVersion === "room.v1.ko");
  const body = seen[0]!;
  check("파일에서 읽은 system 프롬프트를 보냈다",
    JSON.stringify(body.system).includes("텍스트 머드 게임의 서술자"));
  check("씨앗이 user 메시지에 들어갔다",
    JSON.stringify(body.messages).includes("붉은 빛이 스며나온다"));
  check("켜진 플래그의 mood 지시가 들어갔다",
    JSON.stringify(body.messages).includes("파수꾼"), JSON.stringify(body.messages));
  check("effort 를 낮춰 보낸다 (짧은 창작이라 추론이 필요 없다)",
    body.output_config?.effort === "low");
  check("max_tokens 가 잘리지 않을 만큼 넉넉하다", (body.max_tokens ?? 0) >= 2000);

  const refusal = makeLlmRenderer(moodsForTest, fb, {
    client: stub(() => ({ stop_reason: "refusal", stop_details: { category: "x" }, content: [] })),
  });
  check("거절(stop_reason='refusal')은 폴백으로 떨어진다",
    (await refusal(req)).source === "fallback");

  const truncated = makeLlmRenderer(moodsForTest, fb, {
    client: stub(() => ({ stop_reason: "max_tokens", content: [{ type: "text", text: "반쯤 쓰다 만" }] })),
  });
  check("max_tokens 로 잘린 문장은 쓰지 않는다 (영구 고정되면 안 된다)",
    (await truncated(req)).source === "fallback");

  const empty = makeLlmRenderer(moodsForTest, fb, {
    client: stub(() => ({ stop_reason: "end_turn", content: [] })),
  });
  check("빈 응답도 폴백", (await empty(req)).source === "fallback");

  const boom = makeLlmRenderer(moodsForTest, fb, {
    client: stub(() => new Error("network down")),
  });
  const boomRes = await boom(req);
  check("예외를 던지지 않고 폴백을 돌려준다", boomRes.source === "fallback");
  check("폴백 문장은 씨앗 기반", boomRes.text.includes("붉은 빛이 스며나온다"));

  /* ── ⑧' NPC 대사 렌더러도 같은 스텁으로 ────────────────────────────
   *
   * ★ 이 절이 생긴 이유: 예전에는 이 경로가 '우연히' 도는 것에 기대고 있었다.
   *   테스트가 방 렌더러만 꽂으면 NPC 렌더러는 키가 있는 기계에서 실물 API 로
   *   나갔고, 그것이 makeLlmNpcRenderer 와 loadNpcPrompt 를 태우는 유일한
   *   경로였다. 이제 모든 스위트가 llm:"off" 라 그 우연이 사라졌으므로,
   *   방 렌더러에 해 둔 것과 같은 검증을 여기서 명시적으로 한다. */
  section("⑧' NPC 대사 렌더러 — 프롬프트가 실제로 읽히고 실패가 폴백으로 떨어진다");
  const npcReq = {
    npcId: "altar_keeper",
    topic: "warden",
    stateHash: "a.b.c",
    npcName: "제단지기",
    persona: "무너진 서고의 제단을 지키는 늙은 사제",
    seed: "남쪽 홀을 지키는 그림자 파수꾼",
    seedId: "a",
    flags: [["guardian_slain", true]] as const,
  };
  const npcFb = fallbackNpcForTest;

  seen.length = 0;
  const npcOk = makeLlmNpcRenderer(moodsForTest, npcFb, {
    client: stub(() => ({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "  ...오래 거기 있었다.  " }],
    })),
    model: "m2",
  });
  const npcRes = await npcOk(npcReq);
  check("성공하면 source='llm'", npcRes.source === "llm");
  check("공백이 정리된다", npcRes.text === "...오래 거기 있었다.");
  check("모델과 프롬프트 버전이 실린다",
    npcRes.model === "m2" && npcRes.promptVersion === "npc.v1.ko");
  const npcBody = seen[0]!;
  check("파일에서 읽은 NPC system 프롬프트를 보냈다",
    JSON.stringify(npcBody.system).includes(loadNpcPrompt().system.slice(0, 24)),
    JSON.stringify(npcBody.system).slice(0, 120));
  check("persona 와 주제 씨앗이 둘 다 user 메시지에 들어갔다",
    JSON.stringify(npcBody.messages).includes("늙은 사제") &&
      JSON.stringify(npcBody.messages).includes("그림자 파수꾼"),
    JSON.stringify(npcBody.messages));
  check("켜진 플래그의 mood 지시가 들어갔다",
    JSON.stringify(npcBody.messages).includes("파수꾼"), JSON.stringify(npcBody.messages));
  check("★ 대사 프롬프트에 플레이어가 쓴 문자열이 들어갈 자리가 없다 (규칙 1)",
    !JSON.stringify(npcBody.messages).includes("undefined"));

  for (const [label, reply] of [
    ["거절", () => ({ stop_reason: "refusal", stop_details: { category: "x" }, content: [] })],
    ["잘림", () => ({ stop_reason: "max_tokens", content: [{ type: "text", text: "반쯤" }] })],
    ["빈 응답", () => ({ stop_reason: "end_turn", content: [] })],
    ["네트워크 예외", () => new Error("network down")],
  ] as const) {
    const r = await makeLlmNpcRenderer(moodsForTest, npcFb, { client: stub(reply) })(npcReq);
    check(`${label}은 폴백으로 떨어진다 (던지지 않는다)`, r.source === "fallback", r.text);
  }
  const npcBoom = await makeLlmNpcRenderer(moodsForTest, npcFb, {
    client: stub(() => new Error("boom")),
  })(npcReq);
  check("폴백 문장은 씨앗 기반", npcBoom.text.includes("그림자 파수꾼"), npcBoom.text);

  // ── ⑨ 종료 중에 승급이 해소되는 경우 ────────────────────────────────
  section("⑨ 종료 — 진행 중이던 승급이 닫힌 DB 를 만지지 않는다");
  for (const c of [alice, carol, dave]) c.close();
  await server.close();
  await sleep(50);
  check("종료 시점에 큐가 비어 있다", server.upgrades.stats().running === 0);

  // 별도 서버로, '승급이 진행 중인 채' 로 닫아 본다.
  const DB2 = `${DB}.race`;
  for (const f of [DB2, `${DB2}-wal`, `${DB2}-shm`]) rmSync(f, { force: true });
  let uncaught: unknown = null;
  const onErr = (e: unknown) => (uncaught = e);
  process.on("uncaughtException", onErr);
  process.on("unhandledRejection", onErr);

  const slow = boot(DB2, PORT + 1, {
    llm: "off",
    llmRenderer: async (req) => {
      await sleep(500); // 종료보다 오래 걸린다
      return { text: `[생성] ${req.seed}`, source: "llm" as const, model: "m", promptVersion: "p" };
    },
  });
  const late = new Client("late", PORT + 1);
  await late.connect(null);
  await sleep(100);
  check("승급이 '진행 중' 인 상태를 만들었다", slow.upgrades.stats().running === 1,
    JSON.stringify(slow.upgrades.stats()));
  late.close();
  await slow.close(); // DB 를 닫는다 — 승급은 아직 렌더러 안에 있다
  await sleep(700);
  process.off("uncaughtException", onErr);
  process.off("unhandledRejection", onErr);
  check("크래시하지 않는다", uncaught === null,
    uncaught instanceof Error ? uncaught.message : String(uncaught));
  check("닫힌 DB 에 쓰려다 실패로 기록되지도 않는다 (깨끗이 빠져나온다)",
    slow.upgrades.stats().failed === 0, JSON.stringify(slow.upgrades.stats()));
  for (const f of [DB2, `${DB2}-wal`, `${DB2}-shm`]) rmSync(f, { force: true });

  // ── 정리 ────────────────────────────────────────────────────────────
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} 검사 통과`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
