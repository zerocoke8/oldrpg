/* 백업. 살아 있는 서버 옆에서 mud.db 의 일관된 사본 하나를 만든다.
 *
 *     npm run backup                      (MUD_DB 를 읽어 /data/backups 아래에)
 *     npm run backup -- <원본> <목적지>
 *
 * ★ 왜 cp 가 아닌가: 이 DB 는 WAL 모드다(db/open.ts). 살아 있는 서버의 주
 *   파일만 복사하면 사본에 표조차 없을 수 있다 — 실제로 확인했다:
 *   copyFileSync 로 뜬 사본에서 `no such table: room_text`. 내용이 전부
 *   -wal 에 있었다. better-sqlite3 의 db.backup() 은 SQLite 의 온라인 백업
 *   API 라 이 문제를 구조적으로 갖지 않는다.
 *
 * ★ boot() 을 부르지 않는다. boot() 은 DB 를 열기도 전에 loadBalance() /
 *   loadWorld() 를 부르고, 그게 실패하면 죽는다. 재해 상황은 정확히
 *   '무언가 틀어진' 상황이므로 백업만은 세계를 몰라도 돌아야 한다.
 *
 * ★ 이미 있는 파일을 절대 덮어쓰지 않는다. db.backup() 자체는 유효한 다른
 *   DB 도 말없이 덮어쓴다(확인했다) — 저작 도구의 '이미 있는 것은 덮어쓰지
 *   않는다' 규칙을 라이브러리가 지켜 주지 않으므로 도구가 지킨다.
 *
 * ★ 볼륨 위의 백업은 엄밀히 백업이 아니다. 머신이 죽으면 함께 죽는다.
 *   기계 밖으로 내보내는 것은 코드가 아니라 런북이고, 도구가 자기 출력에서
 *   그 사실을 말한다 (사람이 그 줄을 잊으면 백업은 없는 것과 같다).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDb } from "../db/open";
import { makeQueries } from "../db/queries";

export interface BackupCounts {
  rooms: number;
  roomText: number;
  roomTextBySource: Record<string, number>;
  npcLines: number;
  worldFlags: number;
  players: number;
}

export interface BackupReport {
  dest: string;
  bytes: number;
  schemaVersion: string;
  /** engine 의 맵과 DB 의 rooms 가 같은 세대인가의 증명. 사본 안에 함께 실려
   *  나가므로 백업과 그 증명이 분리될 수 없다. */
  contentHash: string;
  counts: BackupCounts;
  integrity: string;
}

/** 사본을 다시 열어 세는 쪽과 원본을 세는 쪽이 같은 함수를 써야 검산이 된다. */
function countOf(dbPath: string): { counts: BackupCounts; meta: Record<string, string> } {
  const db = openDb(dbPath);
  try {
    const hasMeta = db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='meta'")
      .get() as { ok: number } | undefined;
    if (!hasMeta) throw new Error(`${dbPath} 는 이 게임의 DB 가 아니다 (meta 표가 없다).`);
    const q = makeQueries(db);
    const bySource: Record<string, number> = {};
    for (const r of q.countRoomTextBySource.all()) bySource[r.source] = r.n;
    const one = (sql: string): number =>
      (db.prepare(sql).get() as { n: number }).n;
    const meta: Record<string, string> = {};
    for (const r of db.prepare("SELECT key, value FROM meta").all() as {
      key: string;
      value: string;
    }[]) {
      meta[r.key] = r.value;
    }
    return {
      meta,
      counts: {
        rooms: one("SELECT count(*) AS n FROM rooms"),
        roomText: one("SELECT count(*) AS n FROM room_text"),
        roomTextBySource: bySource,
        npcLines: q.countNpcLines.get()!.n,
        worldFlags: one("SELECT count(*) AS n FROM world_flags"),
        players: one("SELECT count(*) AS n FROM players"),
      },
    };
  } finally {
    db.close();
  }
}

export async function runBackup(
  srcPath: string,
  destPath: string,
  log: (s: string) => void = console.log,
): Promise<BackupReport> {
  if (existsSync(destPath)) {
    throw new Error(`${destPath} 가 이미 있다. 지우거나 다른 이름을 줄 것 — 덮어쓰지 않는다.`);
  }
  if (!existsSync(srcPath)) throw new Error(`${srcPath} 가 없다.`);
  mkdirSync(dirname(destPath), { recursive: true });

  const before = countOf(srcPath);
  const db = openDb(srcPath);
  let bytes = 0;
  try {
    // 살아 있는 WAL 연결에서 그대로 불러도 된다 — 그게 온라인 백업 API 다.
    const r = await db.backup(destPath);
    bytes = r.totalPages;
  } finally {
    db.close();
  }

  /* 사본을 다시 열어 검산한다. '백업했다' 와 '읽을 수 있는 백업이다' 는
     다른 명제이고, 후자를 확인하지 않으면 복원할 때 알게 된다. */
  const copy = openDb(destPath);
  let integrity = "?";
  try {
    integrity = String((copy.pragma("integrity_check", { simple: true }) as unknown) ?? "?");
  } finally {
    copy.close();
  }
  const after = countOf(destPath);

  const mismatch = (Object.keys(before.counts) as (keyof BackupCounts)[]).filter(
    (k) => JSON.stringify(before.counts[k]) !== JSON.stringify(after.counts[k]),
  );
  if (integrity !== "ok") throw new Error(`사본의 integrity_check 가 ok 가 아니다: ${integrity}`);
  if (mismatch.length) {
    throw new Error(`사본의 행 수가 원본과 다르다: ${mismatch.join(", ")}`);
  }

  const report: BackupReport = {
    dest: destPath,
    bytes,
    schemaVersion: before.meta.schema_version ?? "?",
    contentHash: before.meta.content_hash ?? "?",
    counts: after.counts,
    integrity,
  };
  /* 매니페스트를 따로 쓴다. 사람이 백업 파일 여럿을 놓고 '어느 것이 어느
     세계의 것인가' 를 열어 보지 않고 판정할 수 있어야 한다. */
  writeFileSync(`${destPath}.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  log(`[backup] ${destPath}`);
  log(`[backup] schema v${report.schemaVersion} · content ${report.contentHash}`);
  log(
    `[backup] rooms ${report.counts.rooms} · room_text ${report.counts.roomText} ` +
      `(${JSON.stringify(report.counts.roomTextBySource)}) · npc_lines ${report.counts.npcLines}`,
  );
  log(`[backup] integrity ${integrity}`);
  return report;
}

/** 기본 목적지. /data 만 node 소유라(Dockerfile) 그 아래에 둔다. */
export function defaultDest(srcPath: string, stamp: string, contentHash: string): string {
  return join(dirname(resolve(srcPath)), "backups", `mud-${stamp}-${contentHash.slice(0, 8)}.db`);
}

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
  const [srcArg, destArg] = process.argv.slice(2);
  const src = srcArg ?? process.env.MUD_DB ?? "mud.db";
  const { meta } = countOf(src);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dest = destArg ?? defaultDest(src, stamp, meta.content_hash ?? "unknown");
  const r = await runBackup(src, dest);
  console.log(
    "\n[backup] ★ 이 파일은 아직 같은 기계 위에 있다. 머신이 죽으면 함께 죽는다.\n" +
      `[backup]   기계 밖으로 내보낼 것:  fly ssh sftp get ${r.dest}\n`,
  );
}

if (isEntry) {
  main().catch((e) => {
    console.error(`[backup] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
