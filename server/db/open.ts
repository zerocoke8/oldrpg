/* DB 연결 하나를 여는 유일한 곳.
 *
 * 여기 있는 PRAGMA 들은 SQLite 에서 '연결 단위'라 파일에 저장되지 않는다.
 * schema.sql 에 두면 (버전 가드 때문에) 첫 부팅 때만 걸리고 그 뒤로는 영원히
 * 안 걸린다 — FK 가 꺼진 채 돌게 된다. journal_mode 는 파일에 영구 저장되지만
 * 매번 호출해도 두 번째부터 no-op 이므로 그냥 여기에 함께 둔다. */

import Database from "better-sqlite3";
import type { Database as Db } from "better-sqlite3";
import { statSync } from "node:fs";
import { dirname } from "node:path";

export type { Db };

/** 열기 실패를 사람이 읽는 문장으로 바꾼다.
 *
 *  ★ 왜 이게 코드에 있어야 하는가: 이 실패의 압도적 다수는 **볼륨 소유권**이고,
 *    그때 나오는 것은 `SQLITE_CANTOPEN: unable to open database file` 한 줄이다.
 *    경로도 uid 도 없어서, 배포한 사람이 볼 수 있는 것은 "안 된다" 뿐이다.
 *    이미지의 `RUN mkdir -p /data && chown node:node /data` 는 **빌드 시점**의
 *    빈 디렉터리를 고친 것이고, 볼륨은 런타임에 그 위에 새 파일시스템을
 *    root 소유로 덮어쓴다. 그래서 이미지가 맞아도 첫 부팅이 여기서 죽는다.
 *    한 번뿐인 실패지만, 그 한 번을 로그만 보고 못 짚으면 배포가 하루 간다. */
function explainOpenFailure(path: string, err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code ?? "";
  const message = err instanceof Error ? err.message : String(err);
  const dir = dirname(path);
  const lines = [`${path} 를 열 수 없다 — ${message}`];
  let st: ReturnType<typeof statSync> | null = null;
  try {
    st = statSync(dir);
  } catch {
    /* 디렉터리 자체가 없다 */
  }
  if (!st) {
    lines.push(`  디렉터리 ${dir} 가 없다. 볼륨이 안 붙었거나 MUD_DB 가 틀렸다.`);
  } else {
    const mode = (st.mode & 0o777).toString(8);
    /* uid/gid 는 리눅스에만 있다. 없는 플랫폼에서는 그 줄을 빼는 편이,
       "uid=undefined" 로 사람을 헷갈리게 하는 것보다 낫다. */
    const me = typeof process.getuid === "function" ? `${process.getuid()}:${process.getgid?.() ?? "?"}` : null;
    lines.push(`  디렉터리 ${dir}: 소유 ${st.uid}:${st.gid} · 모드 ${mode}${me ? ` / 이 프로세스 ${me}` : ""}`);
    if (me && st.uid !== process.getuid!() && (st.mode & 0o002) === 0) {
      lines.push(
        "  ★ 소유자가 다르고 남에게 쓰기 권한도 없다. 볼륨 소유권이다:",
        "    이미지의 chown 은 빌드 시점의 빈 디렉터리를 고친 것이고, 볼륨은",
        "    런타임에 그 위를 root 소유의 새 파일시스템으로 덮는다.",
        `    고치는 법 (fly): fly ssh console -C "chown -R ${me.split(":")[0]}:${me.split(":")[1]} ${dir}"`,
      );
    }
  }
  if (code === "SQLITE_READONLY" || /readonly/i.test(message)) {
    lines.push("  (읽기 전용으로 붙었다 — 마운트 옵션도 함께 볼 것)");
  }
  return lines.join("\n");
}

export function openDb(path: string): Db {
  let db: Db;
  try {
    db = new Database(path);
  } catch (err) {
    /* 원인은 그대로 매달아 둔다 — 위의 문장은 사람용이고, 스택은 도구용이다. */
    throw new Error(explainOpenFailure(path, err), { cause: err });
  }
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON"); // SQLite 기본값이 OFF 다. room_text 의 FK 는 실효성이 있다.
  db.pragma("synchronous = NORMAL"); // WAL 과 짝. 커밋마다 fsync 하지 않는다.
  // 하드 크래시 시 마지막 몇 건의 위치 쓰기를 잃을 수 있고, 그건 방 한 칸
  // 물러나는 것이므로 수용한다. 이게 "이동마다 write-through" 를 공짜로 만든다.
  db.pragma("busy_timeout = 5000"); // 3단계에 워커가 붙을 때를 위해 지금부터.
  return db;
}
