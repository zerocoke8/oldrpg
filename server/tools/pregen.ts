/* 선생성. 운영을 시작하기 '전에' 세계의 초기 문장을 전부 만들어 DB 에 박는다.
 *
 * ★ 왜 필요한가: 지연 생성은 방이 스무 개일 때의 이야기다. 방이 수백~수천 개면
 *   "처음 들어간 사람이 만든다" 는 곧 "처음 들어간 방마다 누군가는 폴백을 본다"
 *   이다. 초기 상태는 모두에게 같으므로 미리 한 번 만들어 두는 것이 맞다.
 *
 * ★ world/events.ts 의 pregenerate() 를 부르지 '않는' 이유:
 *   그쪽은 이벤트 경로라 절대 막히면 안 되므로 폴백 행 생성을 await 하지 않고
 *   `.then(() => enqueue())` 로 흘려보낸다. 이 도구는 반대다 — "다 됐다" 를
 *   말할 수 있어야 한다. 그 둘을 같은 함수로 쓰면 큐가 비어 있는 순간에
 *   idle() 이 즉시 돌아오고, 폴백만 잔뜩 깔린 채 '성공' 으로 끝난다.
 *   (실제로 그렇게 짰다가 테스트가 잡았다: 19방 큐에 넣었는데 LLM 호출 0회.)
 *   그래서 여기서는 행 생성을 await 한 다음에 승급을 건다.
 *
 * ★ 여러 번 돌려도 안전하다. insertRoomTextIfAbsent 가 ON CONFLICT DO NOTHING
 *   이고 승급은 WHERE source='fallback' 이라 이미 확정된 문장은 건드리지 않는다.
 *   지역을 하나 추가하고 다시 돌리면 그 지역만 생성된다.
 *
 * ★ 폴백을 없애지는 않는다. 선생성 뒤에도 폴백은 남아야 한다 — 플래그가 막
 *   바뀌어 워커가 아직 못 따라잡은 순간과, 생성이 실패한 경우의 안전망이다.
 *   달라지는 것은 '흔한 경로' 에서 '드문 안전망' 으로 바뀐다는 것뿐이다.
 *
 * ★ 돈을 쓰기 전에 두 개의 스위치가 있다. 둘 다 '실기로만 닫힌다' 를 줄이려고
 *   있는 것이다:
 *     --dry-run    한 번도 부르지 않고 '몇 번 부를 것이고 얼마인가' 만 말한다.
 *                  DB 에도 쓰지 않는다 (폴백 행조차 만들지 않는다).
 *     --limit N    앞의 N 자리만 진짜로 생성한다. 견적의 출력 토큰은 추정뿐이라
 *                  (사고 토큰) 폭이 크고, 그 폭은 작게 한 번 돌려 봐야 닫힌다.
 *
 * 쓰기:  npm run pregen                    (MUD_DB 로 대상 DB 를 고른다)
 *        npm run pregen -- --dry-run
 *        npm run pregen -- --limit 10
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { boot, type BootOptions } from "../index";
import { loadMoods, loadNpcPrompt, loadRoomPrompt, loadTones, regionOfRoomId } from "../narration/prompts";
import { moodTextFor } from "../narration/static";
import { topicOf } from "../engine/npcs";
import {
  estimate,
  estimateTokens,
  formatEstimate,
  makeTokenCounter,
  measureRatio,
  type Estimate,
  type TokenCounter,
} from "./cost";

export interface PregenResult {
  rooms: number;
  lines: number;
  queuedRooms: number;
  queuedLines: number;
  done: number;
  failed: number;
  givenUp: number;
  /** 아직 폴백인 room_text 행 수. 0 이 아니면 그만큼 생성에 실패한 것이다.
   *  ★ stoppedEarly 일 때는 '남은 일' 의 척도가 아니다 — 손도 안 댄 자리는
   *    행이 아예 없어서 여기 안 세어진다. 남은 자리는 planPregen 이 센다. */
  leftoverFallback: number;
  /** limit 에 걸려 중간에 멈췄다. 그러면 leftoverFallback 0 이 '다 됐다' 가 아니다. */
  stoppedEarly: boolean;
}

export interface PregenOptions extends BootOptions {
  /** 이만큼만 큐에 넣는다. 방을 먼저 채우고 남으면 대사로 간다.
   *  ★ 시험 주행용이다 — "다 됐다" 를 말하면 안 되므로 main() 은 이때
   *    폴백이 남아 있어도 실패로 끝내지 않는다. */
  limit?: number;
}

export async function runPregen(
  dbPath: string,
  options: PregenOptions = {},
  log: (s: string) => void = console.log,
): Promise<PregenResult> {
  /* 포트 0 = 임의 포트. 이 도구는 소켓을 쓰지 않지만 boot() 가 조합의 유일한
     지점이므로 그대로 쓴다 — 운영과 다른 배선으로 생성하면 그게 곧 다른 세계다. */
  const server = boot(dbPath, Number(process.env.MUD_PREGEN_PORT ?? 0), options);
  const { ctx, upgrades, npcText } = server;

  try {
    const rooms = ctx.world.allRoomIds();
    const topics = ctx.map.npcs().flatMap((n) =>
      ctx.world.openTopics(n.id).map((t) => ({ npc: n.id, topic: t.id })),
    );
    log(`[pregen] db=${dbPath} · 방 ${rooms.length}개 · 대사 ${topics.length}개`);

    /* 1) 폴백 행을 '먼저, 기다려서' 만든다. 승급은 WHERE source='fallback' 로
          기존 행을 갈아끼우는 것이라, 행이 없으면 워커가 헛돈다.
       2) 그 다음에 승급을 건다. 동시 실행 한도와 재시도·포기 정책은
          narration/queue.ts 가 소유하고, 운영에서 쓰는 그 정책을 그대로 쓴다. */
    /** null 이면 상한이 없다. 0 은 '아무것도' 라서 ?? 로 뭉개면 안 된다. */
    const limit = options.limit ?? null;
    let queuedRooms = 0;
    let queuedLines = 0;
    const hasRoom = (): boolean => limit === null || queuedRooms + queuedLines < limit;
    for (const roomId of rooms) {
      if (!hasRoom()) break;
      const { source, stateHash } = await ctx.roomText.get(roomId);
      if (source === "fallback" && upgrades.enqueue({ kind: "room", roomId, stateHash })) {
        queuedRooms++;
      }
    }
    for (const t of topics) {
      if (!hasRoom()) break;
      const { source, stateHash } = await npcText.get(t.npc, t.topic);
      if (
        source === "fallback" &&
        upgrades.enqueue({ kind: "npc", npcId: t.npc, topic: t.topic, stateHash })
      ) {
        queuedLines++;
      }
    }
    log(`[pregen] 큐: 방 ${queuedRooms} · 대사 ${queuedLines} (나머지는 이미 확정본이 있다)`);

    /** 몇 초에 한 번 진행 상황. 방이 1000개면 이게 유일한 창이다. */
    const ticker = setInterval(() => {
      const s = upgrades.stats();
      log(`[pregen] 남음 ${s.pending} · 도는 중 ${s.running} · 완료 ${s.done} · 실패 ${s.failed}`);
    }, 5000);
    ticker.unref?.();
    await upgrades.idle();
    clearInterval(ticker);

    const stats = upgrades.stats();
    const bySource = ctx.q.countRoomTextBySource.all();
    for (const r of bySource) log(`[pregen]   room_text ${r.source}: ${r.n}행`);
    log(`[pregen]   npc_lines: ${ctx.q.countNpcLines.get()?.n ?? 0}행`);

    return {
      rooms: rooms.length,
      lines: topics.length,
      queuedRooms,
      queuedLines,
      done: stats.done,
      failed: stats.failed,
      givenUp: stats.givenUp,
      leftoverFallback: bySource.find((r) => r.source === "fallback")?.n ?? 0,
      stoppedEarly: limit !== null && queuedRooms + queuedLines >= limit,
    };
  } finally {
    await server.close();
  }
}

/* ── 예상 (--dry-run) ───────────────────────────────────────────────────
 *
 * ★ 이 함수는 DB 에 한 행도 쓰지 않는다. runPregen 의 1단계가 폴백 행을
 *   '만들어서' 자리를 확인하는 것과 정반대다 — 예상이 세계를 바꾸면 그건
 *   예상이 아니다. 그래서 state_hash 를 직접 계산해 조회만 한다.
 *
 * ★ 프롬프트를 진짜로 조립한다. "씨앗 길이 × 방 수" 같은 대용물을 쓰면
 *   system 프롬프트도 톤도 무드도 안 세어져서, 실제의 1/3 이 나온다.
 *   렌더러가 만드는 것과 같은 문자열을 같은 로더로 만든다.
 *
 * ★ 프롬프트 캐시는 모델하지 않는다. system 절이 최소 캐시 길이를 넘으면
 *   실제 비용은 이보다 싸다 — 견적이 실제보다 높은 쪽으로 틀리는 것은
 *   예산에서 안전한 방향이다. 반대였다면 모델했어야 한다. */

export interface PregenPlan {
  rooms: { total: number; todo: number };
  lines: { total: number; todo: number };
  estimate: Estimate;
}

export async function planPregen(
  dbPath: string,
  options: PregenOptions = {},
  log: (s: string) => void = console.log,
  /** 주입 지점. 테스트가 네트워크 없이 '실측 경로' 를 돌린다. */
  counter: TokenCounter | null | undefined = undefined,
): Promise<PregenPlan> {
  const server = boot(dbPath, Number(process.env.MUD_PREGEN_PORT ?? 0), options);
  const { ctx } = server;
  try {
    const moods = options.moods ?? loadMoods();
    const tones = options.tones ?? loadTones();
    const roomPrompt = loadRoomPrompt();
    const npcPrompt = loadNpcPrompt();
    const model = process.env.MUD_MODEL ?? "claude-opus-5";

    /** 지금 세계가 부를 자리들. '확정본이 없다' 가 곧 부를 이유다. */
    const prompts: { system: string; user: string }[] = [];
    const roomIds = ctx.world.allRoomIds();
    for (const roomId of roomIds) {
      const hash = ctx.world.stateHash(roomId);
      const row = ctx.q.getRoomText.get(roomId, hash);
      if (row && row.source !== "fallback") continue;
      const def = ctx.world.room(roomId);
      if (!def) continue;
      const flags = ctx.world.projectFlags(roomId);
      prompts.push({
        system: roomPrompt.system,
        user: roomPrompt.render({
          seed: def.seed,
          tone: tones.get(regionOfRoomId(roomId))?.prompt ?? "",
          mood: moodTextFor({ seed: def.seed, flags }, moods, (m) => m.prompt),
        }),
      });
    }
    const todoRooms = prompts.length;

    let totalLines = 0;
    for (const npc of ctx.map.npcs()) {
      for (const t of ctx.world.openTopics(npc.id)) {
        totalLines++;
        const hash = ctx.world.npcStateHash(npc.id, t.id);
        const row = ctx.q.getNpcLine.get(npc.id, t.id, hash);
        if (row && row.source !== "fallback") continue;
        const def = ctx.world.npc(npc.id);
        const topic = def && topicOf(def, t.id);
        if (!def || !topic) continue;
        const flags = ctx.world.npcProjectFlags(npc.id);
        prompts.push({
          system: npcPrompt.system,
          user: npcPrompt.render({
            name: def.name,
            persona: def.persona,
            seed: topic.seed,
            mood: moodTextFor({ seed: topic.seed, flags }, moods, (m) => m.npcPrompt),
          }),
        });
      }
    }

    const chars = prompts.reduce((n, p) => n + p.system.length + p.user.length, 0);
    /* 표본으로 글자당 토큰 비를 재고, 재지 못하면 폭이 2배인 추정으로 떨어진다. */
    const count = counter === undefined ? makeTokenCounter(model) : counter;
    const measured = count
      ? await measureRatio(prompts, count)
      : { ratio: null, error: null };
    const inputTokens = measured.ratio
      ? { lo: Math.round(chars * measured.ratio), hi: Math.round(chars * measured.ratio) }
      : estimateTokens(chars);
    const est = estimate(prompts.length, inputTokens, measured.ratio !== null, model);

    log(`[pregen] (예상) db=${dbPath} · 방 ${todoRooms}/${roomIds.length} · 대사 ${prompts.length - todoRooms}/${totalLines} 자리가 비어 있다`);
    if (prompts.length === 0) {
      log("[pregen] (예상) 부를 것이 없다 — 이미 전부 확정본이다.");
    } else {
      for (const line of formatEstimate(est, "[pregen] (예상) ")) log(line);
      /* ★ 키가 있는데 못 셌으면 그건 정보다. 조용히 '추정' 으로 내려앉으면
         --dry-run 이 '키가 틀렸다' 를 말할 수 있는 유일한 자리를 버린다 —
         그러면 그 다음의 --limit 이 전부 401 로 타고 나서야 알게 된다. */
      if (measured.error) log(`[pregen] (예상) ! 입력 토큰을 못 셌다 — ${measured.error}`);
    }
    return {
      rooms: { total: roomIds.length, todo: todoRooms },
      lines: { total: totalLines, todo: prompts.length - todoRooms },
      estimate: est,
    };
  } finally {
    await server.close();
  }
}

/* tsx 로 이 파일을 '직접' 실행할 때만 돈다. 테스트는 runPregen 을 부른다. */
const isEntry = (() => {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return realpathSync(arg) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const db = process.env.MUD_DB ?? "mud.db";
  /* --limit 10 과 --limit=10 을 둘 다 받는다. npm run 을 거치면 사람이
     어느 쪽으로도 쓴다. */
  const limitArg = args.find((a) => a === "--limit" || a.startsWith("--limit="));
  const limit = limitArg
    ? Number(limitArg.includes("=") ? limitArg.split("=")[1] : args[args.indexOf(limitArg) + 1])
    : null;
  if (limitArg && (!Number.isInteger(limit) || limit === null || limit <= 0)) {
    console.error("--limit 에는 1 이상의 정수를 줄 것. 예: npm run pregen -- --limit 10");
    process.exit(1);
  }

  if (args.includes("--dry-run")) {
    /* ★ 예상에는 키가 필요 없다. 키가 있으면 입력 토큰이 추정에서 실측으로
       올라갈 뿐이다 — 키가 없다고 '얼마인지 모른다' 로 끝내면, 키를 받기
       전에 결정해야 하는 사람이 아무것도 못 한다. */
    await planPregen(db);
    process.exit(0);
  }

  /* ★ --authored: 모델 대신 content/authored/ 의 손으로 쓴 문장을 박는다.
     큐·멱등성·보고는 그대로 쓴다 — 갈리는 것은 렌더러 하나뿐이다. 그래서
     "여러 번 돌려도 안전하다" 도, "폴백이 남으면 실패다" 도 그대로 성립한다.
     키는 필요 없다 (호출이 아예 없다). */
  const authored = args.includes("--authored");
  if (!authored && !(process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN)) {
    console.error(
      "ANTHROPIC_API_KEY 가 없다. 선생성은 '진짜 문장' 을 미리 박아 두는 것이 목적이라,\n" +
        "키 없이 돌면 폴백 행만 채운다 — 그건 첫 입장이 어차피 하는 일이다.\n" +
        ".env 를 만들고 다시 돌릴 것. (부르지 않고 견적만: --dry-run,\n" +
        " 손으로 쓴 문장을 박으려면: --authored)",
    );
    process.exit(1);
  }
  const opts: PregenOptions = limit === null ? {} : { limit };
  if (authored) {
    const { loadAuthored, makeAuthoredRenderer, makeAuthoredNpcRenderer } = await import(
      "../narration/authored"
    );
    const { makeStaticRenderer, makeStaticNpcRenderer } = await import("../narration/static");
    const { loadMoods, loadTails, loadTones } = await import("../narration/prompts");
    const moods = loadMoods();
    const tails = loadTails();
    const bank = loadAuthored();
    console.log(`[pregen] --authored: 방 ${bank.rooms.size}자리 · 대사 ${bank.npc.size}자리 (${bank.version})`);
    /* 쓰인 것이 없는 자리는 폴백으로 떨어진다. 그러면 승급이 'fallback' 을
       다시 써서 아무 일도 안 일어난 것이 되고, 아래 leftoverFallback 이
       그만큼 남아 정확히 '아직 안 쓴 자리 수' 를 말한다. */
    opts.llm = "off";
    opts.llmRenderer = makeAuthoredRenderer(makeStaticRenderer(moods, tails, loadTones()), bank);
    opts.llmNpcRenderer = makeAuthoredNpcRenderer(makeStaticNpcRenderer(moods, tails), bank);
  }
  const r = await runPregen(db, opts);
  console.log(`[pregen] 끝. 완료 ${r.done} · 실패 ${r.failed} · 포기 ${r.givenUp}`);
  /* ★ --limit 은 '남기는' 것이 목적이라 폴백이 남아도 실패가 아니다.
     여기서 1 로 끝내면 시험 주행이 언제나 빨갛고, 사람이 빨강을 무시하는
     법을 배운다. 대신 남은 것이 몇 개인지 말한다. */
  if (limit !== null) {
    /* ★ 여기서 leftoverFallback 을 '남은 일' 로 인용하면 거짓말이 된다.
       손도 안 댄 자리는 room_text 에 행이 아예 없어서 그 수에 안 들어간다 —
       상한 3 으로 51방을 건드리면 "폴백 0행" 이 나오고, 그게 '다 됐다' 로
       읽힌다 (검사가 잡았다). 남은 자리를 세는 것은 --dry-run 쪽이다. */
    console.log(
      `[pregen] 시험 주행이었다 (--limit ${limit}) — ${r.done}개를 만들었다. ` +
        "남은 자리는 `npm run pregen -- --dry-run` 이 센다.",
    );
    console.log("[pregen] ★ 이제 콘솔의 실제 사용량을 볼 것. 그게 --dry-run 견적의 출력 폭을 닫는 유일한 수다.");
    process.exit(r.failed > 0 || r.givenUp > 0 ? 1 : 0);
  }
  /* 폴백이 남았다는 것은 그만큼 생성에 실패했다는 뜻이다. 조용히 0 으로 끝내면
     배포 파이프라인이 '다 됐다' 고 믿는다. */
  if (r.failed > 0 || r.givenUp > 0 || r.leftoverFallback > 0) {
    console.error(`[pregen] ★ 폴백이 ${r.leftoverFallback}행 남았다. 다시 돌리면 그것만 재시도한다.`);
    process.exit(1);
  }
  process.exit(0);
}

if (isEntry) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
