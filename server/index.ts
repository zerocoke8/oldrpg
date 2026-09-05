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

  const ctx: Ctx = { reg, emit, presence, world, q, roomText, clock };
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
        wss.close(() => {
          db.close();
          resolve();
        });
        for (const s of reg.all()) s.socket?.terminate();
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
