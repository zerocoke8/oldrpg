/* LLM 렌더러. 이 파일이 프로젝트에서 유일하게 Anthropic API 를 호출한다.
 *
 * 규칙 2: 클라이언트는 절대 LLM 을 호출하지 않는다. 키는 서버에만 있다.
 * 규칙 1: 이 파일은 db/ 도 engine/ 도 import 하지 않는다 (.eslintrc.cjs 가 강제).
 *         텍스트를 '반환' 할 뿐이고, 어디에 어떻게 기록할지는 호출자가 정한다.
 *         그래서 모델 출력이 게임 상태를 바꿀 수 있는 핸들이 애초에 없다.
 *
 * 실패는 던지지 않고 폴백 결과를 돌려준다 — 호출자(world/upgrade.ts)가
 * source 를 보고 '승급 안 됨' 으로 처리한다. */

import Anthropic from "@anthropic-ai/sdk";
import type {
  NpcLineRenderer,
  NpcLineRequest,
  RoomTextRenderer,
  RoomTextRequest,
  RoomTextResult,
} from "../../shared/narration";
import { loadNpcPrompt, loadRoomPrompt, type Mood } from "./prompts";
import { moodTextFor } from "./static";

/** 테스트가 스텁을 꽂을 수 있도록 클라이언트 표면을 좁힌 것.
 *  Message / MessageCreateParams 는 SDK 타입을 그대로 쓴다 — 동등한 인터페이스를
 *  다시 정의하면 타입 안전성만 잃는다. */
export interface AnthropicLike {
  messages: {
    create(body: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

export interface LlmOptions {
  /** 기본값 claude-opus-5. 비용 때문에 낮추는 것은 운영자의 결정이므로 env 로 연다. */
  model?: string;
  /** 2~3문장이면 충분하지만 적응형 사고 토큰이 함께 잡히므로 넉넉히 준다.
   *  max_tokens 를 넘겨 잘리면 그 결과는 버리고 폴백을 쓴다. */
  maxTokens?: number;
  /** 방 묘사는 추론이 필요 없는 짧은 창작이다. 사고를 끄는 것보다
   *  effort 를 낮추는 쪽이 안전하다 (사고 비활성화는 도구 호출/태그 누출
   *  실패 모드가 있다). */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** SDK 기본 타임아웃은 10분이라 큐가 막힌다. 밀리초. */
  timeoutMs?: number;
  promptVersion?: string;
  client?: AnthropicLike;
}

export function makeLlmRenderer(
  moods: ReadonlyMap<string, Mood>,
  fallback: RoomTextRenderer,
  opts: LlmOptions = {},
): RoomTextRenderer {
  const model = opts.model ?? process.env.MUD_MODEL ?? "claude-opus-5";
  const maxTokens = opts.maxTokens ?? 4000;
  const effort = opts.effort ?? "low";
  const timeout = opts.timeoutMs ?? 30_000;
  const prompt = loadRoomPrompt(opts.promptVersion);
  const client =
    opts.client ??
    new Anthropic({
      timeout,
      maxRetries: 2, // 429 / 5xx / 연결 오류를 SDK 가 재시도한다
    });

  return async (req: RoomTextRequest): Promise<RoomTextResult> => {
    try {
      const res = await client.messages.create({
        model,
        max_tokens: maxTokens,
        output_config: { effort },
        system: [
          {
            type: "text",
            text: prompt.system,
            // 시스템 프롬프트는 모든 방에 대해 한 글자도 안 바뀐다. 지금은
            // 최소 캐시 길이에 못 미쳐 실제로는 캐시되지 않을 수 있지만,
            // 프롬프트가 길어지면(few-shot 등) 저절로 켜진다. 공짜다.
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [
          {
            role: "user",
            content: prompt.render({
              seed: req.seed,
              mood: moodTextFor(req, moods, (m) => m.prompt),
            }),
          },
        ],
      });

      // 안전 분류기가 거절했을 수 있다 (HTTP 200 + stop_reason). content 를
      // 읽기 전에 반드시 확인한다.
      if (res.stop_reason === "refusal") {
        console.warn(`[llm] refusal ${req.roomId}: ${res.stop_details?.category ?? "?"}`);
        return fallback(req);
      }
      // max_tokens 로 잘린 문장은 쓰지 않는다. 반쯤 끊긴 묘사가 DB 에 영구
      // 고정되는 것이 잠깐 폴백을 보는 것보다 나쁘다.
      if (res.stop_reason === "max_tokens") {
        console.warn(`[llm] truncated ${req.roomId}`);
        return fallback(req);
      }

      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();

      if (!text) {
        console.warn(`[llm] empty ${req.roomId}`);
        return fallback(req);
      }

      return { text, source: "llm", model, promptVersion: prompt.version };
    } catch (err) {
      // 타입이 있는 예외를 좁은 것부터 확인한다. 어느 쪽이든 결과는 같지만
      // (폴백), 무엇이 왜 실패했는지는 로그에 남아야 한다.
      if (err instanceof Anthropic.AuthenticationError) {
        console.error(`[llm] 인증 실패 — ANTHROPIC_API_KEY 를 확인할 것`);
      } else if (err instanceof Anthropic.RateLimitError) {
        console.warn(`[llm] rate limited ${req.roomId}`);
      } else if (err instanceof Anthropic.APIError) {
        console.warn(`[llm] API ${err.status} ${req.roomId}: ${err.message}`);
      } else {
        console.warn(`[llm] ${req.roomId}:`, err);
      }
      return fallback(req);
    }
  };
}

/** NPC 대사 렌더러. 방 묘사와 같은 클라이언트·같은 실패 처리를 쓴다 —
 *  다른 것은 프롬프트 파일과 사용자 메시지의 모양뿐이다. */
export function makeLlmNpcRenderer(
  moods: ReadonlyMap<string, Mood>,
  fallback: NpcLineRenderer,
  opts: LlmOptions = {},
): NpcLineRenderer {
  const model = opts.model ?? process.env.MUD_MODEL ?? "claude-opus-5";
  const maxTokens = opts.maxTokens ?? 4000;
  const effort = opts.effort ?? "low";
  const timeout = opts.timeoutMs ?? 30_000;
  const prompt = loadNpcPrompt(opts.promptVersion);
  const client = opts.client ?? new Anthropic({ timeout, maxRetries: 2 });

  return async (req: NpcLineRequest): Promise<RoomTextResult> => {
    try {
      const mood = req.flags
        .filter(([, v]) => v === true)
        .map(([k]) => moods.get(k)?.prompt)
        .filter((x): x is string => Boolean(x))
        .join(" ");
      const res = await client.messages.create({
        model,
        max_tokens: maxTokens,
        output_config: { effort },
        system: [{ type: "text", text: prompt.system, cache_control: { type: "ephemeral" } }],
        messages: [
          {
            role: "user",
            content: prompt.render({
              name: req.npcName,
              persona: req.persona,
              seed: req.seed,
              mood,
            }),
          },
        ],
      });

      if (res.stop_reason === "refusal") {
        console.warn(`[llm] refusal ${req.npcId}/${req.topic}`);
        return fallback(req);
      }
      if (res.stop_reason === "max_tokens") {
        console.warn(`[llm] truncated ${req.npcId}/${req.topic}`);
        return fallback(req);
      }
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      if (!text) return fallback(req);
      return { text, source: "llm", model, promptVersion: prompt.version };
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        console.error("[llm] 인증 실패 — ANTHROPIC_API_KEY 를 확인할 것");
      } else if (err instanceof Anthropic.APIError) {
        console.warn(`[llm] API ${err.status} ${req.npcId}/${req.topic}`);
      } else {
        console.warn(`[llm] ${req.npcId}/${req.topic}:`, err);
      }
      return fallback(req);
    }
  };
}
