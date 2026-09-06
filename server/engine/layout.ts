/* 지역 배치(타일 격자) 생성기. 저작 시점에 한 번 돌고 결과가 커밋된다.
 *
 * ★ 왜 engine/ 인가: 맵 구조는 '세계의 진실' 이다 (규칙 1). LLM 은 이것을
 *   만들지 않는다 — 만들게 하면 연결성도, 출구가 벽 자리라는 성질도,
 *   'E' 타일과 적 배치의 짝도 아무것도 보장되지 않는다. 배치는 코드가 만들고
 *   LLM 은 그 위에 문장만 얹는다. 이 분업이 이 파일의 존재 이유다.
 *
 * ★ 왜 순수한가: 난수를 주입받고 파일을 모른다. 같은 시드는 같은 격자를 낸다 —
 *   그래서 브리프에 시드를 적어 두면 나중에 누구든 같은 지도를 다시 만들 수 있고,
 *   "이 지도가 어디서 왔는가" 가 커밋 안에 남는다.
 *
 * 알고리즘: 프론티어 굴착. 가운데 한 칸에서 시작해, 이미 뚫린 칸에 붙어 있는
 * 벽 칸 중 하나를 무작위로 골라 뚫는다. '뚫린 이웃이 1개 이하일 때만' 뚫으므로
 * 넓은 광장이 아니라 통로가 나온다. 가끔(loopChance) 2개까지 허용해 고리를
 * 만든다 — 완전한 나무 미로는 막다른 길이 너무 많아 걷기 지루하다.
 *
 * 뚫는 순간 반드시 이미 뚫린 칸에 붙어 있으므로 결과는 '항상 연결되어 있다'.
 * 이것이 이 알고리즘을 고른 이유다: 연결성을 나중에 검사해 고치는 것이 아니라
 * 만들어질 수 없게 한다. */

import type { Rng } from "./rng";

export interface LayoutOptions {
  /** 목표 '걷는 칸' 수. 지역 하나는 50방쯤이 적당하다 (engine/map.ts 참조). */
  rooms: number;
  /** 뚫린 이웃이 2개인 칸도 뚫을 확률 = 고리가 생길 확률.
   *  0 이면 완전한 나무(막다른 길 투성이), 크면 광장이 된다. */
  loopChance?: number;
}

const N = [
  [0, -1],
  [0, 1],
  [-1, 0],
  [1, 0],
] as const;

/** `"x,y"` 집합을, 1칸 벽 테두리를 두른 최소 격자 문자열로. */
function render(carved: ReadonlySet<string>): string[] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const k of carved) {
    const [x, y] = k.split(",").map(Number) as [number, number];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const w = maxX - minX + 3; // 양쪽 테두리
  const h = maxY - minY + 3;
  const rows: string[] = [];
  for (let y = 0; y < h; y++) {
    let row = "";
    for (let x = 0; x < w; x++) {
      row += carved.has(`${x + minX - 1},${y + minY - 1}`) ? "." : "#";
    }
    rows.push(row);
  }
  return rows;
}

export function generateLayout(opts: LayoutOptions, rng: Rng): string[] {
  const rooms = Math.floor(opts.rooms);
  if (!Number.isFinite(rooms) || rooms < 1) throw new Error(`rooms 는 1 이상이어야 한다 (${opts.rooms}).`);
  const loopChance = opts.loopChance ?? 0.12;

  /* 넉넉한 작업 격자에서 뚫고 나중에 잘라낸다. 미로는 내부 면적의 절반쯤을
     채우므로 목표의 서너 배를 잡아 두면 프론티어가 먼저 마르는 일이 없다. */
  const side = Math.max(7, Math.ceil(Math.sqrt(rooms)) * 3 + 4);
  const inside = (x: number, y: number): boolean => x >= 1 && y >= 1 && x < side - 1 && y < side - 1;

  const carved = new Set<string>();
  const neighborsCarved = (x: number, y: number): number =>
    N.reduce((n, [dx, dy]) => n + (carved.has(`${x + dx},${y + dy}`) ? 1 : 0), 0);

  /* 프론티어에 같은 칸이 여러 번 들어갈 수 있다. 그대로 둔다 — 이웃이 많은
     칸일수록 자주 뽑히는 편향이 통로를 자연스럽게 만들고, 무엇보다 결정론이
     깨지지 않는다 (Set 을 쓰면 순회 순서에 기대게 된다). */
  const frontier: [number, number][] = [];
  const push = (x: number, y: number): void => {
    for (const [dx, dy] of N) {
      const nx = x + dx;
      const ny = y + dy;
      if (inside(nx, ny) && !carved.has(`${nx},${ny}`)) frontier.push([nx, ny]);
    }
  };

  const mid = Math.floor(side / 2);
  carved.add(`${mid},${mid}`);
  push(mid, mid);

  while (carved.size < rooms && frontier.length > 0) {
    const i = rng.int(0, frontier.length - 1);
    const [x, y] = frontier[i]!;
    frontier[i] = frontier[frontier.length - 1]!;
    frontier.pop();
    if (carved.has(`${x},${y}`)) continue;
    const n = neighborsCarved(x, y);
    // n === 0 은 프론티어에 들어올 때 이웃이 뚫려 있었는데 그 사이 바뀐 경우가
    // 없으므로 실제로는 일어나지 않는다. n >= 2 는 고리다.
    if (n > 1 && !(n === 2 && rng.chance(loopChance))) continue;
    carved.add(`${x},${y}`);
    push(x, y);
  }

  if (carved.size < rooms) {
    // 격자를 다 쓰고도 모자랐다. 여기까지 오면 side 공식이 틀린 것이다.
    throw new Error(`배치 생성 실패: ${rooms}칸을 요청했는데 ${carved.size}칸에서 막혔다.`);
  }
  return render(carved);
}

/** 걷는 칸이 전부 서로 이어져 있는가. 생성기는 구조적으로 보장하지만,
 *  사람이 손으로 그린 격자에는 이 검사가 필요하다 — 갈 수 없는 방은
 *  씨앗도 생성 비용도 그대로 먹으면서 아무도 못 본다. */
export function connectedComponents(tiles: readonly string[]): number {
  const walk = (x: number, y: number): boolean => (tiles[y]?.[x] ?? "#") !== "#";
  const seen = new Set<string>();
  let components = 0;
  for (let y = 0; y < tiles.length; y++) {
    for (let x = 0; x < (tiles[y]?.length ?? 0); x++) {
      if (!walk(x, y) || seen.has(`${x},${y}`)) continue;
      components++;
      const stack: [number, number][] = [[x, y]];
      seen.add(`${x},${y}`);
      while (stack.length) {
        const [cx, cy] = stack.pop()!;
        for (const [dx, dy] of N) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (walk(nx, ny) && !seen.has(`${nx},${ny}`)) {
            seen.add(`${nx},${ny}`);
            stack.push([nx, ny]);
          }
        }
      }
    }
  }
  return components;
}

/** 그 칸에서 갈 수 있는 방향들 + 모양. 씨앗을 쓰는 프롬프트에 넣는다 —
 *  이웃을 알려주지 않으면 모델이 지도에 없는 문과 계단을 만들어낸다. */
export function shapeOf(tiles: readonly string[], x: number, y: number): string {
  const walk = (ax: number, ay: number): boolean => (tiles[ay]?.[ax] ?? "#") !== "#";
  const names: string[] = [];
  if (walk(x, y - 1)) names.push("북");
  if (walk(x, y + 1)) names.push("남");
  if (walk(x - 1, y)) names.push("서");
  if (walk(x + 1, y)) names.push("동");
  const kind =
    names.length === 1 ? "막다른 곳" : names.length === 2 ? "통로" : names.length === 3 ? "갈림길" : "네거리";
  return `${names.join("·")} (${kind})`;
}
