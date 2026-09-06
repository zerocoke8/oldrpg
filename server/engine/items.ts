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
