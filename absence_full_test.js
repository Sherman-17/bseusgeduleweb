const fs = require("fs");
const { JSDOM, VirtualConsole } = require("jsdom");

let htmlRaw = fs.readFileSync("index.html", "utf-8");
htmlRaw = htmlRaw.replace(/<script src="https:\/\/cdn\.tailwindcss\.com[^>]*><\/script>/g, "");
htmlRaw = htmlRaw.replace(/<script id="tailwind-config">[\s\S]*?<\/script>/g, "");
// убираем прочие внешние скрипты (jsdelivr и т.п.), чтобы jsdom не лез в сеть
htmlRaw = htmlRaw.replace(/<script src="https:\/\/[^"]+"><\/script>/g, "");
// Подставляем app.js инлайном, чтобы jsdom выполнил его ДО наступления
// DOMContentLoaded (как в реальном браузере), а не через appendChild после.
const appJs = fs.readFileSync("app.js", "utf-8");
htmlRaw = htmlRaw.replace(/<script src="app\.js"><\/script>/, `<script>${appJs}</script>`);

const scheduleHtml = `<!DOCTYPE HTML><html><head><meta charset="windows-1251">
<!--second semester=Mon Feb 9 00:00:00 UTC+0300 2026-->
</head><body class="general"><div id="content"><div class="inlnBlck">
<table cellspacing="1" id="sched">
<tr><td colspan="5" class="wday">понедельник</td></tr>
<tr><td rowspan="1">8:15-9:35</td><td rowspan="1">(1-10)</td>
<td colspan="3">Математика <span class="distype">(Лекции)</span> ,  <span class="teacher dd">Иванов</span></td>
<td class="right">1/100</td></tr>
<tr><td rowspan="1">9:45-11:05</td><td rowspan="1">(1-10)</td>
<td colspan="3">Физика <span class="distype">(Практические занятия)</span> ,  <span class="teacher dd">Петров</span></td>
<td class="right">1/200</td></tr>
</table></div></div></body></html>`;

const formsJson = '[{"value":"10","text":"Дневная"}]';
const coursesJson = '[{"value":"1","text":"1"}]';
const groupsJson = '[{"value":"9820","text":"25 ДЭА-1 | Бух"}]';

const primaryGroup = { faculty: "12", form: "10", course: "1", group: "9820", groupText: "25 ДЭА-1" };
const primaryLessons = [
  { day: "понедельник", time: "8:15-9:35", weeks: "(1-10)", subject: "Математика", type: "Лекции", teacher: "Иванов", room: "1/100", isTeacher: false, _subjectOrderIndex: 1 },
  { day: "понедельник", time: "9:45-11:05", weeks: "(1-10)", subject: "Физика", type: "Практические занятия", teacher: "Петров", room: "1/200", isTeacher: false, _subjectOrderIndex: 2 }
];

const store = {};
store["bseu_primary_group"] = JSON.stringify(primaryGroup);
store["bseu_primary_group_lessons"] = JSON.stringify(primaryLessons);

const vc = new VirtualConsole();
vc.on("jsdomError", e => console.log("JSDOM ERROR:", e.message, e.detail && e.detail.stack ? e.detail.stack.split("\n").slice(0,3).join(" | ") : ""));
vc.on("error", (...a) => console.log("CONSOLE.ERROR:", ...a));

const dom = new JSDOM(htmlRaw, {
  runScripts: "dangerously",
  pretendToBeVisual: true,
  url: "http://localhost:3000/",
  virtualConsole: vc,
  beforeParse(window) {
    window.matchMedia = window.matchMedia || function (q) {
      return { matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
    };
    window.localStorage = {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; }
    };
    let calls = 0;
    window.fetch = async (url, opts) => {
      calls++;
      let body = "";
      if (opts && opts.body) {
        try { body = JSON.parse(opts.body).body || ""; } catch (e) { body = opts.body; }
      }
      let resp = "";
      if (body.includes("GetForms")) resp = formsJson;
      else if (body.includes("GetCourse")) resp = coursesJson;
      else if (body.includes("GetGroups")) resp = groupsJson;
      else if (body.includes("schedule")) resp = scheduleHtml;
      else resp = "[]";
      return {
        ok: true, status: 200,
        text: async () => resp,
        arrayBuffer: async () => new TextEncoder().encode(resp).buffer,
        json: async () => JSON.parse(resp)
      };
    };
    window.__fetchCalls = () => calls;
  }
});

const { window } = dom;
// app.js уже встроен в htmlRaw инлайном — jsdom выполнит его при парсинге,
// до естественного DOMContentLoaded.

setTimeout(() => {
  console.log("fetch calls:", window.__fetchCalls());
  console.log("cachedLessons len:", (window.cachedLessons || []).length);
  const cards = window.document.querySelectorAll(".lesson-card");
  const attToggles = window.document.querySelectorAll(".att-toggle");
  console.log("cards:", cards.length, "att-toggles:", attToggles.length);

  const toggle = window.document.getElementById("absence-toggle");
  const panel = window.document.getElementById("absence-panel");
  console.log("toggle hidden:", toggle.classList.contains("hidden"));
  toggle.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  console.log("panel hidden after click:", panel.classList.contains("hidden"));

  console.log("valid BEFORE:", window.document.getElementById("absence-valid").textContent);
  if (attToggles.length) {
    attToggles[0].querySelector(".att-state-btn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    console.log("valid AFTER toggle click:", window.document.getElementById("absence-valid").textContent);
  } else {
    console.log("NO TOGGLES - can't test counter");
  }

  // Тест добавления документа
  const form = window.document.getElementById("absence-excuse-form");
  window.document.getElementById("absence-excuse-label").value = "Больничный";
  window.document.getElementById("absence-excuse-start").value = "2026-02-10";
  window.document.getElementById("absence-excuse-end").value = "2026-02-12";
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  const list = window.document.getElementById("absence-excuses-list");
  console.log("excuses list html length:", list.innerHTML.length);
  console.log("excuses store:", store["bseu_excuses_v1"]);
}, 6000);
