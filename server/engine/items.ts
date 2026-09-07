/* 아이템의 '타입'. 값은 content/balance/items.json 이 소유한다
 * (engine/enemies.ts 의 머리 주석에 그 이유가 있다).
 *
 * ★ 이름은 세계의 사실이라 여기 계약에 있고, 문장은 narration/lines.ts 가
 *   만든다 — "물약을 마셨다" 는 문장이고 "낡은 물약" 은 이름이다. */

export interface ItemDef {
  readonly id: string;
  readonly name: string;
  /** potion  — 쓰면 사라진다.
   *  trophy  — 쓸 수 없다. 그 적을 쓰러뜨렸다는 사실 자체가 내용이다. */
  readonly kind: "potion" | "trophy";
  /** potion 이 회복시키는 양. trophy 는 null. */
  readonly heal: number | null;
}

/** 남에게 건넬 수 있는가.
 *
 *  ★ 증표는 안 된다. 그 적을 쓰러뜨렸다는 사실 자체가 내용이라(위 kind 주석),
 *    넘겨받은 증표는 증표가 아니다. 그리고 그것이 등급 사다리를 지킨다 —
 *    ranks.json 2·3급의 유일한 재료가 dark_shard 이고 등급은 지역 문의
 *    열쇠인데, 승급은 되돌아가지 않는다(queries.ts 의 MAX). 한 사람이 남을
 *    3급까지 밀어 올릴 수 있으면 사다리는 기록이 아니라 선물이 된다.
 *
 *  ★ 왜 items.json 의 tradable 필드가 아닌가: 수치를 데이터로 둔 이유는
 *    "바꿔도 공짜다 — 되돌릴 수 있고" 인데, 증표를 건넬 수 있게 한 순간은
 *    되돌릴 수 없다(이미 올라간 등급이 남는다). 되돌릴 수 없는 결정은
 *    리뷰를 거치는 자리에 있어야 한다.
 *
 *  ★ 오늘 usable 과 식이 같지만 다른 규칙이다 — kind 가 하나 늘면 갈린다.
 *    모르는 kind 는 건넬 수 없다: 데이터가 침묵하면 안전한 쪽이다. */
export const givable = (def: ItemDef): boolean => def.kind === "potion";
