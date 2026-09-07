/* 계정. hello 의 auth 를 '누구로 들어가는가' 로 바꾸는 것이 전부다.
 *
 * ★ 계정은 게임 프로토콜이 아니라 **토큰을 발급하는 기계**다. 성공하면
 *   지금까지와 똑같은 무기명 토큰 하나가 나가고, 그 뒤로는 익명 경로와 글자
 *   하나도 다르지 않다. 그래서 액션 유니온도, 새 서버 메시지도 늘지 않는다.
 *
 * ★ HTTP 엔드포인트를 열지 않는다. hello 가 이미 신원 핸드셰이크다. 별도
 *   엔드포인트를 열면 이 저장소의 첫 HTTP API 표면이 생기고, 그 응답이 사람이
 *   읽을 문장을 나르는 순간 불변식 (1)이 절반만 참이 된다.
 *
 * ★ 오라클에 대해 이 파일이 지키는 것:
 *     로그인  모르는 이름과 틀린 비밀번호가 **같은 한 문장**이고 **같은 시간**이
 *             든다 (없는 이름에도 더미 해시를 대조한다).
 *     가입    "그 이름은 이미 있다" 를 말해 줘야 하므로 이름 열거는 완화만
 *             되고 없어지지 않는다. 그건 가입의 본질이라 감수한다.
 *     토큰    기기 토큰의 miss 는 익명 토큰의 miss 와 같은 경로로 흘러야 한다
 *             (둘 다 신규 생성으로 흡수). 그것은 handlers.ts 가 지킨다.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Queries } from "../db/queries";
import { DUMMY_SECRET, hashSecret, nameKeyOf, verifySecret } from "./secret";

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** 한 캐릭터가 동시에 들 수 있는 기기 토큰 수. 넘으면 가장 오래 안 쓴 것부터
 *  축출한다 — '폰과 노트북' 이 되게 하는 것이 이 표의 존재 이유이므로 1 은
 *  안 되고, 무한이면 유출된 토큰이 영원히 산다. */
export const MAX_DEVICES = 5;

export const ACCOUNT_NAME_MAX = 24;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

export interface AuthResolved {
  accountId: string;
  accountName: string;
  /** 이 계정의 캐릭터. null 이면 호출자가 새로 만들어 묶는다. */
  playerId: string | null;
  /** 이 기기에 줄 새 토큰. 원문이고, DB 에는 sha256 만 들어간다. */
  deviceToken: string;
}

export type AuthOutcome = { ok: true; resolved: AuthResolved } | { ok: false; message: string };

export interface AuthInput {
  kind: "register" | "login";
  name: string;
  password: string;
}

/** 기기 토큰을 하나 발급하고 상한을 넘은 것을 축출한다.
 *  ★ 호출자가 트랜잭션 안에서 부른다 — 발급과 축출이 갈라지면 상한이 뚫린다. */
export function issueDeviceToken(q: Queries, playerId: string, now: number): string {
  const token = randomBytes(32).toString("hex");
  q.insertDeviceToken.run({ token_hash: sha256(token), player_id: playerId, now });
  const all = q.deviceTokensOf.all(playerId); // last_used_at 내림차순
  for (const row of all.slice(MAX_DEVICES)) q.dropDeviceToken.run(row.token_hash);
  return token;
}

export async function resolveAuth(
  q: Queries,
  tx: (fn: () => void) => void,
  auth: AuthInput,
  /** 지금 들고 있는 익명 토큰. register 일 때 그 캐릭터를 계정에 묶는다. */
  bearerToken: string | null,
  now: number,
  /** 실패 문장. 코드에 프로즈를 두지 않기 위해 호출자가 넘긴다. */
  say: {
    badName: string;
    badPassword: string;
    taken: string;
    refused: string;
  },
): Promise<AuthOutcome> {
  const name = auth.name.normalize("NFKC").trim();
  const nameKey = nameKeyOf(auth.name);
  if (!nameKey || name.length > ACCOUNT_NAME_MAX) return { ok: false, message: say.badName };
  /* ★ 코드 포인트로 센다. UTF-16 단위로 세면 이모지 하나가 2로 세어져
     실제보다 길게 보이고, 반대로 상한에서는 멀쩡한 비밀번호가 잘린다. */
  const pwLen = [...auth.password].length;
  if (pwLen < PASSWORD_MIN || pwLen > PASSWORD_MAX) {
    return { ok: false, message: say.badPassword };
  }

  if (auth.kind === "register") {
    /* ★ 가입만이 이름의 존재를 알려 준다. 그게 가입의 본질이고, 감추면
       사람이 같은 이름을 몇 번이고 다시 시도한다. */
    if (q.accountByNameKey.get(nameKey)) return { ok: false, message: say.taken };
    const secret = await hashSecret(auth.password);
    const accountId = randomUUID();
    /* 들고 있던 익명 캐릭터가 있으면 그것을 데려간다 — 계정은 새 시작이
       아니라 덧옷이다. 이미 다른 계정에 묶인 캐릭터는 데려가지 않는다
       (bindPlayerToAccount 의 WHERE account_id IS NULL 이 그것을 든다). */
    const bearer = bearerToken ? q.playerByTokenHash.get(sha256(bearerToken)) : undefined;
    const claim = bearer && bearer.account_id === null ? bearer : undefined;

    let deviceToken = "";
    let playerId: string | null = null;
    try {
      tx(() => {
        q.insertAccount.run({ id: accountId, name_key: nameKey, name, secret, now });
        if (claim) {
          const bound = q.bindPlayerToAccount.run({ account_id: accountId, id: claim.id }).changes;
          if (bound === 0) throw new Error("RACE"); // 그 사이 남이 묶었다
          /* ★ 무덤 토큰. 익명 재개 토큰을 아무도 모르는 난수로 덮어써 죽인다.
             안 하면 계정을 만든 뒤에도 옛 토큰이 그 캐릭터를 그대로 연다. */
          q.buryPlayerToken.run({
            token_hash: sha256(randomBytes(32).toString("hex")),
            id: claim.id,
          });
          deviceToken = issueDeviceToken(q, claim.id, now);
          playerId = claim.id;
        }
      });
    } catch {
      // UNIQUE(name_key) 경합 포함. 무엇이 부딪혔든 같은 한 문장이다.
      return { ok: false, message: say.taken };
    }
    return { ok: true, resolved: { accountId, accountName: name, playerId, deviceToken } };
  }

  // ── 로그인 ──────────────────────────────────────────────────────────
  const acc = q.accountByNameKey.get(nameKey);
  /* ★ 모르는 이름에도 같은 시간을 쓴다. 즉시 돌아가면 '그 이름이 있는가' 가
     타이밍으로 샌다. 결과는 언제나 거짓이고, 문장도 아래와 같은 하나다. */
  const stored = acc?.secret ?? (await DUMMY_SECRET);
  const v = await verifySecret(auth.password, stored);
  if (!acc || !v.ok) return { ok: false, message: say.refused };

  const players = q.playersOfAccount.all(acc.id);
  const player = players[0];
  let deviceToken = "";
  tx(() => {
    /* 파라미터가 낡았으면 조용히 다시 쓴다 — N 을 올리는 것이 마이그레이션이
       아니라 '다음 로그인에 재해시' 인 이유가 이 한 줄이다. */
    const secret = v.stale ? undefined : acc.secret;
    q.touchAccount.run({ id: acc.id, now, secret: secret ?? acc.secret });
    if (player) deviceToken = issueDeviceToken(q, player.id, now);
  });
  if (v.stale) {
    // 재해시는 트랜잭션 밖에서 (scrypt 는 비동기다). 실패해도 로그인은 성공이다.
    hashSecret(auth.password)
      .then((fresh) => q.touchAccount.run({ id: acc.id, now, secret: fresh }))
      .catch((err: unknown) => console.error("[accounts] rehash", err));
  }
  return {
    ok: true,
    resolved: {
      accountId: acc.id,
      accountName: acc.name,
      playerId: player?.id ?? null,
      deviceToken,
    },
  };
}
