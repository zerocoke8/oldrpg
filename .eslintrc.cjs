/* CLAUDE.md 규칙 1의 '기계적' 강제.
   charter 110줄("engine/이 narration/을 import 하는 코드가 생기면 규칙 1이 깨진 것이다")은
   주석으로 지킬 수 있는 문장이 아니라 import 검사로 쓰여 있다. 그래서 빌드 에러로 만든다. */
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: { ecmaVersion: 2022, sourceType: "module" },
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  env: { node: true, browser: true, es2022: true },
  ignorePatterns: ["node_modules/", "dist/", "*.cjs"],
  rules: {
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    "no-restricted-syntax": [
      "error",
      {
        // 엔진은 결정론이어야 한다. Date.now()/Math.random()은 주입받는다.
        selector: "MemberExpression[object.name='Math'][property.name='random']",
        message: "engine/은 결정론이어야 한다. 난수는 호출자가 주입한다.",
      },
    ],
  },
  overrides: [
    {
      // ── 규칙 1: engine/은 세계의 진실만 안다. 서술도, DB도, 소켓도 모른다.
      files: ["server/engine/**/*.ts"],
      rules: {
        "no-restricted-imports": ["error", { patterns: [
          { group: ["**/narration/**", "*/narration"], message: "규칙 1 위반: engine/ 이 server/narration/ 을 import 했다. 엔진이 진실, LLM은 묘사만 한다. (shared/narration 의 얼어붙은 계약 타입은 허용된다.)" },
          { group: ["**/db/**", "*/db"],                message: "engine/ 은 영속화를 모른다. 상태 변경은 반환값(effects)으로 내고, 기록은 호출자가 한다." },
          { group: ["**/net/**", "**/world/**"],        message: "engine/ 은 전송도 조합도 모른다." },
          { group: ["better-sqlite3", "ws"],            message: "engine/ 은 I/O 라이브러리를 import 하지 않는다." },
        ]}],
      },
    },
    {
      // ── 규칙 1의 반대 방향: narration/은 상태를 '바꿀 수 있는 핸들'을 애초에 못 잡는다.
      files: ["server/narration/**/*.ts"],
      rules: {
        "no-restricted-imports": ["error", { patterns: [
          { group: ["**/engine/**", "*/engine"], message: "narration/ 은 engine/ 을 import 하지 않는다. 얼어붙은 RoomTextRequest 만 받는다." },
          { group: ["**/db/**", "*/db"],         message: "규칙 1 위반: narration/ 이 DB 핸들을 잡으면 LLM 출력이 상태를 바꾸는 경로가 생긴다." },
          { group: ["**/net/**", "**/world/**"],  message: "narration/ 은 텍스트를 반환할 뿐 방출하지 않는다." },
          { group: ["better-sqlite3", "ws"],      message: "narration/ 은 DB/소켓 라이브러리를 import 하지 않는다." },
        ]}],
      },
    },
    {
      // 클라이언트는 절대 LLM을 호출하지 않는다 (규칙 2). API 키는 서버에만 있다.
      files: ["client/**/*.ts", "client/**/*.tsx"],
      rules: {
        "no-restricted-imports": ["error", { patterns: [
          { group: ["@anthropic-ai/*", "**/server/**"], message: "규칙 2 위반: 클라이언트는 LLM을 호출하지 않고 서버 내부를 import 하지 않는다." },
        ]}],
      },
    },
  ],
};
