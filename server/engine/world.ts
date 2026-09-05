/* 메모리 월드 상태: 플래그 맵 + 방 정의 + state_hash 계산.
 *
 * 이 파일은 DB 를 import 하지 않는다 (.eslintrc.cjs 가 강제). 부팅 때
 * server/index.ts 가 DB 에서 읽은 값을 `load()` 로 주입한다 —
 * server/index.ts 가 유일한 조합 지점이다. */

import { createHash } from "node:crypto";
import type { RoomId } from "../../shared/ids";
import type { JsonScalar } from "../../shared/json";
import { allRooms, type RoomDef } from "./map";

const sha = (s: string, n: number): string =>
  createHash("sha256").update(s, "utf8").digest("hex").slice(0, n);

export class World {
  private readonly rooms = new Map<RoomId, RoomDef>();
  /** key -> world_flags.value 에 '저장된 그 문자열'. 정규화는 db/flags.ts 한 곳에서
   *  일어나고, 해시는 저장 문자열을 그대로 쓴다. 그래서 'true' 와 '1' 은
   *  관례가 아니라 단일 쓰기 경로에 의해 서로 다른 상태다. */
  private readonly flags = new Map<string, string>();

  constructor() {
    for (const r of allRooms()) this.rooms.set(r.id, r);
  }

  load(flags: ReadonlyMap<string, string> | Iterable<[string, string]>): void {
    this.flags.clear();
    for (const [k, v] of flags) this.flags.set(k, v);
  }

  room(id: RoomId): RoomDef | undefined {
    return this.rooms.get(id);
  }

  allRoomIds(): RoomId[] {
    return [...this.rooms.keys()];
  }

  /** 그 방이 '선언한' 플래그만, 정렬된 순서로 투영한다.
   *  전체 월드 플래그 맵을 넘기는 함수는 존재하지 않는다 — 좁음이 함수 본문의
   *  관례가 되면 내일의 한 줄짜리 수정이 전체를 해싱해 charter 45줄의 재앙을 만든다.
   *  ("전체 월드 플래그를 해시하면 플래그 하나 바뀔 때마다 모든 방의 캐시가 날아간다") */
  projectFlags(roomId: RoomId): (readonly [string, JsonScalar])[] {
    const r = this.rooms.get(roomId);
    if (!r) return [];
    return r.sensitiveFlags.map((k) => {
      const raw = this.flags.get(k);
      const parsed: JsonScalar = raw === undefined ? null : (JSON.parse(raw) as JsonScalar);
      return [k, parsed] as const;
    });
  }

  /** state_hash = `${seedId}.${declHash}.${valueDigest}`
   *
   *  세 조각이 각각 하는 일:
   *    seedId    — 씨앗을 고치면 미스, 되돌리면 옛 행 복구 (내용 파생이므로)
   *    declHash  — 선언을 바꾸면 옛 행이 '다른 상태'로 오독되는 대신 깨끗한 미스
   *    valueDig  — 플래그 값이 바뀌면 미스, 되돌리면 옛 행 복구 (charter 51줄)
   *
   *  빈 선언도 같은 형식으로 계산한다. 특례를 두면 그 특례가 나중에 버그가 된다. */
  stateHash(roomId: RoomId): string {
    const r = this.rooms.get(roomId);
    if (!r) throw new Error(`unknown room ${roomId}`);
    const preimage = r.sensitiveFlags.map((k) => `${k}=${this.flags.get(k) ?? "null"}`).join("\n");
    return `${r.seedId}.${r.flagsDeclHash}.${sha(preimage, 16)}`;
  }

  /** state_hash 의 preimage 를 그대로 room_text.flags_json 에 보관한다.
   *  절단 다이제스트 충돌을 탐지 가능하게 만들고,
   *  "이 방이 왜 저 문장을 말하나"를 SELECT 하나로 만든다. */
  flagsJson(roomId: RoomId): string {
    return JSON.stringify(Object.fromEntries(this.projectFlags(roomId)));
  }

  getFlag(key: string): string | undefined {
    return this.flags.get(key);
  }

  /** 3단계에서 워커가 쓴다. narration/ 이 engine/ 을 import 하지 않고도
   *  "이 플래그에 반응하는 방"을 물을 수 있도록 여기 둔다. */
  roomsSensitiveTo(flag: string): RoomId[] {
    const out: RoomId[] = [];
    for (const [id, r] of this.rooms) if (r.sensitiveFlags.includes(flag)) out.push(id);
    return out;
  }
}
