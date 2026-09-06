/* 테스트가 쓰는 '고정 세계'. 운영 콘텐츠(content/world/, content/balance/)와
 * 완전히 분리돼 있다.
 *
 * ★ 왜 분리하는가: 세계관을 갈아끼웠더니 테스트 280곳이 한꺼번에 깨졌다.
 *   프로토콜·전투·인벤토리·UI 검사는 '어떤 세계인가' 와 아무 상관이 없어야
 *   한다. 좌표와 문장을 운영 데이터에서 읽어 오는 순간, 방 하나를 옮기는
 *   일이 무관한 검사 백 개를 빨갛게 만든다.
 *
 * ★ 그래서 이 파일은 '얼어붙은' 것이다. 게임 내용이 바뀌어도 여기는 안 바뀐다.
 *   반대로 여기를 고치는 것은 검사의 전제를 고치는 일이므로 그만한 이유가
 *   있어야 한다.
 *
 * 내용은 이 프로젝트의 첫 세계(지하 서고)를 그대로 옮긴 것이다 — 이미 모든
 * 검사가 이 좌표와 문장을 알고 있었으므로, 옮기면서 한 글자도 바꾸지 않았다.
 * 플래그(guardian_slain)도 여기서 선언한다 — 운영 세계에 플래그가 늘거나
 * 이름이 바뀌어도 검사는 그대로다.
 *
 * 운영 콘텐츠 자체를 검사하는 곳은 여기를 쓰지 않는다:
 *   test/world.ts    씨앗이 안 바뀌었는가 (얼어붙은 seed_id 표)
 *   test/regions.ts  실제 지역 데이터의 정합성
 *   test/balance.ts  실제 밸런스 파일
 *   test/author.ts   저작 도구가 실제 디렉터리를 다룬다 */

import type { MapData } from "../server/engine/map";
import type { Balance, EnemyDef, ItemDef, SkillDef } from "../server/engine/enemies";
import type { Mood } from "../server/narration/prompts";

export const FIXTURE_WORLD: MapData = {
  "flags": { "guardian_slain": { "default": "false", "broadcast": true } },
  "spawn": {
    "region": "b1",
    "x": 3,
    "y": 3
  },
  "regions": [
    {
      "id": "b1",
      "name": "지하 1층",
      "tiles": [
        "#######",
        "#..TE.#",
        "#.###E#",
        "#..S..#",
        "#.###.#",
        "#..E..#",
        "#######"
      ],
      "seeds": {
        "1,1": "무너진 서고의 서쪽 끝. 쓰러진 책장이 길을 반쯤 막고 있다",
        "2,1": "곰팡이 핀 책 더미 사이의 좁은 통로",
        "3,1": "낮은 제단 위에 낡은 상자가 놓여 있다",
        "4,1": "벽에 그을린 손자국이 줄지어 나 있다",
        "5,1": "갈라진 동쪽 벽에서 찬 바람이 새어든다",
        "1,2": "이끼로 미끄러운 계단참",
        "5,2": "녹슨 쇠창살이 반쯤 열린 채 굳어 있다",
        "1,3": "물이 발목까지 고인 서쪽 회랑",
        "2,3": "천장에서 물방울이 규칙적으로 떨어진다",
        "3,3": "한때 네 갈래였을 석조 교차로. 남북 통로는 무너진 돌더미에 막혀 동서로만 길이 트여 있다",
        "4,3": "부서진 갑옷 조각이 바닥에 흩어져 있다",
        "5,3": "동쪽 벽에 알아볼 수 없는 문자가 새겨져 있다",
        "1,4": "좁고 가파른 내리막",
        "5,4": "벽 틈에서 희미한 붉은 빛이 스며나온다",
        "1,5": "천장이 낮아 몸을 숙여야 하는 굴",
        "2,5": "바닥에 마른 핏자국이 길게 이어진다",
        "3,5": "기둥이 늘어선 넓은 홀. 어둠 속에서 무언가 움직인다",
        "4,5": "부서진 기둥들이 늘어선 폐허",
        "5,5": "막다른 곳. 벽에 봉인된 문이 있다"
      },
      "sensitive": {
        "1,4": [
          "guardian_slain"
        ],
        "5,4": [
          "guardian_slain"
        ],
        "1,5": [
          "guardian_slain"
        ],
        "2,5": [
          "guardian_slain"
        ],
        "3,5": [
          "guardian_slain"
        ],
        "4,5": [
          "guardian_slain"
        ],
        "5,5": [
          "guardian_slain"
        ]
      },
      "enemies": {
        "3,5": "shadow_warden",
        "4,1": "ashen_pages",
        "5,2": "rusted_watcher"
      },
      "npcs": {
        "clerk": {
          "at": "1,1",
          "name": "시험 접수원",
          "persona": "검사를 위한 접수원",
          "sensitiveFlags": [],
          "guild": true,
          "topics": [
            { "id": "greet", "label": null, "seed": "등급부터 확인한다", "requires": null }
          ]
        },
        "sweeper": {
          "at": "1,1",
          "name": "청소부",
          "persona": "접수대 옆을 쓸고 있는 사람. 길드 일과는 아무 상관이 없다",
          "sensitiveFlags": [],
          "topics": [
            { "id": "greet", "label": null, "seed": "빗자루를 멈추지 않는다", "requires": null }
          ]
        },
        "altar_keeper": {
          "at": "3,1",
          "name": "제단지기",
          "persona": "무너진 서고의 제단을 지키는 늙은 사제. 눈이 어둡고 말수가 적다. 짧게 끊어 말하며, 묻지 않은 것은 말하지 않는다",
          "sensitiveFlags": [
            "guardian_slain"
          ],
          "topics": [
            {
              "id": "greet",
              "label": null,
              "seed": "낯선 이를 흘깃 보고는 다시 제단으로 시선을 돌린다. 인사라기보다 확인에 가깝다",
              "requires": null
            },
            {
              "id": "warden",
              "label": "파수꾼에 대해",
              "seed": "남쪽 홀을 지키는 그림자 파수꾼. 오래전부터 거기 있었고, 무엇을 지키는지는 말하지 않는다",
              "requires": null
            },
            {
              "id": "altar",
              "label": "제단에 대해",
              "seed": "제단 위의 낡은 상자. 자신이 지키는 것이지만 열어 본 적은 없다",
              "requires": null
            },
            {
              "id": "sealed_door",
              "label": "봉인된 문에 대해",
              "seed": "동쪽 끝의 봉인된 문. 파수꾼이 사라진 지금에야 말할 수 있는 것이고, 그 너머에 무엇이 있는지는 자신도 모른다",
              "requires": "guardian_slain"
            }
          ]
        }
      },
      "exits": [
        {
          "at": "5,5",
          "dir": "east",
          "to": {
            "region": "b2",
            "x": 1,
            "y": 3
          },
          "requires": "guardian_slain",
          "minRank": 0,
          "oneWay": false
        }
      ]
    },
    {
      "id": "b2",
      "name": "봉인된 서고",
      "tiles": [
        "#####",
        "#..E#",
        "#.#.#",
        "#...#",
        "#####"
      ],
      "seeds": {
        "1,1": "천장까지 닿는 서가가 무너지지 않은 채 서 있다. 먼지가 손대지 않은 두께로 쌓였다",
        "2,1": "바닥에 백묵으로 그린 원이 반쯤 지워져 있다",
        "3,1": "쇠사슬에 묶인 책상. 사슬은 책상이 아니라 그 위의 것을 묶고 있었다",
        "1,2": "좁은 서가 사이. 어깨가 양쪽에 닿는다",
        "3,2": "벽을 따라 촛농이 굳어 흘러내렸다. 오래전에 꺼진 것이다",
        "1,3": "봉인된 문의 안쪽. 돌아보면 문틀만 남아 있다",
        "2,3": "발밑의 돌이 하나씩 어긋나 있다. 무언가를 파냈던 자리다",
        "3,3": "가장 안쪽. 빈 받침대 하나가 남아 있다"
      },
      "sensitive": {},
      "enemies": {
        "3,1": "rusted_watcher"
      },
      "npcs": {},
      "exits": [
        {
          "at": "1,3",
          "dir": "west",
          "to": {
            "region": "b1",
            "x": 5,
            "y": 5
          },
          "requires": null,
          "minRank": 0,
          "oneWay": false
        },
        {
          "at": "3,3",
          "dir": "south",
          "to": {
            "region": "b3",
            "x": 3,
            "y": 1
          },
          "requires": null,
          "minRank": 0,
          "oneWay": false
        }
      ]
    },
    {
      "id": "b3",
      "name": "물에 잠긴 계단",
      "tiles": [
        "##########",
        "###.######",
        "###.######",
        "###..#.#.#",
        "#........#",
        "#.##.#.###",
        "###..#####",
        "####...###",
        "######.E##",
        "##########"
      ],
      "seeds": {
        "3,1": "나선 계단이 여기서 끊겼다. 난간이 반쯤 떨어져 나간 채 벽에 박혀 있다",
        "3,2": "층계참 사이의 좁은 내리막. 돌 표면이 물기로 검게 젖었다",
        "3,3": "물소리가 처음으로 들리는 곳. 세 갈래가 여기서 만난다",
        "4,3": "벽에 수위를 표시한 눈금이 새겨져 있다. 가장 높은 줄은 머리 위다",
        "6,3": "천장이 내려앉아 생긴 우묵한 자리. 고인 물이 검고 움직이지 않는다",
        "8,3": "벽감이었을 자리. 안쪽에 진흙이 손자국 모양으로 말라붙었다",
        "1,4": "복도 서쪽 끝. 물이 발목까지 차 있고 발밑이 미끄럽다",
        "2,4": "물살이 한 방향으로 아주 느리게 흐른다. 어딘가로 빠지고 있다",
        "3,4": "젖은 종이 뭉치가 벽 아래에 밀려 쌓인 채 굳었다",
        "4,4": "네 갈래가 만나는 넓은 층계참. 물이 여기서 가장 잔잔하다",
        "5,4": "물에 뜬 책장이 통로를 반쯤 막은 채 걸려 있다",
        "6,4": "기둥 밑동이 물에 잠겨 있다. 위쪽만 마른 채 갈라졌다",
        "7,4": "바닥의 돌이 들려 물이 그 아래로 소리 없이 빨려든다",
        "8,4": "복도 동쪽 끝. 벽이 안쪽으로 배가 불러 금이 가 있다",
        "1,5": "좁게 파인 웅덩이. 정강이까지 물이 차고 바닥이 보이지 않는다",
        "4,5": "한 단씩 내려가는 계단. 세 번째 단부터 물에 잠겼다",
        "6,5": "물이 벽 틈으로 새어 나가는 자리. 끊임없이 낮은 소리가 난다",
        "3,6": "떠내려온 것들이 구석에 뭉쳐 있다. 무엇이었는지 알아볼 수 없다",
        "4,6": "무릎까지 오는 물. 걸음마다 바닥의 것들이 발에 걸린다",
        "4,7": "물이 허벅지까지 온다. 벽을 짚지 않으면 걷기 어렵다",
        "5,7": "수면 위로 서까래 끝이 몇 개 튀어나와 있다",
        "6,7": "물속에서 계단 한 단이 발끝에 닿는다. 아래로 더 있다",
        "6,8": "허리까지 잠긴 통로. 숨소리가 물 위에서 크게 들린다",
        "7,8": "가장 깊은 곳. 수면이 조금씩 흔들리는데 바람은 없다"
      },
      "sensitive": {},
      "enemies": {
        "7,8": "ashen_pages"
      },
      "npcs": {},
      "exits": [
        {
          "at": "3,1",
          "dir": "north",
          "to": {
            "region": "b2",
            "x": 3,
            "y": 3
          },
          "requires": null,
          "minRank": 0,
          "oneWay": false
        }
      ]
    }
  ]
};

/* 리터럴에 타입을 붙여 문맥 추론을 건다 — 안 붙이면 kind 가 string 으로,
   damage 가 number[] 로 넓어져 계약과 어긋난다. */
const raw: {
  player: Balance["player"];
  enemies: Record<string, Omit<EnemyDef, "id">>;
  items: Record<string, Omit<ItemDef, "id">>;
  skills: Record<string, Omit<SkillDef, "id">>;
} = {
  "player": {
    "maxHp": 40,
    "swingMs": 500,
    "damage": [
      4,
      8
    ],
    "critChance": 0.15,
    "critMult": 2,
    "respawnMs": 5000
  },
  "enemies": {
    "shadow_warden": {
      "name": "그림자 파수꾼",
      "maxHp": 200,
      "damage": [
        2,
        5
      ],
      "swingMs": 900,
      "slainFlag": "guardian_slain",
      "respawnMs": null,
      "drops": [
        {
          "itemId": "warden_shard",
          "qty": 1,
          "chance": 1
        }
      ]
    },
    "ashen_pages": {
      "name": "잿빛 종잇장",
      "maxHp": 70,
      "damage": [
        1,
        3
      ],
      "swingMs": 1100,
      "slainFlag": null,
      "respawnMs": 45000,
      "drops": [
        {
          "itemId": "minor_potion",
          "qty": 1,
          "chance": 0.5
        }
      ]
    },
    "rusted_watcher": {
      "name": "녹슨 감시자",
      "maxHp": 110,
      "damage": [
        2,
        4
      ],
      "swingMs": 950,
      "slainFlag": null,
      "respawnMs": 60000,
      "drops": [
        {
          "itemId": "minor_potion",
          "qty": 1,
          "chance": 0.8
        }
      ]
    }
  },
  "skills": {
    "heavy_strike": {
      "name": "강타",
      "cooldownMs": 4000,
      "kind": "strike",
      "power": [
        14,
        22
      ]
    },
    "mend": {
      "name": "응급 치료",
      "cooldownMs": 8000,
      "kind": "heal",
      "power": [
        12,
        18
      ]
    },
    "brace": {
      "name": "방어 태세",
      "cooldownMs": 6000,
      "kind": "guard",
      "power": [
        50,
        50
      ]
    }
  },
  "items": {
    "minor_potion": {
      "name": "낡은 물약",
      "kind": "potion",
      "heal": 14
    },
    "warden_shard": {
      "name": "파수꾼의 파편",
      "kind": "trophy",
      "heal": null
    }
  }
};

const withIds = <T>(o: Record<string, Omit<T, "id">>): Record<string, T> =>
  Object.fromEntries(Object.entries(o).map(([id, v]) => [id, { id, ...v } as T]));

const skills = withIds<SkillDef>(raw.skills);
/** 픽스처의 등급 사다리. 운영과 분리돼 있다 — 등급 수를 늘려도 검사는 그대로다. */
const FIXTURE_RANKS = [
  { level: 1, name: "시험 1급", requires: [] },
  { level: 2, name: "시험 2급", requires: [{ itemId: "warden_shard", qty: 1 }] },
] as const;

export const FIXTURE_BALANCE: Balance = {
  player: raw.player,
  ranks: FIXTURE_RANKS,
  enemies: withIds<EnemyDef>(raw.enemies),
  items: withIds<ItemDef>(raw.items),
  skills,
  skillList: Object.values(skills),
};

/** 픽스처 세계의 플래그가 프로즈에 하는 일. 운영의 moods/ 와 분리돼 있다 —
 *  검사가 게임 문구에 매달리면 문구를 다듬을 때마다 검사가 깨진다. */
export const FIXTURE_MOODS: ReadonlyMap<string, Mood> = new Map<string, Mood>([
  ["guardian_slain", {
    prompt: "이 구역을 지키던 그림자 파수꾼은 방금 쓰러졌다.\n위협이 사라진 직후의 느슨한 정적을 담아라.",
    fallback: "위협이 사라진 뒤의 느슨한 정적이 감돈다.",
    label: "파수꾼 처치됨",
    near: "주변의 공기가 달라졌다. 지나온 길이 예전 같지 않을 것이다.",
    far: "멀리서 무언가 무너지는 소리가 길게 이어지다 잦아든다.",
  }],
]);
