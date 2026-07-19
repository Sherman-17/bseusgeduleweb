// Регистрация service worker для возможности установки PWA на рабочий стол
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => {
      console.warn("SW registration failed:", err);
    });
  });
}

const FACULTIES = [
  { value: "12", text: "Учетно-экономический факультет (УЭФ)" },
  { value: "14", text: "Факультет коммерции и туристической индустрии (ФКТИ)" },
  { value: "13", text: "Факультет маркетинга и логистики (ФМк)" },
  { value: "7", text: "Факультет международных экономических отношений (ФМЭО)" },
  { value: "2", text: "Факультет права (ФП)" },
  { value: "8", text: "Факультет финансов и банковского дела (ФФБД)" },
  { value: "534", text: "Факультет цифровой экономики (ФЦЭ)" },
  { value: "11", text: "Факультет экономики и менеджмента (ФЭМ)" },
  { value: "263", text: "Факультет международных бизнес-коммуникаций (ФМБК)" },
  { value: "18", text: "Высшая школа управления и бизнеса (ВШУБ)" },
  { value: "129", text: "Магистратура" },
  { value: "450", text: "Аспирантура" },
  { value: "530", text: "Деканат по работе с иностранными учащимися" },
  { value: "531", text: "ИПК и ПЭК (вечернее)" },
  { value: "497", text: "ИПК и ПЭК (очное)" },
  { value: "535", text: "СБ" },
  { value: "432", text: "СЭФ" }
];

// ===== Кэширование расписания на случай недоступности сервера =====
const SCHEDULE_CACHE_KEY = "bseu_schedule_cache_v1";

function buildCacheKey(tab, params) {
  if (tab === "group") return `group:${params.faculty}:${params.form}:${params.course}:${params.group}`;
  if (tab === "teacher") return `teacher:${params.teacher?.tid || ''}:${params.teacher?.tname || ''}`;
  if (tab === "room") return `room:${params.audience}:${params.date}`;
  return "unknown";
}

function saveScheduleCache(tab, params, payload) {
  try {
    const key = buildCacheKey(tab, params);
    const entry = { key, tab, params, payload, savedAt: Date.now() };
    localStorage.setItem(SCHEDULE_CACHE_KEY, JSON.stringify(entry));
  } catch (e) {
    console.warn("Не удалось сохранить кэш расписания:", e);
  }
}

function loadScheduleCache(tab, params) {
  try {
    const raw = localStorage.getItem(SCHEDULE_CACHE_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (entry.key !== buildCacheKey(tab, params)) return null;
    return entry;
  } catch (e) {
    console.warn("Не удалось прочитать кэш расписания:", e);
    return null;
  }
}

// Закэшированное расписание основной группы (сохраняется отдельно,
// чтобы при возврате из других режимов показать его мгновенно).
function loadPrimaryGroupLessonsCache() {
  try {
    const raw = localStorage.getItem("bseu_primary_group_lessons");
    if (!raw) return null;
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : null;
  } catch (e) {
    return null;
  }
}

function formatCacheTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
}

let cacheBannerTimer = null;
function showCacheBanner(savedAt) {
  const modal = document.getElementById("server-offline-modal");
  if (!modal) return;
  const timeEl = modal.querySelector("#offline-modal-time");
  if (timeEl) {
    const timeStr = formatCacheTime(savedAt);
    timeEl.textContent = timeStr ? `Обновлено: ${timeStr}` : "Показаны сохранённые данные.";
  }
  modal.classList.remove("hidden");
  const card = modal.querySelector(".offline-modal-card");
  requestAnimationFrame(() => {
    card.classList.remove("translate-y-[-12px]", "opacity-0");
    card.classList.add("translate-y-0", "opacity-100");
  });
  if (cacheBannerTimer) clearTimeout(cacheBannerTimer);
  cacheBannerTimer = setTimeout(hideCacheBanner, 5000);
}

function hideCacheBanner() {
  const modal = document.getElementById("server-offline-modal");
  if (!modal) return;
  const card = modal.querySelector(".offline-modal-card");
  card.classList.remove("translate-y-0", "opacity-100");
  card.classList.add("translate-y-[-12px]", "opacity-0");
  setTimeout(() => modal.classList.add("hidden"), 300);
}

// ===== Хранилище домашних заданий =====
const HOMEWORK_STORAGE_KEY = "bseu_homework_v1";

function getHomeworkKey(lesson) {
  // Ключ: предмет + порядковый номер пары в рамках этого предмета в дне
  // Например: "Математика:1" — первая Математика в этот день,
  // "Математика:2" — вторая Математика в этот день.
  // При переносе пары в другой день/время, но с тем же номером в рамках предмета ДЗ сохранится.
  const subject = (lesson.subject || "").trim();
  const order = lesson._subjectOrderIndex || "";
  return `${subject}:${order}`;
}

function loadHomework() {
  try {
    const raw = localStorage.getItem(HOMEWORK_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

function saveHomework(homework) {
  try {
    localStorage.setItem(HOMEWORK_STORAGE_KEY, JSON.stringify(homework));
  } catch (e) {
    console.warn("Не удалось сохранить домашнее задание:", e);
  }
  if (window.AccountSync) window.AccountSync.schedulePush();
}

function getHomeworkForLesson(lesson) {
  const hw = loadHomework();
  return hw[getHomeworkKey(lesson)] || "";
}

function setHomeworkForLesson(lesson, text) {
  const hw = loadHomework();
  const key = getHomeworkKey(lesson);
  if (text.trim()) {
    hw[key] = text.trim();
  } else {
    delete hw[key];
  }
  saveHomework(hw);
}

// ===== Хранилище посещаемости (пропуски) =====
// Статус пары: отсутствие ключа = «был на паре» (присутствие).
// Явные значения: "valid" — уважительная причина, "invalid" — неуважительная.
const ATTENDANCE_STORAGE_KEY = "bseu_attendance_v1";
// Оправдательные документы: массив { id, label, start, end } (ISO-даты).
const EXCUSE_STORAGE_KEY = "bseu_excuses_v1";

function getAttendanceKey(lesson) {
  // Стабильный ключ пары в рамках семестра основной группы.
  const subject = (lesson.subject || "").trim();
  const order = lesson._subjectOrderIndex || "";
  const time = (lesson.time || "").trim();
  const day = (lesson.day || "").trim();
  return `${subject}::${order}::${time}::${day}`;
}

function loadAttendance() {
  try {
    const raw = localStorage.getItem(ATTENDANCE_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

function saveAttendance(attendance) {
  try {
    localStorage.setItem(ATTENDANCE_STORAGE_KEY, JSON.stringify(attendance));
  } catch (e) {
    console.warn("Не удалось сохранить посещаемость:", e);
  }
  if (window.AccountSync) window.AccountSync.schedulePush();
}

function setAttendanceStatus(lesson, status) {
  const attendance = loadAttendance();
  const key = getAttendanceKey(lesson);
  if (status === "present" || !status) {
    delete attendance[key];
  } else {
    attendance[key] = status; // "valid" | "invalid"
  }
  saveAttendance(attendance);
  // Любое изменение статуса сразу пересчитывает итоги панели пропусков
  if (typeof updateAbsencePanel === "function") {
    try { updateAbsencePanel(); } catch (e) { console.warn("updateAbsencePanel:", e); }
  }
  return attendance;
}

function loadExcuses() {
  try {
    const raw = localStorage.getItem(EXCUSE_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function saveExcuses(excuses) {
  try {
    localStorage.setItem(EXCUSE_STORAGE_KEY, JSON.stringify(excuses));
  } catch (e) {
    console.warn("Не удалось сохранить оправдательные документы:", e);
  }
  if (window.AccountSync) window.AccountSync.schedulePush();
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/'/g, '&#039;');
}

function formatHumanDate(dateString) {
  if (!dateString) return '';
  const d = new Date(dateString);
  if (Number.isNaN(d.getTime())) return dateString;
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

// Правильное русское окончание для слова «пара»:
// 1 пара, 2–4 пары, 5–20 пар, 11–14 пар, 21 пара, 22–24 пары...
function pluralLessons(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  let word;
  if (mod10 === 1 && mod100 !== 11) word = 'пара';
  else if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) word = 'пары';
  else word = 'пар';
  return `${n} ${word}`;
}

function parseWeeks(weeksStr) {
  if (!weeksStr) return [];
  const clean = weeksStr.replace(/[()]/g, '').trim();
  if (!clean) return [];
  const parts = clean.split(',');
  const result = [];
  parts.forEach(part => {
    if (part.includes('-')) {
      const [start, end] = part.split('-').map(Number);
      for (let i = start; i <= end; i++) {
        result.push(i);
      }
    } else {
      const num = Number(part);
      if (!Number.isNaN(num)) {
        result.push(num);
      }
    }
  });
  return result;
}

function getMonday(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(date.setDate(diff));
}

// Преобразует день недели (строка рус.) и номер недели в конкретную дату ISO
function getDateForLesson(dayName, weekNum) {
  if (!window.semesterStartDate) return null;
  const daysOfWeekMap = {
    'понедельник': 0, 'вторник': 1, 'среда': 2, 'четверг': 3,
    'пятница': 4, 'суббота': 5, 'воскресенье': 6
  };
  const dayIndex = daysOfWeekMap[dayName.toLowerCase().trim()];
  if (dayIndex === undefined) return null;
  
  const semesterMonday = getMonday(window.semesterStartDate);
  semesterMonday.setHours(0, 0, 0, 0);
  const resultDate = new Date(semesterMonday);
  resultDate.setDate(semesterMonday.getDate() + (weekNum - 1) * 7 + dayIndex);
  
  const year = resultDate.getFullYear();
  const month = String(resultDate.getMonth() + 1).padStart(2, '0');
  const day = String(resultDate.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function calculateHours(start, end) {
  const [sH, sM] = start.split(':').map(Number);
  const [eH, eM] = end.split(':').map(Number);
  let diff = (eH * 60 + eM) - (sH * 60 + sM);
  return (diff < 0 ? diff + 1440 : diff) / 60;
}

// Возвращает статус пары с учётом оправдательных документов.
// Приоритет: явный статус (invalid/valid) > авто-уважительно по документу > присутствие.
function getAttendanceStatus(lesson) {
  try {
    const attendance = loadAttendance();
    const explicit = attendance[getAttendanceKey(lesson)];
    if (explicit === "invalid") return "invalid";
    if (explicit === "valid") return "valid";
    // Автоматическая уважительная причина по периоду оправдательного документа
    const dates = getLessonDates(lesson);
    if (dates.length) {
      const excuses = loadExcuses();
      for (const d of dates) {
        if (excuses.some(ex => d >= ex.start && d <= ex.end)) return "valid";
      }
    }
  } catch (e) {
    console.warn("getAttendanceStatus:", e);
  }
  return "present";
}

// Реальные календарные даты пары, вычисленные от старта семестра.
// Для пар без привязки к неделям (weeks === "") возвращает [] (разовые,
// не привязанные к семестру — не попадают под оправдательные документы по датам).
function getLessonDates(lesson) {
  try {
    const weeks = parseWeeks(lesson.weeks);
    if (!weeks.length) return [];
    const result = [];
    weeks.forEach(w => {
      const iso = getDateForLesson((lesson.day || "").toLowerCase().trim(), w);
      if (iso) result.push(iso);
    });
    return result;
  } catch (e) {
    return [];
  }
}

// Итоги пропусков за семестр для текущего расписания группы.
function computeAbsenceTotals() {
  const lessons = window.cachedLessons || [];
  let validHours = 0, validPairs = 0, invalidHours = 0, invalidPairs = 0;
  lessons.forEach(l => {
    const status = getAttendanceStatus(l);
    if (status === "present") return;
    // Каждая пара — отдельное занятие. 1 пара = 2 часа.
    validPairs += status === "valid" ? 1 : 0;
    invalidPairs += status === "invalid" ? 1 : 0;
    validHours += status === "valid" ? 2 : 0;
    invalidHours += status === "invalid" ? 2 : 0;
  });
  return { validHours, validPairs, invalidHours, invalidPairs };
}

// Активен ли режим «По группе» (вкладка группы выбрана). Именно в этом
// режиме показываем учёт пропусков — в режимах преподавателя/аудитории нет.
// Работает как для сохранённой основной группы, так и для обычного выбора группы.
function isGroupModeActive() {
  const tab = document.getElementById("tab-group");
  return !!tab && tab.classList.contains("segment-btn-active");
}

// Обновляет панель учёта пропусков: итоги, список документов, предупреждение.
function updateAbsencePanel() {
  try {
    const panel = document.getElementById("absence-panel");
    if (!panel) return;
    const totals = computeAbsenceTotals();
  const validEl = document.getElementById("absence-valid");
  const invalidEl = document.getElementById("absence-invalid");
  if (validEl) validEl.textContent = `${formatHours(totals.validHours)} (${pluralLessons(totals.validPairs)})`;
  if (invalidEl) invalidEl.textContent = `${formatHours(totals.invalidHours)} (${pluralLessons(totals.invalidPairs)})`;

  // Предупреждение, если даты семестра не определены
  const semWarning = document.getElementById("absence-semester-warning");
  if (semWarning) {
    const semStartStr = localStorage.getItem("bseu_semester_start_date");
    if (semStartStr) semWarning.classList.add("hidden");
    else semWarning.classList.remove("hidden");
  }

  // Список оправдательных документов
  const list = document.getElementById("absence-excuses-list");
  if (list) {
    const excuses = loadExcuses();
    if (!excuses.length) {
      list.innerHTML = '<p class="text-[11px] text-on-surface-variant/50 dark:text-slate-500 text-center py-1">Документов нет.</p>';
    } else {
      list.innerHTML = excuses.map(ex => {
        const dates = `${formatHumanDate(ex.start)} — ${formatHumanDate(ex.end)}`;
        return `
          <div class="flex items-center justify-between gap-2 text-[11px] sm:text-xs border border-outline-variant/15 dark:border-slate-800 rounded-lg bg-surface-container-low dark:bg-slate-800/60 px-2.5 py-1.5">
            <div class="flex items-center gap-1.5 min-w-0">
              <span class="material-symbols-outlined text-base text-sky-600 dark:text-sky-400 shrink-0">medical_services</span>
              <div class="min-w-0">
                <div class="font-semibold text-on-surface dark:text-slate-200 truncate">${escapeHtml(ex.label || "Документ")}</div>
                <div class="text-on-surface-variant/60 dark:text-slate-400 text-[10px]">${dates}</div>
              </div>
            </div>
            <button type="button" data-excuse="${ex.id}" class="absence-excuse-del shrink-0 text-on-surface-variant/40 hover:text-rose-500 dark:text-slate-500 dark:hover:text-rose-400 text-base font-light leading-none px-1 cursor-pointer" title="Удалить">&times;</button>
          </div>`;
      }).join('');
      list.querySelectorAll('.absence-excuse-del').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.excuse;
          const remaining = loadExcuses().filter(e => e.id !== id);
          saveExcuses(remaining);
          updateAbsencePanel();
          syncAllAttendanceToggles();
        });
      });
    }
  }
  } catch (e) {
    console.warn("updateAbsencePanel:", e);
  }
}

// Синхронизирует состояние всех видимых переключателей на карточках
function syncAllAttendanceToggles() {
  try {
    const container = document.getElementById("schedule-container");
    if (!container) return;
    container.querySelectorAll('.lesson-card').forEach(card => {
      const toggle = card.querySelector('.att-toggle');
      if (toggle && card._lesson) syncAttendanceToggle(toggle, card._lesson);
    });
  } catch (e) {
    console.warn("syncAllAttendanceToggles:", e);
  }
}

// Форматирует часы: дробные округляем до 1 знака, целые — без дроби
function formatHours(h) {
  const rounded = Math.round(h * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} ч`;
}

// Показать/скрыть панель пропусков.
// Получаем элемент панели через getElementById (а не через переменную
// из области видимости DOMContentLoaded), т.к. эта функция определена
// на верхнем уровне модуля и иначе не видит локальную const absencePanel.
function toggleAbsencePanel() {
  const panel = document.getElementById("absence-panel");
  if (!panel) return;
  if (panel.classList.contains("hidden")) {
    panel.classList.remove("hidden");
    updateAbsencePanel();
  } else {
    panel.classList.add("hidden");
  }
}

// Добавление оправдательного документа
function addExcuse(label, start, end) {
  const excuses = loadExcuses();
  if (new Date(end) < new Date(start)) {
    const tmp = start; start = end; end = tmp;
  }
  excuses.push({ id: Date.now().toString(), label: label || "Документ", start, end });
  saveExcuses(excuses);
  updateAbsencePanel();
  syncAllAttendanceToggles();
}

document.addEventListener("DOMContentLoaded", () => {
  // Селекторы UI
  const facultySelect = document.getElementById("faculty");
  const formSelect = document.getElementById("form");
  const courseSelect = document.getElementById("course");
  const groupSelect = document.getElementById("group");
  const modeDaysBtn = document.getElementById("mode-days");
  const modeSemesterBtn = document.getElementById("mode-semester");
  const modeExamsBtn = document.getElementById("mode-exams");
  let currentDisplayMode = "days"; // 'days' | 'semester' | 'exams'
  let isDefaultGroupActive = false; // true только когда загружена основная группа по умолчанию
  // Данные режима дохода (объявлены здесь, чтобы быть доступными
  // рендеру расписания группы, который может вызываться до блока доходов)
  let incomeJobs = JSON.parse(localStorage.getItem('jobs')) || [
    { id: '1', name: 'Основная работа', rate: 12.50, currency: 'BYN', color: '#98A2F3' }
  ];
  let incomeShifts = JSON.parse(localStorage.getItem('shifts')) || [];
  const getBtn = document.getElementById("get-btn");
  
  const groupSelectionDiv = document.getElementById("group-selection");
  const teacherSelectionDiv = document.getElementById("teacher-selection");
  const roomSelectionDiv = document.getElementById("room-selection");

  const teacherInput = document.getElementById("teacher-name");
  const autocompleteList = document.getElementById("autocomplete-list");
  const roomInput = document.getElementById("room-name");
  const roomDropdown = document.getElementById("room-autocomplete-list");
  const roomDateInput = document.getElementById("room-date");
  const roomDateDisplay = document.getElementById("room-date-display");
  const roomDateTrigger = document.getElementById("room-date-trigger");
   const roomCalendar = document.getElementById("room-calendar");
   const periodSection = document.getElementById("period-section");
   const tabRoom = document.getElementById("tab-room");
   const dayStripContainer = document.getElementById("day-strip-container");
   const scheduleToolbar = document.getElementById("schedule-toolbar");
   const examsToggle = document.getElementById("exams-toggle");
   const absenceToggle = document.getElementById("absence-toggle");
   const absencePanel = document.getElementById("absence-panel");
   const weekLabel = document.getElementById("week-label");
   const weekPrev = document.getElementById("week-prev");
   const weekNext = document.getElementById("week-next");
   let roomCalendarMonth = new Date();
   let allAudiences = [];
   
   const scheduleContainer = document.getElementById("schedule-container");
  const scheduleTitle = document.getElementById("schedule-title");
  const scheduleHeaderRow = document.getElementById("schedule-header-row");
  
  const themeToggleBtn = document.getElementById("theme-toggle");
  const themeToggleIcon = document.getElementById("theme-toggle-icon");
  const widgetEl = document.querySelector('.w-full.max-w-2xl');
  const heroTextEl = document.querySelector('.text-center.max-w-3xl');
  
  let selectedTeacher = null;
  let isEditingGroup = false; // флаг, что модалка открыта для редактирования (не первичный выбор)

  // Новые селекторы для основной группы и первого посещения
  const navPrimaryGroupWrapper = document.getElementById("nav-primary-group-wrapper");
  const navEditGroup = document.getElementById("nav-edit-group");
  const navDefaultGroup = document.getElementById("nav-default-group");
  const firstTimeModal = document.getElementById("first-time-modal");
  const modalTitle = document.getElementById("modal-title");
  const modalFaculty = document.getElementById("modal-faculty");
  const modalForm = document.getElementById("modal-form");
  const modalCourse = document.getElementById("modal-course");
  const modalGroup = document.getElementById("modal-group");
  const modalSaveBtn = document.getElementById("modal-save-btn");

  // Инициализация темной темы
  initTheme();
  
   // Заполнение факультетов
   populateFacultySelect(facultySelect);
   attachAbbrevSelect(facultySelect);
  attachAbbrevSelect(groupSelect);
  attachAbbrevSelect(modalFaculty);
  attachAbbrevSelect(modalGroup);

  // Загрузка сохраненного состояния
  loadSavedState();
  loadAudiences();

  // Переключение табов
  document.getElementById("top-mode-group").addEventListener("click", () => setActiveTab("group"));
  document.getElementById("top-mode-teacher").addEventListener("click", () => setActiveTab("teacher"));
  document.getElementById("top-mode-room").addEventListener("click", () => setActiveTab("room"));
  document.getElementById("tab-group").addEventListener("click", () => setActiveTab("group"));
  document.getElementById("tab-teacher").addEventListener("click", () => setActiveTab("teacher"));
  document.getElementById("tab-room").addEventListener("click", () => setActiveTab("room"));

  const topModeButtons = {
    group: document.getElementById("top-mode-group"),
    teacher: document.getElementById("top-mode-teacher"),
    room: document.getElementById("top-mode-room")
  };
  const dayStrip = document.getElementById("day-strip");
  const dayStripRow = dayStrip.querySelector(".flex");
  
  function setActiveTab(tab) {
    if (window.isInIncomeMode && typeof exitIncomeMode === "function") {
      exitIncomeMode();
    }
    isDefaultGroupActive = false; // переключение таба сбрасывает режим основной группы
    updateDefaultGroupModeClass();
    setDefaultGroupActiveState(false);
    const tabGroup = document.getElementById("tab-group");
    const tabTeacher = document.getElementById("tab-teacher");
    const tabRoom = document.getElementById("tab-room");
    const topGroup = document.getElementById("top-mode-group");
    const topTeacher = document.getElementById("top-mode-teacher");
    const topRoom = document.getElementById("top-mode-room");

    const activeTabClasses = "segment-btn-active py-2 sm:py-3 text-xs sm:text-sm font-bold text-primary dark:text-primary-container flex items-center justify-center gap-1 sm:gap-2 transition-all";
    const inactiveTabClasses = "segment-btn-inactive py-2 sm:py-3 text-xs sm:text-sm font-semibold text-on-surface-variant/60 dark:text-slate-400 hover:text-primary dark:hover:text-primary-container flex items-center justify-center gap-1 sm:gap-2 transition-all";
    const activeTopClasses = "segment-btn-active px-2 sm:px-3 py-1.5 sm:py-2 text-xs sm:text-sm font-semibold transition";
    const inactiveTopClasses = "segment-btn-inactive px-2 sm:px-3 py-1.5 sm:py-2 text-xs sm:text-sm font-semibold text-on-surface-variant dark:text-slate-300 transition";
    
    // Анимация переключения контента
    const widget = document.querySelector('.w-full.max-w-2xl');
    if (widget) {
      widget.classList.remove('animate-slide-down');
      void widget.offsetWidth; // перезапуск анимации
      widget.classList.add('animate-slide-down');
    }
    
    if (tab === "group") {
      tabGroup.className = activeTabClasses;
      tabTeacher.className = inactiveTabClasses;
      tabRoom.className = inactiveTabClasses;
      topGroup.className = activeTopClasses;
      topTeacher.className = inactiveTopClasses;
      topRoom.className = inactiveTopClasses;
      groupSelectionDiv.classList.remove("hidden");
      teacherSelectionDiv.classList.add("hidden");
      roomSelectionDiv.classList.add("hidden");
      // Кнопки "По дням", "На семестр", "Экзамены" видимы в режиме "По группе"
      periodSection.style.display = 'block';
      modeDaysBtn.classList.remove("hidden");
      modeSemesterBtn.classList.remove("hidden");
      modeExamsBtn.classList.remove("hidden");
      scheduleToolbar.classList.toggle("hidden", !(window.cachedLessons && window.cachedLessons.length));
    } else if (tab === "teacher") {
       tabTeacher.className = activeTabClasses;
       tabGroup.className = inactiveTabClasses;
       tabRoom.className = inactiveTabClasses;
       topTeacher.className = activeTopClasses;
       topGroup.className = inactiveTopClasses;
       topRoom.className = inactiveTopClasses;
       groupSelectionDiv.classList.add("hidden");
       teacherSelectionDiv.classList.remove("hidden");
       roomSelectionDiv.classList.add("hidden");
       periodSection.style.display = 'block';
       // В режиме преподавателя — только "Экзамены" (по умолчанию расписание по дням)
       modeDaysBtn.classList.add("hidden");
       modeSemesterBtn.classList.add("hidden");
       modeExamsBtn.classList.remove("hidden");
       scheduleToolbar.classList.toggle("hidden", !(window.cachedLessons && window.cachedLessons.length));
     } else {
      tabRoom.className = activeTabClasses;
      tabGroup.className = inactiveTabClasses;
      tabTeacher.className = inactiveTabClasses;
       topRoom.className = activeTopClasses;
       topGroup.className = inactiveTopClasses;
       topTeacher.className = inactiveTopClasses;
       groupSelectionDiv.classList.add("hidden");
       teacherSelectionDiv.classList.add("hidden");
       roomSelectionDiv.classList.remove("hidden");
       periodSection.style.display = 'none';
       dayStripContainer.classList.add('hidden');
       scheduleToolbar.classList.add('hidden');
     }
    // Сбрасываем режим отображения на "По дням" при переключении таба
    currentDisplayMode = "days";
    updateModeButtons();
    updateWeekButtonsState();
    
    // Скрываем списки подсказок
    autocompleteList.innerHTML = "";
    autocompleteList.classList.add("hidden");
    closeRoomDropdown();
    updatePrimaryGroupButtonVisibility();
    showWidget();
    // Синхронизируем переключатели пропусков с режимом (показать/скрыть)
    refreshAttendanceToggles();
  }

  // Логика тёмной темы
  function initTheme() {
    const savedTheme = localStorage.getItem("theme");
    const systemPrefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    
    if (savedTheme === "dark" || (!savedTheme && systemPrefersDark)) {
      document.documentElement.classList.add("dark");
      document.documentElement.classList.remove("light");
      themeToggleIcon.textContent = "light_mode";
    } else {
      document.documentElement.classList.remove("dark");
      document.documentElement.classList.add("light");
      themeToggleIcon.textContent = "dark_mode";
    }
  }

  themeToggleBtn.addEventListener("click", () => {
    if (document.documentElement.classList.contains("dark")) {
      document.documentElement.classList.remove("dark");
      document.documentElement.classList.add("light");
      themeToggleIcon.textContent = "dark_mode";
      localStorage.setItem("theme", "light");
    } else {
      document.documentElement.classList.add("dark");
      document.documentElement.classList.remove("light");
      themeToggleIcon.textContent = "light_mode";
      localStorage.setItem("theme", "dark");
    }
  });

  // Долгое нажатие (5 сек) на заголовок «БГЭУ Расписание» открывает
  // модалку сброса состояния первого запуска. Удобно на смартфоне,
  // где нет консоли разработчика для очистки localStorage.
  const appTitleEl = document.getElementById("app-title");
  const resetStateModal = document.getElementById("reset-state-modal");
  const resetStateConfirm = document.getElementById("reset-state-confirm");
  const resetStateCancel = document.getElementById("reset-state-cancel");
  let titleLongPressTimer = null;
  const TITLE_LONG_PRESS_MS = 5000;

  function showResetStateModal() {
    if (!resetStateModal) return;
    resetStateModal.classList.remove("hidden");
    requestAnimationFrame(() => {
      resetStateModal.classList.remove("opacity-0");
      resetStateModal.classList.add("opacity-100");
      const card = resetStateModal.querySelector(".bg-white, .dark\\:bg-slate-900");
      if (card) {
        card.classList.remove("scale-95");
        card.classList.add("scale-100");
      }
    });
  }

  function hideResetStateModal() {
    if (!resetStateModal) return;
    resetStateModal.classList.remove("opacity-100");
    resetStateModal.classList.add("opacity-0");
    const card = resetStateModal.querySelector(".bg-white, .dark\\:bg-slate-900");
    if (card) {
      card.classList.remove("scale-100");
      card.classList.add("scale-95");
    }
    setTimeout(() => resetStateModal.classList.add("hidden"), 300);
  }

  function startTitleLongPress() {
    if (titleLongPressTimer) return;
    titleLongPressTimer = setTimeout(() => {
      titleLongPressTimer = null;
      showResetStateModal();
    }, TITLE_LONG_PRESS_MS);
  }

  function cancelTitleLongPress() {
    if (titleLongPressTimer) {
      clearTimeout(titleLongPressTimer);
      titleLongPressTimer = null;
    }
  }

  if (appTitleEl) {
    appTitleEl.addEventListener("touchstart", (e) => { e.preventDefault(); startTitleLongPress(); }, { passive: false });
    appTitleEl.addEventListener("touchend", cancelTitleLongPress);
    appTitleEl.addEventListener("touchmove", cancelTitleLongPress);
    appTitleEl.addEventListener("touchcancel", cancelTitleLongPress);
    // Для десктопа/мыши — зажатие левой кнопки
    appTitleEl.addEventListener("mousedown", startTitleLongPress);
    appTitleEl.addEventListener("mouseup", cancelTitleLongPress);
    appTitleEl.addEventListener("mouseleave", cancelTitleLongPress);
    appTitleEl.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  if (resetStateCancel) resetStateCancel.addEventListener("click", hideResetStateModal);
  if (resetStateModal) {
    resetStateModal.addEventListener("click", (e) => {
      if (e.target === resetStateModal) hideResetStateModal();
    });
  }
  if (resetStateConfirm) {
    resetStateConfirm.addEventListener("click", () => {
      try { localStorage.clear(); } catch (e) { /* ignore */ }
      hideResetStateModal();
      // Перезагружаем, чтобы приложение открылось как при первом запуске
      setTimeout(() => location.reload(), 300);
    });
  }

  // Кнопка закрытия стилизованного уведомления о кэше
  const offlineModalDismiss = document.getElementById("offline-modal-dismiss");
  const serverOfflineModal = document.getElementById("server-offline-modal");
  if (offlineModalDismiss) {
    offlineModalDismiss.addEventListener("click", hideCacheBanner);
  }

  // Каскадные выпадающие списки
  facultySelect.addEventListener("change", async () => {
    resetSelect(formSelect, "Загрузка форм...");
    resetSelect(courseSelect, "Выберите курс");
    resetSelect(groupSelect, "Выберите группу");
    
    if (facultySelect.value === "-1") {
      resetSelect(formSelect, "Не выбран факультет");
      return;
    }
    try {
      const response = await apiRequest("__id.22.main.inpFldsA.GetForms", { faculty: facultySelect.value });
      populateSelect(formSelect, response, "Выберите форму обучения");
    } catch (e) {
      showError("Ошибка загрузки форм: " + e.message);
    }
  });

  formSelect.addEventListener("change", async () => {
    resetSelect(courseSelect, "Загрузка курсов...");
    resetSelect(groupSelect, "Выберите группу");
    
    if (formSelect.value === "-1") {
      resetSelect(courseSelect, "Не выбрана форма");
      return;
    }
    try {
      const response = await apiRequest("__id.23.main.inpFldsA.GetCourse", { faculty: facultySelect.value, form: formSelect.value });
      populateSelect(courseSelect, response, "Выберите курс");
    } catch (e) {
      showError("Ошибка загрузки курсов: " + e.message);
    }
  });

  courseSelect.addEventListener("change", async () => {
    resetSelect(groupSelect, "Загрузка групп...");
    
    if (courseSelect.value === "-1") {
      resetSelect(groupSelect, "Не выбран курс");
      return;
    }
    try {
      const response = await apiRequest("__id.23.main.inpFldsA.GetGroups", { faculty: facultySelect.value, form: formSelect.value, course: courseSelect.value });
      populateSelect(groupSelect, response, "Выберите группу", shortenGroupName);
      applySelectAbbrev(groupSelect);
    } catch (e) {
      showError("Ошибка загрузки групп: " + e.message);
    }
  });

  // Поиск преподавателей
  let debounceTimeout = null;
  teacherInput.addEventListener("input", () => {
    clearTimeout(debounceTimeout);
    const query = teacherInput.value.trim();
    
    if (query.length <= 2) {
      autocompleteList.innerHTML = "";
      autocompleteList.classList.add("hidden");
      return;
    }

    debounceTimeout = setTimeout(async () => {
      try {
        const response = await apiRequest("__id.24.main.TSchedA.getTeachers", { tname: query });
        renderSuggestions(response);
      } catch (e) {
        console.error("Ошибка поиска преподавателей:", e);
      }
    }, 300);
  });

  function renderSuggestions(teachers) {
    autocompleteList.innerHTML = "";
    if (teachers.length === 0) {
      const emptyDiv = document.createElement("div");
      emptyDiv.className = "autocomplete-suggestion no-results text-center py-4 text-on-surface-variant/50 font-medium";
      emptyDiv.textContent = "Преподаватели не найдены";
      autocompleteList.appendChild(emptyDiv);
    } else {
      teachers.forEach(item => {
        const div = document.createElement("div");
        div.className = "autocomplete-suggestion font-semibold text-on-surface dark:text-slate-200";
        div.innerHTML = `<span class="material-symbols-outlined text-slate-400">person</span> <span>${item.tname}</span>`;
        div.addEventListener("click", () => {
          teacherInput.value = item.tname;
          selectedTeacher = {
            tid: item.tid,
            taid: item.taid,
            sid: item.sid,
            tname: item.tname
          };
          autocompleteList.innerHTML = "";
          autocompleteList.classList.add("hidden");
        });
        autocompleteList.appendChild(div);
      });
    }
    autocompleteList.classList.remove("hidden");
  }

  // Закрывать список при клике вне его
  document.addEventListener("click", (e) => {
    if (!e.target.closest('#autocomplete-list') && e.target !== teacherInput) {
      autocompleteList.innerHTML = "";
      autocompleteList.classList.add("hidden");
    }
    if (!e.target.closest('#room-selection')) {
      closeRoomDropdown();
    }
    if (!e.target.closest('#room-date-wrapper') && !e.target.closest('#room-calendar')) {
      hideRoomCalendar();
    }
  });

  roomInput.addEventListener('input', () => {
    clearTimeout(roomAudiencesTimer);
    roomAudiencesTimer = setTimeout(filterAudiences, 250);
  });

  roomInput.addEventListener('focus', () => {
    clearTimeout(roomAudiencesTimer);
    roomAudiencesTimer = setTimeout(filterAudiences, 250);
  });

  roomInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      getSchedule();
    }
    if (event.key === 'Escape') {
      closeRoomDropdown();
      hideRoomCalendar();
    }
  });

  roomInput.addEventListener('blur', () => {
    setTimeout(closeRoomDropdown, 120);
  });

  roomDateTrigger.addEventListener('click', () => {
    toggleRoomCalendar();
  });

  roomDateDisplay.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleRoomCalendar();
  });

  // Запуск расписания
  getBtn.addEventListener("click", () => {
    isDefaultGroupActive = false; // ручной выбор группы — не основная группа по умолчанию
    setDefaultGroupActiveState(false);
    updateDefaultGroupModeClass();
    getSchedule();
  });

  // Общий вызов API к нашему чистому бэкенду
  async function apiRequest(action, params = {}) {
    let url = "";
    const cleanParams = { ...params };
    
    if (action.includes("GetForms")) {
      url = "/api/forms";
    } else if (action.includes("GetCourse")) {
      url = "/api/courses";
    } else if (action.includes("GetGroups")) {
      url = "/api/groups";
    } else if (action.includes("getTeachers")) {
      url = "/api/teachers";
      if (cleanParams.tname) {
        cleanParams.q = cleanParams.tname;
        delete cleanParams.tname;
      }
    } else {
      throw new Error("Unknown action: " + action);
    }
    
    const query = new URLSearchParams(cleanParams).toString();
    const response = await fetch(`${url}?${query}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  function todayISO() {
    const d = new Date();
    const tz = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return tz.toISOString().slice(0, 10);
  }

  function shiftDate(days) {
    const d = new Date(todayISO());
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }

  function weekStartISO() {
    const d = new Date();
    const day = (d.getDay() + 6) % 7;
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - day);
    const tz = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return tz.toISOString().slice(0, 10);
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    const raw = String(iso).trim();
    if (!raw) return '—';

    const text = raw.replace(/[.,]/g, ':');
    const rangeParts = text.split(/[-–]/).map(part => part.trim()).filter(Boolean);
    const timePart = rangeParts[0] || text;

    const explicitTime = timePart.match(/(\d{1,2}):(\d{2})/);
    if (explicitTime) {
      const hours = Number(explicitTime[1]);
      const minutes = Number(explicitTime[2]);
      if (hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60) {
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
      }
    }

    const dateTimeMatch = text.match(/\d{4}-\d{2}-\d{2}[T ](\d{2}:\d{2})/);
    if (dateTimeMatch) {
      return dateTimeMatch[1];
    }

    const compactMatch = timePart.match(/^(\d{3,4})$/);
    if (compactMatch) {
      const digits = compactMatch[1];
      const hours = Number(digits.slice(0, digits.length - 2));
      const minutes = Number(digits.slice(-2));
      if (hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60) {
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
      }
    }

    const d = new Date(text);
    if (!Number.isNaN(d.getTime())) {
      const timeString = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      if (timeString !== '00:00' || /\d{2}:\d{2}/.test(text)) {
        return timeString;
      }
    }

    return '—';
  }

  // Извлекает сокращённое название факультета из текста в скобках, напр. "(УЭФ)" → "УЭФ"
  function shortenFacultyName(full) {
    if (!full) return '';
    const m = full.match(/\(([^)]+)\)\s*$/);
    return m ? m[1] : full;
  }

  // Извлекает сокращённый код группы (например "23 ДФЗ-1" или "1-ПИ-1")
  // из полного названия опции выбора группы
  function shortenGroupName(full) {
    if (!full) return '';
    const match = full.match(/(\d{1,3}\s*-?\s*[А-ЯЁ][А-ЯЁ-]*\.?\s*-?\s*\d{1,3})/);
    if (match) return match[1].replace(/\s+/g, ' ').trim();
    const parts = String(full).trim().split(/\s+/);
    return parts[parts.length - 1];
  }

  // Сокращает название предмета до аббревиатуры из первых букв слов,
  // включая частицы (как в режиме аудитории): «Иностранный язык» → «ИЯ»,
  // «История Беларуси и мира» → «ИБИМ». Для однословных названий
  // берётся начало слова.
  function getShortSubjectName(lesson) {
    const full = (lesson?.subject || lesson?.shortNameRU || lesson?.fullNameRU || '').trim();
    if (!full) return '—';
    const words = full.split(/\s+/).filter(Boolean);
    if (words.length === 1) {
      const w = words[0].replace(/[().,\-]/g, '');
      return w.length <= 4 ? w : w.slice(0, 4);
    }
    return words
      .map(w => {
        const c = w.replace(/^[().,\-]+|[().,\-]+$/g, '');
        return c ? c.charAt(0).toUpperCase() : '';
      })
      .join('');
  }

  function createSelectOption(value, text, shortener) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.dataset.full = text;
    if (shortener) {
      const short = shortener(text);
      if (short && short !== text) opt.dataset.short = short;
    }
    opt.textContent = text;
    return opt;
  }

  function getSelectOptionFullText(selectEl) {
    const opt = selectEl.selectedOptions[0];
    if (!opt || opt.value === "-1") return "";
    return opt.dataset.full || opt.textContent;
  }

  // Заголовок расписания группы. В режиме основной группы по умолчанию
  // показываем только короткий код (например "23 ДФЗ-2"), без префикса "Группа"
  // и без длинного описания из ответа сервера.
  function getGroupTitleText() {
    const selGroupText = getSelectOptionFullText(groupSelect);
    if (isDefaultGroupActive) {
      return shortenGroupName(selGroupText);
    }
    return shortenGroupName(selGroupText);
  }

  function applySelectAbbrev(selectEl) {
    const opt = selectEl.selectedOptions[0];
    if (opt?.dataset.short && selectEl.value !== "-1") {
      opt.textContent = opt.dataset.short;
    }
  }

  function restoreSelectFullText(selectEl) {
    [...selectEl.options].forEach(o => {
      if (o.dataset.full) o.textContent = o.dataset.full;
    });
  }

  function attachAbbrevSelect(selectEl) {
    if (selectEl.dataset.abbrevAttached) return;
    selectEl.dataset.abbrevAttached = "1";

    selectEl.addEventListener("mousedown", () => restoreSelectFullText(selectEl));
    selectEl.addEventListener("focus", () => restoreSelectFullText(selectEl));
    selectEl.addEventListener("keydown", (e) => {
      if (["ArrowUp", "ArrowDown", "Enter", " "].includes(e.key)) {
        restoreSelectFullText(selectEl);
      }
    });
    selectEl.addEventListener("change", () => {
      restoreSelectFullText(selectEl);
      applySelectAbbrev(selectEl);
    });
    selectEl.addEventListener("blur", () => applySelectAbbrev(selectEl));
  }

  function populateFacultySelect(sel) {
    sel.innerHTML = `<option value="-1">Выберите факультет</option>`;
    FACULTIES.forEach(f => {
      sel.appendChild(createSelectOption(f.value, f.text, shortenFacultyName));
    });
  }

  function normalizeAudienceList(data) {
    if (Array.isArray(data)) {
      return data.map(x => typeof x === 'string' ? x : (x?.name ?? x?.title ?? x?.audience ?? JSON.stringify(x))).filter(Boolean);
    }
    if (Array.isArray(data?.items)) return data.items.filter(Boolean);
    if (Array.isArray(data?.audiences)) return data.audiences.filter(Boolean);
    return [];
  }

  function scrollToSchedule() {
    window.setTimeout(() => {
      const target = scheduleHeaderRow.classList.contains('hidden') ? scheduleContainer : scheduleHeaderRow;
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 120);
  }

  function renderRoomSchedule(payload, selectedAudience, selectedDate, shouldScroll = true) {
    const root = Array.isArray(payload) ? payload[0] ?? null : payload;
    const days = root?.scheduleOnDays ?? [];
    const titleText = `Аудитория ${selectedAudience}${selectedDate ? ` — ${formatHumanDate(selectedDate)}` : ''}`;
    scheduleTitle.textContent = titleText;
    scheduleHeaderRow.classList.remove('hidden');
    dayStripContainer.classList.add('hidden');
    scheduleToolbar.classList.add('hidden');

    if (!days.length) {
      scheduleContainer.innerHTML = `
        <div class="bg-surface-container-lowest dark:bg-slate-900 rounded-xl border border-outline-variant/10 dark:border-slate-800 p-8 text-center text-on-surface-variant/60 font-semibold flex flex-col items-center gap-3">
          <span class="material-symbols-outlined text-4xl text-slate-400">event_busy</span>
          <span>На ${escapeHtml(formatHumanDate(selectedDate))} расписание для аудитории не найдено.</span>
        </div>`;
      if (shouldScroll) scrollToSchedule();
      return;
    }

    const html = days.map(day => {
      const lessons = Array.isArray(day.lessons) ? day.lessons : [];
      const lessonsHtml = lessons.length ? lessons.map(lesson => {
        const subject = lesson.shortNameRU || lesson.fullNameRU || lesson.subject || 'Без названия';
        const type = lesson.lessonTypeShortNameRU || lesson.lessonTypeNameRU || lesson.type || 'Занятие';
        const teachers = Array.isArray(lesson.teachers) && lesson.teachers.length ? lesson.teachers.join(', ') : (lesson.teacher || '—');
        const groups = Array.isArray(lesson.groups) && lesson.groups.length ? lesson.groups.join(', ') : (lesson.group || '—');
        const room = lesson.audience || selectedAudience || '—';
        const start = fmtTime(lesson.startTime || lesson.time?.split('-')[0]);
        const end = fmtTime(lesson.endTime || lesson.time?.split('-')[1]);
        const styles = getLessonStyles(type);
        const typeBadge = type ? `<span class="${styles.badge} text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded">${type}</span>` : "";
        return `
          <div class="bg-surface-container-lowest dark:bg-slate-900 rounded-xl p-6 transition-all hover:translate-x-1 duration-300 border border-outline-variant/10 dark:border-slate-800 relative overflow-hidden group lesson-card">
            <div class="absolute top-0 left-0 w-1 h-full ${styles.border}"></div>
            <div class="flex items-start justify-between">
              <div class="flex gap-6 w-full">
                <div class="flex flex-col items-center min-w-[64px]">
                  <span class="text-lg font-extrabold text-on-surface dark:text-white">${escapeHtml(start)}</span>
                  <div class="w-[2px] h-8 bg-surface-container-highest dark:bg-slate-800 my-1"></div>
                  <span class="text-xs font-semibold text-on-surface-variant/60 dark:text-slate-400">${escapeHtml(end)}</span>
                </div>
                <div class="flex-grow">
                  <div class="flex flex-wrap items-center gap-2 mb-2">
                    ${typeBadge}
                    <span class="text-primary dark:text-[#b5bcff] font-bold text-xs md:text-sm flex items-center gap-1">
                      <span class="material-symbols-outlined text-base">location_on</span>
                      <span>Ауд. ${escapeHtml(room)}</span>
                    </span>
                  </div>
                  <h3 class="text-lg md:text-xl font-bold text-on-surface dark:text-white mb-2 leading-snug">${escapeHtml(subject)}</h3>
                  <p class="text-on-surface dark:text-slate-200 font-semibold text-sm flex items-center gap-2">
                    <span class="material-symbols-outlined text-base text-slate-400">person</span>
                    <span>${escapeHtml(teachers)}</span>
                  </p>
                  <p class="text-on-surface-variant/70 dark:text-slate-400 font-semibold text-xs flex items-center gap-2 mt-1">
                    <span class="material-symbols-outlined text-sm text-slate-400">groups</span>
                    <span>${escapeHtml(groups)}</span>
                  </p>
                </div>
              </div>
            </div>
          </div>`;
      }).join('') : `
          <div class="bg-surface-container-lowest dark:bg-slate-900 rounded-xl border border-outline-variant/10 dark:border-slate-800 p-8 text-center text-on-surface-variant/60 font-semibold flex flex-col items-center gap-3">
            <span class="material-symbols-outlined text-4xl text-slate-400">event_busy</span>
            <span>Нет занятий для этого дня.</span>
          </div>`;
      return `
        <div class="day-section mb-10">
          <div class="day-header text-sm font-bold text-primary dark:text-[#b5bcff] uppercase tracking-wider mb-4 pb-2 border-b border-outline-variant/10 dark:border-slate-800 flex items-center gap-2">
            <span class="material-symbols-outlined text-lg">calendar_today</span>
            <span>${escapeHtml(day.dayNameRU || day.dayName || 'День')}</span>
            <span class="text-xs font-normal text-on-surface-variant/60 dark:text-slate-400 ml-1">${escapeHtml(day.date ? formatHumanDate(day.date.slice(0, 10)) : selectedDate)}</span>
          </div>
          <div class="cards-container space-y-4">${lessonsHtml}</div>
        </div>`;
    }).join('');
    scheduleContainer.innerHTML = html;
  }

  const timePopover = document.getElementById("time-popover");
  const closeTimePopoverBtn = document.getElementById("close-time-popover");
  const popoverDateTitle = document.getElementById("popover-date-title");
  const popoverDayShifts = document.getElementById("popover-day-shifts");
  const popoverJobList = document.getElementById("popover-job-list");
  const popoverJobId = document.getElementById("popover-job-id");
  const popoverShiftStart = document.getElementById("popover-shift-start");
  const popoverShiftEnd = document.getElementById("popover-shift-end");
  const popoverSave = document.getElementById("popover-save");
  let currentPopoverDate = null;

  // Поповер быстрого выбора времени смены (клик по времени в ячейке календаря)
  const shiftTimePopover = document.getElementById("shift-time-popover");
  const closeShiftTimePopoverBtn = document.getElementById("close-shift-time-popover");
  const shiftTimePopoverTitle = document.getElementById("shift-time-popover-title");
  const shiftTimeStartInput = document.getElementById("shift-time-start");
  const shiftTimeEndInput = document.getElementById("shift-time-end");
  const shiftTimeSaveBtn = document.getElementById("shift-time-save");
  let currentEditingShift = null;

  // ===== Компактный поповер выбора времени смены =====
  function renderPopoverJobList() {
    if (!incomeJobs.length) {
      popoverJobList.innerHTML = '<span class="text-[10px] text-on-surface-variant/60 dark:text-slate-400">Нет работ</span>';
      return;
    }
    if (!popoverJobId.value || !incomeJobs.some(j => j.id === popoverJobId.value)) {
      popoverJobId.value = incomeJobs[0].id;
    }
    popoverJobList.innerHTML = incomeJobs.map(j => {
      const active = j.id === popoverJobId.value;
      const cls = active
        ? 'border-primary dark:border-[#b5bcff] bg-primary/10 dark:bg-[#b5bcff]/10 text-primary dark:text-[#b5bcff]'
        : 'border-outline-variant/20 dark:border-slate-700 text-on-surface-variant/70 dark:text-slate-400 hover:border-primary/40';
      return `<button type="button" data-job="${j.id}" class="job-pill text-[10px] font-bold pl-2 pr-2.5 py-1 rounded-lg border ${cls} transition-colors cursor-pointer flex items-center gap-1.5">
        <span class="w-2 h-2 rounded-full shrink-0" style="background:${j.color}"></span>
        <span class="truncate min-w-0">${escapeHtml(j.name)}</span>
        <span class="text-[9px] font-semibold opacity-70 whitespace-nowrap">${j.rate.toFixed(2)} ${j.currency}/ч</span>
      </button>`;
    }).join('');
    popoverJobList.querySelectorAll('.job-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        popoverJobId.value = btn.dataset.job;
        renderPopoverJobList();
      });
    });
  }

  function renderPopoverDayShifts(dateStr) {
    const dayShifts = incomeShifts.filter(s => s.date === dateStr);
    if (!dayShifts.length) {
      popoverDayShifts.innerHTML = '<p class="text-[10px] text-on-surface-variant/50 dark:text-slate-500 text-center py-1">Смен на этот день нет.</p>';
      return;
    }
    popoverDayShifts.innerHTML = dayShifts.map(s => {
      const job = incomeJobs.find(j => j.id === s.jobId);
      if (!job) return '';
      const hours = calculateHours(s.startTime, s.endTime);
      return `
        <div class="flex items-center justify-between text-[10px] border border-outline-variant/15 dark:border-slate-800 rounded-lg bg-surface-container-low dark:bg-slate-800/60 px-2 py-1">
          <div class="flex items-center gap-1.5 truncate">
            <span class="w-2 h-2 rounded-full shrink-0" style="background:${job.color}"></span>
            <span class="truncate text-on-surface dark:text-slate-200 font-semibold">${s.startTime}–${s.endTime}</span>
            <span class="text-on-surface-variant/60 dark:text-slate-400">${hours.toFixed(1)}ч</span>
          </div>
          <button type="button" onclick="event.stopPropagation(); deleteShift('${s.id}', '${dateStr}')" class="text-on-surface-variant/40 hover:text-rose-500 dark:text-slate-500 dark:hover:text-rose-400 text-base font-light leading-none px-0.5 cursor-pointer">&times;</button>
        </div>`;
    }).join('');
  }

  function positionTimePopover(anchor) {
    const pop = timePopover.firstElementChild;
    timePopover.classList.remove('hidden');
    const rect = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = rect.left + rect.width / 2 - pw / 2;
    left = Math.max(8, Math.min(left, vw - pw - 8));
    let top = rect.bottom + 8;
    if (top + ph > vh - 8) top = rect.top - ph - 8;
    if (top < 8) top = 8;
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }

  function openTimePopover(dateStr, anchor) {
    if (!incomeJobs.length) {
      alert("Сначала создайте карточку работы в настройках (⚙️)!");
      return;
    }
    currentPopoverDate = dateStr;
    const formattedDate = dateStr.split('-').reverse().join('.');
    popoverDateTitle.textContent = `Смена: ${formattedDate}`;
    popoverShiftStart.value = "09:00";
    popoverShiftEnd.value = "18:00";
    renderPopoverJobList();
    renderPopoverDayShifts(dateStr);
    // Скрываем вертикальные ленты выбора; показываем только простое время
    document.querySelectorAll('#time-popover .vt-picker-wrap').forEach(w => w.classList.add('hidden'));
    const sd = document.getElementById('popover-start-display');
    const ed = document.getElementById('popover-end-display');
    if (sd) sd.textContent = popoverShiftStart.value;
    if (ed) ed.textContent = popoverShiftEnd.value;
    // Предупреждение о пересечении смен с парами
    updatePopoverIntersectionState(dateStr, computeDayIntersect(dateStr));
    positionTimePopover(anchor);
  }

  // Проверка пересечения смен с парами для указанной даты
  function computeDayIntersect(dateStr) {
    const dayLessons = getLessonsForDate(dateStr);
    const dayShifts = incomeShifts.filter(s => s.date === dateStr);
    if (dayLessons.length === 0 || dayShifts.length === 0) return false;
    let hasIntersect = false;
    dayShifts.forEach(shift => {
      const s0 = parseTimeToMinutes(shift.startTime);
      const s1 = parseTimeToMinutes(shift.endTime);
      dayLessons.forEach(l => {
        const parts = l.time.split("-");
        const c0 = parseTimeToMinutes(parts[0]);
        const c1 = parseTimeToMinutes(parts[1]);
        if (c0 < s1 && s0 < c1) hasIntersect = true;
      });
    });
    return hasIntersect;
  }

  // Показывает в поповере предупреждение о пересечении либо приглушённое состояние
  function updatePopoverIntersectionState(dateStr, hasIntersect) {
    const warning = document.getElementById('popover-intersection-warning');
    const muted = document.getElementById('popover-intersection-muted');
    if (!warning || !muted) return;
    if (!hasIntersect) {
      warning.classList.add('hidden');
      muted.classList.add('hidden');
      return;
    }
    if (isIntersectionDismissed(dateStr)) {
      warning.classList.add('hidden');
      muted.classList.remove('hidden');
    } else {
      warning.classList.remove('hidden');
      muted.classList.add('hidden');
    }
  }

  function closeTimePopover() {
    timePopover.classList.add('hidden');
    currentPopoverDate = null;
  }

  closeTimePopoverBtn.addEventListener('click', closeTimePopover);
  document.addEventListener('click', (e) => {
    if (!timePopover.classList.contains('hidden') &&
        !timePopover.contains(e.target) &&
        !e.target.closest('#calendar-grid > div')) {
      closeTimePopover();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !timePopover.classList.contains('hidden')) closeTimePopover();
  });

  // Кнопки скрытия/показа предупреждения о пересечении в поповере дня
  const popoverDismissBtn = document.getElementById('popover-dismiss-intersection');
  const popoverShowBtn = document.getElementById('popover-show-intersection');
  if (popoverDismissBtn) {
    popoverDismissBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!currentPopoverDate) return;
      dismissIntersection(currentPopoverDate);
      updatePopoverIntersectionState(currentPopoverDate, true);
      updateIncomeUI();
    });
  }
  if (popoverShowBtn) {
    popoverShowBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!currentPopoverDate) return;
      showIntersection(currentPopoverDate);
      updatePopoverIntersectionState(currentPopoverDate, true);
      updateIncomeUI();
    });
  }

  popoverSave.addEventListener('click', () => {
    if (!currentPopoverDate || !popoverJobId.value) return;
    incomeShifts.push({
      id: Date.now().toString(),
      date: currentPopoverDate,
      jobId: popoverJobId.value,
      startTime: popoverShiftStart.value,
      endTime: popoverShiftEnd.value
    });
    saveIncomeData();
    renderPopoverDayShifts(currentPopoverDate);
    updateIncomeUI();
    closeTimePopover();
  });

  // ===== Поповер быстрого выбора времени смены (клик по времени в ячейке) =====
  function positionShiftTimePopover(anchor) {
    const pop = shiftTimePopover.firstElementChild;
    shiftTimePopover.classList.remove('hidden');
    const rect = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = rect.left + rect.width / 2 - pw / 2;
    left = Math.max(8, Math.min(left, vw - pw - 8));
    let top = rect.bottom + 8;
    if (top + ph > vh - 8) top = rect.top - ph - 8;
    if (top < 8) top = 8;
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }

  function openShiftTimePopover(shift, anchor) {
    currentEditingShift = shift;
    const job = incomeJobs.find(j => j.id === shift.jobId);
    shiftTimePopoverTitle.textContent = job ? job.name : 'Время смены';
    shiftTimeStartInput.value = shift.startTime;
    shiftTimeEndInput.value = shift.endTime;
    // Скрываем вертикальные ленты выбора; показываем только простое время
    document.querySelectorAll('#shift-time-popover .vt-picker-wrap').forEach(w => w.classList.add('hidden'));
    const sd = document.getElementById('shift-time-start-display');
    const ed = document.getElementById('shift-time-end-display');
    if (sd) sd.textContent = shiftTimeStartInput.value;
    if (ed) ed.textContent = shiftTimeEndInput.value;
    positionShiftTimePopover(anchor);
  }

  function closeShiftTimePopover() {
    shiftTimePopover.classList.add('hidden');
    currentEditingShift = null;
  }

  closeShiftTimePopoverBtn.addEventListener('click', closeShiftTimePopover);
  document.addEventListener('click', (e) => {
    if (!shiftTimePopover.classList.contains('hidden') &&
        !shiftTimePopover.contains(e.target) &&
        !e.target.closest('.shift-time-trigger')) {
      closeShiftTimePopover();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !shiftTimePopover.classList.contains('hidden')) closeShiftTimePopover();
  });
  shiftTimeSaveBtn.addEventListener('click', () => {
    if (!currentEditingShift) return;
    currentEditingShift.startTime = shiftTimeStartInput.value;
    currentEditingShift.endTime = shiftTimeEndInput.value;
    saveIncomeData();
    updateIncomeUI();
    closeShiftTimePopover();
  });

  // Поля времени в поповерах: клик по часам/времени раскрывает вертикальную ленту часов и минут
  function initTimeFieldToggles() {
    document.querySelectorAll('[data-time-toggle]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const wrap = document.getElementById(btn.dataset.timeToggle);
        if (!wrap) return;
        const picker = wrap.querySelector('.vt-picker');
        const popover = btn.closest('#time-popover, #shift-time-popover');
        // сворачиваем остальные ленты в этом же поповере
        if (popover) {
          popover.querySelectorAll('.vt-picker-wrap').forEach(w => {
            if (w !== wrap) w.classList.add('hidden');
          });
        }
        if (wrap.classList.contains('hidden')) {
          wrap.classList.remove('hidden');
          requestAnimationFrame(() => syncOnePicker(picker));
        } else {
          wrap.classList.add('hidden');
        }
      });
    });
  }

  function renderRoomDropdown(list) {
    roomDropdown.innerHTML = '';
    if (!list.length) {
      const emptyDiv = document.createElement('div');
      emptyDiv.className = 'autocomplete-suggestion no-results text-center py-4 text-on-surface-variant/50 font-medium';
      emptyDiv.textContent = 'Ничего не найдено';
      roomDropdown.appendChild(emptyDiv);
      roomDropdown.classList.remove('hidden');
      return;
    }

    list.slice(0, 30).forEach(item => {
      const aud = typeof item === 'string' ? item : item.audience;
      const count = typeof item === 'object' && item.count ? item.count : null;
      const div = document.createElement('div');
      div.className = 'autocomplete-suggestion font-semibold text-on-surface dark:text-slate-200 flex items-center justify-between gap-2';
      const nameSpan = document.createElement('span');
      nameSpan.textContent = aud;
      div.appendChild(nameSpan);
      if (count) {
        const badge = document.createElement('span');
        badge.className = 'text-[10px] font-bold text-primary/60 dark:text-[#b5bcff]/60 bg-primary/10 dark:bg-[#b5bcff]/10 rounded-full px-2 py-0.5';
        badge.textContent = count;
        div.appendChild(badge);
      }
      const selectAudience = () => {
        roomInput.value = aud;
        closeRoomDropdown();
      };
      div.addEventListener('mousedown', (e) => {
        e.preventDefault();
        selectAudience();
      });
      div.addEventListener('click', selectAudience);
      roomDropdown.appendChild(div);
    });
    roomDropdown.classList.remove('hidden');
  }

  function closeRoomDropdown() {
    roomDropdown.classList.add('hidden');
    roomDropdown.innerHTML = '';
  }

  function isValidRoomDate(value) {
    const d = new Date(value);
    return !Number.isNaN(d.getTime());
  }

  function setRoomDate(isoDate) {
    const normalized = isValidRoomDate(isoDate) ? isoDate : todayISO();
    roomDateInput.value = normalized;
    roomDateDisplay.value = formatHumanDate(normalized);
    const [year, month] = normalized.split('-').map(Number);
    roomCalendarMonth = new Date(year, month - 1, 1);
  }

  function renderRoomCalendar() {
    const month = roomCalendarMonth.getMonth();
    const year = roomCalendarMonth.getFullYear();
    const firstDay = new Date(year, month, 1);
    const startDay = (firstDay.getDay() + 6) % 7; // Понедельник = 0
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const selectedIso = roomDateInput.value;
    const monthName = firstDay.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });

    let gridHtml = '<div class="grid grid-cols-7 gap-2 text-center text-[11px] font-semibold text-slate-700 dark:text-slate-200 mb-3">';
    ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].forEach(dayName => {
      gridHtml += `<div>${dayName}</div>`;
    });
    gridHtml += '</div>';

    gridHtml += '<div class="grid grid-cols-7 gap-2">';
    for (let blank = 0; blank < startDay; blank++) {
      gridHtml += '<div class="h-10"></div>';
    }
    for (let date = 1; date <= daysInMonth; date++) {
      const candidate = new Date(year, month, date);
      const iso = `${candidate.getFullYear()}-${String(candidate.getMonth() + 1).padStart(2, '0')}-${String(candidate.getDate()).padStart(2, '0')}`;
      const isSelected = iso === selectedIso;
      const isWeekend = candidate.getDay() === 0 || candidate.getDay() === 6;
      const buttonClasses = isSelected
        ? 'bg-primary text-white shadow-sm'
        : isWeekend
          ? 'bg-slate-200/80 text-slate-800 dark:bg-slate-800 dark:text-slate-200'
          : 'bg-slate-100 text-slate-800 dark:bg-slate-900 dark:text-slate-100';
      gridHtml += `<button type="button" data-day="${iso}" class="h-10 rounded-2xl font-semibold ${buttonClasses} hover:bg-primary/10 hover:text-primary dark:hover:bg-slate-700 transition-all">${date}</button>`;
    }
    gridHtml += '</div>';

    roomCalendar.innerHTML = `
      <div class="flex items-center justify-between mb-4">
        <button type="button" id="room-calendar-prev" class="rounded-2xl p-2 text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors">
          <span class="material-symbols-outlined">chevron_left</span>
        </button>
        <div class="text-sm font-semibold text-slate-800 dark:text-slate-100">${monthName}</div>
        <button type="button" id="room-calendar-next" class="rounded-2xl p-2 text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors">
          <span class="material-symbols-outlined">chevron_right</span>
        </button>
      </div>
      ${gridHtml}
    `;

    roomCalendar.querySelectorAll('[data-day]').forEach(button => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        setRoomDate(button.dataset.day);
        hideRoomCalendar();
      });
    });
    const prevBtn = roomCalendar.querySelector('#room-calendar-prev');
    const nextBtn = roomCalendar.querySelector('#room-calendar-next');
    if (prevBtn) {
      prevBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        roomCalendarMonth.setMonth(roomCalendarMonth.getMonth() - 1);
        renderRoomCalendar();
      });
    }
    if (nextBtn) {
      nextBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        roomCalendarMonth.setMonth(roomCalendarMonth.getMonth() + 1);
        renderRoomCalendar();
      });
    }
    roomCalendar.addEventListener('click', (event) => {
      event.stopPropagation();
    });
  }

  function showRoomCalendar() {
    if (!roomDateInput.value) {
      setRoomDate(todayISO());
    }
    renderRoomCalendar();
    roomCalendar.classList.remove('hidden');
  }

  function hideRoomCalendar() {
    roomCalendar.classList.add('hidden');
  }

  function toggleRoomCalendar() {
    if (roomCalendar.classList.contains('hidden')) {
      showRoomCalendar();
    } else {
      hideRoomCalendar();
    }
  }

  let roomAudiencesTimer = null;
  // Нормализуем ответ сервера к массиву строк "корпус/аудитория".
  // Поддерживаем оба формата бэкенда:
  //   - server.js (studhub) отдаёт плоский массив строк ["2/301", ...]
  //   - schedj.js отдаёт массив объектов [{audience, count}, ...]
  function normalizeAudienceList(data) {
    if (!Array.isArray(data)) return [];
    return data
      .map(x => (typeof x === 'string' ? x : (x && x.audience) ? x.audience : null))
      .filter(Boolean)
      .map(String);
  }

  // Сервер может не фильтровать по подстроке (studhub отдаёт все сразу),
  // поэтому отбираем совпадения на клиенте по введённому запросу.
  async function fetchAudiences(q) {
    try {
      const response = await fetch(`/api/audiences?q=${encodeURIComponent(q || '')}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const all = normalizeAudienceList(data);
      const query = (q || '').trim().toLowerCase();
      if (!query) return sortAudiences(all);
      return sortAudiences(all.filter(a => a.toLowerCase().includes(query)));
    } catch (err) {
      console.warn('Не удалось загрузить список аудиторий:', err);
      return [];
    }
  }

  // Сортируем аудитории по корпусу, затем по номеру внутри корпуса,
  // чтобы предлагать настоящие номера в понятном порядке.
  function sortAudiences(list) {
    return [...list].sort((a, b) => {
      const pa = parseAudience(a), pb = parseAudience(b);
      if (pa.building !== pb.building) return pa.building - pb.building;
      return pa.num - pb.num || a.localeCompare(b);
    });
  }

  function parseAudience(a) {
    const m = a.split('/');
    const building = Number(m[0]) || 0;
    const numMatch = (m[1] || '').match(/^\d+/);
    const num = numMatch ? Number(numMatch[0]) : 0;
    return { building, num };
  }

  async function loadAudiences() {
    // При открытии режима аудитории подгружаем все варианты (для возможности
    // быстрого выбора без ввода).
    const list = await fetchAudiences('');
    allAudiences = list;
    setRoomDate(roomDateInput.value || todayISO());
  }

  async function filterAudiences() {
    const value = roomInput.value.trim();
    if (!value) {
      renderRoomDropdown(allAudiences);
      return;
    }
    const list = await fetchAudiences(value);
    renderRoomDropdown(list);
  }

  function renderRoomPrompt(message) {
    scheduleTitle.textContent = roomInput.value ? `Аудитория ${roomInput.value}` : 'Выберите аудиторию';
    scheduleHeaderRow.classList.remove('hidden');
    scheduleContainer.innerHTML = `
      <div class="bg-surface-container-lowest dark:bg-slate-900 rounded-3xl border border-outline-variant/15 dark:border-slate-800 p-8 text-on-surface-variant dark:text-slate-400 text-center">
        ${message ? escapeHtml(message) : 'Введите аудиторию и нажмите «Показать расписание»'}
      </div>`;
  }

  async function getSchedule(shouldScroll = true, opts = {}) {
    // Сбрасываем смещение недели при загрузке нового расписания
    currentWeekOffset = 0;
    updateWeekLabel();
    
    // В "тихом" режиме (silent) не показываем спиннер загрузки —
    // данные уже отрисованы из кэша, обновление идёт в фоне.
    if (!opts.silent) {
      scheduleContainer.innerHTML = `
        <div class="loading flex flex-col items-center justify-center py-12 text-on-surface-variant/60 font-semibold gap-3">
          <span class="animate-spin material-symbols-outlined text-4xl text-primary dark:text-[#b5bcff]">autorenew</span>
          <span>Загрузка актуального расписания БГЭУ...</span>
        </div>`;
    }
    
    const isGroupTab = document.getElementById("tab-group").classList.contains("segment-btn-active");
    const isTeacherTab = document.getElementById("tab-teacher").classList.contains("segment-btn-active");
    const isRoomTab = document.getElementById("tab-room").classList.contains("segment-btn-active");
    let bodyParams = {};
    let saveState = {};
    let queryTitle = "";

    if (isGroupTab) {
      if (facultySelect.value === "-1" || !facultySelect.value) {
        showError("Пожалуйста, выберите факультет.");
        return;
      }
      if (formSelect.value === "-1" || !formSelect.value) {
        showError("Пожалуйста, выберите форму обучения.");
        return;
      }
      if (courseSelect.value === "-1" || !courseSelect.value) {
        showError("Пожалуйста, выберите курс.");
        return;
      }
      if (groupSelect.value === "-1" || !groupSelect.value) {
        showError("Пожалуйста, выберите группу.");
        return;
      }
      bodyParams = {
        __act: "__id.25.main.inpFldsA.GetSchedule__sp.7.results__fp.4.main",
        faculty: facultySelect.value,
        form: formSelect.value,
        course: courseSelect.value,
        group: groupSelect.value
      };
      
      const selGroupText = getSelectOptionFullText(groupSelect);
      queryTitle = getGroupTitleText();
      
      saveState = {
        tab: "group",
        faculty: facultySelect.value,
        form: formSelect.value,
        course: courseSelect.value,
        group: groupSelect.value,
        groupText: selGroupText
      };
    } else if (isTeacherTab) {
      if (!selectedTeacher || teacherInput.value.trim() !== selectedTeacher.tname) {
        showError("Пожалуйста, введите фамилию преподавателя и выберите его из списка.");
        return;
      }
      bodyParams = {
        __act: `tid.${selectedTeacher.tid.length}.${selectedTeacher.tid}taid.${selectedTeacher.taid.length}.${selectedTeacher.taid}sid.${selectedTeacher.sid.length}.${selectedTeacher.sid}__id.22.main.TSchedA.GetTSched__sp.8.tresults__fp.4.main`,
        tname: selectedTeacher.tname
      };
      queryTitle = selectedTeacher.tname;
      
      saveState = {
        tab: "teacher",
        teacher: selectedTeacher
      };
    } else if (isRoomTab) {
      const audience = roomInput.value.trim();
      let date = roomDateInput.value || todayISO();
      if (!date) date = todayISO();
      if (!audience) {
        showError("Пожалуйста, введите номер аудитории.");
        return;
      }
      queryTitle = `Аудитория ${audience}`;
      saveState = {
        tab: "room",
        audience,
        date
      };
      setRoomDate(date);
      scheduleTitle.textContent = queryTitle;
      scheduleHeaderRow.classList.remove("hidden");
      try {
        const response = await fetch(`/api/schedule?audience=${encodeURIComponent(audience)}&date=${encodeURIComponent(date)}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const json = await response.json();
        // Бэкенд возвращает { data: [...], isFallback: bool, savedAt? }
        const payload = json.data ?? json;
        renderRoomSchedule(payload, audience, date, shouldScroll);
        saveScheduleCache("room", { audience, date }, payload);
        dayStripContainer.classList.add('hidden');
        scheduleToolbar.classList.add('hidden');
        if (json.isFallback) {
          showCacheBanner(json.savedAt);
        } else {
          hideCacheBanner();
        }
        localStorage.setItem("bseu_saved_state", JSON.stringify(saveState));
      } catch (e) {
        // Сервер недоступен — пытаемся показать кэш
        const cached = loadScheduleCache("room", { audience, date });
        if (cached && cached.payload) {
          renderRoomSchedule(cached.payload, audience, date, shouldScroll);
          showCacheBanner(cached.savedAt);
        } else {
          showError("Не удалось загрузить расписание аудитории: " + e.message);
        }
      }
      return;
    } else {
      showError("Выберите вкладку группы, преподавателя или аудитории.");
      return;
    }

    bodyParams.period = "3"; // Всегда семестр

    // В "тихом" режиме не перезаписываем заголовок датой-меньшим
    // значением (суффикс с датой добавляется при рендере) — иначе
    // при возврате к группе по умолчанию дата на мгновение исчезает.
    if (!opts.silent) {
      scheduleTitle.textContent = queryTitle;
    }
    scheduleHeaderRow.classList.remove("hidden");

    localStorage.setItem("bseu_saved_state", JSON.stringify(saveState));

    try {
      let fetchUrl = "";
      if (saveState.tab === "group") {
        fetchUrl = `/api/schedule?faculty=${encodeURIComponent(saveState.faculty)}&form=${encodeURIComponent(saveState.form)}&course=${encodeURIComponent(saveState.course)}&group=${encodeURIComponent(saveState.group)}`;
      } else if (saveState.tab === "teacher") {
        const { tid, taid, sid, tname } = saveState.teacher;
        fetchUrl = `/api/schedule?tid=${encodeURIComponent(tid)}&taid=${encodeURIComponent(taid)}&sid=${encodeURIComponent(sid)}&tname=${encodeURIComponent(tname)}`;
      }

      const response = await fetch(fetchUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();

      window.semesterStartDate = data.semesterStartDate ? new Date(data.semesterStartDate) : new Date();
      window.currentSemesterWeek = data.currentSemesterWeek || 1;
      window.cachedLessons = data.lessons || [];

      // Сохраняем в кэш
      saveScheduleCache(saveState.tab, saveState, data);

      if (data.isFallback) {
        showCacheBanner(data.savedAt);
      } else {
        hideCacheBanner();
      }

      if (saveState.tab === "group" && isDefaultGroupActive) {
        localStorage.setItem("bseu_primary_group_lessons", JSON.stringify(data.lessons));
        if (window.semesterStartDate) {
          localStorage.setItem("bseu_semester_start_date", window.semesterStartDate.toISOString());
        }
        if (typeof updateIntersectionAlerts === "function") {
          updateIntersectionAlerts();
        }
      }

      renderCurrentMode(shouldScroll);
    } catch (e) {
      // Сервер недоступен — пытаемся показать клиентский кэш (localStorage)
      const cached = loadScheduleCache(saveState.tab, saveState);
      if (cached && cached.payload) {
        const data = cached.payload;
        window.semesterStartDate = data.semesterStartDate ? new Date(data.semesterStartDate) : new Date();
        window.currentSemesterWeek = data.currentSemesterWeek || 1;
        window.cachedLessons = data.lessons || [];

        renderCurrentMode(shouldScroll);
        showCacheBanner(cached.savedAt);
      } else {
        showError("Не удалось получить расписание: " + e.message);
      }
    }
  }

  // Стили для карточек занятий в зависимости от типа
  function getLessonStyles(type) {
    if (!type) return { border: 'bg-slate-400', badge: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400' };
    const t = type.toLowerCase();

    if (t.includes("куратор")) { // кураторский час
      return {
        border: 'bg-slate-500',
        borderColor: 'border-slate-300 dark:border-slate-700',
        badge: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
      };
    }
    if (t.includes("конс")) { // консультация
      return {
        border: 'bg-violet-600',
        borderColor: 'border-violet-300 dark:border-violet-900/50',
        badge: 'bg-violet-100 dark:bg-violet-950/40 text-violet-600 dark:text-violet-400'
      };
    }
    if (t.includes("экз")) { // экзамен
      return {
        border: 'bg-red-600',
        borderColor: 'border-red-300 dark:border-red-900/50',
        badge: 'bg-red-100 dark:bg-red-950/40 text-red-600 dark:text-red-400'
      };
    }
    if (t.includes("зач")) { // зачёт
      return {
        border: 'bg-yellow-500',
        borderColor: 'border-yellow-300 dark:border-yellow-900/50',
        badge: 'bg-yellow-100 dark:bg-yellow-950/40 text-yellow-600 dark:text-yellow-400'
      };
    }
    if (t.includes("л")) { // лекция
      return {
        border: 'bg-green-600',
        borderColor: 'border-green-300 dark:border-green-900/50',
        badge: 'bg-green-100 dark:bg-green-950/40 text-green-600 dark:text-green-400'
      };
    }
    if (t.includes("п") || t.includes("сем")) { // практика / семинар
      return {
        border: 'bg-blue-600',
        borderColor: 'border-blue-300 dark:border-blue-900/50',
        badge: 'bg-blue-100 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400'
      };
    }
    if (t.includes("лаб") || t.includes("л.р") || t.includes("комп")) { // лаборатория
      return {
        border: 'bg-blue-600',
        borderColor: 'border-blue-300 dark:border-blue-900/50',
        badge: 'bg-blue-100 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400'
      };
    }
    return {
      border: 'bg-slate-400',
      borderColor: 'border-slate-300 dark:border-slate-700',
      badge: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
    };
  }

  // Возвращает насыщенный цвет типа пары в виде HEX (соответствует
  // цвету левого индикатора в карточке занятия режима группы по умолчанию).
  function getLessonColorHex(type) {
    if (!type) return '#94a3b8';
    const t = type.toLowerCase();
    if (t.includes("куратор")) return '#64748b';
    if (t.includes("конс")) return '#7c3aed';
    if (t.includes("экз")) return '#dc2626';
    if (t.includes("зач")) return '#eab308';
    if (t.includes("л")) return '#16a34a';
    if (t.includes("п") || t.includes("сем")) return '#2563eb';
    if (t.includes("лаб") || t.includes("л.р") || t.includes("комп")) return '#2563eb';
    return '#94a3b8';
  }

  // Создаёт маленький переключатель статуса посещаемости пары (3 состояния):
  // 1 — был на паре (по умолчанию), 2 — уважительная причина, 3 — неуважительная.
  function buildAttendanceToggle(l) {
    const wrap = document.createElement("div");
    wrap.className = "att-toggle absolute top-3 right-3 z-10 flex items-center rounded-full border border-outline-variant/20 dark:border-slate-700 bg-surface-container-low dark:bg-slate-800 overflow-hidden select-none";
    wrap.title = "Статус посещаемости: был / уважительно / неуважительно";

    try {
    const states = [
      { value: "present", icon: "check_circle", cls: "text-on-surface-variant/50 dark:text-slate-500", title: "Был на паре" },
      { value: "valid", icon: "event_available", cls: "text-sky-600 dark:text-sky-400", title: "Уважительная причина" },
      { value: "invalid", icon: "cancel", cls: "text-error dark:text-error-container", title: "Неуважительная причина" }
    ];

    const status = getAttendanceStatus(l);

    states.forEach(s => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.attState = s.value;
      btn.title = s.title;
      btn.className = `att-state-btn flex items-center justify-center w-8 h-8 transition-colors cursor-pointer ${s.value === status ? s.cls + " bg-surface-container-high dark:bg-slate-700" : "text-on-surface-variant/40 dark:text-slate-600 hover:bg-surface-container-high/60 dark:hover:bg-slate-700/50"}`;
      btn.innerHTML = `<span class="material-symbols-outlined text-[18px] leading-none">${s.icon}</span>`;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const targetValue = s.value;
        setAttendanceStatus(l, targetValue === "present" ? "present" : targetValue);
        syncAttendanceToggle(wrap, l);
        updateAbsencePanel();
      });
      wrap.appendChild(btn);
    });
    } catch (e) {
      console.warn("buildAttendanceToggle:", e);
    }

    return wrap;
  }

  // Синхронизирует визуальное состояние переключателя с текущим статусом пары
  function syncAttendanceToggle(wrap, l) {
    const status = getAttendanceStatus(l);
    const map = {
      present: { icon: "check_circle", cls: "text-on-surface-variant/50 dark:text-slate-500" },
      valid: { icon: "event_available", cls: "text-sky-600 dark:text-sky-400" },
      invalid: { icon: "cancel", cls: "text-error dark:text-error-container" }
    };
    wrap.querySelectorAll(".att-state-btn").forEach(btn => {
      const st = btn.dataset.attState;
      const iconEl = btn.querySelector(".material-symbols-outlined");
      const active = st === status;
      const target = map[st];
      btn.className = `att-state-btn flex items-center justify-center w-8 h-8 transition-colors cursor-pointer ${active ? target.cls + " bg-surface-container-high dark:bg-slate-700" : "text-on-surface-variant/40 dark:text-slate-600 hover:bg-surface-container-high/60 dark:hover:bg-slate-700/50"}`;
      iconEl.textContent = target.icon;
    });
  }

  // Добавляет переключатели посещаемости ко всем карточкам пар в контейнере
  // расписания, у которых их ещё нет (идемпотентно). Используется для
  // представлений, строящих карточки вручную (По дням). Также убирает
  // «висячие» переключатели, если больше не активен режим основной группы.
  function refreshAttendanceToggles() {
    try {
      if (!isGroupModeActive() || !isDefaultGroupActive) {
        scheduleContainer.querySelectorAll('.lesson-card .att-toggle').forEach(t => t.remove());
        return;
      }
      scheduleContainer.querySelectorAll('.lesson-card').forEach(card => {
        // Без :scope — он не поддерживается в ряде WebView и бросает ошибку.
        if (card.querySelector('.att-toggle')) return;
        const l = card._lesson;
        if (!l) return;
        const toggle = buildAttendanceToggle(l);
        toggle.classList.add('att-toggle');
        card.appendChild(toggle);
      });
      // Синхронизируем итоги панели пропусков с актуальными статусами
      updateAbsencePanel();
    } catch (e) {
      console.warn("refreshAttendanceToggles:", e);
    }
  }

  // Создаёт DOM-карточку занятия (общий виджет для дневного и семестрового режимов)
  function buildLessonCard(l, showWeeks) {
    const styles = getLessonStyles(l.type);
    const card = document.createElement("div");
    card.className = "bg-surface-container-lowest dark:bg-slate-900 rounded-xl p-6 transition-all hover:translate-x-1 duration-300 border border-outline-variant/10 dark:border-slate-800 relative overflow-hidden group lesson-card";
    card.setAttribute("data-search", `${l.subject} ${l.teacher}`.toLowerCase());
    card._lesson = l;
    card.dataset.attKey = getAttendanceKey(l);

    const timeParts = l.time.split("-");
    const startTime = timeParts[0] ? timeParts[0].trim() : l.time;
    const endTime = timeParts[1] ? timeParts[1].trim() : "";

    const typeBadge = l.type ? `<span class="${styles.badge} text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded">${l.type}</span>` : "";
    const weeksBadge = (l.weeks && showWeeks) ? `<span class="bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 text-[10px] font-bold px-2 py-1 rounded">Недели: ${l.weeks}</span>` : "";

    // Домашнее задание для этой пары (если есть) - только в режиме группы по умолчанию
    const hwText = getHomeworkForLesson(l);
    const showHomeworkControls = isGroupModeActive() && isDefaultGroupActive;
    const hwHtml = hwText
      ? showHomeworkControls ? `<div class="homework-block mt-3 pt-3 border-t border-outline-variant/20 dark:border-slate-700/50 flex items-start gap-2">
          <span class="material-symbols-outlined text-sm shrink-0 mt-0.5 text-amber-600 dark:text-amber-400">assignment</span>
          <div class="flex-1 min-w-0">
            <span class="text-xs font-semibold text-amber-700 dark:text-amber-300 block leading-relaxed break-words">${escapeHtml(hwText)}</span>
          </div>
          <button type="button" class="hw-edit-btn shrink-0 mt-0.5 p-0.5 rounded-lg text-on-surface-variant/50 hover:text-primary dark:hover:text-[#b5bcff] transition-colors cursor-pointer" title="Редактировать ДЗ">
            <span class="material-symbols-outlined text-sm">edit</span>
          </button>
        </div>` : `<div class="homework-block mt-3 pt-3 border-t border-outline-variant/20 dark:border-slate-700/50 flex items-start gap-2">
          <span class="material-symbols-outlined text-sm shrink-0 mt-0.5 text-amber-600 dark:text-amber-400">assignment</span>
          <div class="flex-1 min-w-0">
            <span class="text-xs font-semibold text-amber-700 dark:text-amber-300 block leading-relaxed break-words">${escapeHtml(hwText)}</span>
          </div>
        </div>`
      : showHomeworkControls ? `<button type="button" class="hw-add-btn mt-2 text-[11px] font-semibold text-primary/70 dark:text-[#b5bcff]/70 hover:text-primary dark:hover:text-[#b5bcff] transition-colors flex items-center gap-1 cursor-pointer border border-dashed border-primary/20 dark:border-[#b5bcff]/20 rounded-lg px-2 py-1 hover:border-primary/40 dark:hover:border-[#b5bcff]/40">
          <span class="material-symbols-outlined text-sm">add_task</span>
          <span>Добавить ДЗ</span>
        </button>` : '';

    card.innerHTML = `
      <div class="absolute top-0 left-0 w-1 h-full ${styles.border}"></div>
      <div class="flex items-start justify-between">
        <div class="flex gap-6 w-full">
          <div class="flex flex-col items-center min-w-[64px] lesson-time-col">
            <span class="text-lg font-extrabold text-on-surface dark:text-white">${startTime}</span>
            <div class="w-[2px] h-8 bg-surface-container-highest dark:bg-slate-800 my-1"></div>
            <span class="text-xs font-semibold text-on-surface-variant/60 dark:text-slate-400">${endTime}</span>
          </div>
          <div class="flex-grow">
            <div class="flex flex-wrap items-center gap-2 mb-2 lesson-meta-row">
              ${typeBadge}
              <span class="text-primary dark:text-[#b5bcff] font-bold text-xs md:text-sm flex items-center gap-1">
                <span class="material-symbols-outlined text-base">location_on</span>
                <span>Ауд. ${l.room || '—'}</span>
              </span>
              ${weeksBadge}
            </div>
            <h3 class="text-lg md:text-xl font-bold text-on-surface dark:text-white mb-2 leading-snug">${l.subject}</h3>
            <p class="text-on-surface dark:text-slate-200 font-semibold text-sm flex items-center gap-2">
              <span class="material-symbols-outlined text-base text-slate-400">${l.isTeacher ? 'groups' : 'person'}</span>
              <span>${l.teacher || '—'}</span>
            </p>
            ${hwHtml}
          </div>
        </div>
      </div>
    `;

    // Переключатель статуса посещаемости — строго для основной группы по умолчанию
    if (isGroupModeActive() && isDefaultGroupActive) {
      const toggle = buildAttendanceToggle(l);
      card.appendChild(toggle);
    }

    // Обработчики кнопок ДЗ
    const addBtn = card.querySelector('.hw-add-btn');
    const editBtn = card.querySelector('.hw-edit-btn');
    const clickTarget = addBtn || editBtn;
    if (clickTarget) {
      clickTarget.addEventListener('click', (e) => {
        e.stopPropagation();
        openHomeworkModal(l, showWeeks);
      });
    }

    return card;
  }

  // ===== Модальное окно записи домашнего задания =====
  const homeworkModal = document.getElementById("homework-modal");
  const homeworkModalTitle = document.getElementById("homework-modal-title");
  const homeworkModalSubjectName = document.getElementById("homework-modal-subject-name");
  const homeworkModalSubjectMeta = document.getElementById("homework-modal-subject-meta");
  const homeworkTextInput = document.getElementById("homework-text");
  const homeworkSaveBtn = document.getElementById("homework-save-btn");
  const homeworkCancelBtn = document.getElementById("homework-cancel-btn");
  const homeworkDeleteBtn = document.getElementById("homework-delete-btn");
  const homeworkCloseBtn = document.getElementById("homework-modal-close");
  let homeworkCurrentLesson = null;
  let homeworkCurrentShowWeeks = false;

  function openHomeworkModal(lesson, showWeeks) {
    // Разрешаем открытие модального окна ДЗ только в режиме группы по умолчанию
    if (!isGroupModeActive() || !isDefaultGroupActive) return;
    
    homeworkCurrentLesson = lesson;
    homeworkCurrentShowWeeks = showWeeks;
    const currentHw = getHomeworkForLesson(lesson);

    homeworkModalTitle.textContent = currentHw ? "Редактировать ДЗ" : "Добавить ДЗ";
    homeworkModalSubjectName.textContent = lesson.subject || "—";
    const metaParts = [];
    if (lesson.time) metaParts.push(lesson.time);
    if (lesson.room) metaParts.push(`Ауд. ${lesson.room}`);
    if (lesson.teacher) metaParts.push(lesson.teacher);
    homeworkModalSubjectMeta.textContent = metaParts.join(" · ");

    homeworkTextInput.value = currentHw || "";
    homeworkDeleteBtn.classList.toggle("hidden", !currentHw);

    homeworkModal.classList.remove("hidden");
    homeworkModal.classList.add("flex");
    requestAnimationFrame(() => {
      homeworkModal.classList.remove("opacity-0");
      homeworkModal.firstElementChild.classList.remove("scale-95");
    });
    setTimeout(() => homeworkTextInput.focus(), 60);
  }

  function closeHomeworkModal() {
    homeworkModal.classList.add("opacity-0");
    homeworkModal.firstElementChild.classList.add("scale-95");
    setTimeout(() => {
      homeworkModal.classList.add("hidden");
      homeworkModal.classList.remove("flex");
    }, 200);
    homeworkCurrentLesson = null;
  }

  function findLessonCard(lesson) {
    const needle = `${lesson.subject} ${lesson.teacher}`.toLowerCase();
    const cards = document.querySelectorAll(".lesson-card");
    for (const c of cards) {
      if (c.dataset.search === needle) return c;
    }
    return null;
  }

  function saveHomeworkFromModal() {
    if (!homeworkCurrentLesson || !isGroupModeActive() || !isDefaultGroupActive) return;
    const lesson = homeworkCurrentLesson;
    const showWeeks = homeworkCurrentShowWeeks;
    setHomeworkForLesson(lesson, homeworkTextInput.value);
    const card = findLessonCard(lesson);
    if (card && card.parentNode) {
      card.replaceWith(buildLessonCard(lesson, showWeeks));
    } else {
      renderCurrentMode(false);
    }
    closeHomeworkModal();
  }

  homeworkSaveBtn.addEventListener("click", saveHomeworkFromModal);
  homeworkCancelBtn.addEventListener("click", closeHomeworkModal);
  homeworkCloseBtn.addEventListener("click", closeHomeworkModal);
  homeworkDeleteBtn.addEventListener("click", () => {
    if (!homeworkCurrentLesson || !isGroupModeActive() || !isDefaultGroupActive) return;
    const lesson = homeworkCurrentLesson;
    const showWeeks = homeworkCurrentShowWeeks;
    setHomeworkForLesson(lesson, "");
    const card = findLessonCard(lesson);
    if (card && card.parentNode) {
      card.replaceWith(buildLessonCard(lesson, showWeeks));
    } else {
      renderCurrentMode(false);
    }
    closeHomeworkModal();
  });
  homeworkModal.addEventListener("click", (e) => {
    if (e.target === homeworkModal) closeHomeworkModal();
  });
  homeworkTextInput.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      saveHomeworkFromModal();
    }
    if (e.key === "Escape") closeHomeworkModal();
  });

  // Рендеринг всего семестра (без ленты дней) — группировка по дням недели
  function renderSemesterView(shouldScroll = true) {
    const isGroupTab = document.getElementById("tab-group").classList.contains("segment-btn-active");
    const isTeacherTab = document.getElementById("tab-teacher").classList.contains("segment-btn-active");

    let titlePrefix = "";
    if (isGroupTab) {
      titlePrefix = getGroupTitleText();
    } else if (isTeacherTab) {
      titlePrefix = selectedTeacher?.tname || "";
    }

    scheduleTitle.textContent = `${titlePrefix} — на семестр`;
    scheduleHeaderRow.classList.remove("hidden");
    dayStripContainer.classList.add("hidden");
    scheduleToolbar.classList.add("hidden");

    const lessons = window.cachedLessons || [];
    scheduleContainer.innerHTML = "";

    if (lessons.length === 0) {
      scheduleContainer.innerHTML = `
        <div class="no-schedule bg-surface-container-lowest dark:bg-slate-900 border border-outline-variant/10 dark:border-slate-800 rounded-2xl p-12 text-center text-on-surface-variant/60 font-semibold flex flex-col items-center gap-3">
          <span class="material-symbols-outlined text-4xl text-slate-400">event_busy</span>
          <span>Расписание на семестр не найдено.</span>
        </div>`;
      return;
    }

    const order = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
    const days = {};
    lessons.forEach(l => {
      const key = (l.day || "вне сетки").toLowerCase();
      if (!days[key]) days[key] = [];
      days[key].push(l);
    });

    const sortedKeys = Object.keys(days).sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });

    sortedKeys.forEach(dayKey => {
      const daySection = document.createElement("div");
      daySection.className = "day-section mb-10";

      const dayHeader = document.createElement("div");
      dayHeader.className = "day-header flex items-center gap-2 mb-5 px-3 py-2 rounded-xl bg-primary/10 dark:bg-[#b5bcff]/10 border border-primary/20 dark:border-[#b5bcff]/25 shadow-sm";
      dayHeader.innerHTML = `<span class="material-symbols-outlined text-xl sm:text-2xl text-primary dark:text-[#b5bcff]">calendar_today</span> <span class="text-base sm:text-lg font-extrabold text-primary dark:text-[#b5bcff] uppercase tracking-wider">${days[dayKey][0].day || dayKey}</span>`;
      daySection.appendChild(dayHeader);

      const cardsContainer = document.createElement("div");
      cardsContainer.className = "cards-container space-y-4";

      days[dayKey].forEach(l => {
        cardsContainer.appendChild(buildLessonCard(l, true));
      });

      daySection.appendChild(cardsContainer);
      scheduleContainer.appendChild(daySection);
    });

    if (shouldScroll) scrollToSchedule();
  }

  // Парсинг расписания


  // Применяет текущий режим отображения (по дням / на семестр / экзамены)
  // к уже загруженным window.cachedLessons. Используется и после парсинга,
  // и для мгновенного показа закэшированного расписания (например,
  // при возврате к группе по умолчанию без повторного запроса к серверу).
  function renderCurrentMode(shouldScroll = true) {
    if (!window.cachedLessons) window.cachedLessons = [];
    updateWeekLabel();
    const targetDate = window.selectedDateISO || todayISO();
    if (currentDisplayMode === "semester") {
      renderSemesterView(shouldScroll);
    } else if (currentDisplayMode === "exams") {
      renderExamView(shouldScroll);
    } else {
      renderDayStrip(targetDate);
      selectDayOnStrip(targetDate);
    }
    if (shouldScroll) scrollToSchedule();
  }

  // Рендеринг карточек занятий
  function renderLessons(lessons, shouldScroll = true) {
    scheduleContainer.innerHTML = "";
    const days = {};
    lessons.forEach(l => {
      if (!days[l.day]) days[l.day] = [];
      days[l.day].push(l);
    });

    for (let day in days) {
      const daySection = document.createElement("div");
      daySection.className = "day-section mb-10";

      const dayHeader = document.createElement("div");
      dayHeader.className = "day-header text-sm font-bold text-primary dark:text-[#b5bcff] uppercase tracking-wider mb-4 pb-2 border-b border-outline-variant/10 dark:border-slate-800 flex items-center gap-2";
      dayHeader.innerHTML = `<span class="material-symbols-outlined text-lg">calendar_today</span> <span>${day}</span>`;
      daySection.appendChild(dayHeader);

      const cardsContainer = document.createElement("div");
      cardsContainer.className = "cards-container space-y-4";

      days[day].forEach(l => {
        const card = document.createElement("div");
        const styles = getLessonStyles(l.type);
        
        card.className = "bg-surface-container-lowest dark:bg-slate-900 rounded-xl p-6 transition-all hover:translate-x-1 duration-300 border border-outline-variant/10 dark:border-slate-800 relative overflow-hidden group lesson-card";
        card.setAttribute("data-search", `${l.subject} ${l.teacher}`.toLowerCase());
        card._lesson = l;
        card.dataset.attKey = getAttendanceKey(l);

        // Разделяем время пары
        const timeParts = l.time.split("-");
        const startTime = timeParts[0] ? timeParts[0].trim() : l.time;
        const endTime = timeParts[1] ? timeParts[1].trim() : "";

        const typeBadge = l.type ? `<span class="${styles.badge} text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded">${l.type}</span>` : "";

        card.innerHTML = `
          <!-- Левый вертикальный цветной индикатор типа пары -->
          <div class="absolute top-0 left-0 w-1 h-full ${styles.border}"></div>
          <div class="flex items-start justify-between">
            <div class="flex gap-6 w-full">
              <!-- Блок времени -->
              <div class="flex flex-col items-center min-w-[64px]">
                <span class="text-lg font-extrabold text-on-surface dark:text-white">${startTime}</span>
                <div class="w-[2px] h-8 bg-surface-container-highest dark:bg-slate-800 my-1"></div>
                <span class="text-xs font-semibold text-on-surface-variant/60 dark:text-slate-400">${endTime}</span>
              </div>
              <!-- Блок информации о занятии -->
              <div class="flex-grow">
                <div class="flex flex-wrap items-center gap-2 mb-2">
                  ${typeBadge}
                  <span class="text-primary dark:text-[#b5bcff] font-bold text-xs md:text-sm flex items-center gap-1">
                    <span class="material-symbols-outlined text-base">location_on</span>
                    <span>Ауд. ${l.room || '—'}</span>
                  </span>
                </div>
                </div>
                <h3 class="text-lg md:text-xl font-bold text-on-surface dark:text-white mb-2 leading-snug">${l.subject}</h3>
                <p class="text-on-surface dark:text-slate-200 font-semibold text-sm flex items-center gap-2">
                  <span class="material-symbols-outlined text-base text-slate-400">${l.isTeacher ? 'groups' : 'person'}</span>
                  <span>${l.teacher || '—'}</span>
                </p>
              </div>
            </div>
          </div>
        `;
        if (isGroupModeActive() && isDefaultGroupActive) {
          card.appendChild(buildAttendanceToggle(l));
        }
        cardsContainer.appendChild(card);
      });
      
      daySection.appendChild(cardsContainer);
      scheduleContainer.appendChild(daySection);
    }
    if (shouldScroll) scrollToSchedule();
  }

  // Восстановление состояния
  async function loadSavedState() {
    const primaryGroupStr = localStorage.getItem("bseu_primary_group");

    if (!primaryGroupStr) {
      // Нет сохранённой группы — открываем режим выбора "По группе"
      setActiveTab("group");
      showFirstTimeModal();
      return;
    }

    const primaryGroup = JSON.parse(primaryGroupStr);
    // Показываем и активируем кнопку основной группы сразу, не дожидаясь сети
    showPrimaryGroupButton(primaryGroup.groupText);
    const bottomDefaultBtn = document.getElementById('bottom-default-group-btn');
    if (bottomDefaultBtn) {
      document.querySelectorAll('.mobile-bottom-nav-btn').forEach(btn => btn.classList.remove('active'));
      bottomDefaultBtn.classList.add('active');
    }

    try {
      // Сразу загружаем группу по умолчанию, минуя показ формы выбора
      await applyGroupState(primaryGroup);
    } catch (e) {
      console.error("Failed to load primary group:", e);
      setActiveTab("group");
      showFirstTimeModal();
    }
  }

  function resetSelect(sel, text) {
    sel.innerHTML = `<option value="-1">${text}</option>`;
    sel.disabled = true;
  }

  function populateSelect(sel, items, defaultText, shortener) {
    sel.innerHTML = `<option value="-1">${defaultText}</option>`;
    items.forEach(item => {
      sel.appendChild(createSelectOption(item.value, item.text, shortener));
    });
    sel.disabled = false;
  }

  function showError(msg) {
    scheduleContainer.innerHTML = `
      <div class="error-msg bg-rose-50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-900 rounded-xl p-8 text-center text-rose-600 dark:text-rose-400 font-semibold flex flex-col items-center gap-2">
        <span class="material-symbols-outlined text-4xl text-rose-500">error</span>
        <span>${msg}</span>
      </div>`;
  }

  // Вспомогательные функции для ленты и выбора группы
  
  // Переменная для хранения смещения недели
  let currentWeekOffset = 0;
  
  function getStartOfWeek(offset = 0) {
    const d = new Date();
    const day = (d.getDay() + 6) % 7; // Понедельник = 0
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - day + (offset * 7));
    // Коррекция для часового пояса
    const tz = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return tz;
  }
  
  function updateWeekLabel() {
    // Вычисляем номер недели на основе отображаемой даты (первый день ленты)
    const startDate = getStartOfWeek(currentWeekOffset);
    const date = new Date(startDate);
    let weekNum = 1;
    if (window.semesterStartDate) {
      const targetMonday = getMonday(date);
      targetMonday.setHours(0,0,0,0);
      const semesterMonday = getMonday(window.semesterStartDate);
      semesterMonday.setHours(0,0,0,0);
      const msDiff = targetMonday.getTime() - semesterMonday.getTime();
      weekNum = Math.max(1, Math.round(msDiff / (7 * 24 * 60 * 60 * 1000)) + 1);
    }
    weekLabel.textContent = `Неделя ${weekNum}`;
  }
  
  function renderDayStrip(selectedDateISO) {
    dayStripRow.innerHTML = '';
    const startDate = getStartOfWeek(currentWeekOffset);
    
    // Determine mobile sizes via CSS class instead of inline
    const isMobile = window.innerWidth <= 480;
    // On mobile: use 7 equal flex items that fit the screen
    // The flex container has gap-1.5 so each button gets flex-1 and min-width auto
    
    for (let i = 0; i < 7; i++) {
      const date = new Date(startDate);
      date.setDate(startDate.getDate() + i);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const iso = `${year}-${month}-${day}`;
      
      const dayName = date.toLocaleDateString('ru-RU', { weekday: 'short' });
      const dayNum = date.getDate();
      const monthName = date.toLocaleDateString('ru-RU', { month: 'short' }).replace('.', '');
      
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.date = iso;
      
      const isSelected = iso === selectedDateISO;
      const isToday = iso === todayISO();
      
      if (isMobile) {
        // Mobile: equal-width buttons that fill the screen, no scroll needed
        const baseClass = 'flex flex-col items-center justify-center rounded-2xl transition-all min-w-0 flex-1 relative';
        if (isSelected) {
          btn.className = `${baseClass} h-16 bg-primary text-white shadow-lg shadow-primary/20 transform scale-[1.02]`;
          btn.innerHTML = `
            <span class="text-[9px] uppercase font-bold text-white/75">${dayName}</span>
            <span class="text-sm font-extrabold my-0 text-white">${dayNum}</span>
            <span class="text-[9px] font-bold text-white/90">${monthName}</span>
          `;
        } else {
          const todayRing = isToday ? ' ring-2 ring-primary/40' : '';
          btn.className = `${baseClass} h-16 border border-outline-variant/15 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-primary/50 text-on-surface dark:text-slate-200${todayRing}`;
          btn.innerHTML = `
            <span class="text-[9px] uppercase font-bold text-on-surface-variant/60 dark:text-slate-400">${dayName}</span>
            <span class="text-sm font-extrabold my-0 text-on-surface dark:text-white">${dayNum}</span>
            <span class="text-[9px] font-bold text-primary dark:text-[#b5bcff]">${monthName}</span>
          `;
        }
      } else {
        // Desktop: fixed-width scrollable buttons
        if (isSelected) {
          btn.className = 'flex flex-col items-center justify-center min-w-[70px] h-[85px] rounded-2xl bg-primary text-white shadow-lg shadow-primary/20 transition-all transform scale-[1.02] relative';
          btn.innerHTML = `
            <span class="text-[10px] uppercase font-bold text-white/75">${dayName}</span>
            <span class="text-2xl font-extrabold my-0.5 text-white">${dayNum}</span>
            <span class="text-[10px] font-bold text-white/90">${monthName}</span>
          `;
        } else {
          const todayRing = isToday ? ' ring-2 ring-primary/40' : '';
          btn.className = `flex flex-col items-center justify-center min-w-[70px] h-[85px] rounded-2xl border border-outline-variant/15 dark:border-slate-800 bg-white dark:bg-slate-900 transition-all hover:border-primary/50 text-on-surface dark:text-slate-200 relative${todayRing}`;
          btn.innerHTML = `
            <span class="text-[10px] uppercase font-bold text-on-surface-variant/60 dark:text-slate-400">${dayName}</span>
            <span class="text-2xl font-extrabold my-0.5 text-on-surface dark:text-white">${dayNum}</span>
            <span class="text-[10px] font-bold text-primary dark:text-[#b5bcff]">${monthName}</span>
          `;
        }
      }
      
      if (isDefaultGroupActive && incomeShifts.some(s => s.date === iso)) {
        const workDot = document.createElement('span');
        workDot.className = 'material-symbols-outlined absolute top-1 right-1 text-[13px] leading-none pointer-events-none text-emerald-500 dark:text-emerald-400';
        workDot.textContent = 'work';
        btn.appendChild(workDot);
      }

      btn.addEventListener('click', () => {
        selectDayOnStrip(iso);
      });
      
      dayStripRow.appendChild(btn);
    }
     dayStripContainer.classList.remove('hidden');
     scheduleToolbar.classList.remove('hidden');
     updateWeekButtonsState();
   }
  
  function selectDayOnStrip(dateISO) {
    window.selectedDateISO = dateISO;
    renderDayStrip(dateISO);
    
    const isRoomTab = document.getElementById("tab-room").classList.contains("segment-btn-active");
    if (isRoomTab) {
      roomDateInput.value = dateISO;
      roomDateDisplay.value = formatHumanDate(dateISO);
      getSchedule(false);
    } else {
      renderLessonsForDate(dateISO);
    }
  }

  function renderLessonsForDate(dateISO) {
    const date = new Date(dateISO);
    const daysOfWeekRU = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
    const targetDayName = daysOfWeekRU[date.getDay()];
    
    let targetWeekNum = 1;
    if (window.semesterStartDate) {
      const targetMonday = getMonday(date);
      targetMonday.setHours(0,0,0,0);
      const semesterMonday = getMonday(window.semesterStartDate);
      semesterMonday.setHours(0,0,0,0);
      const msDiff = targetMonday.getTime() - semesterMonday.getTime();
      const weekDiff = Math.round(msDiff / (7 * 24 * 60 * 60 * 1000));
      targetWeekNum = weekDiff + 1;
    }
    
    const filtered = (window.cachedLessons || []).filter(l => {
      if (l.day.toLowerCase() !== targetDayName) return false;
      const weeks = parseWeeks(l.weeks);
      return weeks.length === 0 || weeks.includes(targetWeekNum);
    });
    
    const isGroupTab = document.getElementById("tab-group").classList.contains("segment-btn-active");
    const isTeacherTab = document.getElementById("tab-teacher").classList.contains("segment-btn-active");
    
    let titlePrefix = "";
    if (isGroupTab) {
      titlePrefix = getGroupTitleText();
    } else if (isTeacherTab) {
      titlePrefix = selectedTeacher?.tname || "";
    }
    
    scheduleTitle.textContent = `${titlePrefix} — ${formatHumanDate(dateISO)}`;
    scheduleHeaderRow.classList.remove("hidden");
    
    scheduleContainer.innerHTML = "";
    const cardsContainer = document.createElement("div");
    cardsContainer.className = "cards-container space-y-4";

    if (filtered.length === 0) {
      // Если в этот день есть рабочие смены (режим дохода), показываем их,
      // иначе — сообщение о свободном дне.
      renderShiftCards(dateISO, cardsContainer);
      if (cardsContainer.childElementCount === 0) {
        scheduleContainer.innerHTML = `
          <div class="no-schedule bg-surface-container-lowest dark:bg-slate-900 border border-outline-variant/10 dark:border-slate-800 rounded-2xl p-12 text-center text-on-surface-variant/60 font-semibold flex flex-col items-center gap-3">
            <span class="material-symbols-outlined text-4xl text-slate-400">event_busy</span>
            <span>Занятий не найдено</span>
          </div>`;
        return;
      }
      scheduleContainer.appendChild(cardsContainer);
      return;
    }
    
    filtered.forEach(l => {
      cardsContainer.appendChild(buildLessonCard(l, false));
    });

    // Рабочие смены из режима дохода — показываем в расписании группы по умолчанию
    renderShiftCards(dateISO, cardsContainer);

    scheduleContainer.appendChild(cardsContainer);
  }

  // Отображает рабочие смены (созданные в режиме дохода) в виде карточек
  // в расписании группы по умолчанию для конкретной даты.
  function renderShiftCards(dateISO, container) {
    if (!isDefaultGroupActive) return;
    const dayShifts = incomeShifts.filter(s => s.date === dateISO);
    if (!dayShifts.length) return;

    dayShifts
      .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''))
      .forEach(shift => {
        const job = incomeJobs.find(j => j.id === shift.jobId);
        if (!job) return;
        const hours = calculateHours(shift.startTime, shift.endTime);
        const earn = (hours * job.rate).toFixed(2);
        const card = document.createElement('div');
        card.className = "bg-surface-container-lowest dark:bg-slate-900 rounded-xl p-6 transition-all hover:translate-x-1 duration-300 border relative overflow-hidden group lesson-card";
        card.style.borderColor = job.color;
        card.innerHTML = `
          <div class="absolute top-0 left-0 w-1 h-full" style="background-color: ${job.color}"></div>
          <div class="flex items-start justify-between">
            <div class="flex gap-6 w-full">
              <div class="flex flex-col items-center min-w-[64px]">
                <span class="text-lg font-extrabold" style="color: ${job.color}">${shift.startTime}</span>
                <div class="w-[2px] h-8 my-1" style="background-color: ${job.color}; opacity:.3"></div>
                <span class="text-xs font-semibold text-on-surface-variant/60 dark:text-slate-400">${shift.endTime}</span>
              </div>
              <div class="flex-grow">
                <div class="flex flex-wrap items-center gap-2 mb-2">
                  <span class="text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded" style="background-color: ${job.color}; color: ${getContrastColor(job.color)}">Работа</span>
                </div>
                <h3 class="text-lg md:text-xl font-bold text-on-surface dark:text-white mb-2 leading-snug">${escapeHtml(job.name)}</h3>
                <p class="text-on-surface dark:text-slate-200 font-semibold text-sm flex items-center gap-2">
                  <span class="material-symbols-outlined text-base" style="color: ${job.color}">work</span>
                  <span>${hours.toFixed(1)} ч · ${earn} ${job.currency}</span>
                </p>
              </div>
            </div>
          </div>`;
        container.appendChild(card);
      });
  }

  // ===== Три режима отображения: "По дням", "На семестр", "Экзамены" =====
  
  function updateModeButtons() {
    const activeBtnClasses = "segment-btn-active py-2 sm:py-2.5 text-xs sm:text-sm font-bold text-primary dark:text-primary-container flex items-center justify-center gap-1 sm:gap-1.5 transition-all";
    const inactiveBtnClasses = "segment-btn-inactive py-2 sm:py-2.5 text-xs sm:text-sm font-semibold text-on-surface-variant/60 dark:text-slate-400 hover:text-primary dark:hover:text-primary-container flex items-center justify-center gap-1 sm:gap-1.5 transition-all";
    const inactiveExamClasses = "segment-btn-inactive py-2 sm:py-2.5 text-xs sm:text-sm font-semibold text-on-surface-variant/60 dark:text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 flex items-center justify-center gap-1 sm:gap-1.5 transition-all";
    const activeExamBtnClasses = "ml-1 px-3 py-2 rounded-xl text-sm font-bold bg-rose-500 text-white shadow flex items-center gap-1.5 transition-all";
    const inactiveExamBtnClasses = "ml-1 px-3 py-2 rounded-xl text-sm font-semibold border-2 border-rose-400/60 text-rose-600 dark:text-rose-400 bg-rose-50/70 dark:bg-rose-950/30 hover:bg-rose-100 dark:hover:bg-rose-950/50 transition-all flex items-center gap-1.5 shadow-sm";
    
    const isGroupTab = document.getElementById("tab-group").classList.contains("segment-btn-active");
    const isTeacherTab = document.getElementById("tab-teacher").classList.contains("segment-btn-active");
    
    modeDaysBtn.className = currentDisplayMode === "days" ? activeBtnClasses : inactiveBtnClasses;
    modeSemesterBtn.className = currentDisplayMode === "semester" ? activeBtnClasses : inactiveBtnClasses;
    modeExamsBtn.className = currentDisplayMode === "exams" ?
      "segment-btn-exam-active py-2 sm:py-2.5 text-xs sm:text-sm font-bold flex items-center justify-center gap-1 sm:gap-1.5 transition-all" :
      inactiveExamClasses;
    examsToggle.className = currentDisplayMode === "exams" ? activeExamBtnClasses : inactiveExamBtnClasses;

    // В режиме преподавателя скрываем "По дням" и "На семестр" — остаётся только "Экзамены"
    if (isTeacherTab) {
      modeDaysBtn.classList.add("hidden");
      modeSemesterBtn.classList.add("hidden");
    } else {
      modeDaysBtn.classList.remove("hidden");
      modeSemesterBtn.classList.remove("hidden");
    }
    
    // Кнопки "Экзамены" и "Пропуски" рядом с неделями — только в режиме
    // «По группе», а учёт пропусков — строго для основной группы по умолчанию.
    if (isGroupTab) {
      examsToggle.classList.remove("hidden");
      if (isDefaultGroupActive) {
        absenceToggle.classList.remove("hidden");
      } else {
        absenceToggle.classList.add("hidden");
        // Скрываем панель пропусков при выходе из режима основной группы
        if (absencePanel) absencePanel.classList.add("hidden");
      }
    } else {
      examsToggle.classList.add("hidden");
      absenceToggle.classList.add("hidden");
      // Скрываем панель пропусков при выходе из режима основной группы
      if (absencePanel) absencePanel.classList.add("hidden");
    }
  }

  // ===== Обработчики панели учёта пропусков =====
  // Кнопка видна только для основной группы по умолчанию (см. updateModeButtons),
  // поэтому дополнительных проверок режима здесь не требуется.
  if (absenceToggle) {
    absenceToggle.addEventListener("click", () => {
      toggleAbsencePanel();
    });
  }
  const absencePanelClose = document.getElementById("absence-panel-close");
  if (absencePanelClose) {
    absencePanelClose.addEventListener("click", () => {
      if (absencePanel) absencePanel.classList.add("hidden");
    });
  }
  const absenceExcuseForm = document.getElementById("absence-excuse-form");
  if (absenceExcuseForm) {
    // Логика всплывающего календаря для выбора дат оправдательного документа
    let _absenceCalTarget = null; // "start" | "end"
    let _absenceCalDate = new Date();
    const absenceCalGrid = document.getElementById("absence-cal-grid");
    const absenceCalMonth = document.getElementById("absence-cal-month");
    const absenceCalPrev = document.getElementById("absence-cal-prev");
    const absenceCalNext = document.getElementById("absence-cal-next");
    const absenceStartTrigger = document.getElementById("absence-start-trigger");
    const absenceEndTrigger = document.getElementById("absence-end-trigger");
    const absenceStartDisplay = document.getElementById("absence-start-display");
    const absenceEndDisplay = document.getElementById("absence-end-display");
    const absenceExcuseStart = document.getElementById("absence-excuse-start");
    const absenceExcuseEnd = document.getElementById("absence-excuse-end");
    const absenceCalendar = document.getElementById("absence-calendar");

    // Переносим попап календаря в <body>, чтобы на него не влиял transform
    // у карточки панели (animate-slide-down) и он не оказывался запертым
    // в стековом контексте родителя, оставаясь под лентой дней / контентом.
    if (absenceCalendar && absenceCalendar.parentElement !== document.body) {
      document.body.appendChild(absenceCalendar);
    }

    // Границы семестра (если заданы) — вне них оправдательные документы
    // по периоду не работают, поэтому даты за пределами делаем неактивными.
    function getSemesterBounds() {
      const semStartStr = localStorage.getItem("bseu_semester_start_date");
      if (!semStartStr) return null;
      const start = new Date(semStartStr);
      start.setHours(0, 0, 0, 0);
      // Семестр ~ 17 недель (примерно 4 месяца) от старта.
      const end = new Date(start);
      end.setMonth(end.getMonth() + 4);
      end.setDate(end.getDate() + 20);
      return { start, end };
    }

    function renderAbsenceCalendar() {
      if (!absenceCalGrid || !absenceCalMonth) return;
      const year = _absenceCalDate.getFullYear();
      const month = _absenceCalDate.getMonth();
      const firstDay = new Date(year, month, 1);
      const startDow = (firstDay.getDay() + 6) % 7;
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      const monthName = firstDay.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
      absenceCalMonth.textContent = monthName;

      const bounds = getSemesterBounds();
      const sStart = absenceExcuseStart.value;
      const sEnd = absenceExcuseEnd.value;
      const rangeStart = sStart && sEnd ? (sStart <= sEnd ? sStart : sEnd) : null;
      const rangeEnd = sStart && sEnd ? (sStart <= sEnd ? sEnd : sStart) : null;

      // Сводка выбранного периода
      const rangeInfo = document.getElementById("absence-cal-range");
      const rangeText = document.getElementById("absence-cal-range-text");
      if (rangeInfo && rangeText) {
        if (rangeStart && rangeEnd) {
          const days = Math.round((new Date(rangeEnd) - new Date(rangeStart)) / 86400000) + 1;
          rangeText.textContent = `${formatHumanDate(rangeStart)} — ${formatHumanDate(rangeEnd)} · ${days} ${days === 1 ? 'день' : 'дней'}`;
          rangeInfo.classList.remove("hidden");
        } else if (rangeStart) {
          rangeText.textContent = `${formatHumanDate(rangeStart)} — …`;
          rangeInfo.classList.remove("hidden");
        } else {
          rangeInfo.classList.add("hidden");
        }
      }

      let html = '';
      // Заглушки для выравнивания первого дня недели (воскресенье убрано,
      // т.к. заголовки дней недели теперь в самом HTML).
      for (let i = 0; i < startDow; i++) html += '<div class="h-8"></div>';
      for (let day = 1; day <= daysInMonth; day++) {
        const iso = `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
        const dateObj = new Date(year, month, day);
        const isToday = iso === todayISO();
        const isStart = iso === sStart;
        const isEnd = iso === sEnd;
        const inRange = rangeStart && rangeEnd && iso > rangeStart && iso < rangeEnd;
        const disabled = bounds && (dateObj < bounds.start || dateObj > bounds.end);

        let cellCls, capCls = '';
        if (disabled) {
          cellCls = 'text-on-surface-variant/25 dark:text-slate-600';
          capCls = 'rounded-full';
        } else if (isStart && isEnd) {
          cellCls = 'bg-primary text-white font-bold';
          capCls = 'rounded-full';
        } else if (isStart) {
          cellCls = 'bg-primary text-white font-bold';
          capCls = 'rounded-l-full';
        } else if (isEnd) {
          cellCls = 'bg-primary text-white font-bold';
          capCls = 'rounded-r-full';
        } else if (inRange) {
          cellCls = 'bg-primary/15 dark:bg-[#b5bcff]/15 text-primary dark:text-[#b5bcff] font-semibold';
          capCls = '!rounded-none';
        } else if (isToday) {
          cellCls = 'text-primary dark:text-[#b5bcff] font-bold hover:bg-primary/10 dark:hover:bg-slate-700';
          capCls = 'rounded-full';
        } else {
          cellCls = 'text-slate-700 dark:text-slate-200 hover:bg-primary/10 dark:hover:bg-slate-700';
          capCls = 'rounded-full';
        }

        const attr = disabled ? 'disabled' : '';
        const opacity = disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer';
        html += `<button type="button" data-date="${iso}" ${attr} class="h-8 w-full flex items-center justify-center text-xs font-semibold ${cellCls} ${capCls} transition-colors ${opacity}" ${disabled ? 'aria-disabled="true"' : ''}>${day}</button>`;
      }
      absenceCalGrid.innerHTML = html;
      absenceCalGrid.querySelectorAll('[data-date]').forEach(btn => {
        btn.addEventListener('click', () => {
          if (btn.disabled) return;
          const val = btn.dataset.date;
          if (_absenceCalTarget === "start") {
            absenceExcuseStart.value = val;
            absenceStartDisplay.textContent = formatHumanDate(val);
          } else if (_absenceCalTarget === "end") {
            absenceExcuseEnd.value = val;
            absenceEndDisplay.textContent = formatHumanDate(val);
          }
          absenceCalendar.classList.add('hidden');
        });
      });
    }

    function openAbsenceCalendar(target) {
      _absenceCalTarget = target;
      const currentVal = target === "start" ? absenceExcuseStart.value : absenceExcuseEnd.value;
      if (currentVal) {
        _absenceCalDate = new Date(currentVal);
      } else {
        _absenceCalDate = new Date();
      }
      renderAbsenceCalendar();
      // Позиционируем попап (fixed — поверх всего сайта).
      // На смартфонах делаем его почти во всю ширину и центрируем по экрану,
      // чтобы он не выходил за края и оставался удобным для касаний.
      const trigger = target === "start" ? absenceStartTrigger : absenceEndTrigger;
      absenceCalendar.classList.remove('hidden');
      const isMobile = window.innerWidth < 480;
      if (trigger && !isMobile) {
        const r = trigger.getBoundingClientRect();
        const calH = absenceCalendar.offsetHeight || 320;
        let top = r.bottom + 8;
        if (top + calH > window.innerHeight - 8) {
          top = Math.max(8, r.top - calH - 8);
        }
        absenceCalendar.style.top = `${top}px`;
        let left = r.left + r.width / 2;
        const calW = absenceCalendar.offsetWidth || 340;
        left = Math.min(Math.max(8, left), window.innerWidth - calW - 8);
        absenceCalendar.style.left = `${left}px`;
        absenceCalendar.style.transform = 'translateX(-50%)';
      } else {
        // Смартфон: центрируем по горизонтали и ставим ниже верхней шапки
        absenceCalendar.style.left = '50%';
        absenceCalendar.style.transform = 'translateX(-50%)';
        const calH = absenceCalendar.offsetHeight || 360;
        const safeTop = (window.scrollY || 0) + 72; // под sticky-шапкой
        let top = safeTop;
        if (top + calH > (window.scrollY || 0) + window.innerHeight - 8) {
          top = Math.max(safeTop, (window.scrollY || 0) + window.innerHeight - calH - 8);
        }
        absenceCalendar.style.top = `${top}px`;
      }
    }

    if (absenceStartTrigger) {
      absenceStartTrigger.addEventListener('click', () => openAbsenceCalendar('start'));
    }
    if (absenceEndTrigger) {
      absenceEndTrigger.addEventListener('click', () => openAbsenceCalendar('end'));
    }
    if (absenceCalPrev) {
      absenceCalPrev.addEventListener('click', () => {
        _absenceCalDate.setMonth(_absenceCalDate.getMonth() - 1);
        renderAbsenceCalendar();
      });
    }
    if (absenceCalNext) {
      absenceCalNext.addEventListener('click', () => {
        _absenceCalDate.setMonth(_absenceCalDate.getMonth() + 1);
        renderAbsenceCalendar();
      });
    }
    // Закрытие календаря при клике вне его
    document.addEventListener('click', (e) => {
      if (absenceCalendar && !absenceCalendar.classList.contains('hidden') &&
          !absenceCalendar.contains(e.target) &&
          !e.target.closest('#absence-start-trigger') &&
          !e.target.closest('#absence-end-trigger')) {
        absenceCalendar.classList.add('hidden');
      }
    });
    // Закрытие по Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && absenceCalendar && !absenceCalendar.classList.contains('hidden')) {
        absenceCalendar.classList.add('hidden');
      }
    });

    absenceExcuseForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const label = document.getElementById("absence-excuse-label").value.trim();
      const start = absenceExcuseStart.value;
      const end = absenceExcuseEnd.value;
      if (!start || !end) return;
      addExcuse(label, start, end);
      absenceExcuseForm.reset();
      absenceStartDisplay.textContent = "Выберите дату";
      absenceEndDisplay.textContent = "Выберите дату";
    });
  }
  
  // Включает/выключает кнопки недель (в режиме экзаменов они неактивны)
  function updateWeekButtonsState() {
    if (currentDisplayMode === "exams") {
      // В режиме экзаменов счётчик недель и навигация по неделям не нужны
      weekPrev.classList.add("hidden");
      weekNext.classList.add("hidden");
      weekLabel.classList.add("hidden");
    } else {
      weekPrev.classList.remove("hidden");
      weekNext.classList.remove("hidden");
      weekLabel.classList.remove("hidden");
      weekPrev.disabled = false;
      weekNext.disabled = false;
      weekPrev.classList.remove("opacity-50", "cursor-not-allowed");
      weekNext.classList.remove("opacity-50", "cursor-not-allowed");
    }
  }
  
  // Обработчики кнопок режимов
  modeDaysBtn.addEventListener("click", () => setDisplayMode("days"));
  modeSemesterBtn.addEventListener("click", () => setDisplayMode("semester"));
  modeExamsBtn.addEventListener("click", () => setDisplayMode(currentDisplayMode === "exams" ? "days" : "exams"));
  
  function setDisplayMode(mode) {
    currentDisplayMode = mode;
    updateModeButtons();
    updateWeekButtonsState();
    
    if (!window.cachedLessons || !window.cachedLessons.length) return;
    
    if (mode === "semester") {
      renderSemesterView(false);
    } else if (mode === "exams") {
      renderExamView(false);
    } else {
      const targetDate = window.selectedDateISO || todayISO();
      renderDayStrip(targetDate);
      selectDayOnStrip(targetDate);
    }
  }

  // ===== Фильтр "Экзамены" (экзамены, зачёты, консультации) =====
  
  // Определяет, является ли занятие экзаменом/зачётом/консультацией
  function isExamType(typeStr) {
    if (!typeStr) return false;
    const t = typeStr.toLowerCase().trim();
    // Точное совпадение по одному символу или по полному названию
    return t === 'э' || t === 'з' || 
           t.includes('экз') || t.includes('зач') || t.includes('конс');
  }

  // Рендеринг представления экзаменов/зачётов/консультаций, сгруппированных по датам
  function renderExamView(shouldScroll = true) {
    const isGroupTab = document.getElementById("tab-group").classList.contains("segment-btn-active");
    const isTeacherTab = document.getElementById("tab-teacher").classList.contains("segment-btn-active");
    
    let titlePrefix = "";
    if (isGroupTab) {
      titlePrefix = getGroupTitleText();
    } else if (isTeacherTab) {
      titlePrefix = selectedTeacher?.tname || "";
    }
    
     scheduleTitle.textContent = `${titlePrefix} — Экзамены`;
    scheduleHeaderRow.classList.remove("hidden");
    dayStripContainer.classList.add("hidden");
    scheduleToolbar.classList.remove("hidden");
    updateWeekButtonsState();
    
    const allLessons = window.cachedLessons || [];
    
    const exams = allLessons.filter(l => isExamType(l.type));
    
    if (exams.length === 0) {
      scheduleContainer.innerHTML = `
        <div class="bg-surface-container-lowest dark:bg-slate-900 border border-outline-variant/10 dark:border-slate-800 rounded-2xl p-12 text-center text-on-surface-variant/60 font-semibold flex flex-col items-center gap-3">
          <span class="material-symbols-outlined text-4xl text-slate-400">celebration</span>
          <span>Экзамены, зачёты и консультации не найдены.</span>
        </div>`;
      if (shouldScroll) scrollToSchedule();
      return;
    }
    
    const byDate = {};
    
    exams.forEach(l => {
      const weeks = parseWeeks(l.weeks);
      if (weeks.length === 0) {
        const key = l.day || "Вне сетки";
        if (!byDate[key]) byDate[key] = [];
        byDate[key].push(l);
      } else {
        weeks.forEach(weekNum => {
          const dateISO = getDateForLesson(l.day, weekNum);
          if (dateISO) {
            if (!byDate[dateISO]) byDate[dateISO] = [];
            byDate[dateISO].push({ ...l, _dateISO: dateISO, _weekNum: weekNum });
          } else {
            const key = l.day || "Вне сетки";
            if (!byDate[key]) byDate[key] = [];
            byDate[key].push(l);
          }
        });
      }
    });
    
    const sortedDates = Object.keys(byDate).sort((a, b) => {
      const isADate = /^\d{4}-\d{2}-\d{2}$/.test(a);
      const isBDate = /^\d{4}-\d{2}-\d{2}$/.test(b);
      if (isADate && isBDate) return a.localeCompare(b);
      if (isADate) return -1;
      if (isBDate) return 1;
      return 0;
    });
    
    scheduleContainer.innerHTML = "";
    
    sortedDates.forEach(dateKey => {
      const daySection = document.createElement("div");
      daySection.className = "day-section mb-10";
      
      const dayHeader = document.createElement("div");
      dayHeader.className = "day-header text-sm font-bold text-on-surface-variant dark:text-slate-400 uppercase tracking-wider mb-4 pb-2 border-b border-outline-variant/20 dark:border-slate-800 flex items-center gap-2";
      
      const isIsoDate = /^\d{4}-\d{2}-\d{2}$/.test(dateKey);
      if (isIsoDate) {
        dayHeader.innerHTML = `
          <span class="material-symbols-outlined text-lg">event</span>
          <span>${formatHumanDate(dateKey)}</span>`;
      } else {
        dayHeader.innerHTML = `
          <span class="material-symbols-outlined text-lg">event</span>
          <span>${dateKey}</span>`;
      }
      daySection.appendChild(dayHeader);
      
      const cardsContainer = document.createElement("div");
      cardsContainer.className = "cards-container space-y-4";
      
      byDate[dateKey].forEach(l => {
        const styles = getLessonStyles(l.type);
        
        const card = document.createElement("div");
        card.className = `bg-surface-container-lowest dark:bg-slate-900 rounded-xl p-6 transition-all hover:translate-x-1 duration-300 border ${styles.borderColor} shadow-sm relative overflow-hidden group lesson-card`;
        card.setAttribute("data-search", `${l.subject} ${l.teacher}`.toLowerCase());
        card._lesson = l;
        card.dataset.attKey = getAttendanceKey(l);

        const timeParts = l.time.split("-");
        const startTime = timeParts[0] ? timeParts[0].trim() : l.time;
        const endTime = timeParts[1] ? timeParts[1].trim() : "";
        
        const typeBadge = l.type ? `<span class="${styles.badge} text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded">${l.type}</span>` : "";

        card.innerHTML = `
          <div class="absolute top-0 left-0 w-1 h-full ${styles.border}"></div>
          <div class="flex items-start justify-between">
            <div class="flex gap-6 w-full">
              <div class="flex flex-col items-center min-w-[64px]">
                <span class="text-lg font-extrabold text-on-surface dark:text-white">${startTime}</span>
                <div class="w-[2px] h-8 bg-surface-container-highest dark:bg-slate-800 my-1"></div>
                <span class="text-xs font-semibold text-on-surface-variant/60 dark:text-slate-400">${endTime}</span>
              </div>
              <div class="flex-grow">
                <div class="flex flex-wrap items-center gap-2 mb-2">
                  ${typeBadge}
                  <span class="text-primary dark:text-[#b5bcff] font-bold text-xs md:text-sm flex items-center gap-1">
                    <span class="material-symbols-outlined text-base">location_on</span>
                    <span>Ауд. ${l.room || '—'}</span>
                  </span>
                </div>
                <h3 class="text-lg md:text-xl font-bold text-on-surface dark:text-white mb-2 leading-snug">${l.subject}</h3>
                <p class="text-on-surface dark:text-slate-200 font-semibold text-sm flex items-center gap-2">
                  <span class="material-symbols-outlined text-base text-slate-400">${l.isTeacher ? 'groups' : 'person'}</span>
                  <span>${l.teacher || '—'}</span>
                 </p>
               </div>
             </div>
           </div>
         `;
        if (isGroupModeActive()) {
          card.appendChild(buildAttendanceToggle(l));
        }
        cardsContainer.appendChild(card);
      });
      
      daySection.appendChild(cardsContainer);
      scheduleContainer.appendChild(daySection);
    });
    
    if (shouldScroll) scrollToSchedule();
  }

  // Инициализация кнопок режима
  updateModeButtons();

  // Функции управления видимостью виджета выбора
  function hideWidget() {
    if (widgetEl) widgetEl.classList.add('hidden');
    if (heroTextEl) heroTextEl.classList.add('hidden');
    const heroSection = heroTextEl ? heroTextEl.closest('section') : null;
    if (heroSection) {
      heroSection.classList.add('!pt-0', '!pb-0');
    }
  }
  
  function showWidget() {
    if (widgetEl) widgetEl.classList.remove('hidden');
    if (heroTextEl) heroTextEl.classList.remove('hidden');
    // Восстанавливаем отступы hero секции
    const heroSection = heroTextEl ? heroTextEl.closest('section') : null;
    if (heroSection) {
      heroSection.classList.remove('!pt-0', '!pb-0');
    }
  }

  function showPrimaryGroupButton(groupName) {
    // В шапке показываем карандаш для смены группы по умолчанию
    // и кнопку быстрого возврата к группе по умолчанию (доступна и на ПК)
    navPrimaryGroupWrapper.classList.remove("hidden");
    navEditGroup.classList.remove("hidden");
    if (navDefaultGroup) navDefaultGroup.classList.remove("hidden");
    // В нижней панели — кнопка основной группы по умолчанию (сокращённый код)
    const bottomDefaultBtn = document.getElementById("bottom-default-group-btn");
    const bottomDefaultLabel = document.getElementById("bottom-default-group-label");
    if (bottomDefaultBtn) bottomDefaultBtn.classList.remove("hidden");
    if (bottomDefaultLabel) bottomDefaultLabel.textContent = shortenGroupName(groupName);
    const navDefaultLabel = document.getElementById("nav-default-group-label");
    if (navDefaultLabel) navDefaultLabel.textContent = shortenGroupName(groupName);
  }

  function setDefaultGroupActiveState(active) {
    if (!navDefaultGroup) return;
    const icon = document.getElementById("nav-default-group-icon");
    if (active) {
      navDefaultGroup.classList.remove("text-primary/60", "dark:text-[#b5bcff]/60");
      navDefaultGroup.classList.add("text-primary", "dark:text-[#b5bcff]");
      if (icon) icon.style.fontVariationSettings = "'FILL' 1";
    } else {
      navDefaultGroup.classList.add("text-primary/60", "dark:text-[#b5bcff]/60");
      navDefaultGroup.classList.remove("text-primary", "dark:text-[#b5bcff]");
      if (icon) icon.style.fontVariationSettings = "'FILL' 0";
    }
  }

  // Переключает класс на <body>, чтобы на смартфоне в режиме основной группы
  // можно было убрать отступы hero-секции и прижать расписание к шапке.
  function updateDefaultGroupModeClass() {
    document.body.classList.toggle("default-group-mode", !!isDefaultGroupActive);
  }

  function hidePrimaryGroupButton() {
    navEditGroup.classList.add("hidden");
    const bottomDefaultBtn = document.getElementById("bottom-default-group-btn");
    if (bottomDefaultBtn) bottomDefaultBtn.classList.add("hidden");
    setTimeout(() => {
      navPrimaryGroupWrapper.classList.add("hidden");
    }, 300);
  }

  function updatePrimaryGroupButtonVisibility() {
    const primaryGroupStr = localStorage.getItem("bseu_primary_group");
    if (!primaryGroupStr) {
      // Кнопка не показывается, если нет сохранённой группы
      navPrimaryGroupWrapper.classList.add("hidden");
      navEditGroup.classList.add("hidden");
      if (navDefaultGroup) navDefaultGroup.classList.add("hidden");
      updateModeButtons();
      return;
    }
    const primaryGroup = JSON.parse(primaryGroupStr);
    // Кнопка группы всегда видима (не скрывается при переключении на вкладку группы)
    showPrimaryGroupButton(primaryGroup.groupText);
    updateModeButtons();
  }

  function showFirstTimeModal() {
    populateFacultySelect(modalFaculty);
    
    firstTimeModal.classList.remove("hidden");
    requestAnimationFrame(() => {
      firstTimeModal.classList.remove("opacity-0");
      firstTimeModal.classList.add("opacity-100");
      firstTimeModal.querySelector(".bg-white").classList.remove("scale-95");
      firstTimeModal.querySelector(".bg-white").classList.add("scale-100");
    });
  }

  function hideFirstTimeModal() {
    firstTimeModal.classList.remove("opacity-100");
    firstTimeModal.classList.add("opacity-0");
    firstTimeModal.querySelector(".bg-white").classList.remove("scale-100");
    firstTimeModal.querySelector(".bg-white").classList.add("scale-95");
    setTimeout(() => {
      firstTimeModal.classList.add("hidden");
    }, 300);
  }

  // Гарантирует, что в селекте есть опция с нужным value (и выбрана),
  // даже если каскадная загрузка списков с сервера не удалась. Без этого
  // при сбое сети value не «прилипает» к select и getSchedule получает "-1",
  // из-за чего группа по умолчанию не загружается автоматически.
  function ensureSelectValue(sel, value, text) {
    if (!sel || !value || value === "-1") return;
    let opt = Array.from(sel.options).find(o => o.value === value);
    if (!opt) {
      opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text || value;
      sel.appendChild(opt);
    }
    sel.disabled = false;
    sel.value = value;
  }

  async function applyGroupState(state, opts = {}) {
    isDefaultGroupActive = true; // загружается основная группа по умолчанию
    setDefaultGroupActiveState(true);
    updateDefaultGroupModeClass();
    // Показываем элементы режима «По группе», которые иначе скрыты до
    // первого вызова setActiveTab("group"). Без этого расписание
    // рендерится в скрытый контейнер и не видно до повторного переключения.
    if (typeof dayStripContainer !== 'undefined' && dayStripContainer) {
      dayStripContainer.classList.remove('hidden');
    }
    if (typeof scheduleToolbar !== 'undefined' && scheduleToolbar) {
      scheduleToolbar.classList.toggle("hidden", !(window.cachedLessons && window.cachedLessons.length));
    }
    periodSection.style.display = 'block';
    modeDaysBtn.classList.remove("hidden");
    modeSemesterBtn.classList.remove("hidden");
    modeExamsBtn.classList.remove("hidden");
    // Сбрасываем все top-mode кнопки в неактивное состояние
    const topGroup = document.getElementById("top-mode-group");
    const topTeacher = document.getElementById("top-mode-teacher");
    const topRoom = document.getElementById("top-mode-room");
    const inactiveTopClasses = "segment-btn-inactive px-2 sm:px-3 py-1.5 sm:py-2 text-xs sm:text-sm font-semibold text-on-surface-variant dark:text-slate-300 transition";
    topGroup.className = inactiveTopClasses;
    topTeacher.className = inactiveTopClasses;
    topRoom.className = inactiveTopClasses;
    
    hideWidget();
    // Убираем отступы hero секции когда виджет скрыт
    const heroSection = document.getElementById("hero-section");
    if (heroSection) {
      heroSection.classList.add('!pt-0', '!pb-0');
    }
    
    ensureSelectValue(facultySelect, state.faculty);

    // Каскад загрузок делаем устойчивым к сбоям сети:
    // при ошибке оставляем ранее заполненные списки (они уже валидны
    // после первой успешной загрузки) и всё равно переходим к расписанию,
    // которое при недоступности сервера возьмётся из кэша.
    try {
      resetSelect(formSelect, "Загрузка форм...");
      const forms = await apiRequest("__id.22.main.inpFldsA.GetForms", { faculty: state.faculty });
      populateSelect(formSelect, forms, "Выберите форму обучения");
      formSelect.value = state.form;
    } catch (e) {
      console.warn("Не удалось обновить формы, используем ранее загруженные:", e);
    }
    ensureSelectValue(formSelect, state.form);

    try {
      resetSelect(courseSelect, "Загрузка курсов...");
      const courses = await apiRequest("__id.23.main.inpFldsA.GetCourse", { faculty: state.faculty, form: state.form });
      populateSelect(courseSelect, courses, "Выберите курс");
      courseSelect.value = state.course;
    } catch (e) {
      console.warn("Не удалось обновить курсы, используем ранее загруженные:", e);
    }
    ensureSelectValue(courseSelect, state.course);

    try {
      resetSelect(groupSelect, "Загрузка групп...");
      const groups = await apiRequest("__id.23.main.inpFldsA.GetGroups", { faculty: state.faculty, form: state.form, course: state.course });
      populateSelect(groupSelect, groups, "Выберите группу", shortenGroupName);
      applySelectAbbrev(groupSelect);
    } catch (e) {
      console.warn("Не удалось обновить группы, используем ранее загруженные:", e);
    }
    ensureSelectValue(groupSelect, state.group, state.groupText);
    applySelectAbbrev(facultySelect);
    applySelectAbbrev(groupSelect);

    await getSchedule(false, { silent: !!opts.silent });
    updatePrimaryGroupButtonVisibility();
    updateModeButtons();
    refreshAttendanceToggles();

    // Активируем кнопку основной группы в нижней навигации
    document.querySelectorAll('.mobile-bottom-nav-btn').forEach(btn => {
      btn.classList.remove('active');
    });
    const bottomDefaultBtn = document.getElementById('bottom-default-group-btn');
    if (bottomDefaultBtn) bottomDefaultBtn.classList.add('active');
  }

  // Настройка событий для модального окна первого входа
  modalFaculty.addEventListener("change", async () => {
    resetSelect(modalForm, "Загрузка форм...");
    resetSelect(modalCourse, "Выберите курс");
    resetSelect(modalGroup, "Выберите группу");
    modalSaveBtn.disabled = true;
    
    if (modalFaculty.value === "-1") {
      resetSelect(modalForm, "Не выбран факультет");
      return;
    }
    try {
      const response = await apiRequest("__id.22.main.inpFldsA.GetForms", { faculty: modalFaculty.value });
      populateSelect(modalForm, response, "Выберите форму обучения");
    } catch (e) {
      showError("Ошибка загрузки форм в модалке: " + e.message);
    }
  });

  modalForm.addEventListener("change", async () => {
    resetSelect(modalCourse, "Загрузка курсов...");
    resetSelect(modalGroup, "Выберите группу");
    modalSaveBtn.disabled = true;
    
    if (modalForm.value === "-1") {
      resetSelect(modalCourse, "Не выбрана форма");
      return;
    }
    try {
      const response = await apiRequest("__id.23.main.inpFldsA.GetCourse", { faculty: modalFaculty.value, form: modalForm.value });
      populateSelect(modalCourse, response, "Выберите курс");
    } catch (e) {
      showError("Ошибка загрузки курсов в модалке: " + e.message);
    }
  });

  modalCourse.addEventListener("change", async () => {
    resetSelect(modalGroup, "Загрузка групп...");
    modalSaveBtn.disabled = true;
    
    if (modalCourse.value === "-1") {
      resetSelect(modalGroup, "Не выбран курс");
      return;
    }
    try {
      const response = await apiRequest("__id.23.main.inpFldsA.GetGroups", { faculty: modalFaculty.value, form: modalForm.value, course: modalCourse.value });
      populateSelect(modalGroup, response, "Выберите группу", shortenGroupName);
      applySelectAbbrev(modalGroup);
    } catch (e) {
      showError("Ошибка загрузки групп в модалке: " + e.message);
    }
  });

  modalGroup.addEventListener("change", () => {
    modalSaveBtn.disabled = modalGroup.value === "-1";
  });

  modalSaveBtn.addEventListener("click", async () => {
    const selGroupText = getSelectOptionFullText(modalGroup);
    const primaryGroup = {
      faculty: modalFaculty.value,
      form: modalForm.value,
      course: modalCourse.value,
      group: modalGroup.value,
      groupText: selGroupText
    };
    
    localStorage.setItem("bseu_primary_group", JSON.stringify(primaryGroup));
    hideFirstTimeModal();
    setActiveTab("group");
    await applyGroupState(primaryGroup);
    // После первого выбора группы предлагаем создать аккаунт (один раз)
    if (window.AccountSync && typeof window.AccountSync.showOfferIfNeeded === 'function') {
      setTimeout(() => window.AccountSync.showOfferIfNeeded(), 600);
    }
  });

  // Кнопка "Моя группа по умолчанию" (звезда) — возврат к основной группе.
  // Доступна и на ПК (в мобильной нижней панели ей соответствует bottom-default-group-btn).
  function selectDefaultGroup() {
    document.querySelectorAll('.mobile-bottom-nav-btn').forEach(btn => btn.classList.remove('active'));
    const bottomDefaultBtn = document.getElementById('bottom-default-group-btn');
    if (bottomDefaultBtn) bottomDefaultBtn.classList.add('active');
    if (window.isInIncomeMode && typeof exitIncomeMode === 'function') {
      exitIncomeMode();
    }
    const primaryGroupStr = localStorage.getItem("bseu_primary_group");
    if (!primaryGroupStr) {
      // Нет сохранённой группы — открываем выбор
      setActiveTab("group");
      showFirstTimeModal();
      return;
    }
    const primaryGroup = JSON.parse(primaryGroupStr);
    showPrimaryGroupButton(primaryGroup.groupText);
    setActiveTab("group");
    hideWidget();

    // Мгновенно показываем ранее загруженное расписание группы по умолчанию,
    // чтобы при возврате из других режимов информация появлялась сразу,
    // без повторной загрузки и спиннера.
    const cachedGroupLessons = loadPrimaryGroupLessonsCache();
    if (cachedGroupLessons && cachedGroupLessons.length) {
      isDefaultGroupActive = true;
      setDefaultGroupActiveState(true);
      updateDefaultGroupModeClass();
      window.cachedLessons = cachedGroupLessons;
      scheduleTitle.textContent = getGroupTitleText();
      scheduleHeaderRow.classList.remove("hidden");
      renderCurrentMode(false);
      updateModeButtons();
      refreshAttendanceToggles();
      // Синхронизируем панель недели (setActiveTab переключал ей
      // по устаревшим данным из другого режима).
      if (currentDisplayMode === "days") {
        scheduleToolbar.classList.toggle("hidden", !(window.cachedLessons && window.cachedLessons.length));
      }
      updatePrimaryGroupButtonVisibility();
    }

    // Фоновое обновление без спиннера (перезапишет кэш при успехе).
    // Если кэша нет — грузим обычным способом (со спиннером).
    const refreshOpts = (cachedGroupLessons && cachedGroupLessons.length) ? { silent: true } : {};
    applyGroupState(primaryGroup, refreshOpts).catch((e) => {
      // Группа сохранена — модалку первого входа не показываем.
      // При недоступности сервера getSchedule сам отрисует кэш/ошибку.
      console.error("Не удалось обновить группу по умолчанию:", e);
    });
  }

  if (navDefaultGroup) {
    navDefaultGroup.addEventListener("click", () => selectDefaultGroup());
  }

  const bottomDefaultBtnEl = document.getElementById("bottom-default-group-btn");
  if (bottomDefaultBtnEl) {
    bottomDefaultBtnEl.addEventListener("click", (e) => {
      e.preventDefault();
      selectDefaultGroup();
    });
  }

  // Кнопка карандаш - открыть модалку для изменения группы по умолчанию
  navEditGroup.addEventListener("click", async () => {
    isEditingGroup = true;
    const primaryGroupStr = localStorage.getItem("bseu_primary_group");
    if (!primaryGroupStr) return;
    
    const primaryGroup = JSON.parse(primaryGroupStr);
    
    // Сбрасываем модалку и заново заполняем факультеты
    populateFacultySelect(modalFaculty);
    resetSelect(modalForm, "Загрузка форм...");
    resetSelect(modalCourse, "Выберите курс");
    resetSelect(modalGroup, "Выберите группу");
    modalSaveBtn.disabled = true;
    
    // Показываем модалку сразу, чтобы пользователь видел прогресс
    firstTimeModal.classList.remove("hidden");
    requestAnimationFrame(() => {
      firstTimeModal.classList.remove("opacity-0");
      firstTimeModal.classList.add("opacity-100");
      firstTimeModal.querySelector(".bg-white").classList.remove("scale-95");
      firstTimeModal.querySelector(".bg-white").classList.add("scale-100");
    });
    
    // Устанавливаем факультет и загружаем данные последовательно
    modalFaculty.value = primaryGroup.faculty;
    
    try {
      // Загружаем формы
      const forms = await apiRequest("__id.22.main.inpFldsA.GetForms", { faculty: primaryGroup.faculty });
      populateSelect(modalForm, forms, "Выберите форму обучения");
      modalForm.value = primaryGroup.form;
      
      // Загружаем курсы
      const courses = await apiRequest("__id.23.main.inpFldsA.GetCourse", { faculty: primaryGroup.faculty, form: primaryGroup.form });
      populateSelect(modalCourse, courses, "Выберите курс");
      modalCourse.value = primaryGroup.course;
      
      // Загружаем группы
      const groups = await apiRequest("__id.23.main.inpFldsA.GetGroups", { faculty: primaryGroup.faculty, form: primaryGroup.form, course: primaryGroup.course });
      populateSelect(modalGroup, groups, "Выберите группу", shortenGroupName);
      modalGroup.value = primaryGroup.group;
      modalSaveBtn.disabled = false;
      applySelectAbbrev(modalFaculty);
      applySelectAbbrev(modalGroup);
    } catch (e) {
      showError("Ошибка загрузки данных: " + e.message);
    }
  });

  // Закрытие модалки при клике на пустое место (только в режиме редактирования)
  firstTimeModal.addEventListener("click", (e) => {
    if (isEditingGroup && e.target === firstTimeModal) {
      hideFirstTimeModal();
      isEditingGroup = false;
    }
  });

  // Вспомогательная функция для форматирования даты в ISO (местное время)
  function formatDateToISO(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  
  // Обработчики кнопок недели
  weekPrev.addEventListener('click', () => {
    if (currentDisplayMode === "exams") return;
    currentWeekOffset--;
    updateWeekLabel();
    const newStartDate = getStartOfWeek(currentWeekOffset);
    const newDateISO = formatDateToISO(newStartDate);
    renderDayStrip(newDateISO);
    // Переключаем расписание для всех режимов кроме аудитории
    const isRoomTab = document.getElementById("tab-room").classList.contains("segment-btn-active");
    if (!isRoomTab) {
      renderLessonsForDate(newDateISO);
    }
  });
  
  weekNext.addEventListener('click', () => {
    if (currentDisplayMode === "exams") return;
    currentWeekOffset++;
    updateWeekLabel();
    const newStartDate = getStartOfWeek(currentWeekOffset);
    const newDateISO = formatDateToISO(newStartDate);
    renderDayStrip(newDateISO);
    // Переключаем расписание для всех режимов кроме аудитории
    const isRoomTab = document.getElementById("tab-room").classList.contains("segment-btn-active");
    if (!isRoomTab) {
      renderLessonsForDate(newDateISO);
    }
  });

  // Кнопка "Экзамены" рядом с переключателем недель: включает/выключает режим экзаменов
  examsToggle.addEventListener('click', () => {
    setDisplayMode(currentDisplayMode === "exams" ? "days" : "exams");
  });

  // ==========================================
  // ЛОГИКА РЕЖИМА "УЧЁТ ДОХОДОВ" (INCOME MODE)
  // ==========================================

  window.isInIncomeMode = false;

  // Селекторы элементов Доходов
  const incomeToggle = document.getElementById("income-toggle");
  const incomeDot = document.getElementById("income-dot");
  const scheduleViewContainer = document.getElementById("schedule-view-container");
  const incomeViewContainer = document.getElementById("income-view-container");
  const incomeSettingsBtn = document.getElementById("income-settings-btn");
  const incomeSettingsModal = document.getElementById("income-settings-modal");
  const closeIncomeSettingsBtn = document.getElementById("close-income-settings-btn");
  
  const currencySelect = document.getElementById("currency-select");
  const periodStartDay = document.getElementById("period-start-day");
  const salaryCurrency = document.getElementById("salary-currency");
  const salaryAmount = document.getElementById("salary-amount");
  const jobForm = document.getElementById("job-form");
  const jobName = document.getElementById("job-name");
  const jobCurrency = document.getElementById("job-currency");
  const jobRate = document.getElementById("job-rate");
  const jobColor = document.getElementById("job-color");
  const jobsList = document.getElementById("jobs-list");
  
  const shiftModal = document.getElementById("shift-modal");
  const closeShiftModalBtn = document.getElementById("close-shift-modal-btn");
  const currentDayShifts = document.getElementById("current-day-shifts");
  const modalIntersectionWarning = document.getElementById("modal-intersection-warning");
  const modalIntersectionMuted = document.getElementById("modal-intersection-muted");
  let currentShiftModalDate = null;
  const shiftForm = document.getElementById("shift-form");
  const shiftDateInput = document.getElementById("shift-date");
  const jobSelectorList = document.getElementById("job-selector-list");
  const selectedJobId = document.getElementById("selected-job-id");
  const shiftStart = document.getElementById("shift-start");
  const shiftEnd = document.getElementById("shift-end");
  
  const calendarPrevMonth = document.getElementById("calendar-prev-month");
  const calendarNextMonth = document.getElementById("calendar-next-month");
  const calendarMonthYear = document.getElementById("calendar-month-year");
  const calendarGrid = document.getElementById("calendar-grid");
  
  const incomePrevPeriod = document.getElementById("income-prev-period");
  const incomeNextPeriod = document.getElementById("income-next-period");
  const incomeMonthLabel = document.getElementById("income-month-label");
  const totalIncomeValue = document.getElementById("total-income-value");
  const incomeDisplayArea = document.getElementById("income-display-area");
  const incomeByJobs = document.getElementById("income-by-jobs");
  const graphCurrencyBadge = document.getElementById("graph-currency-badge");
  const multicurrencyToggle = document.getElementById("multicurrency-toggle");

  // Переменные состояния Доходов
  incomeJobs = JSON.parse(localStorage.getItem('jobs')) || [
      { id: '1', name: 'Основная работа', rate: 12.50, currency: 'BYN', color: '#98A2F3' }
  ];
  incomeShifts = JSON.parse(localStorage.getItem('shifts')) || [];
  let incomeCurrentCurrency = localStorage.getItem('currency') || 'BYN';
  let incomeStartDay = parseInt(localStorage.getItem('startDay')) || 1;
  let incomeIsMultiCurrency = localStorage.getItem('isMultiCurrency') === 'true';
  let incomeMonthlySalariesPeriod = JSON.parse(localStorage.getItem('monthlySalariesPeriod')) || {};
  // Дни, для которых скрыто уведомление о пересечении с парами
  let incomeDismissedIntersections = JSON.parse(localStorage.getItem('dismissedIntersections')) || [];

  let incomeGlobalDate = new Date(); 
  let incomeChartInstance = null;
  let incomeRates = { USD: 1, EUR: 1, RUB: 1, BYN: 1 }; 
  const incomeMonths = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];

  // Инициализация значений элементов
  if (currencySelect) currencySelect.value = incomeCurrentCurrency;
  if (periodStartDay) periodStartDay.value = incomeStartDay;
  if (multicurrencyToggle) multicurrencyToggle.checked = incomeIsMultiCurrency;

  // Обработчик закрытия модалок по клику вне контента
  window.addEventListener('click', (event) => {
    if (event.target === incomeSettingsModal) closeIncomeSettings();
    if (event.target === shiftModal) closeShiftModal();
  });

  // Вспомогательные функции для расчёта пересечений

  function parseTimeToMinutes(timeStr) {
    if (!timeStr) return 0;
    const parts = timeStr.trim().split(":");
    const h = parseInt(parts[0]) || 0;
    const m = parseInt(parts[1]) || 0;
    return h * 60 + m;
  }

  // Кэш распарсенного расписания группы, чтобы не делать
  // JSON.parse(localStorage) на каядый день календаря и каядую проверку пересечения
  let _cachedLessonsRaw = null;
  let _cachedLessonsArr = [];
  function getPrimaryGroupLessons() {
    const raw = localStorage.getItem("bseu_primary_group_lessons");
    if (raw !== _cachedLessonsRaw) {
      _cachedLessonsRaw = raw;
      try { _cachedLessonsArr = raw ? JSON.parse(raw) : []; }
      catch (e) { console.error(e); _cachedLessonsArr = []; }
    }
    return _cachedLessonsArr;
  }

  function getLessonsForDate(dateISO) {
    const lessons = getPrimaryGroupLessons();
    if (!lessons.length) return [];
    
    const date = new Date(dateISO + "T12:00:00");
    const daysOfWeekRU = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
    const targetDayName = daysOfWeekRU[date.getDay()];
    
    const semStartStr = localStorage.getItem("bseu_semester_start_date");
    let targetWeekNum = 1;
    if (semStartStr) {
      const semStart = new Date(semStartStr);
      const targetMonday = getMonday(date);
      targetMonday.setHours(0,0,0,0);
      const semesterMonday = getMonday(semStart);
      semesterMonday.setHours(0,0,0,0);
      const msDiff = targetMonday.getTime() - semesterMonday.getTime();
      const weekDiff = Math.round(msDiff / (7 * 24 * 60 * 60 * 1000));
      targetWeekNum = weekDiff + 1;
    }
    
    return lessons.filter(l => {
      if (l.day.toLowerCase() !== targetDayName) return false;
      const weeks = parseWeeks(l.weeks);
      return weeks.length === 0 || weeks.includes(targetWeekNum);
    });
  }

  function isIntersectionDismissed(dateStr) {
    return incomeDismissedIntersections.includes(dateStr);
  }
  function dismissIntersection(dateStr) {
    if (!incomeDismissedIntersections.includes(dateStr)) {
      incomeDismissedIntersections.push(dateStr);
      saveIncomeData();
    }
  }
  function showIntersection(dateStr) {
    incomeDismissedIntersections = incomeDismissedIntersections.filter(d => d !== dateStr);
    saveIncomeData();
  }

  window.updateIntersectionAlerts = function() {
    const todayStr = todayISO();
    let hasAnyFutureIntersection = false;
    
    incomeShifts.forEach(shift => {
      if (shift.date >= todayStr && !isIntersectionDismissed(shift.date)) {
        const dayLessons = getLessonsForDate(shift.date);
        if (dayLessons.length > 0) {
          const shiftStartMin = parseTimeToMinutes(shift.startTime);
          const shiftEndMin = parseTimeToMinutes(shift.endTime);
          
          dayLessons.forEach(l => {
            const timeParts = l.time.split("-");
            const classStartMin = parseTimeToMinutes(timeParts[0]);
            const classEndMin = parseTimeToMinutes(timeParts[1]);
            
            if (classStartMin < shiftEndMin && shiftStartMin < classEndMin) {
              hasAnyFutureIntersection = true;
            }
          });
        }
      }
    });
    
    if (incomeDot) {
      if (hasAnyFutureIntersection) {
        incomeDot.classList.remove("hidden");
        incomeToggle.classList.add("income-blink");
        const bottomIncomeBtn = document.getElementById("bottom-income-btn");
        if (bottomIncomeBtn) bottomIncomeBtn.classList.add("income-blink");
      } else {
        incomeDot.classList.add("hidden");
        incomeToggle.classList.remove("income-blink");
        const bottomIncomeBtn = document.getElementById("bottom-income-btn");
        if (bottomIncomeBtn) bottomIncomeBtn.classList.remove("income-blink");
      }
    }
  };

  // Подсветка стрелок переключения месяца, если пересечение смен с парами есть в соседнем месяце
  function shiftHasClassIntersection(shift) {
    if (isIntersectionDismissed(shift.date)) return false;
    // Стрелки месяцев сигнализируют только о будущих пересечениях
    if (shift.date < todayISO()) return false;
    const dayLessons = getLessonsForDate(shift.date);
    if (!dayLessons.length) return false;
    const shiftStartMin = parseTimeToMinutes(shift.startTime);
    const shiftEndMin = parseTimeToMinutes(shift.endTime);
    return dayLessons.some(l => {
      const parts = l.time.split("-");
      const classStartMin = parseTimeToMinutes(parts[0]);
      const classEndMin = parseTimeToMinutes(parts[1]);
      return classStartMin < shiftEndMin && shiftStartMin < classEndMin;
    });
  }

  function toggleArrowAlert(el, on) {
    if (el) el.classList.toggle("month-arrow-alert", on);
  }

  window.updateMonthArrowAlerts = function() {
    const curYear = incomeGlobalDate.getFullYear();
    const curMonth = incomeGlobalDate.getMonth();
    let prevHas = false;
    let nextHas = false;

    for (const shift of incomeShifts) {
      if (!shiftHasClassIntersection(shift)) continue;
      const shiftDate = new Date(shift.date + "T12:00:00");
      if (Number.isNaN(shiftDate.getTime())) continue;
      // Текущий отображаемый месяц уже виден на календаре — пропускаем
      if (shiftDate.getFullYear() === curYear && shiftDate.getMonth() === curMonth) continue;
      if (shiftDate.getFullYear() < curYear || (shiftDate.getFullYear() === curYear && shiftDate.getMonth() < curMonth)) {
        prevHas = true;
      } else {
        nextHas = true;
      }
      if (prevHas && nextHas) break;
    }

    toggleArrowAlert(calendarPrevMonth, prevHas);
    toggleArrowAlert(calendarNextMonth, nextHas);
    toggleArrowAlert(incomePrevPeriod, prevHas);
    toggleArrowAlert(incomeNextPeriod, nextHas);
  };

  // Режим Доходов: переключение и выход

  function toggleIncomeMode() {
    window.isInIncomeMode = !window.isInIncomeMode;
    if (window.isInIncomeMode) {
      scheduleViewContainer.classList.add("hidden");
      incomeViewContainer.classList.remove("hidden");
      incomeToggle.classList.add("income-active");

      // Сбрасываем отображение верхней панели выбора, если она была открыта
      loadRates();
    } else {
      exitIncomeMode();
    }
    // Пересчитываем сигнал пересечения: красный мигающий индикатор должен
    // сохраняться при входе/выходе из режима дохода (приоритет над зелёным)
    if (typeof updateIntersectionAlerts === "function") updateIntersectionAlerts();
  }

  window.exitIncomeMode = function() {
    window.isInIncomeMode = false;
    scheduleViewContainer.classList.remove("hidden");
    incomeViewContainer.classList.add("hidden");
    incomeToggle.classList.remove("income-active");
    if (typeof updateIntersectionAlerts === "function") updateIntersectionAlerts();
  };

  // Логика калькулятора доходов и валютных ставок

  function getPeriodKey(dateObj) {
    return `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}`;
  }

  function getContrastColor(hex) {
    const r = parseInt(hex.slice(1,3), 16), g = parseInt(hex.slice(3,5), 16), b = parseInt(hex.slice(5,7), 16);
    return (((r * 299) + (g * 587) + (b * 114)) / 1000) >= 140 ? '#212529' : '#ffffff';
  }

  async function loadRates() {
    try {
      const response = await fetch('https://www.nbrb.by/api/exrates/rates?periodicity=0');
      const data = await response.json();
      const usd = data.find(item => item.Cur_Abbreviation === 'USD');
      const eur = data.find(item => item.Cur_Abbreviation === 'EUR');
      const rub = data.find(item => item.Cur_Abbreviation === 'RUB');

      if (usd) { incomeRates.USD = usd.Cur_OfficialRate / usd.Cur_Scale; document.getElementById('usd').textContent = `USD: ${(usd.Cur_OfficialRate / usd.Cur_Scale).toFixed(4)}`; }
      if (eur) { incomeRates.EUR = eur.Cur_OfficialRate / eur.Cur_Scale; document.getElementById('eur').textContent = `EUR: ${(eur.Cur_OfficialRate / eur.Cur_Scale).toFixed(4)}`; }
      if (rub) { incomeRates.RUB = rub.Cur_OfficialRate / rub.Cur_Scale; document.getElementById('rub').textContent = `RUB: ${(rub.Cur_OfficialRate / rub.Cur_Scale).toFixed(4)}`; }
      incomeRates.BYN = 1;
    } catch (e) {
      console.warn("Ошибка загрузки валютных ставок, используем встроенные заглушки:", e);
      incomeRates.USD = 3.2751; incomeRates.EUR = 3.5620; incomeRates.RUB = 0.03584; incomeRates.BYN = 1;
      document.getElementById('usd').textContent = 'USD: 3.2751';
      document.getElementById('eur').textContent = 'EUR: 3.5620';
      document.getElementById('rub').textContent = 'RUB: 3.5840';
    }
    updateIncomeUI(); 
  }

  function convertCurrency(amount, fromCurrency, toCurrency) {
    if (fromCurrency === toCurrency) return amount;
    return (amount * incomeRates[fromCurrency]) / incomeRates[toCurrency];
  }

  function getPeriodRange(year, monthIndex, startDayNum) {
    const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
    // Старт — startDayNum текущего месяца (если число больше дней месяца — берём последний день)
    const startDay = Math.min(Math.max(Math.trunc(startDayNum) || 1, 1), daysInMonth);
    const start = new Date(year, monthIndex, startDay, 0, 0, 0);
    // Конец — день (startDayNum - 1) следующего месяца.
    // Если startDayNum === 1, то (startDayNum - 1) === 0 → последний день текущего месяца.
    const end = new Date(year, monthIndex + 1, startDayNum - 1, 23, 59, 59);
    return { start, end };
  }

  function isDateInCurrentPeriod(dateStr) {
    const checkDate = new Date(dateStr + "T12:00:00");
    const range = getPeriodRange(incomeGlobalDate.getFullYear(), incomeGlobalDate.getMonth(), incomeStartDay);
    return checkDate >= range.start && checkDate <= range.end;
  }

  function syncSalaryInputs() {
    const key = getPeriodKey(incomeGlobalDate);
    const currentSalary = incomeMonthlySalariesPeriod[key] || { amount: 0, currency: 'BYN' };
    salaryAmount.value = currentSalary.amount;
    salaryCurrency.value = currentSalary.currency;
  }

  function saveIncomeData() {
    localStorage.setItem('jobs', JSON.stringify(incomeJobs));
    localStorage.setItem('shifts', JSON.stringify(incomeShifts));
    localStorage.setItem('currency', incomeCurrentCurrency);
    localStorage.setItem('startDay', incomeStartDay);
    localStorage.setItem('isMultiCurrency', incomeIsMultiCurrency);
    localStorage.setItem('monthlySalariesPeriod', JSON.stringify(incomeMonthlySalariesPeriod));
    localStorage.setItem('dismissedIntersections', JSON.stringify(incomeDismissedIntersections));
    updateIncomeUI();
    if (window.AccountSync) window.AccountSync.schedulePush();
  }

  // Настройки Доходов
  function openIncomeSettings() { 
    syncSalaryInputs();
    incomeSettingsModal.classList.remove('hidden', 'opacity-0');
    incomeSettingsModal.classList.add('flex', 'opacity-100');
    incomeSettingsModal.querySelector("div").classList.remove("scale-95");
    incomeSettingsModal.querySelector("div").classList.add("scale-100");
  }
  
  function closeIncomeSettings() { 
    incomeSettingsModal.classList.remove('opacity-100');
    incomeSettingsModal.classList.add('opacity-0');
    incomeSettingsModal.querySelector("div").classList.remove("scale-100");
    incomeSettingsModal.querySelector("div").classList.add("scale-95");
    setTimeout(() => {
      incomeSettingsModal.classList.add('hidden');
    }, 300);
  }

  function openShiftModal(dateStr) {
    shiftDateInput.value = dateStr;
    const formattedDate = dateStr.split('-').reverse().join('.');
    document.getElementById('modal-date-title').innerHTML = `
      <span class="material-symbols-outlined text-primary dark:text-[#b5bcff]">calendar_today</span>
      <span>Смены: ${formattedDate}</span>
    `;
    
    if (incomeJobs.length > 0) {
      if (!selectedJobId.value || !incomeJobs.some(j => j.id === selectedJobId.value)) {
        selectedJobId.value = incomeJobs[0].id;
      }
      renderJobSelector();
    } else {
      alert("Сначала создайте карточку работы в настройках (⚙️)!");
      return;
    }
    
    renderDayShiftsList(dateStr);
    
    // Проверка пересечения смен с парами для отображения предупреждения в модалке
    const dayLessons = getLessonsForDate(dateStr);
    const dayShifts = incomeShifts.filter(s => s.date === dateStr);
    let hasIntersect = false;
    
    if (dayLessons.length > 0 && dayShifts.length > 0) {
      dayShifts.forEach(shift => {
        const shiftStartMin = parseTimeToMinutes(shift.startTime);
        const shiftEndMin = parseTimeToMinutes(shift.endTime);
        
        dayLessons.forEach(l => {
          const timeParts = l.time.split("-");
          const classStartMin = parseTimeToMinutes(timeParts[0]);
          const classEndMin = parseTimeToMinutes(timeParts[1]);
          
          if (classStartMin < shiftEndMin && shiftStartMin < classEndMin) {
            hasIntersect = true;
          }
        });
      });
    }
    
    if (hasIntersect) {
      currentShiftModalDate = dateStr;
      updateModalIntersectionState(dateStr, true);
    } else {
      modalIntersectionWarning.classList.add("hidden");
      if (modalIntersectionMuted) modalIntersectionMuted.classList.add("hidden");
    }

    shiftModal.classList.remove('hidden', 'opacity-0');
    shiftModal.classList.add('flex', 'opacity-100');
    shiftModal.querySelector("div").classList.remove("scale-95");
    shiftModal.querySelector("div").classList.add("scale-100");

    requestAnimationFrame(syncVerticalTimePicker);
  }

  function closeShiftModal() {
    shiftModal.classList.remove('opacity-100');
    shiftModal.classList.add('opacity-0');
    shiftModal.querySelector("div").classList.remove("scale-100");
    shiftModal.querySelector("div").classList.add("scale-95");
    setTimeout(() => {
      shiftModal.classList.add('hidden');
    }, 300);
  }

  // Вертикальная лента выбора времени смены: часы и минуты (шаг 5 мин)
  function pad2(n) { return String(n).padStart(2, '0'); }

  function buildVerticalTimePicker() {
    document.querySelectorAll('.vt-picker').forEach(picker => {
      const hoursCol = picker.querySelector('.vt-hours');
      const minsCol = picker.querySelector('.vt-mins');
      if (!hoursCol || !minsCol) return;
      [['hour', hoursCol], ['min', minsCol]].forEach(([kind, col]) => {
        const count = kind === 'hour' ? 24 : 12;
        for (let i = 0; i < count; i++) {
          const val = kind === 'hour' ? i : i * 5;
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'vt-chip';
          chip.dataset.kind = kind;
          chip.dataset.val = val;
          chip.textContent = pad2(val);
          chip.addEventListener('click', () => {
            col.scrollTo({ top: chip.offsetTop - col.clientHeight / 2 + chip.offsetHeight / 2, behavior: 'smooth' });
          });
          col.appendChild(chip);
        }
        col.addEventListener('scroll', () => {
          if (col._raf) cancelAnimationFrame(col._raf);
          col._raf = requestAnimationFrame(() => updateVtCol(col, picker));
        });
      });
    });
  }

  function updateVtCol(col, picker) {
    const chips = Array.from(col.querySelectorAll('.vt-chip'));
    if (!chips.length) return;
    const center = col.scrollTop + col.clientHeight / 2;
    let best = chips[0];
    let bestDist = Infinity;
    chips.forEach(c => {
      const cCenter = c.offsetTop + c.offsetHeight / 2;
      const d = Math.abs(cCenter - center);
      if (d < bestDist) { bestDist = d; best = c; }
    });
    const isHour = col.classList.contains('vt-hours');
    const hidden = document.getElementById(picker.dataset.input);
    let [hh, mm] = (hidden.value || '00:00').split(':').map(Number);
    if (isHour) hh = parseInt(best.dataset.val, 10);
    else mm = parseInt(best.dataset.val, 10);
    hidden.value = `${pad2(hh)}:${pad2(mm)}`;
    chips.forEach(c => c.classList.toggle('vt-selected', c === best));
    const dispId = picker.dataset.display;
    if (dispId) {
      const disp = document.getElementById(dispId);
      if (disp) disp.textContent = hidden.value;
    }
  }

  function syncOnePicker(pickerEl) {
    if (!pickerEl) return;
    const hidden = document.getElementById(pickerEl.dataset.input);
    if (!hidden) return;
    const [hh, mm] = hidden.value.split(':').map(Number);
    setVtCenter(pickerEl.querySelector('.vt-hours'), hh);
    setVtCenter(pickerEl.querySelector('.vt-mins'), mm);
  }

  function syncVerticalTimePicker() {
    document.querySelectorAll('.vt-picker').forEach(picker => {
      if (picker.offsetParent === null) return; // скрытая лента — пропускаем
      const hidden = document.getElementById(picker.dataset.input);
      if (!hidden) return;
      const [hh, mm] = hidden.value.split(':').map(Number);
      setVtCenter(picker.querySelector('.vt-hours'), hh);
      setVtCenter(picker.querySelector('.vt-mins'), mm);
    });
  }

  function setVtCenter(col, val) {
    if (!col) return;
    const chip = col.querySelector(`.vt-chip[data-val="${val}"]`);
    if (chip) col.scrollTop = chip.offsetTop - col.clientHeight / 2 + chip.offsetHeight / 2;
    updateVtCol(col, col.closest('.vt-picker'));
  }

  // Показывает в модалке либо активное предупреждение о пересечении,

  // либо приглушённое состояние (если для этого дня оно скрыто)
  function updateModalIntersectionState(dateStr, rawIntersect) {
    if (!rawIntersect) {
      modalIntersectionWarning.classList.add("hidden");
      if (modalIntersectionMuted) modalIntersectionMuted.classList.add("hidden");
      return;
    }
    if (isIntersectionDismissed(dateStr)) {
      modalIntersectionWarning.classList.add("hidden");
      if (modalIntersectionMuted) modalIntersectionMuted.classList.remove("hidden");
    } else {
      modalIntersectionWarning.classList.remove("hidden");
      if (modalIntersectionMuted) modalIntersectionMuted.classList.add("hidden");
    }
  }

  // Глобальные обработчики для кнопок скрытия/показа предупреждения
  window.dismissIntersectionForDay = function() {
    if (!currentShiftModalDate) return;
    dismissIntersection(currentShiftModalDate);
    updateModalIntersectionState(currentShiftModalDate, true);
  };
  window.showIntersectionForDay = function() {
    if (!currentShiftModalDate) return;
    showIntersection(currentShiftModalDate);
    updateModalIntersectionState(currentShiftModalDate, true);
  };

  // Отрисовка Календаря — улучшенная, информативная и понятная

  function renderCalendar() {
    calendarGrid.innerHTML = '';
    const year = incomeGlobalDate.getFullYear();
    const month = incomeGlobalDate.getMonth();
    const range = getPeriodRange(year, month, incomeStartDay);
    const pad = (num) => String(num).padStart(2, '0');
    
    calendarMonthYear.innerText = 
      `${pad(range.start.getDate())}.${pad(range.start.getMonth()+1)} - ${pad(range.end.getDate())}.${pad(range.end.getMonth()+1)} (${year})`;

    const firstDayIndex = (new Date(year, month, 1).getDay() + 6) % 7;
    const totalDays = new Date(year, month + 1, 0).getDate();

    // Пустые ячейки до первого дня месяца
    for (let i = 0; i < firstDayIndex; i++) {
      const emptyCell = document.createElement('div');
      emptyCell.className = "bg-transparent";
      calendarGrid.appendChild(emptyCell);
    }

    for (let day = 1; day <= totalDays; day++) {
      const dayDiv = document.createElement('div');
      const dateStr = `${year}-${pad(month + 1)}-${pad(day)}`;
      const inPeriod = isDateInCurrentPeriod(dateStr);
      const isToday = dateStr === todayISO();
      
      // Данные для дня: пары, смены, пересечения, доход
      const dayLessons = getLessonsForDate(dateStr);
      const dayShifts = incomeShifts.filter(s => s.date === dateStr);
      let hasIntersect = false;
      let totalHours = 0;
      let totalEarn = 0;
      
      if (dayLessons.length > 0 && dayShifts.length > 0) {
        dayShifts.forEach(shift => {
          const shiftStartMin = parseTimeToMinutes(shift.startTime);
          const shiftEndMin = parseTimeToMinutes(shift.endTime);
          
          dayLessons.forEach(l => {
            const timeParts = l.time.split("-");
            const classStartMin = parseTimeToMinutes(timeParts[0]);
            const classEndMin = parseTimeToMinutes(timeParts[1]);
            
            if (classStartMin < shiftEndMin && shiftStartMin < classEndMin) {
              hasIntersect = true;
            }
          });
        });
      }
      
      // Расчёт часов и дохода за день
      dayShifts.forEach(shift => {
        const job = incomeJobs.find(j => j.id === shift.jobId);
        if (job) {
          const hours = calculateHours(shift.startTime, shift.endTime);
          totalHours += hours;
          totalEarn += hours * job.rate;
        }
      });

      // Если пересечение для этого дня скрыто пользователем — не показываем предупреждение,
      // но подсвечиваем день жёлтым
      const showIntersect = hasIntersect && !isIntersectionDismissed(dateStr);
      const dismissedIntersect = hasIntersect && isIntersectionDismissed(dateStr);

      const hasLessons = dayLessons.length > 0;
      const hasShifts = dayShifts.length > 0;

      // Цветовые классы ячейки
      let cellBg = 'bg-surface-container-lowest dark:bg-slate-900';
      let cellBorder = 'border-outline-variant/15 dark:border-slate-800';
      let cellText = 'text-on-surface dark:text-slate-200';
      
      if (!inPeriod) {
        cellBg = 'bg-surface-container-low/40 dark:bg-slate-950/20';
        cellText = 'text-on-surface-variant/30 dark:text-slate-600';
        cellBorder = 'border-transparent';
      } else if (showIntersect) {
        cellBg = 'bg-rose-100 dark:bg-rose-950/40';
        cellText = 'text-rose-700 dark:text-rose-300';
        cellBorder = 'border-rose-400 dark:border-rose-700';
      } else if (dismissedIntersect) {
        cellBg = 'bg-amber-50 dark:bg-amber-950/30';
        cellText = 'text-amber-700 dark:text-amber-400/90';
        cellBorder = 'border-amber-200 dark:border-amber-800/70';
      } else if (hasShifts && hasLessons) {
        cellBg = 'bg-emerald-50 dark:bg-emerald-950/20';
        cellText = 'text-emerald-700 dark:text-emerald-300';
        cellBorder = 'border-emerald-300 dark:border-emerald-800';
      } else if (hasShifts) {
        cellBg = 'bg-sky-50 dark:bg-sky-950/15';
        cellText = 'text-sky-700 dark:text-sky-300';
        cellBorder = 'border-sky-300 dark:border-sky-800';
      }
      
      // Специальные бордеры для пересечений
      const intersectRing = showIntersect
        ? 'ring-2 ring-rose-500/60 shadow-[0_0_12px_3px_rgba(239,68,68,0.35)]'
        : (dismissedIntersect
          ? 'ring-1 ring-amber-300/50 shadow-[0_0_6px_1px_rgba(245,158,11,0.18)]'
          : '');
      
      const todayHighlight = isToday && inPeriod
        ? 'ring-2 ring-primary/50'
        : '';

      dayDiv.className = `rounded-xl p-1.5 sm:p-2 text-[11px] font-bold border flex flex-col overflow-hidden transition-all cursor-pointer shadow-sm ${intersectRing} ${todayHighlight} ${cellBg} ${cellText} ${cellBorder} ${
        inPeriod ? 'hover:border-primary/50 dark:hover:border-primary-fixed/50 hover:shadow-md' : 'opacity-40 cursor-default pointer-events-none'
      }`;
      
      // Формируем содержимое ячейки
      // Верхняя строка: число + иконки
      const lessonIcon = hasLessons ? `<span class="material-symbols-outlined text-[12px] leading-none text-primary dark:text-[#b5bcff]" title="${pluralLessons(dayLessons.length)}">auto_stories</span>` : '';
      const shiftIcon = hasShifts ? `<span class="material-symbols-outlined text-[12px] leading-none text-emerald-500 dark:text-emerald-400" title="${totalHours.toFixed(1)}ч работы">work</span>` : '';
      const warningIcon = showIntersect
        ? `<span class="material-symbols-outlined text-[12px] leading-none text-rose-500 animate-pulse" title="Пересечение с парой!">warning</span>`
        : (dismissedIntersect
          ? `<span class="material-symbols-outlined text-[12px] leading-none text-amber-500" title="Пересечение скрыто">warning</span>`
          : '');
      
      // Нижняя строка: часы работы и доход
      let infoLine = '';
      if (hasShifts && inPeriod) {
        const earnInSelected = convertCurrency(totalEarn, incomeJobs.find(j => j.id === dayShifts[0].jobId)?.currency || 'BYN', incomeCurrentCurrency);
        infoLine = `<div class="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400 leading-tight truncate">${totalHours.toFixed(1)}ч · ${earnInSelected.toFixed(0)} ${incomeCurrentCurrency}</div>`;
      } else if (hasLessons && inPeriod) {
        infoLine = `<div class="text-[10px] text-primary/70 dark:text-[#b5bcff]/70 leading-tight truncate">${pluralLessons(dayLessons.length)}</div>`;
      }

      const weekdayName = new Date(year, month, day).toLocaleDateString('ru-RU', { weekday: 'short' });

      dayDiv.innerHTML = `
        <div class="flex items-center justify-between gap-2 relative z-10 leading-none">
          <div class="flex items-baseline gap-2">
            <span class="calendar-daynum font-extrabold text-xs sm:text-sm ${isToday && inPeriod ? 'bg-primary text-white rounded-full w-5 h-5 sm:w-6 sm:h-6 flex items-center justify-center' : ''}">${day}</span>
            <span class="calendar-weekday sm:hidden text-sm font-bold text-on-surface-variant/70 dark:text-slate-400">${weekdayName}</span>
          </div>
          <div class="flex items-center gap-0.5">
            ${warningIcon}${lessonIcon}${shiftIcon}
          </div>
        </div>
        <div class="flex flex-col gap-0.5 overflow-y-auto no-scrollbar min-h-0 relative z-10 mt-0.5 flex-grow">
        </div>
        ${infoLine ? `<div class="mt-auto relative z-10">${infoLine}</div>` : ''}
      `;
      
      const container = dayDiv.querySelector('.flex-col.gap-0\\.5.overflow-y-auto');
      
      // Бейджи пар — компактные, с временем начала и конца пары
      dayLessons.forEach(l => {
        const badge = document.createElement('div');
        const lessonColor = getLessonColorHex(l.type);
        badge.className = 'text-[9px] sm:text-[10px] font-semibold px-1 py-[1px] rounded truncate leading-tight border';
        badge.style.backgroundColor = lessonColor;
        badge.style.color = getContrastColor(lessonColor);
        badge.style.borderColor = lessonColor;
        badge.innerText = `${l.time} ${getShortSubjectName(l)}`;
        badge.title = `${l.subject} (${l.type})\n${l.time}\nАуд. ${l.room}\n${l.teacher}`;
        container.appendChild(badge);
      });

      // Ленты смен — цвет работы и только время; нажатие на ленту (где часы)
      // открывает ленту выбора часов и минут для этой смены
      dayShifts.forEach(shift => {
        const job = incomeJobs.find(j => j.id === shift.jobId);
        if (job) {
          const hours = calculateHours(shift.startTime, shift.endTime);
          const ribbon = document.createElement('div');
          ribbon.className = 'shift-ribbon shift-time-trigger';
          ribbon.setAttribute('role', 'button');
          ribbon.setAttribute('tabindex', '0');
          ribbon.style.backgroundColor = job.color;
          ribbon.style.color = getContrastColor(job.color);
          ribbon.innerHTML = `
            <span class="material-symbols-outlined">schedule</span>
            <span class="ribbon-time">${shift.startTime}<span class="material-symbols-outlined ribbon-arrow">arrow_right</span>${shift.endTime}</span>`;
          ribbon.title = `${job.name}\n${shift.startTime}-${shift.endTime}\n${hours.toFixed(1)}ч · ${(hours * job.rate).toFixed(2)} ${job.currency}\nНажмите на время, чтобы изменить`;
          ribbon.addEventListener('click', (e) => {
            e.stopPropagation();
            openShiftTimePopover(shift, ribbon);
          });
          ribbon.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              openShiftTimePopover(shift, ribbon);
            }
          });
          container.appendChild(ribbon);
        }
      });

      dayDiv.onclick = () => openTimePopover(dateStr, dayDiv);
      calendarGrid.appendChild(dayDiv);
    }
  }

  function renderDayShiftsList(dateStr) {
    const dayShifts = incomeShifts.filter(s => s.date === dateStr);
    if (dayShifts.length === 0) { 
      currentDayShifts.innerHTML = '<p class="text-xs text-on-surface-variant/60 dark:text-slate-500 text-center py-4">Смен на этот день нет.</p>'; 
      return; 
    }

    currentDayShifts.innerHTML = dayShifts.map(s => {
      const job = incomeJobs.find(j => j.id === s.jobId);
      if (!job) return '';
      const hours = calculateHours(s.startTime, s.endTime);
      return `
        <div class="flex items-center justify-between p-2.5 border border-outline-variant/15 dark:border-slate-800 rounded-xl bg-surface-container-low dark:bg-slate-800/60 text-xs">
          <div class="flex items-center gap-2 truncate">
            <span class="w-2.5 h-2.5 rounded shrink-0" style="background:${job.color}"></span>
            <span class="truncate text-on-surface dark:text-slate-200"><strong>${job.name}</strong>: ${hours.toFixed(1)}ч</span>
          </div>
          <div class="flex items-center gap-2 ml-2 shrink-0">
            <span class="font-bold text-emerald-500 dark:text-emerald-400 font-headline">+${(hours * job.rate).toFixed(2)} ${job.currency}</span>
            <button type="button" onclick="event.stopPropagation(); deleteShift('${s.id}', '${dateStr}')" class="text-on-surface-variant/40 hover:text-rose-500 dark:text-slate-500 dark:hover:text-rose-400 text-lg font-light px-1 transition-colors cursor-pointer">&times;</button>
          </div>
        </div>
      `;
    }).join('');
  }

  function calculateHours(start, end) {
    const [sH, sM] = start.split(':').map(Number);
    const [eH, eM] = end.split(':').map(Number);
    let diff = (eH * 60 + eM) - (sH * 60 + sM);
    return (diff < 0 ? diff + 1440 : diff) / 60;
  }

  function updateIncomeAndChart() {
    const year = incomeGlobalDate.getFullYear();
    const month = incomeGlobalDate.getMonth();
    const range = getPeriodRange(year, month, incomeStartDay);
    const pad = (num) => String(num).padStart(2, '0');
    const activeKey = getPeriodKey(incomeGlobalDate);
    
    incomeMonthLabel.innerText = `${pad(range.start.getDate())}.${pad(range.start.getMonth()+1)} - ${pad(range.end.getDate())}.${pad(range.end.getMonth()+1)}`;
    graphCurrencyBadge.innerText = `(${incomeCurrentCurrency})`;

    const periodShifts = incomeShifts.filter(s => {
      const d = new Date(s.date + "T12:00:00");
      return d >= range.start && d <= range.end;
    });

    let baseTotalInSelectedCurrency = 0;
    let jobEarnings = {};
    incomeJobs.forEach(j => jobEarnings[j.id] = 0);

    periodShifts.forEach(s => {
      const job = incomeJobs.find(j => j.id === s.jobId);
      if (job) {
        const hours = calculateHours(s.startTime, s.endTime);
        const earn = hours * job.rate;
        baseTotalInSelectedCurrency += convertCurrency(earn, job.currency, incomeCurrentCurrency);
        jobEarnings[s.jobId] += earn;
      }
    });

    const activeSalary = incomeMonthlySalariesPeriod[activeKey] || { amount: 0, currency: 'BYN' };
    if (activeSalary.amount > 0) {
      baseTotalInSelectedCurrency += convertCurrency(activeSalary.amount, activeSalary.currency, incomeCurrentCurrency);
    }

    if (!incomeIsMultiCurrency) {
      incomeDisplayArea.innerHTML = `<div id="total-income-value" class="text-2xl md:text-3xl font-extrabold text-emerald-500 dark:text-emerald-400 tracking-tighter">${baseTotalInSelectedCurrency.toFixed(2)} ${incomeCurrentCurrency}</div>`;
    } else {
      const targetCurrencies = ['BYN', 'USD', 'EUR', 'RUB'];
      let htmlStr = '<div class="flex flex-col gap-1.5 font-bold text-emerald-500 dark:text-emerald-400 text-xs md:text-sm tracking-tight text-left w-full px-1">';
      
      targetCurrencies.forEach(cur => {
        const globalValueInThisCurrency = convertCurrency(baseTotalInSelectedCurrency, incomeCurrentCurrency, cur);
        htmlStr += `<div class="flex justify-between border-b border-outline-variant/10 dark:border-slate-800/60 pb-1 last:border-0">
          <span class="text-on-surface-variant/80 dark:text-slate-400 font-normal">Сумма в ${cur}:</span>
          <span>${globalValueInThisCurrency.toFixed(2)} ${cur}</span>
        </div>`;
      });
      
      htmlStr += '</div>';
      incomeDisplayArea.innerHTML = htmlStr;
    }

    let jobsHtml = incomeJobs.map(j => `
      <li class="flex justify-between items-center text-xs">
        <div class="flex items-center gap-2 truncate">
          <span class="w-2.5 h-2.5 rounded shrink-0 inline-block" style="background:${j.color}"></span>
          <span class="text-on-surface-variant dark:text-slate-350 truncate">${j.name}</span>
        </div>
        <span class="font-bold text-on-surface dark:text-slate-200 ml-2 shrink-0 font-headline">${(jobEarnings[j.id] || 0).toFixed(2)} ${j.currency}</span>
      </li>
    `).join('');

    if (activeSalary.amount > 0) {
      jobsHtml += `
        <li class="flex justify-between items-center text-xs border-t border-dashed border-outline-variant/20 dark:border-slate-800 pt-2 mt-2">
          <div class="flex items-center gap-2 truncate">
            <span class="flex items-center justify-center text-emerald-500 shrink-0" title="Фиксированный оклад">
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-banknote"><rect width="22" height="12" x="2" y="6" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/></svg>
            </span>
            <span class="text-on-surface-variant/90 dark:text-slate-400 truncate italic font-semibold">Фикс. оклад</span>
          </div>
          <span class="font-bold text-on-surface dark:text-slate-200 ml-2 shrink-0 font-headline">${activeSalary.amount.toFixed(2)} ${activeSalary.currency}</span>
        </li>
      `;
    }
    incomeByJobs.innerHTML = jobsHtml;

    renderChart();
  }

  function renderJobsList() {
    jobsList.innerHTML = incomeJobs.map(j => `
      <div class="flex items-center justify-between p-2 border border-outline-variant/15 dark:border-slate-800 rounded-xl bg-surface-container-low dark:bg-slate-850/60 text-xs">
        <div class="flex items-center gap-2 truncate">
          <span class="w-2.5 h-2.5 rounded shrink-0" style="background: ${j.color}"></span>
          <span class="text-on-surface-variant dark:text-slate-350 truncate"><strong>${j.name}</strong> — ${j.rate.toFixed(2)} ${j.currency}</span>
        </div>
        <button onclick="deleteJob('${j.id}')" class="text-on-surface-variant/40 hover:text-rose-500 dark:text-slate-500 dark:hover:text-rose-450 text-lg font-light px-1 transition-colors cursor-pointer">&times;</button>
      </div>
    `).join('');
  }

  function renderChart() {
    const ctx = document.getElementById('incomeChart').getContext('2d');
    let labels = []; 
    let periodsRanges = []; 
    let keys = [];
    
    for (let i = 5; i >= 0; i--) {
      let d = new Date(incomeGlobalDate.getFullYear(), incomeGlobalDate.getMonth() - i, 1);
      labels.push(incomeMonths[d.getMonth()]);
      periodsRanges.push(getPeriodRange(d.getFullYear(), d.getMonth(), incomeStartDay));
      keys.push(getPeriodKey(d));
    }

    let data = [];
    periodsRanges.forEach((range, index) => {
      let pTotal = 0;
      incomeShifts.forEach(s => {
        const d = new Date(s.date + "T12:00:00");
        if (d >= range.start && d <= range.end) {
          const job = incomeJobs.find(j => j.id === s.jobId);
          if (job) pTotal += convertCurrency(calculateHours(s.startTime, s.endTime) * job.rate, job.currency, incomeCurrentCurrency);
        }
      });
      
      const historicKey = keys[index];
      const historicSalary = incomeMonthlySalariesPeriod[historicKey] || { amount: 0, currency: 'BYN' };
      if (historicSalary.amount > 0) {
        pTotal += convertCurrency(historicSalary.amount, historicSalary.currency, incomeCurrentCurrency);
      }
      
      data.push(parseFloat(pTotal.toFixed(2)));
    });

    // Определение цвета сетки и шрифтов в зависимости от темы
    const isDark = document.documentElement.classList.contains("dark");
    const gridColor = isDark ? '#1e293b' : '#f1f5f9';
    const textColor = isDark ? '#94a3b8' : '#64748b';

    if (incomeChartInstance) incomeChartInstance.destroy();
    incomeChartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: `Доход (${incomeCurrentCurrency})`,
          data: data,
          borderColor: '#4f59a4',
          backgroundColor: 'rgba(79, 89, 164, 0.12)',
          borderWidth: 2,
          pointBackgroundColor: '#ffffff',
          pointBorderColor: '#4f59a4',
          pointRadius: 4,
          fill: true,
          tension: 0.35
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: { 
          y: { 
            beginAtZero: true, 
            ticks: { font: { family: "'Manrope', sans-serif", size: 9 }, color: textColor }, 
            grid: { color: gridColor } 
          }, 
          x: { 
            ticks: { font: { family: "'Manrope', sans-serif", size: 10 }, color: textColor }, 
            grid: { color: gridColor } 
          } 
        },
        plugins: { 
          legend: { display: false },
          tooltip: {
            backgroundColor: isDark ? '#0f172a' : '#ffffff',
            titleColor: isDark ? '#f8fafc' : '#0f172a', 
            bodyColor: isDark ? '#f8fafc' : '#0f172a', 
            borderColor: isDark ? '#334155' : '#e2e8f0', 
            borderWidth: 1, 
            padding: 8,
            titleFont: { family: "'Manrope', sans-serif", size: 12, weight: 'bold' },
            bodyFont: { family: "'Manrope', sans-serif", size: 11 }
          }
        }
      }
    });
  }

  function updateIncomeUI() { 
    renderCalendar(); 
    renderJobsList(); 
    updateIncomeAndChart(); 
    window.updateIntersectionAlerts();
    window.updateMonthArrowAlerts();
  }

  // Прикрепление функций удаления и выбора к window для работы из inline onclick шаблонов
  window.deleteShift = function(shiftId, dateStr) {
    incomeShifts = incomeShifts.filter(s => s.id !== shiftId);
    renderDayShiftsList(dateStr);
    saveIncomeData();
  };
  
  window.deleteJob = function(id) {
    incomeJobs = incomeJobs.filter(j => j.id !== id);
    incomeShifts = incomeShifts.filter(s => s.jobId !== id);
    saveIncomeData();
  };

  // Отрисовка списка работ для выбора в модалке смены
  function renderJobSelector() {
    if (!jobSelectorList) return;
    jobSelectorList.innerHTML = '';
    incomeJobs.forEach(j => {
      const isSelected = selectedJobId.value === j.id;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `w-full text-left flex items-center gap-2 px-3 py-2 rounded-xl text-xs sm:text-sm font-semibold border transition-all cursor-pointer ${isSelected ? 'border-primary bg-primary/10 text-primary dark:text-[#b5bcff]' : 'border-outline-variant/15 dark:border-slate-800 bg-surface-container-low dark:bg-slate-800 text-on-surface dark:text-slate-200 hover:bg-primary/5'}`;
      btn.innerHTML = `
        <span class="w-2.5 h-2.5 rounded-sm shrink-0" style="background:${j.color}"></span>
        <span class="truncate flex-1">${escapeHtml(j.name)}</span>
        <span class="text-[10px] text-on-surface-variant/60 dark:text-slate-400 font-normal">${j.rate.toFixed(2)} ${j.currency}/ч</span>
        ${isSelected ? '<span class="material-symbols-outlined text-primary dark:text-[#b5bcff] text-base">check</span>' : ''}`;
      btn.addEventListener('click', () => {
        selectedJobId.value = j.id;
        renderJobSelector();
      });
      jobSelectorList.appendChild(btn);
    });
  }

  // Регистрация обработчиков событий Доходов

  incomeToggle.addEventListener("click", toggleIncomeMode);

  incomeSettingsBtn.addEventListener("click", openIncomeSettings);
  closeIncomeSettingsBtn.addEventListener("click", closeIncomeSettings);

  currencySelect.addEventListener("change", () => {
    incomeCurrentCurrency = currencySelect.value;
    saveIncomeData();
  });

  periodStartDay.addEventListener("change", () => {
    let val = parseInt(periodStartDay.value);
    if (isNaN(val) || val < 1) val = 1; 
    if (val > 31) val = 31; 
    incomeStartDay = val;
    saveIncomeData();
  });

  multicurrencyToggle.addEventListener("change", () => {
    incomeIsMultiCurrency = multicurrencyToggle.checked;
    saveIncomeData();
  });

  function handleSalaryChange() {
    const key = getPeriodKey(incomeGlobalDate);
    const amt = parseFloat(salaryAmount.value);
    incomeMonthlySalariesPeriod[key] = {
      amount: isNaN(amt) ? 0 : amt,
      currency: salaryCurrency.value
    };
    saveIncomeData();
  }

  salaryAmount.addEventListener("change", handleSalaryChange);
  salaryCurrency.addEventListener("change", handleSalaryChange);

  jobForm.addEventListener("submit", function(e) {
    e.preventDefault();
    const name = jobName.value;
    const rate = parseFloat(jobRate.value);
    const currency = jobCurrency.value;
    const color = jobColor.value;
    incomeJobs.push({ id: Date.now().toString(), name, rate, currency, color });
    this.reset(); 
    jobColor.value = '#98A2F3';
    saveIncomeData();
  });

  closeShiftModalBtn.addEventListener("click", closeShiftModal);

  shiftForm.addEventListener("submit", function(e) {
    e.preventDefault();
    const date = shiftDateInput.value;
    const jobId = selectedJobId.value;
    if (!jobId) return;
    incomeShifts.push({ 
      id: Date.now().toString(), 
      date, 
      jobId, 
      startTime: shiftStart.value, 
      endTime: shiftEnd.value 
    });
    renderDayShiftsList(date);
    saveIncomeData();
    closeShiftModal();
  });

  // События переключения месяцев в календаре
  calendarPrevMonth.addEventListener("click", () => {
    incomeGlobalDate.setMonth(incomeGlobalDate.getMonth() - 1);
    updateIncomeUI();
  });
  calendarNextMonth.addEventListener("click", () => {
    incomeGlobalDate.setMonth(incomeGlobalDate.getMonth() + 1);
    updateIncomeUI();
  });

  // События переключения периодов в блоке доходов
  incomePrevPeriod.addEventListener("click", () => {
    incomeGlobalDate.setMonth(incomeGlobalDate.getMonth() - 1);
    updateIncomeUI();
  });
  incomeNextPeriod.addEventListener("click", () => {
    incomeGlobalDate.setMonth(incomeGlobalDate.getMonth() + 1);
    updateIncomeUI();
  });

  // Кастомные стрелки-степперы для числовых полей настроек доходов
  document.querySelectorAll(".num-stepper").forEach((stepper) => {
    const input = stepper.parentElement.querySelector("input[data-stepper]");
    if (!input) return;
    const stepAttr = input.dataset.step ? parseFloat(input.dataset.step) : (parseFloat(input.step) || 1);
    const min = input.min !== "" ? parseFloat(input.min) : null;
    const max = input.max !== "" ? parseFloat(input.max) : null;
    stepper.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        let val = parseFloat(input.value);
        if (isNaN(val)) val = 0;
        val += btn.dataset.step === "up" ? stepAttr : -stepAttr;
        if (min !== null && val < min) val = min;
        if (max !== null && val > max) val = max;
        input.value = val;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    });
  });

  // Иконка-часы в полях времени смены открывает нативный выбор времени
  document.querySelectorAll(".income-time-input").forEach((inp) => {
    const wrapper = inp.closest(".relative");
    const icon = wrapper && wrapper.querySelector(".material-symbols-outlined");
    if (icon) {
      icon.style.cursor = "pointer";
      icon.addEventListener("click", (e) => {
        e.preventDefault();
        try { inp.showPicker(); } catch (_) { /* не поддерживается — ввод вручную */ }
      });
    }
  });

  // Инициализация при первом открытии
  buildVerticalTimePicker();
  initTimeFieldToggles();
  window.updateIntersectionAlerts();
});

// ===== Mobile Bottom Navigation Functions =====
// Эти функции вызываются из onclick атрибутов в HTML

window.switchMobileTab = function(tab) {
  // Находим кнопку "Показать расписание" и кликаем по ней, если нужно
  // Обновляем активное состояние кнопок нижней навигации
  document.querySelectorAll('.mobile-bottom-nav-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  const targetBtn = document.querySelector(`.mobile-bottom-nav-btn[data-tab="${tab}"]`);
  if (targetBtn) targetBtn.classList.add('active');
  
  // Вызываем существующую функцию setActiveTab через событие
  // Находим соответствующую кнопку вкладки и кликаем
  const tabMap = {
    'group': 'tab-group',
    'teacher': 'tab-teacher',
    'room': 'tab-room'
  };
  const tabId = tabMap[tab];
  if (tabId) {
    const tabEl = document.getElementById(tabId);
    if (tabEl) tabEl.click();
  }
};

window.toggleMobileIncome = function() {
  const wasInIncome = window.isInIncomeMode;
  const incomeBtn = document.getElementById('bottom-income-btn');
  if (incomeBtn) incomeBtn.classList.toggle('active');
  const incomeToggle = document.getElementById('income-toggle');
  if (incomeToggle) incomeToggle.click();

  // Синхронизируем активное состояние нижней панели
  if (!wasInIncome) {
    // Вход в режим дохода — активируем только кнопку дохода
    document.querySelectorAll('.mobile-bottom-nav-btn').forEach(btn => btn.classList.remove('active'));
    if (incomeBtn) incomeBtn.classList.add('active');
  } else {
    // Выход из режима дохода — возвращаем активную вкладку расписания
    document.querySelectorAll('.mobile-bottom-nav-btn').forEach(btn => btn.classList.remove('active'));
    const defaultBtn = document.getElementById('bottom-default-group-btn');
    const groupBtn = document.querySelector('.mobile-bottom-nav-btn[data-tab="group"]');
    if (isDefaultGroupActive && defaultBtn && !defaultBtn.classList.contains('hidden')) {
      defaultBtn.classList.add('active');
    } else if (groupBtn) {
      groupBtn.classList.add('active');
    }
  }
};

window.selectMobileDefaultGroup = function() {
  selectDefaultGroup();
};

// Синхронизируем нижнюю навигацию с верхними кнопками
document.addEventListener('click', function(e) {
  const topBtn = e.target.closest('#top-mode-group, #top-mode-teacher, #top-mode-room');
  if (topBtn) {
    const tabMap = {
      'top-mode-group': 'group',
      'top-mode-teacher': 'teacher',
      'top-mode-room': 'room'
    };
    const tab = tabMap[topBtn.id];
    if (tab) {
      document.querySelectorAll('.mobile-bottom-nav-btn').forEach(btn => {
        btn.classList.remove('active');
      });
      const targetBtn = document.querySelector(`.mobile-bottom-nav-btn[data-tab="${tab}"]`);
      if (targetBtn) targetBtn.classList.add('active');
    }
  }
});

// Синхронизируем точку пересечения с нижней навигацией
const origUpdateIntersection = window.updateIntersectionAlerts;
window.updateIntersectionAlerts = function() {
  if (typeof origUpdateIntersection === 'function') {
    origUpdateIntersection();
  }
  // Синхронизируем точку с нижней панелью
  const incomeDot = document.getElementById('income-dot');
  const bottomNavDot = document.getElementById('bottom-nav-dot');
  if (bottomNavDot && incomeDot) {
    bottomNavDot.style.display = incomeDot.style.display || (incomeDot.classList.contains('hidden') ? 'none' : 'block');
  }
  // Стрелки переключения месяца/периода используют тот же принцип
  // сигнализации о пересечении (прошлое и будущее, кроме отклонённых)
  if (typeof updateMonthArrowAlerts === 'function') updateMonthArrowAlerts();
};

// ===== PWA: предложение установки =====
// Service worker уже зарегистрирован в начале файла для кэширования.
// Чтобы предложение установки было надёжным (нативное событие браузера
// может не появиться или исчезнуть, если пользователь его проигнорировал),
// перехватываем beforeinstallprompt, сохраняем событие и показываем свою
// кнопку установки. Она остаётся видимой, пока пользователь не установит
// приложение или не отклонит именно её.
let deferredInstallPrompt = null;
const PWA_DISMISSED_KEY = "bseu_pwa_dismissed";

// Кнопка «Скачать приложение» всегда видна в меню аккаунта (появляется
// при нажатии на иконку аккаунта), поэтому show/hide больше не прячут её.
function showInstallButton() {}
function hideInstallButton() {}

window.addEventListener('beforeinstallprompt', (e) => {
  // Браузер хочет показать нативное предложение — перехватываем,
  // чтобы показать свою кнопку (она не исчезает сама по таймауту,
  // в отличие от нативного баннера).
  e.preventDefault();
  deferredInstallPrompt = e;
  // Если пользователь ранее не отклонял именно нашу кнопку — показываем.
  let dismissed = false;
  try { dismissed = localStorage.getItem(PWA_DISMISSED_KEY) === '1'; } catch (err) { /* ignore */ }
  if (!dismissed) showInstallButton();
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  hideInstallButton();
  try { localStorage.removeItem(PWA_DISMISSED_KEY); } catch (err) { /* ignore */ }
});

const installBtn = document.getElementById('account-menu-install');
if (installBtn) {
  installBtn.addEventListener('click', async () => {
    if (!deferredInstallPrompt) {
      alert('Чтобы установить приложение, откройте меню браузера (⋮) и выберите «Установить приложение» / «Добавить на главный экран».');
      return;
    }
    deferredInstallPrompt.prompt();
    const choiceResult = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    if (choiceResult.outcome === 'accepted') {
      hideInstallButton();
    } else {
      // Пользователь отклонил нашу кнопку — скрываем до следующего
      // beforeinstallprompt, чтобы не «доставать».
      hideInstallButton();
      try { localStorage.setItem(PWA_DISMISSED_KEY, '1'); } catch (err) { /* ignore */ }
    }
  });
}

// ===== Аккаунт и синхронизация данных между устройствами =====
// Бэкенд: Node + SQLite (server.js / server/auth.js). Аккаунт по логину и
// паролю без email. Сессия — httpOnly cookie, выставляется бэкендом.
(function initAccount() {
  const ACCOUNT_OFFER_SHOWN_KEY = "bseu_account_offer_shown";

  const accountBtn = document.getElementById('account-btn');
  const accountMenu = document.getElementById('account-menu');
  const menuStatus = document.getElementById('account-menu-status');
  const menuInstall = document.getElementById('account-menu-install');
  const menuCreate = document.getElementById('account-menu-create');
  const menuLogout = document.getElementById('account-menu-logout');
  const menuDelete = document.getElementById('account-menu-delete');
  const menuTheme = document.getElementById('account-menu-theme');
  const menuEditGroup = document.getElementById('account-menu-edit-group');

  const accountModal = document.getElementById('account-modal');
  const accountForm = document.getElementById('account-form');
  const accountLogin = document.getElementById('account-login');
  const accountPassword = document.getElementById('account-password');
  const accountPasswordToggle = document.getElementById('account-password-toggle');
  const accountError = document.getElementById('account-error');
  const accountToggleMode = document.getElementById('account-toggle-mode');
  const accountModalTitle = document.getElementById('account-modal-title');
  const accountSubmitLabel = document.getElementById('account-submit-label');
  const accountModalClose = document.getElementById('account-modal-close');

  const deleteModal = document.getElementById('account-delete-modal');
  const deleteConfirm = document.getElementById('account-delete-confirm');
  const deleteCancel = document.getElementById('account-delete-cancel');

  const offerModal = document.getElementById('account-offer-modal');
  const offerSkip = document.getElementById('account-offer-skip');
  const offerCreate = document.getElementById('account-offer-create');

  // Состояние текущего пользователя (null = не авторизован)
  let currentUser = null; // { login }

  function api(path, opts = {}) {
    return fetch(path, Object.assign({ credentials: 'include', headers: { 'Content-Type': 'application/json' } }, opts));
  }

  // --- Вспомогательные функции показа/скрытия модалок ---
  function openModal(el) {
    if (!el) return;
    el.classList.remove('hidden', 'opacity-0');
    el.classList.add('opacity-100');
    const card = el.querySelector('div');
    if (card) { card.classList.remove('scale-95'); card.classList.add('scale-100'); }
  }
  function closeModal(el) {
    if (!el) return;
    el.classList.remove('opacity-100');
    el.classList.add('opacity-0');
    const card = el.querySelector('div');
    if (card) { card.classList.remove('scale-100'); card.classList.add('scale-95'); }
    setTimeout(() => el.classList.add('hidden'), 300);
  }

  // --- Обновление выпадающего меню в зависимости от сессии ---
  function refreshMenu() {
    if (!accountMenu) return;
    if (currentUser) {
      menuStatus.textContent = 'Аккаунт: ' + currentUser.login;
      menuCreate.classList.add('hidden');
      menuLogout.classList.remove('hidden');
      menuDelete.classList.remove('hidden');
    } else {
      menuStatus.textContent = 'Не авторизован';
      menuCreate.classList.remove('hidden');
      menuLogout.classList.add('hidden');
      menuDelete.classList.add('hidden');
    }
  }

  function showMenu() {
    if (!accountMenu) return;
    refreshMenu();
    accountMenu.classList.remove('hidden');
  }
  function hideMenu() {
    if (accountMenu) accountMenu.classList.add('hidden');
  }

  // --- Сборка локальных данных в блоки для синхронизации ---
  const SYNC_KINDS = ['group', 'income', 'attendance', 'excuses', 'homework', 'misc'];

  // Локальные метки времени изменения каждого блока и последнее известное
  // серверное updatedAt — нужны для корректного last-write-wins при push.
  const SYNC_TS_KEY = 'bseu_sync_ts';
  function loadSyncTs() {
    try { return JSON.parse(localStorage.getItem(SYNC_TS_KEY) || '{}'); }
    catch (e) { return {}; }
  }
  function saveSyncTs(ts) {
    try { localStorage.setItem(SYNC_TS_KEY, JSON.stringify(ts)); } catch (e) {}
  }
  // Помечаем блок изменённым локально (при записи из UI или после pullSync).
  function touchBlock(kind, updatedAt) {
    const ts = loadSyncTs();
    ts[kind] = { local: Date.now(), server: Number(updatedAt) || 0 };
    saveSyncTs(ts);
  }

  function loadBlock(kind) {
    try {
      if (kind === 'group') {
        const group = localStorage.getItem('bseu_primary_group');
        const lessons = localStorage.getItem('bseu_primary_group_lessons');
        const sem = localStorage.getItem('bseu_semester_start_date');
        return { group: group ? JSON.parse(group) : null, lessons: lessons ? JSON.parse(lessons) : null, semesterStartDate: sem || null };
      }
      if (kind === 'income') {
        return {
          jobs: JSON.parse(localStorage.getItem('jobs') || '[]'),
          shifts: JSON.parse(localStorage.getItem('shifts') || '[]'),
          currency: localStorage.getItem('currency') || 'BYN',
          startDay: parseInt(localStorage.getItem('startDay')) || 1,
          isMultiCurrency: localStorage.getItem('isMultiCurrency') === 'true',
          monthlySalariesPeriod: JSON.parse(localStorage.getItem('monthlySalariesPeriod') || '{}'),
          dismissedIntersections: JSON.parse(localStorage.getItem('dismissedIntersections') || '[]')
        };
      }
      if (kind === 'attendance') return JSON.parse(localStorage.getItem('bseu_attendance_v1') || '{}');
      if (kind === 'excuses') return JSON.parse(localStorage.getItem('bseu_excuses_v1') || '[]');
      if (kind === 'homework') return JSON.parse(localStorage.getItem('bseu_homework_v1') || '{}');
      if (kind === 'misc') return JSON.parse(localStorage.getItem('bseu_saved_state') || '{}');
    } catch (e) {
      console.warn('loadBlock error', kind, e);
    }
    return null;
  }

  function saveBlock(kind, payload) {
    try {
      if (kind === 'group') {
        if (payload.group) localStorage.setItem('bseu_primary_group', JSON.stringify(payload.group));
        if (payload.lessons) localStorage.setItem('bseu_primary_group_lessons', JSON.stringify(payload.lessons));
        if (payload.semesterStartDate) localStorage.setItem('bseu_semester_start_date', payload.semesterStartDate);
      } else if (kind === 'income') {
        localStorage.setItem('jobs', JSON.stringify(payload.jobs || []));
        localStorage.setItem('shifts', JSON.stringify(payload.shifts || []));
        localStorage.setItem('currency', payload.currency || 'BYN');
        localStorage.setItem('startDay', payload.startDay || 1);
        localStorage.setItem('isMultiCurrency', !!payload.isMultiCurrency);
        localStorage.setItem('monthlySalariesPeriod', JSON.stringify(payload.monthlySalariesPeriod || {}));
        localStorage.setItem('dismissedIntersections', JSON.stringify(payload.dismissedIntersections || []));
        if (typeof updateIncomeUI === 'function') updateIncomeUI();
      } else if (kind === 'attendance') {
        localStorage.setItem('bseu_attendance_v1', JSON.stringify(payload || {}));
        if (typeof updateAbsencePanel === 'function') updateAbsencePanel();
      } else if (kind === 'excuses') {
        localStorage.setItem('bseu_excuses_v1', JSON.stringify(payload || []));
        if (typeof updateAbsencePanel === 'function') updateAbsencePanel();
      } else if (kind === 'homework') {
        localStorage.setItem('bseu_homework_v1', JSON.stringify(payload || {}));
      } else if (kind === 'misc') {
        localStorage.setItem('bseu_saved_state', JSON.stringify(payload || {}));
      }
      // Локальное изменение блока — фиксируем метку для last-write-wins.
      touchBlock(kind, 0);
    } catch (e) {
      console.warn('saveBlock error', kind, e);
    }
  }

  // Собрать локальные блоки, изменившиеся после последней синхронизации.
  // updatedAt берётся из локальной метки изменения (last-write-wins).
  // Блок без записи в ts (локальные данные до первой синхронизации)
  // считается изменённым локально и отправляется на сервер.
  function collectLocalBlocks() {
    const ts = loadSyncTs();
    const blocks = [];
    for (const kind of SYNC_KINDS) {
      const payload = loadBlock(kind);
      if (payload === null) continue;
      const meta = ts[kind];
      if (meta && meta.server && meta.local && meta.local <= meta.server) continue;
      const updatedAt = (meta && meta.local) ? meta.local : Date.now();
      blocks.push({ kind, payload: JSON.stringify(payload), updatedAt });
    }
    return blocks;
  }

  // Отправить локальные изменения на сервер (last-write-wins).
  // Сервер применит блок, только если updatedAt клиента > серверного.
  async function pushSync() {
    if (!currentUser) return;
    try {
      const blocks = collectLocalBlocks();
      if (!blocks.length) return;
      const res = await api('/api/sync', { method: 'POST', body: JSON.stringify({ blocks }) });
      const data = await res.json();
      // Обновляем локальные метки серверным updatedAt из ответа (источник истины).
      if (data.ok && data.blocks) {
        const ts = loadSyncTs();
        for (const kind of SYNC_KINDS) {
          const b = data.blocks[kind];
          if (b && ts[kind]) { ts[kind].server = Number(b.updatedAt) || 0; ts[kind].local = 0; }
        }
        saveSyncTs(ts);
      }
    } catch (e) {
      console.warn('pushSync не удалось (офлайн?):', e);
    }
  }

  // Подтянуть данные с сервера и применить локально (last-write-wins по updatedAt)
  async function pullSync() {
    if (!currentUser) return;
    try {
      const res = await api('/api/sync');
      const data = await res.json();
      if (!data.ok || !data.blocks) return;
      const ts = loadSyncTs();
      for (const kind of SYNC_KINDS) {
        const block = data.blocks[kind];
        if (!block) continue;
        const serverUpdated = Number(block.updatedAt) || 0;
        const meta = ts[kind];
        // Пишем серверное, только если оно свежее локального изменения.
        if (meta && meta.local && meta.local > serverUpdated) continue;
        try {
          const payload = JSON.parse(block.payload);
          saveBlock(kind, payload);
          // Фиксируем серверную метку как актуальную (локально не меняли).
          ts[kind] = { local: 0, server: serverUpdated };
        } catch (e) { console.warn('pullSync parse error', kind, e); }
      }
      saveSyncTs(ts);
      // Перерисовываем зависимые части UI
      if (typeof updateIncomeUI === 'function') updateIncomeUI();
      if (typeof updateAbsencePanel === 'function') updateAbsencePanel();
      if (typeof updateIntersectionAlerts === 'function') updateIntersectionAlerts();
    } catch (e) {
      console.warn('pullSync не удалось:', e);
    }
  }

  // Дебаунс-обёртка, чтобы не слать запрос на каждое нажатие клавиши
  let pushTimer = null;
  function schedulePush() {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => { pushTimer = null; pushSync(); }, 800);
  }

  // Публичный API для вызова из других мест (save*-обёртки, триггер предложения)
  window.AccountSync = {
    push: pushSync,
    schedulePush: schedulePush,
    pull: pullSync,
    isLoggedIn: () => !!currentUser,
    showOfferIfNeeded: showOfferIfNeeded,
    refreshMenu
  };

  // Первичная сверка при входе: подтягиваем сервер, для блоков, которых нет
  // на сервере, помечаем локальные данные к отправке; серверные (если есть)
  // применяем локально. Гарантирует корректную миграцию старых local-data
  // без затирки серверных данных на возвращающем устройстве.
  async function bootstrapSync() {
    if (!currentUser) return;
    try {
      const res = await api('/api/sync');
      const data = await res.json();
      const ts = loadSyncTs();
      const blocks = (data.ok && data.blocks) ? data.blocks : {};
      for (const kind of SYNC_KINDS) {
        const serverBlock = blocks[kind];
        if (serverBlock) {
          const serverUpdated = Number(serverBlock.updatedAt) || 0;
          try {
            const payload = JSON.parse(serverBlock.payload);
            saveBlock(kind, payload);
            ts[kind] = { local: 0, server: serverUpdated };
          } catch (e) { console.warn('bootstrapSync parse error', kind, e); }
        } else if (loadBlock(kind) !== null) {
          // Локально есть, на сервере нет — отправим при следующем push.
          if (!ts[kind]) ts[kind] = { local: Date.now(), server: 0 };
        }
      }
      saveSyncTs(ts);
      if (typeof updateIncomeUI === 'function') updateIncomeUI();
      if (typeof updateAbsencePanel === 'function') updateAbsencePanel();
      if (typeof updateIntersectionAlerts === 'function') updateIntersectionAlerts();
      await pushSync();
    } catch (e) {
      console.warn('bootstrapSync не удалось:', e);
    }
  }

  // --- Проверка текущей сессии при загрузке ---
  async function checkSession() {
    try {
      const res = await api('/api/auth/me');
      const data = await res.json();
      if (data.ok && data.user) {
        currentUser = { login: data.user.login };
        // При входе/наличии сессии сверяем локальные данные с сервером.
        await bootstrapSync();
      } else {
        currentUser = null;
      }
    } catch (e) {
      currentUser = null;
    }
    refreshMenu();
  }

  // --- Показ предложения создать аккаунт (один раз) ---
  function showOfferIfNeeded() {
    try {
      if (localStorage.getItem(ACCOUNT_OFFER_SHOWN_KEY) === '1') return;
    } catch (e) { /* ignore */ }
    if (currentUser) {
      // Уже авторизован — помечаем, чтобы больше не предлагать
      try { localStorage.setItem(ACCOUNT_OFFER_SHOWN_KEY, '1'); } catch (e) {}
      return;
    }
    if (offerModal) openModal(offerModal);
  }

  // --- Обработчики UI ---
  if (accountBtn) {
    accountBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (accountMenu.classList.contains('hidden')) showMenu();
      else hideMenu();
    });
  }
  // Закрытие меню при клике вне
  document.addEventListener('click', (e) => {
    if (accountMenu && !accountMenu.classList.contains('hidden') &&
        !e.target.closest('#account-menu') && !e.target.closest('#account-btn')) {
      hideMenu();
    }
  });

  if (menuCreate) menuCreate.addEventListener('click', () => { hideMenu(); openAccountModal(false); });
  if (menuTheme) menuTheme.addEventListener('click', () => {
    hideMenu();
    if (document.documentElement.classList.contains("dark")) {
      document.documentElement.classList.remove("dark");
      document.documentElement.classList.add("light");
      themeToggleIcon.textContent = "dark_mode";
      localStorage.setItem("theme", "light");
    } else {
      document.documentElement.classList.add("dark");
      document.documentElement.classList.remove("light");
      themeToggleIcon.textContent = "light_mode";
      localStorage.setItem("theme", "dark");
    }
  });
  if (menuEditGroup) menuEditGroup.addEventListener('click', async () => {
    hideMenu();
    isEditingGroup = true;
    const primaryGroupStr = localStorage.getItem("bseu_primary_group");
    if (!primaryGroupStr) return;
    const primaryGroup = JSON.parse(primaryGroupStr);
    populateFacultySelect(modalFaculty);
    resetSelect(modalForm, "Загрузка форм...");
    resetSelect(modalCourse, "Выберите курс");
    resetSelect(modalGroup, "Выберите группу");
    modalSaveBtn.disabled = true;
    firstTimeModal.classList.remove("hidden");
    modalTitle.textContent = "Изменить группу по умолчанию";
    const savedFaculty = primaryGroup.faculty;
    const savedForm = primaryGroup.form;
    const savedCourse = primaryGroup.course;
    const savedGroup = primaryGroup.group;
    ensureSelectValue(modalFaculty, savedFaculty);
    if (savedFaculty) {
      modalFaculty.dispatchEvent(new Event('change', { bubbles: true }));
      if (savedForm) {
        modalForm.value = savedForm;
        modalForm.dispatchEvent(new Event('change', { bubbles: true }));
        if (savedCourse) {
          modalCourse.value = savedCourse;
          modalCourse.dispatchEvent(new Event('change', { bubbles: true }));
          if (savedGroup) {
            modalGroup.value = savedGroup;
          }
        }
      }
    }
  });
  if (menuLogout) menuLogout.addEventListener('click', async () => {
    hideMenu();
    try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) {}
    currentUser = null;
    refreshMenu();
  });
  if (menuDelete) menuDelete.addEventListener('click', () => { hideMenu(); if (deleteModal) openModal(deleteModal); });

  if (deleteCancel) deleteCancel.addEventListener('click', () => closeModal(deleteModal));
  if (deleteConfirm) deleteConfirm.addEventListener('click', async () => {
    try { await api('/api/auth/account', { method: 'DELETE' }); } catch (e) {}
    currentUser = null;
    refreshMenu();
    closeModal(deleteModal);
  });

  // --- Модалка аккаунта: вход / регистрация ---
  let accountMode = 'login'; // 'login' | 'register'
  function setAccountMode(mode) {
    accountMode = mode;
    if (mode === 'register') {
      accountModalTitle.textContent = 'Создать аккаунт';
      accountSubmitLabel.textContent = 'Создать';
      accountToggleMode.textContent = 'Уже есть аккаунт? Войти';
      accountPassword.setAttribute('autocomplete', 'new-password');
      accountLogin.setAttribute('autocomplete', 'off');
    } else {
      accountModalTitle.textContent = 'Вход в аккаунт';
      accountSubmitLabel.textContent = 'Войти';
      accountToggleMode.textContent = 'Нет аккаунта? Создать';
      accountPassword.setAttribute('autocomplete', 'current-password');
      accountLogin.setAttribute('autocomplete', 'off');
    }
    if (accountError) accountError.classList.add('hidden');
  }
  function openAccountModal(register) {
    setAccountMode(register ? 'register' : 'login');
    accountForm.setAttribute('action', register ? '/api/auth/register' : '/api/auth/login');
    openModal(accountModal);
    setTimeout(() => accountLogin.focus(), 50);
  }
  if (accountToggleMode) accountToggleMode.addEventListener('click', () => {
    setAccountMode(accountMode === 'login' ? 'register' : 'login');
    accountForm.setAttribute('action', accountMode === 'register' ? '/api/auth/register' : '/api/auth/login');
  });
  if (accountModalClose) accountModalClose.addEventListener('click', () => closeModal(accountModal));

  // Переключатель видимости пароля (значок глаза).
  if (accountPasswordToggle) {
    accountPasswordToggle.addEventListener('click', () => {
      const show = accountPassword.type === 'password';
      accountPassword.type = show ? 'text' : 'password';
      const icon = accountPasswordToggle.querySelector('.material-symbols-outlined');
      if (icon) icon.textContent = show ? 'visibility_off' : 'visibility';
      accountPasswordToggle.setAttribute('aria-label', show ? 'Скрыть пароль' : 'Показать пароль');
    });
  }

  // Отправка формы НАТИВНО (без preventDefault) в скрытый iframe.
  // Это гарантирует, что встроенный менеджер паролей предложит сохранить
  // учётные данные во ВСЕХ браузерах (Google/Chrome, Firefox, Safari, Edge,
  // Brave, Opera и др.), а не только там, где есть Credential Management API.
  // Сама навигация не происходит (iframe скрыт), а SPA-состояние и данные
  // обновляются после ответа сервера (onload iframe) через checkSession().
  const accountIframe = document.getElementById('account-form-iframe');
  let accountSubmitting = false;
  if (accountForm) {
    accountForm.addEventListener('submit', (e) => {
      const login = accountLogin.value.trim();
      const password = accountPassword.value;
      if (login.length < 3 || password.length < 4) {
        e.preventDefault();
        accountError.textContent = 'Логин (от 3 символов) и пароль (от 4 символов) обязательны.';
        accountError.classList.remove('hidden');
        return;
      }
      // Валидно — даём форме уйти нативно (триггер менеджера паролей).
      if (accountError) accountError.classList.add('hidden');
      accountSubmitting = true;
    });
  }
  // После ответа сервера в iframe — обновляем SPA-состояние и данные.
  if (accountIframe) {
    accountIframe.addEventListener('load', () => {
      if (!accountSubmitting) return;
      accountSubmitting = false;
      // Считываем тело ответа из iframe, чтобы показать ошибку при необходимости.
      let data = {};
      try {
        const doc = accountIframe.contentDocument || accountIframe.contentWindow.document;
        const text = doc && doc.body ? doc.body.innerText : '';
        if (text) data = JSON.parse(text);
      } catch (e) { /* iframe cross-origin/пусто — игнорируем */ }
      if (data && data.ok) {
        currentUser = { login: data.user ? data.user.login : accountLogin.value.trim() };
        refreshMenu();
        closeModal(accountModal);
        // Сверяем локальные данные с сервером (last-write-wins) и отправляем
        // локальные, которых ещё нет на сервере.
        bootstrapSync();
        // Дополнительно: Credential Management API, если браузер поддерживает.
        if (navigator.credentials && navigator.credentials.store && window.PasswordCredential) {
          try {
            navigator.credentials.store(new window.PasswordCredential({
              id: accountLogin.value.trim(), password: accountPassword.value, name: accountLogin.value.trim()
            }));
          } catch (err) { /* не критично */ }
        }
      } else if (data && data.error) {
        accountError.textContent = data.error;
        accountError.classList.remove('hidden');
      }
    });
  }

  // --- Модалка предложения ---
  if (offerSkip) offerSkip.addEventListener('click', () => {
    try { localStorage.setItem(ACCOUNT_OFFER_SHOWN_KEY, '1'); } catch (e) {}
    closeModal(offerModal);
  });
  if (offerCreate) offerCreate.addEventListener('click', () => {
    try { localStorage.setItem(ACCOUNT_OFFER_SHOWN_KEY, '1'); } catch (e) {}
    closeModal(offerModal);
    openAccountModal(true);
  });

  // Запускаем проверку сессии при загрузке
  checkSession();
})();



