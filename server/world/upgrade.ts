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
import type { NpcLineRenderer, RoomTextRenderer } from "../../shared/narration";
import type { JsonScalar } from "../../shared/json";
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
  /* ★ 그 줄을 '어떻게 그렸는지'. log.replace 는 줄 전체를 갈아치우므로,
   *   원본 줄에 틀이 있었다면(예: `제단지기: "..."`) 교체본에도 있어야 한다.
   *   그렇지 않으면 승급된 순간 대사에서 화자가 사라진다.
   *   이 콜백은 DB 텍스트 -> 화면 문장의 사상이고, 승급 서비스는 그 내용을
   *   알 필요가 없다 (문장은 여전히 narration/lines.ts 가 소유한다). */
  format?: (text: string) => string;
}

/** 워처 목록의 상한. 방 하나당 동시 접속자 수를 넘을 이유가 없다. */
const MAX_WATCHERS_PER_KEY = 64;

/** 승급 대상. 큐는 문자열 키로 중복을 제거하고, 실제 대상은 이 맵이 든다 —
 *  키를 파싱하지 않는 것이 요점이다 (npcId 나 topic 에 구분자가 섞이는 사고를
 *  아예 없앤다). */
export type Target =
  | { kind: "room"; roomId: RoomId; stateHash: string }
  | { kind: "npc"; npcId: string; topic: string; stateHash: string };

const keyOf = (t: Target): string =>
  t.kind === "room" ? `room:${t.roomId}#${t.stateHash}` : `npc:${t.npcId}:${t.topic}#${t.stateHash}`;

export interface UpgradeService {
  /** 방금 내보낸 줄을 승급 대상으로 등록한다. 방 묘사와 NPC 대사가 같은 큐를
   *  쓴다 — 동시 실행 한도가 하나여야 API 예산이 하나로 관리된다.
   *  이미 llm/authored 면 아무 일도 하지 않는다 (규칙 2: 생성은 딱 한 번). */
  watch(
    target: Target,
    source: TextSource,
    s: Session,
    logId: string,
    /** 원본 줄에 틀이 있었다면 그 틀. 없으면 DB 텍스트가 그대로 나간다. */
    format?: (text: string) => string,
  ): void;
  /** 지켜보는 사람 없이 생성만 예약한다 (3단계 사전 생성).
   *  아무도 아직 그 문장을 화면에 갖고 있지 않으므로 교체할 대상이 없다 —
   *  다음 입장이 '확정본 즉시' 가 되게 만드는 것이 목적이다.
   *  반환값은 '이 호출로 새로 큐에 들어갔는가'. */
  enqueue(target: Target): boolean;
  /** 큐가 빌 때까지 — 테스트와 우아한 종료용. */
  idle(): Promise<void>;
  stop(): void;
  stats(): QueueStats & { watching: number };
}

export function makeUpgradeService(
  world: World,
  q: Queries,
  /** 방 묘사 / NPC 대사의 LLM 렌더러. null 이면 그 종류의 승급 경로가 아예
   *  없다 — 대상이 큐에 들어가지도 않는다. "폴백을 돌려주는 렌더러" 를
   *  꽂는 대안은 매번 실패로 기록되어 큐의 쿨다운·포기 통계를 오염시킨다. */
  render: RoomTextRenderer | null,
  renderNpc: NpcLineRenderer | null,
  emit: Emit,
  clock: () => number,
  /** 종료 중인가. 진행 중인 승급은 렌더러가 해소될 때까지 남아 있는데,
   *  그 사이 db.close() 가 돌면 닫힌 핸들에 쓰게 된다. 큐가 예외를 삼키므로
   *  크래시는 아니지만 '실패' 로 기록되고 로그가 지저분해진다. */
  isShuttingDown: () => boolean = () => false,
  opts: QueueOptions = {},
): UpgradeService {
  /** 키 -> 그 문장을 받은 세션들 */
  const watchers = new Map<string, Watcher[]>();
  /** 키 -> 무엇을 승급하는가. 키를 파싱하지 않기 위한 맵이다. */
  const targets = new Map<string, Target>();

  /** 그 종류의 승급 경로가 있는가. 없으면 큐에 넣지 않는다. */
  const canUpgrade = (t: Target): boolean =>
    t.kind === "room" ? render !== null : renderNpc !== null;

  async function upgrade(key: string): Promise<void> {
    if (isShuttingDown()) return;
    const target = targets.get(key);
    if (!target) return;
    if (target.kind === "npc") return upgradeNpc(key, target);

    if (!render) return;

    const { roomId, stateHash } = target;
    const room = world.room(roomId);
    if (!room) throw new Error(`unknown room ${roomId}`);

    const before = q.getRoomTextRow.get(roomId, stateHash);
    // 행이 아직 없다 = 그 (방, 상태) 의 텍스트가 실체화된 적이 없다.
    // 오류가 아니다: 첫 입장 때 평범한 경로가 만든다. 승급할 대상이 없을 뿐이라
    // 여기서 렌더러를 부르면 UPDATE 가 0행을 맞추고 재조회도 비어 헛돈다.
    if (!before) return;
    // 이미 승급됐는지 본다 — 큐에 들어간 뒤 다른 경로가 기록했을 수 있다.
    if (before.source !== "fallback") {
      publish(key, before.text, before.source as TextSource);
      return;
    }

    /* ★ 플래그는 '지금의 월드' 가 아니라 '그 행의 preimage' 에서 읽는다.
     *
     * world.projectFlags(roomId) 를 쓰면 승급이 큐에 앉아 있는 동안 플래그가
     * 바뀐 경우 (3단계 이벤트) 두 가지가 한꺼번에 깨진다:
     *   1) 그 방에 서 있는 플레이어의 줄이 '새 상태' 문장으로 갈아치워진다
     *      — charter 63줄 위반. 그 줄은 '들어갔을 때의 상태' 묘사여야 한다.
     *   2) 더 나쁜 것: 옛 state_hash 로 키잉된 행에 '새 플래그로 만든' 텍스트가
     *      들어간다. flags_json(= state_hash 의 preimage) 과 text 가 어긋나
     *      캐시가 조용히 오염되고, 플래그를 되돌리면 엉뚱한 문장이 복구된다.
     *
     * room_text.flags_json 이 바로 그 행을 키잉한 preimage 다. 거기서 읽으면
     * 시간이 얼마나 흘렀든 텍스트와 키가 구성상 일치한다. */
    const flags = Object.entries(JSON.parse(before.flags_json) as Record<string, JsonScalar>);

    const result = await render({
      roomId,
      stateHash,
      seed: room.seed,
      seedId: room.seedId,
      flags,
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
      /* ★ 렌더러가 선언한 출처를 그대로 쓴다. 전에는 SQL 이 'llm' 을 박아
         두어서, 사람이 쓴 문장(authored)도 모델이 쓴 것으로 기록됐다 —
         schema.sql 의 CHECK 는 처음부터 셋을 허용하고 있었는데 한 값이
         도달할 수 없었다. */
      source: result.source,
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

  /** NPC 대사의 승급. 방과 글자 그대로 같은 절차다 —
   *  조회 -> (폴백이면) 렌더 -> WHERE source='fallback' 로 승급 -> 재조회 -> 교체. */
  async function upgradeNpc(key: string, target: Extract<Target, { kind: "npc" }>): Promise<void> {
    if (!renderNpc) return;

    const { npcId, topic, stateHash } = target;
    const npc = world.npc(npcId);
    const topicDef = npc?.topics.find((t) => t.id === topic);
    if (!npc || !topicDef) throw new Error(`unknown npc/topic ${npcId}/${topic}`);

    const before = q.getNpcLineRow.get(npcId, topic, stateHash);
    if (!before) return;
    if (before.source !== "fallback") {
      publish(key, before.text, before.source as TextSource);
      return;
    }

    // 방과 같은 이유로 '그 행의 preimage' 에서 플래그를 읽는다 —
    // 지금의 월드에서 읽으면 승급 중에 플래그가 바뀐 경우 키와 내용이 어긋난다.
    const flags = Object.entries(JSON.parse(before.flags_json) as Record<string, JsonScalar>);
    const result = await renderNpc({
      npcId,
      topic,
      stateHash,
      npcName: npc.name,
      persona: npc.persona,
      seed: topicDef.seed,
      seedId: stateHash.slice(0, stateHash.indexOf(".")),
      flags,
    });
    if (isShuttingDown()) return;
    if (result.source === "fallback") throw new Error(`렌더러가 폴백을 반환했다: ${key}`);

    q.upgradeNpcLineFromFallback.run({
      source: result.source, // 방과 같은 이유 (위 주석)
      text: result.text,
      model: result.model,
      prompt_version: result.promptVersion,
      now: clock(),
      npc_id: npcId,
      topic,
      state_hash: stateHash,
    });
    const settled = q.getNpcLine.get(npcId, topic, stateHash);
    if (!settled) throw new Error(`승급 직후 재조회 실패: ${key}`);
    publish(key, settled.text, settled.source as TextSource);
  }

  /** 그 줄을 받은 '모든' 세션에 조용히 교체를 보낸다. */
  function publish(key: string, text: string, source: TextSource): void {
    const list = watchers.get(key);
    watchers.delete(key); // 작업이 끝났으므로 목록도 끝난다
    targets.delete(key);
    if (!list) return;
    for (const w of list) {
      // 소켓이 바뀌었으면 그 줄은 이미 화면에 없다 (새로고침 = 새 로그).
      if (w.session.connId !== w.connId) continue;
      emit.send(w.session, {
        t: "log.replace",
        id: w.logId,
        text: w.format ? w.format(text) : text,
        source,
      });
    }
  }

  const queue = makeQueue(upgrade, opts);

  return {
    enqueue(target) {
      if (!canUpgrade(target)) return false;
      const key = keyOf(target);
      targets.set(key, target);
      const ok = queue.push(key);
      if (!ok && !queue.active(key)) targets.delete(key);
      return ok;
    },

    watch(target, source, s, logId, format) {
      // 이미 확정된 문장은 교체할 것이 없다.
      if (source !== "fallback") return;
      if (!canUpgrade(target)) return;
      const key = keyOf(target);
      targets.set(key, target);
      // 큐가 받아주지 않으면(쿨다운·포기·상한) 워처도 달지 않는다 —
      // 영원히 오지 않을 교체를 기다리는 목록이 쌓이지 않게.
      const accepted = queue.push(key) || queue.active(key);
      if (!accepted) {
        targets.delete(key);
        return;
      }
      const list = watchers.get(key) ?? [];
      if (list.length >= MAX_WATCHERS_PER_KEY) return;
      list.push({ session: s, connId: s.connId, logId, ...(format ? { format } : {}) });
      watchers.set(key, list);
    },
    idle: () => queue.idle(),
    stop() {
      queue.stop();
      watchers.clear();
      targets.clear();
    },
    stats: () => ({ ...queue.stats(), watching: watchers.size }),
  };
}
