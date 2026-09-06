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
  /** {{seed}} / {{mood}} 를 치환해 user 메시지를 만든다. */
  render(vars: { seed: string; mood: string }): string;
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

export function loadRoomPrompt(version = "room.v1.ko"): RoomPrompt {
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
    render: ({ seed, mood }) =>
      user.replace("{{seed}}", seed).replace("{{mood}}", mood ? `현재 이 구역의 상태: ${mood}` : "").trim(),
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
