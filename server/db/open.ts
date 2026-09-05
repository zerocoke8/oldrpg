/* DB 연결 하나를 여는 유일한 곳.
 *
 * 여기 있는 PRAGMA 들은 SQLite 에서 '연결 단위'라 파일에 저장되지 않는다.
 * schema.sql 에 두면 (버전 가드 때문에) 첫 부팅 때만 걸리고 그 뒤로는 영원히
 * 안 걸린다 — FK 가 꺼진 채 돌게 된다. journal_mode 는 파일에 영구 저장되지만
 * 매번 호출해도 두 번째부터 no-op 이므로 그냥 여기에 함께 둔다. */

import Database from "better-sqlite3";
import type { Database as Db } from "better-sqlite3";

export type { Db };

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON"); // SQLite 기본값이 OFF 다. room_text 의 FK 는 실효성이 있다.
  db.pragma("synchronous = NORMAL"); // WAL 과 짝. 커밋마다 fsync 하지 않는다.
  // 하드 크래시 시 마지막 몇 건의 위치 쓰기를 잃을 수 있고, 그건 방 한 칸
  // 물러나는 것이므로 수용한다. 이게 "이동마다 write-through" 를 공짜로 만든다.
  db.pragma("busy_timeout = 5000"); // 3단계에 워커가 붙을 때를 위해 지금부터.
  return db;
}
