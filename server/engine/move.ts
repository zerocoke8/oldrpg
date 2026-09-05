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
 * (.eslintrc.cjs 의 no-restricted-syntax 가 Math.random 을 빌드 에러로 막는다.) */

import type { Dir, Pos } from "../../shared/ids";
import { step } from "../../shared/ids";
import { walkableAt } from "./map";

export type MoveResult = { ok: true; to: Pos } | { ok: false; reason: "blocked" };

/** 클라이언트가 보낸 것은 '방향'뿐이다. 목표 좌표는 서버가 자기가 들고 있는
 *  위치에서 계산한다 — 그래서 좌표 위조를 검증으로 막을 필요가 없다.
 *  애초에 클라이언트에게 좌표를 주장할 문법이 없다. */
export function resolveMove(from: Pos, dir: Dir): MoveResult {
  const to = step(from, dir);
  if (!walkableAt(to)) return { ok: false, reason: "blocked" };
  return { ok: true, to };
}
