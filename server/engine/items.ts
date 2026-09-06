/* 아이템의 '선언'. SEEDS / ENEMIES / NPCS 와 같은 방식으로 코드가 소유하고,
 * player_items 표는 '누가 몇 개 갖고 있는가' 만 안다.
 *
 * ★ 회복량이 범위가 아니라 고정값이다. 전투의 피해는 난수여야 리듬이 살지만
 *   (그리고 그 난수는 주입된 시드 PRNG 다), 물약까지 흔들 이유가 없다.
 *   고정이면 전투 밖에서 마실 때 난수원을 따로 만들 필요도 없고, 사람이
 *   "이걸 마시면 얼마나 차는가" 를 셀 수 있다.
 *
 * ★ 이 파일은 engine/ 이므로 DB 도 narration/ 도 모른다. 이름은 여기 있지만
 *   문장은 narration/lines.ts 가 만든다 — 아이템 '이름' 은 세계의 사실이고
 *   "물약을 마셨다" 는 문장이다. */

export interface ItemDef {
  readonly id: string;
  readonly name: string;
  /** potion  — 쓰면 사라진다.
   *  trophy  — 쓸 수 없다. 그 적을 쓰러뜨렸다는 사실 자체가 내용이다. */
  readonly kind: "potion" | "trophy";
  /** potion 이 회복시키는 양. trophy 는 null. */
  readonly heal: number | null;
}

export const ITEMS: Readonly<Record<string, ItemDef>> = {
  minor_potion: {
    id: "minor_potion",
    name: "낡은 물약",
    kind: "potion",
    /* 14 는 플레이어 최대 체력(40)의 1/3 을 조금 넘는다. '응급 치료' 스킬과
       겹치지 않게 잡은 값이다 — 스킬은 쿨다운으로 아끼고, 물약은 개수로
       아낀다. 둘 다 다음 호흡에 나가므로 급할 때는 둘 다 늦다. */
    heal: 14,
  },
  warden_shard: {
    id: "warden_shard",
    name: "파수꾼의 파편",
    kind: "trophy",
    heal: null,
  },
};

export const itemDef = (id: string): ItemDef | undefined => ITEMS[id];
