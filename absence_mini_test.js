const fs = require("fs");
const { JSDOM, VirtualConsole } = require("jsdom");

const html = `<!DOCTYPE html><html><head></head><body>
<div id="absence-panel" class="hidden">
  <div id="absence-valid">0</div>
  <div id="absence-invalid">0</div>
  <div id="absence-semester-warning" class="hidden"></div>
  <div id="absence-excuses-list"></div>
  <button id="absence-panel-close">x</button>
</div>
<button id="absence-toggle" class="hidden">Пропуски</button>
<script>${fs.readFileSync("app.js", "utf-8")}</script>
</body></html>`;

const vc = new VirtualConsole();
vc.on("jsdomError", e => console.log("JSDOM ERROR:", e.message));

const dom = new JSDOM(html, {
  runScripts: "dangerously",
  pretendToBeVisual: true,
  url: "http://localhost:3000/",
  virtualConsole: vc,
  beforeParse(window) {
    window.matchMedia = window.matchMedia || function () { return { matches: false, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} }; };
    const store = {};
    window.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k,v)=>{store[k]=String(v)}, removeItem: k=>{delete store[k]} };
    window.fetch = async () => ({ ok:true, status:200, text: async()=>"[]", arrayBuffer: async()=>new TextEncoder().encode("[]").buffer, json: async()=>[] });
  }
});

const { window } = dom;
window.addEventListener("error", e => console.log("WIN ERROR:", e.message));

setTimeout(() => {
  // Устанавливаем расписание напрямую через window.cachedLessons
  const lessons = [
    { day:"понедельник", time:"8:15-9:35", weeks:"(1-10)", subject:"Математика", type:"Лекции", teacher:"Иванов", room:"1/100", _subjectOrderIndex:1 },
    { day:"понедельник", time:"9:45-11:05", weeks:"(1-10)", subject:"Физика", type:"Практические занятия", teacher:"Петров", room:"1/200", _subjectOrderIndex:2 }
  ];
  window.cachedLessons = lessons;
  window.semesterStartDate = new Date("Mon Feb 9 00:00:00 UTC+0300 2026");

  try {
    // Вызываем верхнеуровневую setAttendanceStatus напрямую (доступна через window? нет, в замыкании)
    // Пишем статус вручную через API localStorage с правильным ключом:
    const key = `Математика::1::8:15-9:35::понедельник`;
    window.localStorage.setItem("bseu_attendance_v1", JSON.stringify({ [key]: "valid" }));
  } catch (e) { console.log("setup err", e.message); }

  // Вызываем updateAbsencePanel через toggle (верхнеуровневая функция недоступна снаружи,
  // но toggleAbsencePanel вызывает updateAbsencePanel). Откроем панель кликом:
  const toggle = window.document.getElementById("absence-toggle");
  toggle.classList.remove("hidden");
  toggle.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  console.log("valid after setting valid status:", window.document.getElementById("absence-valid").textContent);

  // Добавим документ через localStorage + updateAbsencePanel через toggle закрытия/открытия
  window.localStorage.setItem("bseu_excuses_v1", JSON.stringify([{id:"1", label:"Больничный", start:"2026-02-10", end:"2026-02-12"}]));
  toggle.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); // закрыть
  toggle.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); // открыть -> updateAbsencePanel
  console.log("excuses list html length:", window.document.getElementById("absence-excuses-list").innerHTML.length);
}, 2000);
