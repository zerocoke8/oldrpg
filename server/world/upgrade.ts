/* 폴백 문장을 LLM 확정본으로 승급시키는 백그라운드 경로.
 *
 * charter 2단계("씨앗 → LLM → DB 고정")와 규칙 4("플레이어를 LLM 앞에
 * 세워두지 않는다")를 잇는 곳이다. 플레이어는 언제나 폴백 문장을 '즉시'
 * 받고, 여기서 준비된 문장이 log.replace 로 조용히 교체된다.
 *
 * 이 파일이 engine + db + narration + net 을 아는 유일한 지점이다
 * (index.ts 와 함께). narration/ 은 여전히 DB 핸들을 잡지 못한다.
 *
 * ★ 가장 틀리기 쉬운 곳: 승급이 끝났을 때 log.replace 는 그 줄을 받은
 *   '모든' 세션에 가야 한다. 생성을 촉발한 한 명에게만 보내면, 같은 방에
 *   함께 서 있던 두 사람이 영구히 서로 다른 문장을 보게 된다 —
 *   charter 20줄("그 시점부터 모든 플레이어에게 동일하다") 위반이다.
 *
 * ★ 두 번째: 교체 문장은 '우리가 방금 생성한 것' 이 아니라 '재조회한 DB 값'
 *   이다. 다른 프로세스/요청이 먼저 기록했으면 그쪽이 진실이고, 모두가
 *   그 하나로 수렴해야 한다. */

import type { RoomId } from "../../shared/ids";
import type { TextSource } from "../../shared/protocol";
import type { RoomTextRenderer } from "../../shared/narration";
import type { World } from "../engine/world";
import type { Queries } from "../db/queries";
import { makeQueue, type QueueOptions, type QueueStats } from "../narration/queue";
import type { Emit } from "../net/emit";
import type { Session } from "../net/session";

/** provisional 로 나간 줄 하나. */
interface Watcher {
  session: Session;
  /** 발급 당시의 에폭. 소켓이 바뀌었으면 그 줄은 이미 화면에 없다. */
  connId: number;
  logId: string;
}

/** 워처 목록의 상한. 방 하나당 동시 접속자 수를 넘을 이유가 없다. */
const MAX_WATCHERS_PER_KEY = 64;

export interface UpgradeService {
  /** 방금 내보낸 서술 줄을 승급 대상으로 등록한다.
   *  이미 llm/authored 면 아무 일도 하지 않는다 (규칙 2: 생성은 딱 한 번). */
  watch(roomId: RoomId, stateHash: string, source: TextSource, s: Session, logId: string): void;
  /** 큐가 빌 때까지 — 테스트와 우아한 종료용. */
  idle(): Promise<void>;
  stop(): void;
  stats(): QueueStats & { watching: number };
}

export function makeUpgradeService(
  world: World,
  q: Queries,
  render: RoomTextRenderer,
  emit: Emit,
  clock: () => number,
  /** 종료 중인가. 진행 중인 승급은 렌더러가 해소될 때까지 남아 있는데,
   *  그 사이 db.close() 가 돌면 닫힌 핸들에 쓰게 된다. 큐가 예외를 삼키므로
   *  크래시는 아니지만 '실패' 로 기록되고 로그가 지저분해진다. */
  isShuttingDown: () => boolean = () => false,
  opts: QueueOptions = {},
): UpgradeService {
  /** `${roomId}#${stateHash}` -> 그 문장을 받은 세션들 */
  const watchers = new Map<string, Watcher[]>();

  const split = (key: string): [RoomId, string] => {
    const i = key.indexOf("#");
    return [key.slice(0, i), key.slice(i + 1)];
  };

  async function upgrade(key: string): Promise<void> {
    if (isShuttingDown()) return;
    const [roomId, stateHash] = split(key);
    const room = world.room(roomId);
    if (!room) throw new Error(`unknown room ${roomId}`);

    // 이미 승급됐는지 다시 본다 — 큐에 들어간 뒤 다른 경로가 기록했을 수 있다.
    const before = q.getRoomText.get(roomId, stateHash);
    if (before && before.source !== "fallback") {
      publish(key, before.text, before.source as TextSource);
      return;
    }

    const result = await render({
      roomId,
      stateHash,
      seed: room.seed,
      seedId: room.seedId,
      // 해시를 만든 그 투영을 그대로 넘긴다. 승급 시점의 플래그를 다시 읽으면
      // 그 사이 플래그가 바뀐 경우 해시와 내용이 어긋난다.
      flags: world.projectFlags(roomId),
    });

    // 렌더러가 도는 동안 서버가 내려갔을 수 있다. DB 를 만지기 전에 다시 본다.
    if (isShuttingDown()) return;

    if (result.source === "fallback") {
      // 렌더러가 폴백을 돌려줬다 = 이번 시도는 실패다. 던져서 큐의
      // 쿨다운/포기 정책을 타게 한다. 기존 폴백 행은 그대로 둔다.
      throw new Error(`렌더러가 폴백을 반환했다: ${key}`);
    }

    // WHERE source='fallback' 이 "딱 한 번" 을 표현하는 절이다.
    // 0행 매치는 오류가 아니라 "남이 먼저 확정했다" 이다.
    q.upgradeRoomTextFromFallback.run({
      text: result.text,
      model: result.model,
      prompt_version: result.promptVersion,
      now: clock(),
      room_id: roomId,
      state_hash: stateHash,
    });

    // ★ 무조건 재조회. 우리 결과가 아니라 DB 의 값이 모두가 볼 진실이다.
    const settled = q.getRoomText.get(roomId, stateHash);
    if (!settled) throw new Error(`승급 직후 재조회 실패: ${key}`);
    publish(key, settled.text, settled.source as TextSource);
  }

  /** 그 줄을 받은 '모든' 세션에 조용히 교체를 보낸다. */
  function publish(key: string, text: string, source: TextSource): void {
    const list = watchers.get(key);
    watchers.delete(key); // 작업이 끝났으므로 목록도 끝난다
    if (!list) return;
    for (const w of list) {
      // 소켓이 바뀌었으면 그 줄은 이미 화면에 없다 (새로고침 = 새 로그).
      if (w.session.connId !== w.connId) continue;
      emit.send(w.session, { t: "log.replace", id: w.logId, text, source });
    }
  }

  const queue = makeQueue(upgrade, opts);

  return {
    watch(roomId, stateHash, source, s, logId) {
      // 이미 확정된 문장은 교체할 것이 없다.
      if (source !== "fallback") return;
      const key = `${roomId}#${stateHash}`;
      // 큐가 받아주지 않으면(쿨다운·포기·상한) 워처도 달지 않는다 —
      // 영원히 오지 않을 교체를 기다리는 목록이 쌓이지 않게.
      const accepted = queue.push(key) || queue.active(key);
      if (!accepted) return;
      const list = watchers.get(key) ?? [];
      if (list.length >= MAX_WATCHERS_PER_KEY) return;
      list.push({ session: s, connId: s.connId, logId });
      watchers.set(key, list);
    },
    idle: () => queue.idle(),
    stop() {
      queue.stop();
      watchers.clear();
    },
    stats: () => ({ ...queue.stats(), watching: watchers.size }),
  };
}
