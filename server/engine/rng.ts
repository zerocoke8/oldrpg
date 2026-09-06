/* 시드된 난수. engine/ 은 Math.random() 이 린트로 막혀 있다
   (.eslintrc.cjs 의 no-restricted-syntax) — 엔진이 결정론이어야 하기 때문이다.

   전투마다 시드를 하나 주고, 그 시드 + 액션 순서만 있으면 전투 전체가
   똑같이 재현된다. 그래서:
     - 테스트가 데미지 굴림까지 결정론적이 된다
     - "그 전투 왜 그렇게 끝났나" 를 재현해 볼 수 있다
     - 4단계가 끝난 뒤 '전투 리플레이' 를 붙이는 것이 순수 가산이 된다

   mulberry32 — 32비트 상태, 빠르고 분포가 충분히 고르다. 암호용이 아니다
   (전투 굴림에 암호 강도는 필요 없고, 필요해지는 날은 서버가 굴린다는
   사실 자체가 이미 방어다). */

export interface Rng {
  /** [0, 1) */
  next(): number;
  /** [lo, hi] 정수, 양 끝 포함. 프로토타입의 rnd(a,b) 와 같은 규약. */
  int(lo: number, hi: number): number;
  /** 확률 p 로 true. */
  chance(p: number): boolean;
  /** 지금까지 몇 번 굴렸는가. 재현 검증용. */
  readonly rolls: number;
}

export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  let rolls = 0;
  const next = (): number => {
    rolls++;
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    get rolls() {
      return rolls;
    },
  };
}
