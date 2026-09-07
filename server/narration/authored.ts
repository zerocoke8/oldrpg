/* 손으로 쓴 문장을 읽는 렌더러.
 *
 * ★ 왜 이것이 있는가: 이 세계의 문장은 원래 두 곳에서 온다 — 결정론적 폴백
 *   (static.ts)과 모델(llm.ts). 셋째 출처가 하나 더 있다: **사람이 쓴 것**.
 *   room_text.source 의 CHECK 가 처음부터 'authored' 를 허용하고 있었고
 *   (schema.sql), 이 파일이 그 자리를 채운다.
 *
 * ★ 규칙 1 은 그대로다. 이 파일은 db/ 도 engine/ 도 import 하지 않고 텍스트를
 *   '반환' 할 뿐이다 — 어디에 어떻게 기록할지는 world/roomText.ts 가 정한다.
 *   규칙 2 도 그대로다: 여기에는 API 호출이 아예 없다.
 *
 * ★ 규칙 3(씨앗은 불변)과의 관계: 이 파일이 씨앗을 대체하지 않는다. 씨앗은
 *   여전히 content/world/regions/ 에 있고 state_hash 의 preimage 다. 여기 있는
 *   것은 '그 씨앗으로부터 나온 문장' 이고, 모델이 만들었을 자리에 사람이 쓴
 *   것이 들어갈 뿐이다. 그래서 씨앗을 고치면 이 문장도 함께 낡는다 —
 *   test/world.ts 가 그 어긋남을 잡는다.
 *
 * ★ 왜 파일인가 (DB 에 직접 넣지 않고): room_text 는 캐시다. 볼륨이 날아가면
 *   같이 날아간다. 사람이 쓴 문장은 캐시가 아니라 **내용**이므로 커밋되어야
 *   하고, 리뷰될 수 있어야 하고, 재해에서 복구되어야 한다. CLAUDE.md 가
 *   "플레이어에게 보이는 문장은 전부 파일에 있다" 고 적은 그 규약이다.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  JsonScalar,
  NpcLineRenderer,
  NpcLineRequest,
  RoomTextRenderer,
  RoomTextRequest,
  RoomTextResult,
} from "../../shared/narration";

const HERE = dirname(fileURLToPath(import.meta.url));
/** content/authored/ — content/world/ 와 같은 층위다. 이미지가 content/ 를
 *  통째로 COPY 하므로 런타임에도 읽힌다 (test/deploy.ts ⓪-c 가 대조한다). */
const DEFAULT_DIR = join(HERE, "..", "..", "content", "authored");

/** 한 자리의 문장 하나. `when` 은 '이 문장이 어느 플래그 상태를 위해 쓰였는가' 다.
 *
 *  ★ when 이 왜 필요한가: 방 12개가 플래그에 반응한다. 파수꾼이 아직 서 있을
 *    때 쓴 문장을 파수꾼이 죽은 뒤에도 그대로 내보내면, 그건 캐시 버그가
 *    아니라 **거짓말**이다. 그래서 요청의 투영 플래그와 정확히 같을 때만 쓴다.
 *    다르면 폴백으로 떨어진다 — 틀린 문장보다 밋밋한 문장이 낫다. */
export interface AuthoredEntry {
  readonly when: Readonly<Record<string, JsonScalar>>;
  readonly text: string;
}

export interface AuthoredFile {
  /** 파일명이 곧 버전인 프롬프트와 달리, 여기서는 이 필드가 버전이다.
   *  room_text.prompt_version 에 그대로 들어가 '어느 판의 문장인가' 를 남긴다. */
  readonly version: string;
  /** roomId -> 후보들. */
  readonly rooms?: Readonly<Record<string, readonly AuthoredEntry[]>>;
  /** `npcId/topic` -> 후보들. */
  readonly npc?: Readonly<Record<string, readonly AuthoredEntry[]>>;
}

export interface Authored {
  readonly rooms: ReadonlyMap<string, readonly AuthoredEntry[]>;
  readonly npc: ReadonlyMap<string, readonly AuthoredEntry[]>;
  readonly version: string;
}

/** 지역마다 한 파일. 없으면 빈 것을 돌려준다 — 아직 아무것도 안 쓴 세계도
 *  정상이고, 그때는 폴백과 모델이 하던 일을 그대로 한다. */
export function loadAuthored(dir = process.env.MUD_AUTHORED_DIR ?? DEFAULT_DIR): Authored {
  const rooms = new Map<string, readonly AuthoredEntry[]>();
  const npc = new Map<string, readonly AuthoredEntry[]>();
  const versions: string[] = [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return { rooms, npc, version: "authored.none" };
  }
  for (const f of files) {
    const raw = JSON.parse(readFileSync(join(dir, f), "utf8")) as AuthoredFile;
    versions.push(raw.version);
    for (const [k, v] of Object.entries(raw.rooms ?? {})) {
      /* ★ 같은 자리를 두 파일이 쓰면 어느 쪽이 이기는지가 파일 이름 순서에
         달리게 된다. 조용히 이기게 두지 않고 죽는다 — 문장이 둘이라는 것은
         둘 중 하나가 낡았다는 뜻이고, 어느 쪽인지는 사람만 안다. */
      if (rooms.has(k)) throw new Error(`${dir}: 방 ${k} 의 문장이 두 파일에 있다 (${f}).`);
      rooms.set(k, v);
    }
    for (const [k, v] of Object.entries(raw.npc ?? {})) {
      if (npc.has(k)) throw new Error(`${dir}: 대사 ${k} 가 두 파일에 있다 (${f}).`);
      npc.set(k, v);
    }
  }
  return { rooms, npc, version: versions.length === 1 ? versions[0]! : `authored(${files.length})` };
}

/** 요청의 투영 플래그와 `when` 이 **정확히** 같은가.
 *
 *  느슨하게 (부분 일치로) 맞추고 싶은 유혹이 있지만, 그러면 플래그를 하나
 *  더 선언한 방이 옛 문장을 계속 쓴다. 정확히 같을 때만이라는 규칙은
 *  '새 상태에는 새 문장을 쓴다' 를 강제한다. */
function matches(when: Readonly<Record<string, JsonScalar>>, flags: RoomTextRequest["flags"]): boolean {
  const got = Object.fromEntries(flags);
  const a = Object.keys(when).sort();
  const b = Object.keys(got).sort();
  if (a.length !== b.length || a.some((k, i) => k !== b[i])) return false;
  return a.every((k) => when[k] === got[k]);
}

const pick = (
  entries: readonly AuthoredEntry[] | undefined,
  flags: RoomTextRequest["flags"],
): AuthoredEntry | undefined => entries?.find((e) => matches(e.when, flags));

/** 방 묘사. 쓰인 것이 없으면 fallback 에게 넘긴다. */
export function makeAuthoredRenderer(
  fallback: RoomTextRenderer,
  authored: Authored = loadAuthored(),
): RoomTextRenderer {
  return async (req: RoomTextRequest): Promise<RoomTextResult> => {
    const hit = pick(authored.rooms.get(req.roomId), req.flags);
    if (!hit) return fallback(req);
    return { text: hit.text, source: "authored", model: null, promptVersion: authored.version };
  };
}

/** NPC 대사. 키는 `npcId/topic` 이다 — 큐의 키(':')와 겹치지 않게 '/' 를 쓴다. */
export function makeAuthoredNpcRenderer(
  fallback: NpcLineRenderer,
  authored: Authored = loadAuthored(),
): NpcLineRenderer {
  return async (req: NpcLineRequest): Promise<RoomTextResult> => {
    const hit = pick(authored.npc.get(`${req.npcId}/${req.topic}`), req.flags);
    if (!hit) return fallback(req);
    return { text: hit.text, source: "authored", model: null, promptVersion: authored.version };
  };
}
