import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getFirestore,
  collection,
  onSnapshot,
  doc,
  updateDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const tasksCol = collection(db, "tasks");

const STATUS_ORDER = ["완료", "진행중", "대기", "보류"];
const STATUS_COLOR = {
  완료: "var(--status-good)",
  진행중: "var(--series-blue)",
  대기: "var(--status-neutral)",
  보류: "var(--status-serious)",
};

const STAGE_KEYS = ["situationAnalysis", "requirement", "designPrep", "systemDev", "test", "deploy"];
const STAGE_LABELS = {
  situationAnalysis: "현황분석",
  requirement: "요구사항정의",
  designPrep: "시스템설계/데이터정제",
  systemDev: "시스템개발/실행",
  test: "검증/테스트",
  deploy: "반영/배포",
};
const STAGE_SHORT = {
  situationAnalysis: "현황",
  requirement: "요구",
  designPrep: "설계",
  systemDev: "개발",
  test: "테스트",
  deploy: "배포",
};

// 체크박스(stages) 기반 진행률이 원칙. 아직 체크박스를 한 번도 안 건드린
// 구버전 문서(stages 필드 없음)는 예전 진행률(%) 값을 그대로 보여준다.
function effectiveProgress(t) {
  if (t.stages && typeof t.stages === "object") {
    const checked = STAGE_KEYS.filter((k) => t.stages[k]).length;
    return Math.round((checked / STAGE_KEYS.length) * 100);
  }
  return clamp(t.progress);
}

// 마감준수여부: 종료일 대비 오늘 날짜로 자동 판단(수기 입력 없음)
function deadlineStatus(t) {
  if (!t.endDate) return { label: "기한 미정", tone: "neutral" };
  if (t.status === "완료") return { label: "완료", tone: "good" };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(t.endDate);
  if (Number.isNaN(end.getTime())) return { label: "기한 미정", tone: "neutral" };
  if (today > end) return { label: "지연", tone: "serious" };
  return { label: "정상", tone: "good" };
}

let allTasks = [];
let filters = { category: "", department: "", status: "" };
let pendingTableRender = false;

const el = (sel) => document.querySelector(sel);

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function cssEscape(s) {
  return window.CSS && CSS.escape ? CSS.escape(s) : s;
}

function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function clamp(v) {
  let n = Number(v);
  if (Number.isNaN(n)) n = 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function weightedAvg(tasks) {
  const totalWeight = tasks.reduce((s, t) => s + (Number(t.weight) || 0), 0);
  if (!totalWeight) return 0;
  const sum = tasks.reduce(
    (s, t) => s + (Number(t.weight) || 0) * effectiveProgress(t),
    0
  );
  return sum / totalWeight;
}

// ---------- Firestore subscription ----------

onSnapshot(
  tasksCol,
  (snap) => {
    allTasks = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.priority ?? a.no ?? 0) - (b.priority ?? b.no ?? 0));
    el("#sync-status").textContent = `실시간 연결됨 · 마지막 갱신 ${new Date().toLocaleTimeString(
      "ko-KR"
    )}`;
    populateFilterOptions();
    renderHero();
    renderKPI();
    renderCategoryChart();
    renderStatusChart();
    renderGantt();
    renderTable();
  },
  (err) => {
    el("#sync-status").textContent =
      "연결 실패 — firebase-config.js 설정을 확인하세요";
    console.error(err);
  }
);

// ---------- filters ----------

function fillSelect(selector, values, placeholder) {
  const selectEl = el(selector);
  const current = selectEl.value;
  selectEl.innerHTML =
    `<option value="">${placeholder}</option>` +
    values
      .sort((a, b) => a.localeCompare(b, "ko"))
      .map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`)
      .join("");
  selectEl.value = current;
}

function populateFilterOptions() {
  fillSelect("#filter-category", uniq(allTasks.map((t) => t.category)), "전체 대분류");
  fillSelect("#filter-department", uniq(allTasks.map((t) => t.department)), "전체 부서");
  fillSelect(
    "#filter-status",
    STATUS_ORDER.filter((s) => allTasks.some((t) => t.status === s)),
    "전체 상태"
  );
}

el("#filter-category").addEventListener("change", (e) => {
  filters.category = e.target.value;
  renderTable();
});
el("#filter-department").addEventListener("change", (e) => {
  filters.department = e.target.value;
  renderTable();
});
el("#filter-status").addEventListener("change", (e) => {
  filters.status = e.target.value;
  renderTable();
});

// ---------- hero / KPI ----------

function renderHero() {
  const avg = weightedAvg(allTasks);
  el("#hero-value").textContent = `${avg.toFixed(1)}%`;
  el("#hero-meter").style.width = `${Math.min(100, avg)}%`;
  const totalWeight = allTasks.reduce((s, t) => s + (Number(t.weight) || 0), 0);
  el("#hero-sub").textContent = `과제 ${allTasks.length}건 · 가중치 합계 ${totalWeight}`;
}

function renderKPI() {
  const tiles = [
    { label: "총 과제", value: allTasks.length, color: null },
    ...STATUS_ORDER.map((s) => ({
      label: s,
      value: allTasks.filter((t) => t.status === s).length,
      color: STATUS_COLOR[s],
    })),
  ];
  el("#kpi-row").innerHTML = tiles
    .map(
      (t) => `
      <div class="kpi-tile">
        <div class="label">${
          t.color ? `<span class="dot" style="background:${t.color}"></span>` : ""
        }${escapeHtml(t.label)}</div>
        <div class="value">${t.value}</div>
      </div>`
    )
    .join("");
}

// ---------- category chart ----------

function renderCategoryChart() {
  const cats = uniq(allTasks.map((t) => t.category));
  const withOrder = cats
    .map((name) => {
      const rows = allTasks.filter((t) => t.category === name);
      const minPriority = Math.min(...rows.map((t) => t.priority ?? t.no ?? 0));
      return { name, rows, minPriority };
    })
    .sort((a, b) => a.minPriority - b.minPriority);

  el("#category-chart").innerHTML = withOrder
    .map(({ name, rows }) => {
      const avg = weightedAvg(rows);
      return `
        <div class="cat-bar-row">
          <div class="cat-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
          <div class="cat-track">
            <div class="grid-tick" style="left:25%"></div>
            <div class="grid-tick" style="left:50%"></div>
            <div class="grid-tick" style="left:75%"></div>
            <div class="cat-fill" style="width:${avg}%"></div>
          </div>
          <div class="cat-value">${avg.toFixed(0)}%</div>
        </div>`;
    })
    .join("");
}

// ---------- status distribution ----------

function renderStatusChart() {
  const total = allTasks.length || 1;
  el("#status-stack").innerHTML = STATUS_ORDER.map((s) => {
    const count = allTasks.filter((t) => t.status === s).length;
    if (!count) return "";
    const pct = (count / total) * 100;
    return `<div class="seg" style="width:${pct}%; background:${STATUS_COLOR[s]}" title="${s} ${count}건"></div>`;
  }).join("");

  el("#status-legend").innerHTML = STATUS_ORDER.map((s) => {
    const count = allTasks.filter((t) => t.status === s).length;
    return `<div class="item"><span class="swatch" style="background:${STATUS_COLOR[s]}"></span>${s} ${count}건</div>`;
  }).join("");
}

// ---------- gantt / timeline ----------

function renderGantt() {
  const container = el("#gantt-chart");
  const withDates = allTasks.filter((t) => t.startDate && t.endDate);
  if (withDates.length === 0) {
    container.innerHTML = `<p class="empty-note">시작일/종료일이 입력된 과제가 아직 없습니다. Excel에 일정이 채워지면 여기에 타임라인이 표시됩니다.</p>`;
    return;
  }

  const todayTime = new Date().setHours(0, 0, 0, 0);
  let rangeStart = Math.min(...withDates.map((t) => new Date(t.startDate).getTime()), todayTime);
  let rangeEnd = Math.max(...withDates.map((t) => new Date(t.endDate).getTime()), todayTime);
  const pad = Math.max((rangeEnd - rangeStart) * 0.03, 1000 * 60 * 60 * 24);
  rangeStart -= pad;
  rangeEnd += pad;
  const span = rangeEnd - rangeStart || 1;
  const pct = (t) => ((t - rangeStart) / span) * 100;

  const months = [];
  const cursor = new Date(rangeStart);
  cursor.setDate(1);
  while (cursor.getTime() <= rangeEnd) {
    months.push(new Date(cursor));
    cursor.setMonth(cursor.getMonth() + 1);
  }

  const axisHtml = `
    <div class="gantt-axis">
      ${months
        .map((m) => `<div class="gantt-month" style="left:${pct(m.getTime())}%">${m.getFullYear()}.${m.getMonth() + 1}</div>`)
        .join("")}
      <div class="gantt-today-label" style="left:${pct(todayTime)}%">오늘</div>
    </div>`;

  const sorted = [...withDates].sort(
    (a, b) => (a.priority ?? a.no ?? 0) - (b.priority ?? b.no ?? 0)
  );

  const rowsHtml = sorted
    .map((t) => {
      const s = pct(new Date(t.startDate).getTime());
      const e = pct(new Date(t.endDate).getTime());
      const width = Math.max(e - s, 0.6);
      const color = STATUS_COLOR[t.status] || "var(--series-blue)";
      return `
        <div class="gantt-row">
          <div class="gantt-label" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</div>
          <div class="gantt-track">
            <div class="gantt-today-line" style="left:${pct(todayTime)}%"></div>
            <div class="gantt-bar" style="left:${s}%; width:${width}%; background:${color}" title="${escapeHtml(
        t.title
      )} · ${t.startDate} ~ ${t.endDate}"></div>
          </div>
        </div>`;
    })
    .join("");

  container.innerHTML = axisHtml + rowsHtml;
}

// ---------- table ----------

function filteredTasks() {
  return allTasks.filter(
    (t) =>
      (!filters.category || t.category === filters.category) &&
      (!filters.department || t.department === filters.department) &&
      (!filters.status || t.status === filters.status)
  );
}

function isEditingActive() {
  const activeEl = document.activeElement;
  return (
    activeEl &&
    activeEl.closest &&
    activeEl.closest("#task-tbody") &&
    ["TEXTAREA", "INPUT", "SELECT"].includes(activeEl.tagName)
  );
}

function rowHtml(t) {
  const progress = effectiveProgress(t);
  const stages = t.stages && typeof t.stages === "object" ? t.stages : {};
  const dl = deadlineStatus(t);
  return `
    <tr data-id="${escapeHtml(t.id)}">
      <td class="no-cell">${t.no}</td>
      <td><span class="cat-badge">${escapeHtml(t.category)}</span></td>
      <td class="title-cell">${escapeHtml(t.title)}</td>
      <td class="desc-cell">${escapeHtml(t.description)}</td>
      <td>${escapeHtml(t.department)}</td>
      <td>
        <select class="status-select" data-field="status">
          ${STATUS_ORDER.map(
            (s) => `<option value="${s}" ${t.status === s ? "selected" : ""}>${s}</option>`
          ).join("")}
        </select>
      </td>
      <td class="stage-cell">
        <div class="stage-grid">
          ${STAGE_KEYS.map(
            (k) => `
            <label class="stage-chip" title="${STAGE_LABELS[k]}">
              <input type="checkbox" data-field="stage" data-stage="${k}" ${stages[k] ? "checked" : ""} />
              <span>${STAGE_SHORT[k]}</span>
            </label>`
          ).join("")}
        </div>
      </td>
      <td class="progress-cell">
        <div class="progress-value" data-role="progress-value">${progress}%</div>
        <div class="mini-track"><div class="mini-fill" data-role="mini-fill" style="width:${progress}%"></div></div>
      </td>
      <td><input type="date" class="date-input" data-field="startDate" value="${t.startDate || ""}" /></td>
      <td><input type="date" class="date-input" data-field="endDate" value="${t.endDate || ""}" /></td>
      <td><span class="deadline-badge tone-${dl.tone}" data-role="deadline-badge">${dl.label}</span></td>
      <td class="issue-cell"><textarea data-field="issue" placeholder="이슈 없음">${escapeHtml(
        t.issue
      )}</textarea></td>
      <td class="remark-cell"><textarea data-field="remark" placeholder="-">${escapeHtml(
        t.remark
      )}</textarea></td>
    </tr>`;
}

function renderTable() {
  if (isEditingActive()) {
    pendingTableRender = true;
    return;
  }
  const rows = filteredTasks();
  el("#task-tbody").innerHTML = rows.map(rowHtml).join("");
  rows.forEach(attachRowHandlers);
}

el("#task-tbody").addEventListener("focusout", () => {
  setTimeout(() => {
    if (pendingTableRender && !isEditingActive()) {
      pendingTableRender = false;
      renderTable();
    }
  }, 50);
});

function attachRowHandlers(t) {
  const tr = document.querySelector(`tr[data-id="${cssEscape(t.id)}"]`);
  if (!tr) return;

  const statusSel = tr.querySelector('[data-field="status"]');
  statusSel.addEventListener("change", () => {
    saveField(t.id, "status", statusSel.value, tr);
    refreshDeadlineBadge(tr, { ...t, status: statusSel.value });
  });

  const stageBoxes = tr.querySelectorAll('[data-field="stage"]');
  stageBoxes.forEach((box) => {
    box.addEventListener("change", async () => {
      const stageKey = box.dataset.stage;
      const nextStages = { ...(t.stages || {}), [stageKey]: box.checked };
      t.stages = nextStages;
      const newProgress = Math.round(
        (STAGE_KEYS.filter((k) => nextStages[k]).length / STAGE_KEYS.length) * 100
      );
      tr.querySelector('[data-role="progress-value"]').textContent = `${newProgress}%`;
      tr.querySelector('[data-role="mini-fill"]').style.width = `${newProgress}%`;
      try {
        await updateDoc(doc(db, "tasks", t.id), {
          [`stages.${stageKey}`]: box.checked,
          progress: newProgress,
          updatedAt: serverTimestamp(),
        });
        tr.classList.add("save-flash");
        setTimeout(() => tr.classList.remove("save-flash"), 600);
      } catch (err) {
        console.error(err);
        alert("저장에 실패했습니다. 네트워크 연결을 확인해주세요.");
      }
    });
  });

  ["startDate", "endDate"].forEach((field) => {
    const input = tr.querySelector(`[data-field="${field}"]`);
    input.addEventListener("change", () => {
      t[field] = input.value || null;
      saveField(t.id, field, input.value || null, tr);
      refreshDeadlineBadge(tr, t);
    });
  });

  ["issue", "remark"].forEach((field) => {
    const ta = tr.querySelector(`[data-field="${field}"]`);
    ta.addEventListener("blur", () => saveField(t.id, field, ta.value, tr));
  });
}

function refreshDeadlineBadge(tr, t) {
  const dl = deadlineStatus(t);
  const badge = tr.querySelector('[data-role="deadline-badge"]');
  badge.textContent = dl.label;
  badge.className = `deadline-badge tone-${dl.tone}`;
}

async function saveField(id, field, value, tr) {
  try {
    await updateDoc(doc(db, "tasks", id), {
      [field]: value,
      updatedAt: serverTimestamp(),
    });
    if (tr) {
      tr.classList.add("save-flash");
      setTimeout(() => tr.classList.remove("save-flash"), 600);
    }
  } catch (err) {
    console.error(err);
    alert("저장에 실패했습니다. 네트워크 연결을 확인해주세요.");
  }
}
