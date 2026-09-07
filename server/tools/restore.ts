/* 복원. 백업본에서 **생성된 문장만** 꺼내 지금 세계에 다시 심는다.
 *
 *     npm run restore -- <백업파일>            (MUD_DB 가 대상)
 *     npm run restore -- <백업파일> --dry-run  (쓰지 않고 예상만)
 *     npm run restore -- <백업파일> --force    (content_hash 가 달라도)
 *
 * ★ 두 가지 복원이 있고 이건 두 번째다.
 *     재해   백업 파일을 그대로 MUD_DB 자리에 놓고 재시작한다. 코드가 아니다.
 *     텍스트 사람들의 진행은 그대로 두고 'LLM 에 쓴 돈' 만 되살린다. 이 도구.
 *   그래서 players · player_items · player_missions 에는 한 행도 쓰지 않는다.
 *   부팅마다 reapStalePlayers 가 무조건 돌고 token_hash 는 UNIQUE 라, 사람을
 *   행 단위로 되돌리는 것은 파일 전체를 되돌리는 일과 다르게 위험하다.
 *
 * ★ 보고의 결과값은 '넣은 행 수' 가 아니라 **적중** 이다.
 *   state_hash 는 (seedId . flagsDeclHash . 값다이제스트) 라, 씨앗을 한 글자
 *   고치거나 sensitive_flags 를 하나 늘리면 행 수는 그대로인데 세계는 그중
 *   하나도 조회하지 않는다. '복원했다' 와 '살아났다' 는 다른 명제다.
 *   그래서 백업본은 그것을 만든 시점의 content/world/ 커밋과 짝으로만 의미가
 *   있고, content_hash 가 그 짝의 증명이다.
 *
 * ★ 백업과 달리 이쪽은 boot() 을 쓴다. room_text.room_id 가 rooms 로 FK 라
 *   rooms 행이 먼저 있어야 하고, '살아났는가' 를 판정하려면 state_hash 를
 *   계산할 World 가 필요하다. 조합 지점은 boot() 하나뿐이다 (pregen 과 같다).
 */

import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDb } from "../db/open";
import { makeQueries } from "../db/queries";
import { boot, type BootOptions } from "../index";

export interface RestoreReport {
  /** 백업본이 가진 행 수. */
  had: { roomText: number; npcLines: number };
  inserted: { roomText: number; npcLines: number };
  /** 대상에 이미 있어서 건너뛴 것 (ON CONFLICT DO NOTHING). */
  skipped: { roomText: number; npcLines: number };
  /** 지금 세계에 그 방·NPC 가 없어서 못 넣은 것. */
  orphans: { roomText: number; npcLines: number };
  /** ★ 지금 세계가 계산한 state_hash 로 실제 조회되고 폴백이 아닌 개수. */
  hits: { rooms: number; npcLines: number };
  /** 지금 세계가 조회할 자리의 총수 (적중의 분모). */
  slots: { rooms: number; npcLines: number };
  contentHash: { backup: string; target: string; same: boolean };
  dryRun: boolean;
}

export interface RestoreOptions extends BootOptions {
  dryRun?: boolean;
  force?: boolean;
}

export async function runRestore(
  dbPath: string,
  backupPath: string,
  options: RestoreOptions = {},
  log: (s: string) => void = console.log,
): Promise<RestoreReport> {
  if (!existsSync(backupPath)) throw new Error(`${backupPath} 가 없다.`);
  const { dryRun = false, force = false, ...bootOpts } = options;

  // ── 백업본을 읽는다 (세계를 몰라도 되는 쪽) ─────────────────────────
  const src = openDb(backupPath);
  let rows: ReturnType<ReturnType<typeof makeQueries>["allRoomText"]["all"]>;
  let npcRows: ReturnType<ReturnType<typeof makeQueries>["allNpcLines"]["all"]>;
  let backupHash: string;
  try {
    const sq = makeQueries(src);
    rows = sq.allRoomText.all();
    npcRows = sq.allNpcLines.all();
    backupHash =
      (
        src.prepare("SELECT value FROM meta WHERE key = 'content_hash'").get() as
          | { value: string }
          | undefined
      )?.value ?? "?";
  } finally {
    src.close();
  }

  /* 포트 0 = 커널이 아무 빈 포트나 준다. 이 도구는 소켓을 쓰지 않는다. */
  const server = boot(dbPath, Number(process.env.MUD_RESTORE_PORT ?? 0), bootOpts);
  let report: RestoreReport;
  try {
    const { q, world, map } = server.ctx;
    const targetHash = q.getMeta.get("content_hash")?.value ?? "?";
    const same = backupHash === targetHash;
    if (!same && !force) {
      throw new Error(
        `짝이 맞지 않는다. 백업 content_hash=${backupHash} / 지금 세계=${targetHash}\n` +
          "  씨앗이나 맵이 그 사이에 바뀌었다는 뜻이고, 그러면 state_hash 가 달라져\n" +
          "  넣어도 아무도 조회하지 않는다. 그래도 넣으려면 --force.",
      );
    }

    // ── 고아를 먼저 걸러낸다. FK 위반은 트랜잭션을 통째로 죽인다 ────────
    const roomIds = new Set(q.allRooms.all().map((r) => r.id));
    const npcIds = new Set(q.allNpcIds.all().map((r) => r.id));
    const liveRows = rows.filter((r) => roomIds.has(r.room_id));
    const liveNpcRows = npcRows.filter((r) => npcIds.has(r.npc_id));

    /** 지금 세계가 조회할 자리들. 적중의 분모다. */
    const roomSlots = [...roomIds].map((id) => ({ id, hash: world.stateHash(id) }));
    const npcSlots = map
      .npcs()
      .flatMap((n) =>
        world.openTopics(n.id).map((t) => ({
          npcId: n.id,
          topic: t.id,
          hash: world.npcStateHash(n.id, t.id),
        })),
      );

    const countHits = (): { rooms: number; npcLines: number } => ({
      rooms: roomSlots.filter((slot) => {
        const row = q.getRoomText.get(slot.id, slot.hash);
        return row !== undefined && row.source !== "fallback";
      }).length,
      npcLines: npcSlots.filter((slot) => {
        const row = q.getNpcLine.get(slot.npcId, slot.topic, slot.hash);
        return row !== undefined && row.source !== "fallback";
      }).length,
    });

    if (dryRun) {
      /* 쓰지 않고, 백업이 지금 세계의 자리를 몇 개나 채울 수 있는지만 센다. */
      const have = new Set(liveRows.map((r) => `${r.room_id} ${r.state_hash}`));
      const haveNpc = new Set(liveNpcRows.map((r) => `${r.npc_id} ${r.topic} ${r.state_hash}`));
      report = {
        had: { roomText: rows.length, npcLines: npcRows.length },
        inserted: { roomText: 0, npcLines: 0 },
        skipped: { roomText: 0, npcLines: 0 },
        orphans: {
          roomText: rows.length - liveRows.length,
          npcLines: npcRows.length - liveNpcRows.length,
        },
        hits: {
          rooms: roomSlots.filter((slot) => have.has(`${slot.id} ${slot.hash}`)).length,
          npcLines: npcSlots.filter((slot) =>
            haveNpc.has(`${slot.npcId} ${slot.topic} ${slot.hash}`),
          ).length,
        },
        slots: { rooms: roomSlots.length, npcLines: npcSlots.length },
        contentHash: { backup: backupHash, target: targetHash, same },
        dryRun: true,
      };
    } else {
      /* ★ 트랜잭션 핸들. Ctx 에는 q 는 있어도 db 가 없고 boot() 의 반환값도
         마찬가지다. 두 번째 연결을 연다 — busy_timeout 이 겹침을 덮는다.
         Ctx 를 넓히는 쪽은 조합 지점을 건드리므로 택하지 않는다. */
      const w = openDb(dbPath);
      const ins = { roomText: 0, npcLines: 0 };
      try {
        const wq = makeQueries(w);
        w.transaction(() => {
          for (const r of liveRows) ins.roomText += wq.restoreRoomText.run(r).changes;
          for (const r of liveNpcRows) ins.npcLines += wq.restoreNpcLine.run(r).changes;
        })();
      } finally {
        w.close();
      }
      report = {
        had: { roomText: rows.length, npcLines: npcRows.length },
        inserted: ins,
        skipped: {
          roomText: liveRows.length - ins.roomText,
          npcLines: liveNpcRows.length - ins.npcLines,
        },
        orphans: {
          roomText: rows.length - liveRows.length,
          npcLines: npcRows.length - liveNpcRows.length,
        },
        hits: countHits(),
        slots: { rooms: roomSlots.length, npcLines: npcSlots.length },
        contentHash: { backup: backupHash, target: targetHash, same },
        dryRun: false,
      };
    }
  } finally {
    await server.close();
  }

  const pct = (a: number, b: number): string => (b === 0 ? "-" : `${Math.round((a / b) * 100)}%`);
  log(
    `[restore]${report.dryRun ? " (예상)" : ""} 백업 room_text ${report.had.roomText} · ` +
      `npc_lines ${report.had.npcLines}`,
  );
  if (!report.dryRun) {
    log(
      `[restore] 넣음 ${report.inserted.roomText}/${report.inserted.npcLines} · ` +
        `이미있음 ${report.skipped.roomText}/${report.skipped.npcLines} · ` +
        `고아 ${report.orphans.roomText}/${report.orphans.npcLines}`,
    );
  }
  log(
    `[restore] ★ 적중 방 ${report.hits.rooms}/${report.slots.rooms} ` +
      `(${pct(report.hits.rooms, report.slots.rooms)}) · ` +
      `대사 ${report.hits.npcLines}/${report.slots.npcLines} ` +
      `(${pct(report.hits.npcLines, report.slots.npcLines)})`,
  );
  if (!report.contentHash.same) {
    log(
      `[restore] ! content_hash 가 다르다 (백업 ${report.contentHash.backup} / ` +
        `지금 ${report.contentHash.target}).\n` +
        "[restore]   씨앗이나 맵이 바뀌었다 — 적중이 낮은 것은 사고가 아니라 그 결과다.",
    );
  }
  return report;
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
  const args = process.argv.slice(2);
  const backup = args.find((a) => !a.startsWith("--"));
  if (!backup) {
    console.error("쓰기: npm run restore -- <백업파일> [--dry-run] [--force]");
    process.exit(1);
  }
  const r = await runRestore(process.env.MUD_DB ?? "mud.db", backup, {
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
  });
  /* 조용히 0 으로 끝내면 배포 파이프라인이 '다 됐다' 고 믿는다 (pregen 과 같은 판단). */
  if (r.orphans.roomText > 0 || r.orphans.npcLines > 0) {
    console.error("[restore] 고아 행이 있었다 (지금 세계에 없는 방·NPC). 세계가 바뀌었는지 볼 것.");
    process.exit(1);
  }
}

if (isEntry) {
  main().catch((e) => {
    console.error(`[restore] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
