/* prompts/ 아래의 마크다운을 읽어 들인다.
 *
 * charter 139줄: "프롬프트는 narration/prompts/에 파일로 분리한다.
 * 코드에 인라인하지 않는다." 그래서 문장은 전부 파일에 있고 이 파일은
 * 자르고 치환하는 일만 한다.
 *
 * 부팅 때 한 번 읽고 메모리에 둔다 — 요청마다 디스크를 때리지 않는다. */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ESM 에는 __dirname 이 없다.
const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPTS = join(HERE, "prompts");

/** `# 절이름` 으로 나뉜 마크다운을 { 절이름: 본문 } 으로. HTML 주석은 버린다. */
function sections(md: string): Record<string, string> {
  const body = md.replace(/<!--[\s\S]*?-->/g, "");
  const out: Record<string, string> = {};
  let name: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (name) out[name] = buf.join("\n").trim();
  };
  for (const line of body.split("\n")) {
    const m = /^#\s+(\S+)\s*$/.exec(line);
    if (m) {
      flush();
      name = m[1]!;
      buf = [];
    } else if (name) {
      buf.push(line);
    }
  }
  flush();
  return out;
}

export interface RoomPrompt {
  /** room_text.prompt_version 에 그대로 기록된다. 파일명이 곧 버전이다. */
  readonly version: string;
  readonly system: string;
  /** {{seed}} / {{mood}} / {{tone}} 를 치환해 user 메시지를 만든다. */
  render(vars: { seed: string; mood: string; tone: string }): string;
}

export interface NpcPrompt {
  readonly version: string;
  readonly system: string;
  render(vars: { name: string; persona: string; seed: string; mood: string }): string;
}

export function loadNpcPrompt(version = "npc.v1.ko"): NpcPrompt {
  const raw = readFileSync(join(PROMPTS, `${version}.md`), "utf8");
  const s = sections(raw);
  if (!s.system || !s.user) {
    throw new Error(`${version}.md 에 '# system' 과 '# user' 절이 모두 있어야 한다`);
  }
  const system = s.system;
  const user = s.user;
  return {
    version,
    system,
    render: ({ name, persona, seed, mood }) =>
      user
        .replace("{{name}}", name)
        .replace("{{persona}}", persona)
        .replace("{{seed}}", seed)
        .replace("{{mood}}", mood ? `지금 이 구역의 상태: ${mood}` : "")
        .trim(),
  };
}

export function loadRoomPrompt(version = "room.v2.ko"): RoomPrompt {
  const raw = readFileSync(join(PROMPTS, `${version}.md`), "utf8");
  const s = sections(raw);
  if (!s.system || !s.user) {
    throw new Error(`${version}.md 에 '# system' 과 '# user' 절이 모두 있어야 한다`);
  }
  const system = s.system;
  const user = s.user;
  return {
    version,
    system,
    render: ({ seed, mood, tone }) =>
      user
        .replace("{{seed}}", seed)
        .replace("{{tone}}", tone ? `이곳의 톤: ${tone}` : "")
        .replace("{{mood}}", mood ? `현재 이 구역의 상태: ${mood}` : "")
        .trim(),
  };
}

/* ── 저작 시점의 프롬프트 ─────────────────────────────────────────────
   런타임 프롬프트와 같은 디렉터리·같은 규약이다 (charter 139줄: 프롬프트는
   파일로 분리한다). 다른 것은 부르는 사람뿐이다 — server/tools/ 의 도구가
   부르고, 서버는 부르지 않는다. */

export interface AuthorPrompt<V> {
  readonly version: string;
  readonly system: string;
  render(vars: V): string;
}

function loadPrompt<V extends Record<string, string>>(version: string): AuthorPrompt<V> {
  const raw = readFileSync(join(PROMPTS, `${version}.md`), "utf8");
  const s = sections(raw);
  if (!s.system || !s.user) {
    throw new Error(`${version}.md 에 '# system' 과 '# user' 절이 모두 있어야 한다`);
  }
  const system = s.system;
  const user = s.user;
  return {
    version,
    system,
    render: (vars) => {
      let out = user;
      for (const [k, v] of Object.entries(vars)) out = out.split(`{{${k}}}`).join(v);
      return out.trim();
    },
  };
}

export const loadRegionPrompt = (version = "region.v1.ko"): AuthorPrompt<{
  name: string;
  theme: string;
  landmarks: string;
}> => loadPrompt(version);

export const loadSeedsPrompt = (version = "seeds.v1.ko"): AuthorPrompt<{
  name: string;
  overview: string;
  map: string;
  count: string;
  coords: string;
}> => loadPrompt(version);

/** 폴백 꼬리 문장들. 씨앗 뒤에 붙는 한 마디이고, 씨앗의 해시로 고른다 —
 *  하나로 두면 방 50개가 전부 같은 문장으로 끝난다. */
export interface Tails {
  readonly room: readonly string[];
  readonly npc: readonly string[];
}

export function loadTails(version = "tails.ko"): Tails {
  const s = sections(readFileSync(join(PROMPTS, `${version}.md`), "utf8"));
  const lines = (name: string): string[] =>
    (s[name] ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const room = lines("room");
  const npc = lines("npc");
  if (!room.length || !npc.length) {
    throw new Error(`${version}.md 에 '# room' 과 '# npc' 절이 모두 있어야 한다`);
  }
  return { room, npc };
}

/** 지역 하나가 프로즈에 하는 일 전부. prompts/tones/<regionId>.md 한 파일.
 *
 *  ★ 왜 필요한가: 방 프롬프트의 system 절이 "어둡고 축축한 지하 던전 톤" 을
 *    164방 전부에 걸고 있었다. 그중 114방(마을·기지·사무실)은 던전이 아니다.
 *    씨앗은 "노점거리 한복판. 흥정 소리가 여러 언어로 섞인다" 라고 써 두고
 *    꼬리가 "목 안쪽이 서늘하다" 로 끝나면, 읽는 사람은 세계가 아니라 템플릿을 본다.
 *
 *  ★ 왜 moods 와 같은 모양인가: 같은 종류의 것이기 때문이다. 플래그가 '언제'
 *    라면 지역은 '어디' 다. 둘 다 씨앗에 붙는 프로즈이고, 둘 다 state_hash 의
 *    preimage 에 들어가지 않아 고쳐도 seed_id 가 안 바뀐다.
 *
 *  ★ 파일이 없는 지역은 tails.ko.md 의 전역 꼬리로 떨어진다. 그래서 검사의
 *    픽스처 세계(b1·b2·b3)나 새로 만든 지역이 톤 파일 없이도 돈다. */
export interface Tone {
  /** LLM 에게 주는 그 지역의 톤 지시. 방 프롬프트의 {{tone}} 에 들어간다. */
  readonly prompt: string;
  /** 그 지역의 폴백 꼬리 후보. 비면 전역 꼬리를 쓴다. */
  readonly room: readonly string[];
}

export function loadTones(): Map<string, Tone> {
  const dir = join(PROMPTS, "tones");
  const out = new Map<string, Tone>();
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    /* 톤 디렉터리가 없어도 된다 — 전부 전역 꼬리와 기본 톤으로 떨어진다. */
    return out;
  }
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    /* 파일 이름이 곧 지역 id 다. 문서는 지역이 아니다 — 이걸 안 거르면
       "README 라는 지역의 톤" 이 조용히 하나 생긴다 (검사가 잡았다). */
    if (f === "README.md") continue;
    const s = sections(readFileSync(join(dir, f), "utf8"));
    out.set(f.replace(/\.md$/, ""), {
      prompt: s.prompt ?? "",
      room: (s.room ?? "").split("\n").map((l) => l.trim()).filter(Boolean),
    });
  }
  return out;
}

/** "region:x,y" 에서 지역만. 지역은 이미 roomId 안에 있으므로 narration 이
 *  이걸 꺼내 쓰는 데 계약 변경이 필요 없다 (RoomTextRequest 는 그대로다). */
export const regionOfRoomId = (roomId: string): string => {
  const i = roomId.indexOf(":");
  return i < 0 ? roomId : roomId.slice(0, i);
};

/** 플래그 하나가 프로즈에 하는 일 전부. prompts/moods/<flag>.md 한 파일. */
export interface Mood {
  /** LLM 에게 주는 톤 지시 (2단계). */
  readonly prompt: string;
  /** LLM 없이(또는 실패 시) 방 묘사 뒤에 붙는 결정론적 한 문장. */
  readonly fallback: string;
  /** 켜졌을 때 상태창에 뜨는 표시 문구. 없으면 상태창에 뜨지 않는다. */
  readonly label: string | null;
  /** 플래그가 켜지는 '순간' 영향받는 방에 서 있는 사람에게 (3단계). */
  readonly near: string | null;
  /** 같은 순간, 그 밖의 사람들에게 (3단계). */
  readonly far: string | null;
}

/** prompts/moods/<flag>.md 를 전부 읽는다. 파일이 없는 플래그는 톤이 없는 것이고,
 *  그건 정상이다 — 모든 플래그가 묘사에 영향을 주지는 않는다. */
export function loadMoods(): Map<string, Mood> {
  const dir = join(PROMPTS, "moods");
  const out = new Map<string, Mood>();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    const s = sections(readFileSync(join(dir, f), "utf8"));
    out.set(f.replace(/\.md$/, ""), {
      prompt: s.prompt ?? "",
      fallback: s.fallback ?? "",
      label: s.label || null,
      near: s.near || null,
      far: s.far || null,
    });
  }
  return out;
}
