import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { applyPalette, loadPalette } from "./theme";

/* ★ render() '전에' 판다. useEffect 로 미루면 첫 페인트가 CSS 변수 없이
   나가고, 그 한 프레임 동안 창틀도 글자색도 없다 (실측: background
   rgba(0,0,0,0) · border none · color rgb(0,0,0)). 매 로드마다 깜빡인다. */
applyPalette(loadPalette());

const el = document.getElementById("root");
if (!el) throw new Error("#root 가 없다");
createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
