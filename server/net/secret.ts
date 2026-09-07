/* 비밀번호의 저장 형식과 검증. DB 도 세션도 모른다 — 문자열이 들어와서
 * 문자열이 나간다.
 *
 * ★ 저장 형식이 자기를 설명한다 (PHC 꼴):
 *
 *     scrypt$N=32768,r=8,p=1$<salt b64url>$<dk b64url>
 *
 *   파라미터를 칼럼 넷으로 쪼개지 않는 이유: N 을 올리는 일이 마이그레이션이
 *   아니라 '다음 로그인에 재해시' 가 된다. 옛 형식으로 저장된 사람도 그대로
 *   검증되고, verify() 가 stale=true 로 알려 주면 호출자가 조용히 다시 쓴다.
 *
 * ★ 왜 동기 scrypt 가 아닌가: 실측으로 8회 순차 동기 호출이 이벤트 루프를
 *   705ms 막았다 (비동기 8개 동시는 최대 2.8ms). 이 서버는 0.5초 전투 틱과
 *   ws 하트비트를 든 단일 프로세스라, 로그인 여덟 번이 전투를 멈춘다.
 *
 * ★ 그래서 동시 실행에 상한을 둔다. 비동기라도 scrypt 는 libuv 스레드풀
 *   (기본 4)을 쓰므로, 상한이 없으면 로그인 폭주가 fs 읽기까지 굶긴다.
 *
 * ★ node 의 기본 maxmem 은 32MiB 라 N=2^15,r=8 이 그대로는 죽는다
 *   (ERR_CRYPTO_INVALID_SCRYPT_PARAMS 를 실제로 확인했다). 필요한 것은
 *   대략 128*N*r = 32MiB 이고, 여유를 두어 128MiB 로 연다.
 */

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const N = 32768;
const R = 8;
const P = 1;
const KEYLEN = 32;
const MAXMEM = 128 * 1024 * 1024;
/** 동시에 도는 scrypt 의 상한. libuv 스레드풀 기본이 4 라 그 절반. */
const CONCURRENCY = 2;

const b64 = (b: Buffer): string => b.toString("base64url");

let running = 0;
const waiting: (() => void)[] = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= CONCURRENCY) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (err, dk) =>
      err ? reject(err) : resolve(dk),
    );
  });
}

/** 새 비밀번호를 저장 형식으로. */
export async function hashSecret(password: string): Promise<string> {
  const salt = randomBytes(16);
  const dk = await withSlot(() => derive(password, salt, N, R, P));
  return `scrypt$N=${N},r=${R},p=${P}$${b64(salt)}$${b64(dk)}`;
}

export interface VerifyResult {
  ok: boolean;
  /** 저장된 파라미터가 지금 기준보다 약하다 — 호출자가 조용히 다시 쓸 자리. */
  stale: boolean;
}

/** 저장된 형식과 대조한다. 형식이 깨져 있어도 던지지 않는다 — 던지면
 *  '그 계정은 있는데 저장이 이상하다' 가 타이밍으로 새어 나간다. */
export async function verifySecret(password: string, stored: string): Promise<VerifyResult> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return { ok: false, stale: false };
  const params = Object.fromEntries(
    parts[1]!.split(",").map((kv) => {
      const [k, v] = kv.split("=");
      return [k, Number(v)];
    }),
  ) as { N?: number; r?: number; p?: number };
  const n = params.N ?? 0;
  const r = params.r ?? 0;
  const p = params.p ?? 0;
  if (!n || !r || !p) return { ok: false, stale: false };
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[2]!, "base64url");
    expected = Buffer.from(parts[3]!, "base64url");
  } catch {
    return { ok: false, stale: false };
  }
  if (expected.length !== KEYLEN) return { ok: false, stale: false };
  let dk: Buffer;
  try {
    dk = await withSlot(() => derive(password, salt, n, r, p));
  } catch {
    return { ok: false, stale: false };
  }
  // 길이가 같음을 위에서 확인했으므로 timingSafeEqual 이 던지지 않는다.
  return { ok: timingSafeEqual(dk, expected), stale: n < N || r < R || p < P };
}

/** ★ 모르는 이름에도 같은 시간을 쓰기 위한 것. 없는 계정이면 즉시 돌아가는
 *  구현은 '그 이름이 있는가' 를 타이밍으로 알려 준다. 모듈 로드 시점에 한 번
 *  만들어 두고, 모르는 이름일 때 이것과 대조한다 (결과는 언제나 거짓). */
export const DUMMY_SECRET = hashSecret(randomBytes(32).toString("hex"));

/** 사람이 입력한 계정 이름 -> 조회 키. NFKC 정규화 + 소문자.
 *  DDL 의 CHECK (name_key = lower(name_key)) 가 이 함수를 빼먹는 것을 막는다. */
export const nameKeyOf = (name: string): string => name.normalize("NFKC").trim().toLowerCase();
