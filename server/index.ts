/* 부팅. 그리고 '유일한 조합 지점'.
 *
 * engine/ 은 db/ 를 모르고, narration/ 은 engine/ 과 db/ 를 모른다
 * (.eslintrc.cjs 가 빌드 에러로 강제). 그 셋을 아는 파일은 여기와
 * world/roomText.ts 둘뿐이다. */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDb } from "./db/open";
import { migrate } from "./db/migrate";
import { makeQueries } from "./db/queries";
import { loadFlags, seed } from "./db/seed";
import { World } from "./engine/world";
import { makeStaticRenderer } from "./narration/static";
import { makeLlmRenderer } from "./narration/llm";
import { loadMoods } from "./narration/prompts";
import { makeRoomTextService } from "./world/roomText";
import { makeUpgradeService } from "./world/upgrade";
import { makeEmit } from "./net/emit";
import { makePresence } from "./net/presence";
import { Registry } from "./net/session";
import { startServer } from "./net/server";
import type { Ctx } from "./net/handlers";
import type { ErrorEvent } from "../shared/protocol";
import type { RoomTextRenderer } from "../shared/narration";
import type { QueueOptions } from "./narration/queue";
import type { UpgradeService } from "./world/upgrade";

/** 승급 경로가 없을 때 (API 키 없음). 아무것도 하지 않는다. */
const NO_UPGRADES: UpgradeService = {
  watch: () => {},
  idle: () => Promise.resolve(),
  stop: () => {},
  stats: () => ({ pending: 0, running: 0, done: 0, failed: 0, givenUp: 0, watching: 0 }),
};

/* .env 를 읽는다 (charter: 키는 .env). Node 22 의 내장 기능이라 의존성이 없다.
   파일이 없어도 정상이다 — 그때는 LLM 없이 1단계와 똑같이 돈다. */
try {
  process.loadEnvFile(".env");
} catch {
  /* .env 없음 */
}

const DB_PATH = process.env.MUD_DB ?? "mud.db";
const PORT = Number(process.env.MUD_PORT ?? 8787);

export interface BootOptions {
  /** 테스트가 가짜 렌더러를 꽂는 자리. 지정하면 API 키 여부와 무관하게 이걸 쓴다. */
  llmRenderer?: RoomTextRenderer;
  /** 큐 옵션 (테스트에서 동시성/쿨다운을 조인다). */
  queue?: QueueOptions;
}

export function boot(dbPath = DB_PATH, port = PORT, options: BootOptions = {}) {
  const clock = () => Date.now();

  const db = openDb(dbPath);
  migrate(db, clock());
  const q = makeQueries(db);
  const { seededRooms, reaped } = seed(db, q, clock());

  const world = new World();
  world.load(loadFlags(q)); // DB -> 메모리. engine/ 이 db/ 를 import 하지 않는 이유.

  /* 종료 플래그. 두 곳이 본다:
       - handleClose: db.close() 뒤에 도착하는 소켓 close 이벤트가 닫힌 핸들에
         쓰면 ws 의 이벤트 핸들러 안에서 던져 uncaughtException 이 된다.
       - upgrade(): 렌더러가 해소되는 사이 서버가 내려갔을 수 있다. */
  let shuttingDown = false;

  const reg = new Registry();
  const emit = makeEmit(reg);
  const presence = makePresence(reg, emit);

  /* ── 서술 레이어 ────────────────────────────────────────────────────
     폴백 렌더러는 '플레이어의 경로' 에 있고, LLM 렌더러는 '백그라운드 큐' 에만
     있다. 이 분리가 규칙 4를 코드 구조로 만든 것이다 — 요청 경로에 모델
     호출이 아예 없으므로 실수로 기다리게 만들 방법이 없다. */
  const moods = loadMoods();
  const fallbackRenderer = makeStaticRenderer(moods);

  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN);
  const llmRenderer =
    options.llmRenderer ?? (hasKey ? makeLlmRenderer(moods, fallbackRenderer) : null);

  const roomText = makeRoomTextService(world, q, fallbackRenderer, clock);
  const upgrades = llmRenderer
    ? makeUpgradeService(world, q, llmRenderer, emit, clock, () => shuttingDown, options.queue ?? {})
    : // 키가 없으면 승급 경로가 통째로 없다. 게임은 1단계와 똑같이 돈다.
      NO_UPGRADES;

  const ctx: Ctx = {
    reg,
    emit,
    presence,
    world,
    q,
    roomText,
    upgrades,
    clock,
    isShuttingDown: () => shuttingDown,
  };
  const wss = startServer(ctx, port);

  console.log(
    `[mud] ws://localhost:${port} · db=${dbPath} · rooms=${world.allRoomIds().length}` +
      (seededRooms ? ` (시드 ${seededRooms}행)` : "") +
      (reaped ? ` · 유령 플레이어 ${reaped}행 정리` : ""),
  );
  console.log(
    llmRenderer
      ? `[mud] 서술: ${options.llmRenderer ? "주입된 렌더러" : (process.env.MUD_MODEL ?? "claude-opus-5")} (백그라운드 승급)`
      : `[mud] 서술: 결정론 폴백만. ANTHROPIC_API_KEY 가 없다 — .env 를 만들면 LLM 이 켜진다.`,
  );

  return {
    ctx,
    wss,
    upgrades,
    close: () =>
      new Promise<void>((resolve) => {
        shuttingDown = true;
        upgrades.stop();
        // 유예 타이머를 먼저 끈다. 안 그러면 종료 후에 깨어나 없어진
        // 레지스트리에 대고 방출을 시도한다.
        for (const s of reg.all()) {
          if (s.linger) clearTimeout(s.linger);
          s.linger = null;
        }
        /* reg.all() 이 아니라 wss.clients 를 순회한다: hello 를 아직 보내지 않은
           소켓은 Session 이 없어 레지스트리에 없는데, 업그레이드된 소켓으로서
           http 서버의 연결 수에는 잡힌다. 그런 소켓 하나만 있어도
           wss.close() 의 콜백이 영영 호출되지 않아 종료가 멈춘다. */
        const bye: ErrorEvent = {
          t: "error",
          code: "shutdown",
          message: "서버가 종료됩니다.",
          reconnect: true,
        };
        for (const c of wss.clients) {
          try {
            c.send(JSON.stringify(bye));
          } catch {
            /* 이미 닫힘 */
          }
          c.terminate();
        }
        wss.close(() => {
          db.close();
          resolve();
        });
      }),
  };
}

/* tsx 로 이 파일을 '직접' 실행할 때만 부팅한다.
   테스트는 boot() 를 직접 부르므로 여기를 타지 않는다. */
const isEntry = (() => {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return realpathSync(arg) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isEntry) boot();
