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
 * 쓰기:  npm run pregen            (MUD_DB 로 대상 DB 를 고른다)
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NPCS } from "../engine/npcs";
import { boot, type BootOptions } from "../index";

export interface PregenResult {
  rooms: number;
  lines: number;
  queuedRooms: number;
  queuedLines: number;
  done: number;
  failed: number;
  givenUp: number;
  /** 아직 폴백인 room_text 행 수. 0 이 아니면 그만큼 생성에 실패한 것이다. */
  leftoverFallback: number;
}

export async function runPregen(
  dbPath: string,
  options: BootOptions = {},
  log: (s: string) => void = console.log,
): Promise<PregenResult> {
  /* 포트 0 = 임의 포트. 이 도구는 소켓을 쓰지 않지만 boot() 가 조합의 유일한
     지점이므로 그대로 쓴다 — 운영과 다른 배선으로 생성하면 그게 곧 다른 세계다. */
  const server = boot(dbPath, Number(process.env.MUD_PREGEN_PORT ?? 0), options);
  const { ctx, upgrades, npcText } = server;

  try {
    const rooms = ctx.world.allRoomIds();
    const topics = NPCS.flatMap((n) =>
      ctx.world.openTopics(n.id).map((t) => ({ npc: n.id, topic: t.id })),
    );
    log(`[pregen] db=${dbPath} · 방 ${rooms.length}개 · 대사 ${topics.length}개`);

    /* 1) 폴백 행을 '먼저, 기다려서' 만든다. 승급은 WHERE source='fallback' 로
          기존 행을 갈아끼우는 것이라, 행이 없으면 워커가 헛돈다.
       2) 그 다음에 승급을 건다. 동시 실행 한도와 재시도·포기 정책은
          narration/queue.ts 가 소유하고, 운영에서 쓰는 그 정책을 그대로 쓴다. */
    let queuedRooms = 0;
    for (const roomId of rooms) {
      const { source, stateHash } = await ctx.roomText.get(roomId);
      if (source === "fallback" && upgrades.enqueue({ kind: "room", roomId, stateHash })) {
        queuedRooms++;
      }
    }
    let queuedLines = 0;
    for (const t of topics) {
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
  if (!(process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN)) {
    console.error(
      "ANTHROPIC_API_KEY 가 없다. 선생성은 '진짜 문장' 을 미리 박아 두는 것이 목적이라,\n" +
        "키 없이 돌면 폴백 행만 채운다 — 그건 첫 입장이 어차피 하는 일이다.\n" +
        ".env 를 만들고 다시 돌릴 것.",
    );
    process.exit(1);
  }
  const r = await runPregen(process.env.MUD_DB ?? "mud.db");
  console.log(`[pregen] 끝. 완료 ${r.done} · 실패 ${r.failed} · 포기 ${r.givenUp}`);
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
