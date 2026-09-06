/* 저작 시점의 모델 호출. server/tools/ 의 도구만 부른다 — 서버는 이 파일을
 * import 하지 않는다 (.eslintrc.cjs 가 빌드 에러로 막는다).
 *
 * ★ 규칙 1과 부딪히지 않는가: 부딪히지 않는다. 규칙 1은 '런타임' 의 규칙이다 —
 *   LLM 출력이 게임 상태를 바꾸는 경로가 있어서는 안 된다는 것. 여기서 나온
 *   문장은 게임 상태가 아니라 '씨앗' 이고, 파일로 나가 사람의 리뷰를 거쳐
 *   커밋된다. 그 뒤로는 코드와 똑같이 취급된다 (규칙 3: 씨앗은 불변).
 *   런타임에는 이 경로가 아예 존재하지 않는다.
 *
 * ★ 그래서 이 파일이 가진 것도 문자열을 '반환' 하는 함수뿐이다. DB 핸들도
 *   소켓도 엔진도 없다 — narration/ 의 다른 파일과 같은 제약을 받는다.
 *
 * 실패는 던진다. 런타임 렌더러(llm.ts)가 폴백을 돌려주는 것과 반대인데,
 * 이유가 다르기 때문이다: 저작은 사람이 지켜보는 앞에서 한 번 도는 배치
 * 작업이고, 조용한 폴백은 "특징 없는 돌 통로" 50개를 커밋하게 만든다. */

import Anthropic from "@anthropic-ai/sdk";
import { loadRegionPrompt, loadSeedsPrompt } from "./prompts";

export interface AnthropicLike {
  messages: {
    create(body: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

export interface AuthorOptions {
  model?: string;
  /** 저작은 사람이 기다리는 배치 작업이다. 런타임(30초)보다 넉넉히 준다. */
  timeoutMs?: number;
  /** 씨앗 짓기는 창작이고 추론이 아니다. 개요도 마찬가지. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  client?: AnthropicLike;
}

export interface RegionSketch {
  name: string;
  theme: string;
  landmarks: readonly string[];
}

/** 씨앗을 물을 칸 하나. shape 은 engine/layout.ts 의 shapeOf 가 만든다 —
 *  이웃을 알려주지 않으면 모델이 지도에 없는 문과 계단을 만들어낸다. */
export interface SeedAsk {
  coord: string;
  shape: string;
}

export interface Author {
  readonly overviewVersion: string;
  readonly seedsVersion: string;
  overview(sketch: RegionSketch): Promise<string>;
  /** 요청한 좌표에 대한 씨앗만. 요청하지 않은 좌표는 버린다 (아래 참조). */
  seeds(ctx: { name: string; overview: string; map: string }, asks: readonly SeedAsk[]): Promise<Map<string, string>>;
}

const textOf = (msg: Anthropic.Message): string =>
  msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

/** 모델이 코드 울타리나 사족을 붙였을 때를 대비해 첫 JSON 객체만 꺼낸다.
 *  프롬프트가 금지하고 있지만, 프롬프트는 계약이 아니라 부탁이다. */
function firstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`JSON 객체를 찾을 수 없다:\n${text.slice(0, 400)}`);
  return JSON.parse(text.slice(start, end + 1));
}

export function makeAuthor(opts: AuthorOptions = {}): Author {
  const model = opts.model ?? process.env.MUD_AUTHOR_MODEL ?? process.env.MUD_MODEL ?? "claude-opus-5";
  const timeout = opts.timeoutMs ?? 120_000;
  const effort = opts.effort ?? "low";
  const regionPrompt = loadRegionPrompt();
  const seedsPrompt = loadSeedsPrompt();
  const client = opts.client ?? new Anthropic({ timeout });

  const ask = async (system: string, user: string, maxTokens: number): Promise<string> => {
    const msg = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
      ...({ effort } as Record<string, unknown>),
    });
    if (msg.stop_reason === "max_tokens") {
      throw new Error(`응답이 max_tokens(${maxTokens})에 잘렸다. 묶음을 줄이거나 한도를 올릴 것.`);
    }
    const text = textOf(msg);
    if (!text) throw new Error("모델이 빈 응답을 돌려줬다.");
    return text;
  };

  return {
    overviewVersion: regionPrompt.version,
    seedsVersion: seedsPrompt.version,

    async overview(sketch) {
      const landmarks = sketch.landmarks.length
        ? `이 지역에 반드시 있어야 하는 것: ${sketch.landmarks.join(", ")}`
        : "";
      return ask(
        regionPrompt.system,
        regionPrompt.render({ name: sketch.name, theme: sketch.theme, landmarks }),
        2000,
      );
    },

    async seeds(ctx, asks) {
      const text = await ask(
        seedsPrompt.system,
        seedsPrompt.render({
          name: ctx.name,
          overview: ctx.overview,
          map: ctx.map,
          count: String(asks.length),
          coords: asks.map((a) => `- ${a.coord} — ${a.shape}`).join("\n"),
        }),
        /* 한 칸에 50자쯤 + JSON 뼈대. 한국어는 토큰이 후하므로 넉넉히. */
        1200 + asks.length * 220,
      );
      const raw = firstJsonObject(text);
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error(`JSON 객체가 아니다: ${JSON.stringify(raw).slice(0, 200)}`);
      }

      /* ★ 여기가 이 파일에서 가장 중요한 열 줄이다.
         모델이 돌려준 것 중 '우리가 물어본 좌표' 만 통과시킨다. 물어보지
         않은 좌표를 그냥 받아 쓰면 모델이 방을 만들어내는 것과 같아진다 —
         지도에 없는 칸에 씨앗이 생기고, 그 씨앗이 다음 사람에게는 '원래
         있던 방' 으로 보인다. 형식(문자열인가, 비어 있지 않은가)도 여기서 본다.
         빠진 좌표는 채우지 않는다. 호출자가 다시 묻거나 사람이 쓴다. */
      const wanted = new Set(asks.map((a) => a.coord));
      const out = new Map<string, string>();
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (!wanted.has(k)) continue;
        if (typeof v !== "string") continue;
        const seed = v.trim();
        if (seed) out.set(k, seed);
      }
      return out;
    },
  };
}
