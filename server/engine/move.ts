/* 이동 판정. 엔진의 전부이자, 1단계에서 '진실'이 계산되는 유일한 곳.
 *
 * ★ 엔진의 규약 (4단계 전투 시그니처를 지금 결정한다):
 *   엔진 함수는 순수하다. 상태를 '바꾸지' 않고, 무엇이 바뀌어야 하는지를
 *   반환값으로만 낸다. 영속화도 방출도 호출자(world/ 또는 net/)의 일이다.
 *   그래서 4단계 전투는 이런 모양이 된다:
 *     resolveAttack(attacker, target, roll) =>
 *       { damage: 7, effects: [{ type: "flag", key: "guardian_slain", value: true }] }
 *   이 규약을 나중에 정하면 engine/ 전면 수정이 된다.
 *
 * 난수도 시각도 엔진이 스스로 만들지 않는다 — 호출자가 주입한다.
 * (.eslintrc.cjs 의 no-restricted-syntax 가 Math.random 을 빌드 에러로 막는다.)
 * 플래그도 마찬가지다: 봉인된 문이 열렸는지는 DB 가 아는 사실이므로
 * 읽는 함수를 주입받는다. 엔진은 db/ 를 import 하지 않는다. */

import type { Dir, Pos } from "../../shared/ids";
import { step } from "../../shared/ids";
import type { GameMap } from "./map";

export type MoveResult =
  | { ok: true; to: Pos; via: "step" | "door" }
  /** wall   — 그냥 벽이다
   *  sealed — 문은 있는데 조건 플래그가 아직 꺼져 있다
   *  둘을 나누는 것은 '문장' 을 위해서다. 와이어의 ack.reason 은 둘 다
   *  "blocked" 하나로 남는다 — 클라이언트가 알 필요가 없고, 알면 지도에
   *  없는 문의 존재가 새어 나간다. */
  | { ok: false; reason: "wall" | "sealed" };

/** 클라이언트가 보낸 것은 '방향'뿐이다. 목표 좌표는 서버가 자기가 들고 있는
 *  위치에서 계산한다 — 그래서 좌표 위조를 검증으로 막을 필요가 없다.
 *  애초에 클라이언트에게 좌표를 주장할 문법이 없다.
 *
 *  ★ 문을 한 칸 이동보다 '먼저' 본다. 출구는 벽 자리에만 있으므로(부팅에서
 *    검증한다) 실제로 겹치는 일은 없지만, 순서를 명시해 두면 나중에 누가
 *    걸을 수 있는 칸에 문을 달아도 판정이 흔들리지 않는다. */
export function resolveMove(
  map: GameMap,
  from: Pos,
  dir: Dir,
  isFlagOn: (key: string) => boolean,
): MoveResult {
  const door = map.exitAt(from, dir);
  if (door) {
    if (door.requires !== null && !isFlagOn(door.requires)) return { ok: false, reason: "sealed" };
    // 목적지가 걸을 수 있는 칸인 것은 부팅에서 검증했다. 그래도 한 번 더 본다 —
    // 이 함수의 사후조건은 "반환한 to 는 설 수 있는 칸" 이다.
    if (!map.walkableAt(door.to)) return { ok: false, reason: "wall" };
    return { ok: true, to: door.to, via: "door" };
  }
  const to = step(from, dir);
  if (!map.walkableAt(to)) return { ok: false, reason: "wall" };
  return { ok: true, to, via: "step" };
}
