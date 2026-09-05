/* 마이그레이션 가드. 부팅 1단계.
 *
 * meta 표의 존재를 먼저 탐침한다 — 빈 DB 에서 meta 를 SELECT 하면
 * "no such table" 로 던지므로, schema_version 을 읽는 것만으로는
 * "새 DB" 와 "고장난 DB" 를 구별할 수 없다. */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./open";

export const SCHEMA_VERSION = 1;

const here = dirname(fileURLToPath(import.meta.url));

export function migrate(db: Db, now: number): void {
  const hasMeta = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'")
    .get();

  if (!hasMeta) {
    db.exec(readFileSync(join(here, "schema.sql"), "utf8"));
    db.prepare("INSERT INTO meta (key, value, updated_at) VALUES ('schema_version', ?, ?)").run(
      String(SCHEMA_VERSION),
      now,
    );
    return;
  }

  const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
    | { value: string }
    | undefined;
  const found = row ? Number(row.value) : 0;
  if (found !== SCHEMA_VERSION) {
    throw new Error(
      `schema_version ${found} != ${SCHEMA_VERSION}. 1단계에는 마이그레이션 경로가 없다. ` +
        `개발 중이라면 DB 파일을 지우고 다시 부팅할 것.`,
    );
  }
}
