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
import { staticRenderer } from "./narration/static";
import { makeRoomTextService } from "./world/roomText";
import { makeEmit } from "./net/emit";
import { makePresence } from "./net/presence";
import { Registry } from "./net/session";
import { startServer } from "./net/server";
import type { Ctx } from "./net/handlers";
import type { ErrorEvent } from "../shared/protocol";

const DB_PATH = process.env.MUD_DB ?? "mud.db";
const PORT = Number(process.env.MUD_PORT ?? 8787);

export function boot(dbPath = DB_PATH, port = PORT) {
  const clock = () => Date.now();

  const db = openDb(dbPath);
  migrate(db, clock());
  const q = makeQueries(db);
  const { seededRooms, reaped } = seed(db, q, clock());

  const world = new World();
  world.load(loadFlags(q)); // DB -> 메모리. engine/ 이 db/ 를 import 하지 않는 이유.

  const reg = new Registry();
  const emit = makeEmit(reg);
  const presence = makePresence(reg, emit);

  // 1단계 렌더러는 결정론적 정적 렌더러. 2단계는 이 인자 하나만 바뀐다.
  const roomText = makeRoomTextService(world, q, staticRenderer, clock);

  /* 종료 플래그. handleClose 가 이걸 보고 아무 일도 하지 않는다 —
     db.close() 뒤에 도착하는 소켓 close 이벤트가 닫힌 핸들에 쓰면
     ws 의 이벤트 핸들러 안에서 던져 uncaughtException 이 된다. */
  let shuttingDown = false;

  const ctx: Ctx = { reg, emit, presence, world, q, roomText, clock, isShuttingDown: () => shuttingDown };
  const wss = startServer(ctx, port);

  console.log(
    `[mud] ws://localhost:${port} · db=${dbPath} · rooms=${world.allRoomIds().length}` +
      (seededRooms ? ` (시드 ${seededRooms}행)` : "") +
      (reaped ? ` · 유령 플레이어 ${reaped}행 정리` : ""),
  );

  return {
    ctx,
    wss,
    close: () =>
      new Promise<void>((resolve) => {
        shuttingDown = true;
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
