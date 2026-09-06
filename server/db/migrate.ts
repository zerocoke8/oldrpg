/* 마이그레이션 가드. 부팅 1단계.
 *
 * meta 표의 존재를 먼저 탐침한다 — 빈 DB 에서 meta 를 SELECT 하면
 * "no such table" 로 던지므로, schema_version 을 읽는 것만으로는
 * "새 DB" 와 "고장난 DB" 를 구별할 수 없다. */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./open";

export const SCHEMA_VERSION = 3;

/** 버전 N 으로 올리는 DDL. 전부 '가산' 이어야 한다 — 기존 표를 건드리면
 *  2단계에서 생성해 둔 room_text(값이 나간 산출물)를 잃는다. */
const MIGRATIONS: Readonly<Record<number, string>> = {
  2: "migrations/002-npcs.sql",
  3: "migrations/003-items.sql",
};

const here = dirname(fileURLToPath(import.meta.url));

export function migrate(db: Db, now: number): void {
  const hasMeta = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'")
    .get();

  if (!hasMeta) {
    /* 새 DB 는 v1 로 만들고 '아래 마이그레이션 루프를 그대로 탄다'.
       바로 SCHEMA_VERSION 을 찍으면 schema.sql 에 없는 v2 표가 빠진 채로
       최신이라고 표시된다. 그리고 이렇게 두면 마이그레이션 경로가 매 새 부팅마다
       실제로 실행되므로 죽은 코드가 되지 않는다 — room_text 를 부팅 프리시드
       하지 않은 것과 같은 이유다. */
    db.exec(readFileSync(join(here, "schema.sql"), "utf8"));
    db.prepare("INSERT INTO meta (key, value, updated_at) VALUES ('schema_version', '1', ?)").run(
      now,
    );
  }

  const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
    | { value: string }
    | undefined;
  const found = row ? Number(row.value) : 0;

  if (found > SCHEMA_VERSION) {
    throw new Error(
      `DB 의 schema_version ${found} 이 코드(${SCHEMA_VERSION})보다 높다. ` +
        `낡은 코드로 새 DB 를 열고 있다.`,
    );
  }

  // 빠진 버전을 순서대로 적용한다. 각 단계는 트랜잭션 하나 —
  // 중간에 실패하면 그 단계는 통째로 없던 일이 되고 버전도 오르지 않는다.
  for (let v = found + 1; v <= SCHEMA_VERSION; v++) {
    const file = MIGRATIONS[v];
    if (!file) throw new Error(`v${v} 로 올릴 마이그레이션이 없다`);
    const ddl = readFileSync(join(here, file), "utf8");
    db.transaction(() => {
      db.exec(ddl);
      db.prepare("UPDATE meta SET value = ?, updated_at = ? WHERE key = 'schema_version'").run(
        String(v),
        now,
      );
    })();
    console.log(`[db] schema v${v - 1} -> v${v} (${file})`);
  }
}
