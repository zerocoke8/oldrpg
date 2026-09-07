/* 선생성이 '얼마인가' 를 말하기 위한 것. 운영 도구 전용이다 —
 * 서버도 engine/ 도 이 파일을 import 하지 않는다.
 *
 * ★ 이 파일의 유일한 목적: **돈을 쓰기 전에 자릿수를 안다.**
 *   $3 인지 $300 인지가 결정을 바꾸고, ±30% 는 아무것도 바꾸지 않는다.
 *   그래서 정밀도가 아니라 '무엇이 실측이고 무엇이 추정인가' 를 분명히 한다.
 *
 * ★ 세 가지 수가 있고 확실성이 각각 다르다:
 *     호출 수    실측이다. 세계와 DB 만 보면 정확히 나온다.
 *     입력 토큰  키가 있으면 실측이다 (count_tokens 는 공짜다). 없으면 추정.
 *     출력 토큰  추정뿐이다. 부를 때까지 아무도 모른다.
 *   보고는 이 셋을 섞지 않는다. 섞으면 전부 추정이 되고, 추정은 못 믿는다.
 *
 * ★ 단가는 코드에 있지만 '밸런스' 가 아니다 — 세계관이 아니라 청구서라
 *   content/balance/ 가 아니고, 사람이 고칠 일도 없다 (환경변수로 연다).
 *   snapshot: 2026-06-24. 바뀌면 여기 한 줄이 낡는다. */

/** 100만 토큰당 USD. */
export interface Price {
  readonly input: number;
  readonly output: number;
}

/** 모델별 단가. 여기 없는 모델은 null 이고, 그러면 도구가 '모른다' 고 말한다 —
 *  아무 단가나 끌어다 쓰면 그 순간 보고가 거짓말이 된다. */
const PRICES: Readonly<Record<string, Price>> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export function priceOf(model: string): Price | null {
  const envIn = Number(process.env.MUD_PRICE_IN);
  const envOut = Number(process.env.MUD_PRICE_OUT);
  if (envIn > 0 && envOut > 0) return { input: envIn, output: envOut };
  /* 날짜 접미사가 붙은 id 도 받는다 ("claude-haiku-4-5-20251001"). */
  const hit = Object.keys(PRICES).find((k) => model === k || model.startsWith(`${k}-`));
  return hit ? PRICES[hit]! : null;
}

/** 아래·위 두 값. 하나의 수를 내면 그게 실측처럼 보인다. */
export interface Band {
  readonly lo: number;
  readonly hi: number;
}

/* ★ 글자 -> 토큰. 한국어는 자모가 아니라 음절이 UTF-8 3바이트라, BPE 가 흔한
   음절만 한 토큰으로 합친다. 그래서 문장에 따라 1글자=1토큰 근처부터
   2글자=1토큰 근처까지 흔들린다. 가운데 값을 고르는 대신 폭을 그대로 남긴다 —
   여기서 한 수를 고르면 '±2배' 라는 사실이 보고에서 사라진다.
   키가 있으면 이 함수는 아예 안 쓰인다 (count_tokens 가 실측을 준다). */
const CHARS_PER_TOKEN: Band = { lo: 0.9, hi: 2.0 };

export const estimateTokens = (chars: number): Band => ({
  lo: Math.round(chars / CHARS_PER_TOKEN.hi),
  hi: Math.round(chars / CHARS_PER_TOKEN.lo),
});

/* ★ 출력은 실측할 방법이 없다. 부르기 전에는 아무도 모른다.
   아래는 두 가지의 합이다:
     본문   프롬프트가 "2~3문장" 을 요구한다 -> 대략 60~200 토큰
     사고   output_config.effort="low" 라도 적응형 사고 토큰이 붙고,
            그것도 출력 단가로 청구된다 -> 여기가 폭의 대부분이다
   이 수만은 실기로만 닫힌다. `npm run pregen -- --limit 10` 을 한 번 돌리고
   콘솔의 실제 사용량을 보면 진짜 값이 나온다 (그 값을 MUD_OUT_LO/HI 로
   되먹이면 그 뒤로는 이 추정이 실측이 된다). */
export const outputBand = (): Band => ({
  lo: Number(process.env.MUD_OUT_LO) || 150,
  hi: Number(process.env.MUD_OUT_HI) || 900,
});

export interface Estimate {
  readonly calls: number;
  readonly inputTokens: Band;
  /** true 면 inputTokens.lo === hi 이고 그것은 count_tokens 의 실측이다. */
  readonly inputMeasured: boolean;
  readonly outputTokens: Band;
  readonly usd: Band | null;
  readonly model: string;
}

export function estimate(
  calls: number,
  inputTokens: Band,
  inputMeasured: boolean,
  model: string,
): Estimate {
  const out = outputBand();
  const outputTokens = { lo: out.lo * calls, hi: out.hi * calls };
  const price = priceOf(model);
  return {
    calls,
    inputTokens,
    inputMeasured,
    outputTokens,
    model,
    usd: price
      ? {
          lo: (inputTokens.lo * price.input + outputTokens.lo * price.output) / 1_000_000,
          hi: (inputTokens.hi * price.input + outputTokens.hi * price.output) / 1_000_000,
        }
      : null,
  };
}

/** 사람이 읽는 여러 줄. 무엇이 실측이고 무엇이 추정인지 줄마다 말한다. */
export function formatEstimate(e: Estimate, prefix = ""): string[] {
  const k = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));
  const band = (b: Band): string => (b.lo === b.hi ? k(b.lo) : `${k(b.lo)}~${k(b.hi)}`);
  const out = [
    `${prefix}호출 ${e.calls}회 (실측 — 세계와 DB 가 정한다)`,
    `${prefix}입력 ${band(e.inputTokens)} 토큰 ` +
      (e.inputMeasured ? "(실측 — count_tokens)" : "(추정 — 글자 수 환산, 폭이 2배다)"),
    `${prefix}출력 ${band(e.outputTokens)} 토큰 (추정 — 사고 토큰 때문에 폭이 크다)`,
  ];
  if (e.usd) {
    const usd = (n: number): string => `$${n < 1 ? n.toFixed(2) : n.toFixed(1)}`;
    out.push(
      `${prefix}★ ${usd(e.usd.lo)} ~ ${usd(e.usd.hi)} (${e.model})`,
      `${prefix}  이 폭을 좁히려면 --limit 10 으로 한 번 돌리고 실제 사용량을 볼 것.`,
    );
  } else {
    out.push(
      `${prefix}★ ${e.model} 의 단가를 모른다. MUD_PRICE_IN / MUD_PRICE_OUT 로 줄 것 ` +
        "(100만 토큰당 USD).",
    );
  }
  return out;
}

/* ── 입력 토큰의 실측 ────────────────────────────────────────────────────
 *
 * ★ 왜 narration/ 이 아니라 여기인가: narration/ 은 '모델이 문장을 만드는'
 *   런타임 경로이고, 그 경로의 호출 모양은 하나여야 한다 (규칙 2). 이쪽은
 *   아무것도 만들지 않는다 — 세는 것뿐이고, 부르는 사람도 운영 도구뿐이다.
 *   count_tokens 는 과금되지 않으므로 '돈을 쓰기 전' 에 부를 수 있다.
 *
 * ★ 실패는 던지지 않는다. 네트워크가 막힌 기계에서도 도구는 답을 내야 하고,
 *   그때 답이 '추정' 으로 내려앉는 것은 정상 동작이다. */
export interface TokenCounter {
  (system: string, user: string): Promise<number>;
}

export function makeTokenCounter(model: string): TokenCounter | null {
  if (!(process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN)) return null;
  let client: { messages: { countTokens(p: never): Promise<{ input_tokens: number }> } } | null = null;
  return async (system, user) => {
    if (!client) {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      client = new Anthropic({ timeout: 20_000, maxRetries: 1 }) as unknown as typeof client;
    }
    const res = await client!.messages.countTokens({
      model,
      system: [{ type: "text", text: system }],
      messages: [{ role: "user", content: user }],
    } as never);
    return res.input_tokens;
  };
}

/** 표본으로 글자당 토큰 비를 재고, 나머지는 그 비로 환산한다.
 *
 *  ★ 왜 전부 안 세는가: 호출이 방 수만큼 늘고, 얻는 것은 이미 알고 있는 값의
 *    소수점이다. 표본 몇 개면 '2배 폭' 이 '몇 % 폭' 이 된다 — 결정을 바꾸는
 *    것은 그 전환이지 그 뒤의 정밀도가 아니다.
 *  ★ 표본은 결정론적으로 고른다 (등간격). 무작위로 고르면 같은 세계에 대해
 *    돌릴 때마다 다른 견적이 나오고, 그러면 사람이 그 수를 안 믿는다. */
export interface RatioResult {
  ratio: number | null;
  /** 못 셌으면 왜. ★ 이걸 삼키면 --dry-run 이 '키가 틀렸다' 를 못 말한다 —
   *  .env.example 의 자리표시자(`sk-ant-...`)는 '값이 있다' 는 가드를 통과하므로
   *  키가 틀린 것과 키가 없는 것이 똑같이 '추정' 으로 보인다. 그 차이를 모르면
   *  견적을 보고 안심한 채 --limit 을 돌려 전부 401 로 태운다. */
  error: string | null;
}

export async function measureRatio(
  prompts: readonly { system: string; user: string }[],
  count: TokenCounter,
  samples = 6,
): Promise<RatioResult> {
  if (prompts.length === 0) return { ratio: null, error: null };
  const step = Math.max(1, Math.floor(prompts.length / samples));
  const picked = prompts.filter((_, i) => i % step === 0).slice(0, samples);
  let chars = 0;
  let tokens = 0;
  for (const p of picked) {
    try {
      tokens += await count(p.system, p.user);
    } catch (err) {
      // 하나라도 못 세면 표본이 편향된다. 통째로 포기하되, 이유는 남긴다.
      const status = (err as { status?: number } | undefined)?.status;
      const why = err instanceof Error ? err.message : String(err);
      return {
        ratio: null,
        error:
          status === 401 || status === 403
            ? `키가 거절당했다 (HTTP ${status}). .env 의 ANTHROPIC_API_KEY 를 확인할 것 — ` +
              "자리표시자(sk-ant-...)는 '값이 있다' 는 검사를 통과한다."
            : why,
      };
    }
    chars += p.system.length + p.user.length;
  }
  return { ratio: chars > 0 && tokens > 0 ? tokens / chars : null, error: null };
}
