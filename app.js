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
const tasksCol = collection(db, "wbsTasks");

const KEY_SEP = "␟";

const STATUS_ORDER = ["완료", "진행중", "검토요청", "미진행", "종결", "-"];
const STATUS_COLOR = {
  완료: "var(--status-good)",
  진행중: "var(--series-blue)",
  검토요청: "var(--status-warning)",
  미진행: "var(--status-neutral)",
  종결: "var(--status-good)",
  "-": "var(--status-neutral)",
};

const STAGE_KEYS = ["statusAnalysis", "requirement", "design", "development", "test", "deploy"];
// 원본 WBS 수식 그대로: R = L*0.05 + M*0.1 + N*0.2 + O*0.25 + P*0.1 + Q*0.3 (합계 100%)
const STAGE_WEIGHTS = {
  statusAnalysis: 5,
  requirement: 10,
  design: 20,
  development: 25,
  test: 10,
  deploy: 30,
};
const STAGE_LABELS = {
  statusAnalysis: "현황분석",
  requirement: "요구사항 정의",
  design: "시스템 설계 / 데이터 정제",
  development: "시스템 개발 / 실행",
  test: "검증 / 테스트",
  deploy: "반영 / 배포",
};
const STAGE_SHORT = {
  statusAnalysis: "현황분석",
  requirement: "요구사항정의",
  design: "설계/정제",
  development: "개발/실행",
  test: "검증/테스트",
  deploy: "반영/배포",
};

// 미팅/협의형 과제용 간이 단계 (개발 6단계 대신 2단계로 진행)
const MEETING_STAGE_KEYS = ["discussion", "agreement"];
const MEETING_STAGE_WEIGHTS = { discussion: 50, agreement: 50 };
const MEETING_STAGE_LABELS = { discussion: "논의", agreement: "협의완료" };
const MEETING_STAGE_SHORT = { discussion: "논의", agreement: "협의완료" };

const TASK_TYPE_LABELS = { development: "개발", meeting: "미팅" };

function getStageConfig(t) {
  if (t.taskType === "meeting") {
    return { keys: MEETING_STAGE_KEYS, weights: MEETING_STAGE_WEIGHTS, labels: MEETING_STAGE_LABELS, short: MEETING_STAGE_SHORT };
  }
  return { keys: STAGE_KEYS, weights: STAGE_WEIGHTS, labels: STAGE_LABELS, short: STAGE_SHORT };
}

function effectiveProgress(t) {
  if (t.stages && typeof t.stages === "object") {
    const { keys, weights } = getStageConfig(t);
    const pct = keys.reduce((sum, k) => sum + (t.stages[k] ? weights[k] : 0), 0);
    return Math.round(pct);
  }
  return clamp(t.progress);
}

function statusToneClass(status) {
  if (status === "완료" || status === "종결") return "tone-good";
  if (status === "진행중") return "tone-blue";
  if (status === "검토요청") return "tone-warning";
  return "tone-neutral";
}

function deadlineStatus(t) {
  if (!t.endDate) return { label: "기한 미정", tone: "neutral" };
  if (t.status === "완료" || t.status === "종결") return { label: "완료", tone: "good" };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(t.endDate);
  if (Number.isNaN(end.getTime())) return { label: "기한 미정", tone: "neutral" };
  if (today > end) return { label: "지연", tone: "serious" };
  return { label: "정상", tone: "good" };
}

let allTasks = [];
let filters = { lv1: "", owner: "", status: "", erp: "" };
let pendingTableRender = false;
let expandedKeys = new Set();
let showArchived = false;

function activeTasks() {
  return showArchived ? allTasks : allTasks.filter((t) => !t.archived);
}

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
  const sum = tasks.reduce((s, t) => s + (Number(t.weight) || 0) * effectiveProgress(t), 0);
  return sum / totalWeight;
}

// ---------- Firestore subscription ----------

onSnapshot(
  tasksCol,
  (snap) => {
    allTasks = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.wbsId || "").localeCompare(b.wbsId || "", "en", { numeric: true }));
    el("#sync-status").textContent = `실시간 연결됨 · 마지막 갱신 ${new Date().toLocaleTimeString(
      "ko-KR"
    )}`;
    populateFilterOptions();
    renderHero();
    renderKPI();
    renderCategoryChart();
    renderOwnerChart();
    renderStatusChart();
    renderErpDonut();
    renderTreeTable();
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
  const tasks = activeTasks();
  fillSelect("#filter-lv1", uniq(tasks.map((t) => t.lv1)), "전체 대분류");
  fillSelect("#filter-owner", uniq(tasks.map((t) => t.owner)), "전체 담당자");
  fillSelect(
    "#filter-status",
    STATUS_ORDER.filter((s) => tasks.some((t) => t.status === s)),
    "전체 상태"
  );
}

el("#filter-lv1").addEventListener("change", (e) => {
  filters.lv1 = e.target.value;
  renderTreeTable();
});
el("#filter-owner").addEventListener("change", (e) => {
  filters.owner = e.target.value;
  renderTreeTable();
});
el("#filter-status").addEventListener("change", (e) => {
  filters.status = e.target.value;
  renderTreeTable();
});
if (el("#filter-erp")) {
  el("#filter-erp").addEventListener("change", (e) => {
    filters.erp = e.target.value;
    renderTreeTable();
  });
}

el("#expand-all").addEventListener("click", () => {
  expandedKeys = new Set(allExpandableKeys(activeTasks()));
  renderTreeTable();
});
el("#collapse-all").addEventListener("click", () => {
  expandedKeys = new Set();
  renderTreeTable();
});
el("#toggle-archived").addEventListener("change", (e) => {
  showArchived = e.target.checked;
  populateFilterOptions();
  renderHero();
  renderKPI();
  renderCategoryChart();
  renderOwnerChart();
  renderStatusChart();
  renderErpDonut();
  renderTreeTable();
});

// ---------- hero / KPI ----------

function renderHero() {
  const tasks = activeTasks();
  const avg = weightedAvg(tasks);
  el("#hero-value").textContent = `${avg.toFixed(1)}%`;
  el("#hero-meter").style.width = `${Math.min(100, avg)}%`;
  const totalWeight = tasks.reduce((s, t) => s + (Number(t.weight) || 0), 0);
  el("#hero-sub").textContent = `과제 ${tasks.length}건 · 가중치 합계 ${totalWeight.toFixed(1)}`;
}

function renderKPI() {
  const tasks = activeTasks();
  const tiles = [
    { label: "총 과제", value: tasks.length, color: null },
    ...STATUS_ORDER.map((s) => ({
      label: s,
      value: tasks.filter((t) => t.status === s).length,
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

// ---------- category chart (LV1) ----------

function renderCategoryChart() {
  const tasks = activeTasks();
  const cats = uniq(tasks.map((t) => t.lv1));
  el("#category-chart").innerHTML = cats
    .map((name) => {
      const rows = tasks.filter((t) => t.lv1 === name);
      const avg = weightedAvg(rows);
      return barRowHtml(name, avg);
    })
    .join("");
}

// ---------- owner chart ----------

function renderOwnerChart() {
  const tasks = activeTasks();
  const owners = uniq(tasks.map((t) => t.owner));
  const withWeight = owners
    .map((name) => {
      const rows = tasks.filter((t) => t.owner === name);
      const totalWeight = rows.reduce((s, t) => s + (Number(t.weight) || 0), 0);
      return { name, rows, totalWeight };
    })
    .sort((a, b) => b.totalWeight - a.totalWeight);

  el("#owner-chart").innerHTML = withWeight.length
    ? withWeight.map(({ name, rows }) => barRowHtml(name, weightedAvg(rows))).join("")
    : `<p class="empty-note">아직 담당자 단위 데이터가 없습니다. LV3/LV4가 채워지면 표시됩니다.</p>`;
}

function barRowHtml(name, avg) {
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
}

// ---------- status distribution ----------

function renderStatusChart() {
  const tasks = activeTasks();
  const total = tasks.length || 1;
  el("#status-stack").innerHTML = STATUS_ORDER.map((s) => {
    const count = tasks.filter((t) => t.status === s).length;
    if (!count) return "";
    const pct = (count / total) * 100;
    return `<div class="seg" style="width:${pct}%; background:${STATUS_COLOR[s]}" title="${s} ${count}건"></div>`;
  }).join("");

  el("#status-legend").innerHTML = STATUS_ORDER.map((s) => {
    const count = tasks.filter((t) => t.status === s).length;
    return `<div class="item"><span class="swatch" style="background:${STATUS_COLOR[s]}"></span>${s} ${count}건</div>`;
  }).join("");
}

// ---------- D365(ERP) 개발 필요 과제 진척률 도넛 ----------

function renderErpDonut() {
  const tasks = activeTasks().filter((t) => t.erpRequired);
  const avg = weightedAvg(tasks);
  const r = 52;
  const circumference = 2 * Math.PI * r;
  const filled = Math.max(0, Math.min(100, avg)) / 100 * circumference;
  const el2 = el("#erp-donut");
  if (!el2) return;
  if (!tasks.length) {
    el2.innerHTML = `<p class="empty-note">D365 개발이 필요한 과제가 없습니다. (LV3/LV4 반영 후 표시)</p>`;
    return;
  }
  el2.innerHTML = `
    <div class="donut-figure">
      <svg viewBox="0 0 120 120" width="120" height="120">
        <circle cx="60" cy="60" r="${r}" fill="none" stroke="var(--series-blue-track)" stroke-width="14" />
        <circle cx="60" cy="60" r="${r}" fill="none" stroke="var(--series-blue)" stroke-width="14"
          stroke-linecap="round" stroke-dasharray="${filled} ${circumference}"
          transform="rotate(-90 60 60)">
          <title>D365 개발 필요 과제 ${tasks.length}건 · 가중평균 진척률 ${avg.toFixed(1)}%</title>
        </circle>
      </svg>
      <div class="donut-center">
        <div class="pct">${avg.toFixed(0)}%</div>
        <div class="cnt">${tasks.length}건</div>
      </div>
    </div>`;
}

// ---------- tree table ----------

function filteredTasks() {
  return activeTasks().filter(
    (t) =>
      (!filters.lv1 || t.lv1 === filters.lv1) &&
      (!filters.owner || t.owner === filters.owner) &&
      (!filters.status || t.status === filters.status) &&
      (!filters.erp || (filters.erp === "yes" ? !!t.erpRequired : !t.erpRequired))
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

function buildTree(tasks) {
  const tree = new Map();
  for (const t of tasks) {
    const lv1 = t.lv1 || "미분류";
    const lv2 = t.lv2 || "미분류";
    const lv3 = t.lv3 || "미분류";
    if (!tree.has(lv1)) tree.set(lv1, new Map());
    const lv2Map = tree.get(lv1);
    if (!lv2Map.has(lv2)) lv2Map.set(lv2, new Map());
    const lv3Map = lv2Map.get(lv2);
    if (!lv3Map.has(lv3)) lv3Map.set(lv3, []);
    lv3Map.get(lv3).push(t);
  }
  return tree;
}

function flattenLv3Map(lv3Map) {
  const out = [];
  for (const arr of lv3Map.values()) out.push(...arr);
  return out;
}
function flattenLv2Map(lv2Map) {
  const out = [];
  for (const lv3Map of lv2Map.values()) out.push(...flattenLv3Map(lv3Map));
  return out;
}

// LV2 밑에 아직 LV3/LV4 상세가 채워지지 않은 경우(stub) — 인위적인 "미분류" 그룹을 한 겹 더
// 만들지 않고, LV2 바로 아래에 요약행만 하나 보여준다. 나중에 실제 LV3/LV4 데이터가 들어오면
// stub이 아닌 leaf가 섞이므로 이 분기를 타지 않고 자동으로 정상적인 3단 트리로 전환된다.
function isPendingDetailGroup(lv3Map) {
  const keys = [...lv3Map.keys()];
  return keys.length === 1 && keys[0] === "미분류" && lv3Map.get("미분류").every((t) => t.stub);
}

function allExpandableKeys(tasks) {
  const tree = buildTree(tasks);
  const keys = [];
  for (const [lv1, lv2Map] of tree) {
    keys.push(lv1);
    for (const [lv2, lv3Map] of lv2Map) {
      keys.push(`${lv1}${KEY_SEP}${lv2}`);
      if (isPendingDetailGroup(lv3Map)) continue;
      for (const lv3 of lv3Map.keys()) {
        keys.push(`${lv1}${KEY_SEP}${lv2}${KEY_SEP}${lv3}`);
      }
    }
  }
  return keys;
}

function groupRowHtml(level, key, label, leaves, open) {
  const avg = weightedAvg(leaves);
  const totalWeight = leaves.reduce((s, t) => s + (Number(t.weight) || 0), 0);
  const icon = open ? "▾" : "▸";
  const indent = (level - 1) * 18;
  return `
    <tr class="tree-group lv${level}">
      <td colspan="3">
        <div class="tree-group-cell" style="padding-left:${indent}px">
          <button type="button" class="tree-toggle" data-key="${escapeHtml(key)}">${icon}</button>
          <span>${escapeHtml(label)}</span>
          <span class="tree-count">과제 ${leaves.length}건 · 가중치 ${totalWeight.toFixed(1)}</span>
        </div>
      </td>
      <td colspan="2" class="tree-empty"></td>
      <td class="progress-cell">
        <div class="progress-value">${avg.toFixed(0)}%</div>
        <div class="mini-track"><div class="mini-fill" style="width:${avg}%"></div></div>
      </td>
      <td colspan="5" class="tree-empty"></td>
    </tr>`;
}

// LV3/LV4 상세가 아직 없는 LV2 항목의 요약행. 담당자·진행현황·진행단계·일정·이슈/비고는
// 아직 신뢰할 수 있는 값이 없으므로 표시하지 않고, WBS-ID·과제명·진척률만 보여준다.
function stubRowHtml(t) {
  const progress = effectiveProgress(t);
  return `
    <tr class="leaf-row stub-row${t.archived ? " is-archived" : ""}" data-id="${escapeHtml(t.id)}">
      <td class="no-cell">${escapeHtml(t.wbsId)}</td>
      <td class="title-cell">${t.archived ? '<span class="archived-badge">삭제됨</span>' : ""}${escapeHtml(t.title)}
        <span class="pending-badge">LV3/LV4 반영 예정</span>
      </td>
      <td class="tree-empty"></td>
      <td class="tree-empty"></td>
      <td class="tree-empty"></td>
      <td class="progress-cell">
        <div class="progress-value">${progress}%</div>
        <div class="mini-track"><div class="mini-fill" style="width:${progress}%"></div></div>
      </td>
      <td class="tree-empty"></td>
      <td class="tree-empty"></td>
      <td class="tree-empty"></td>
      <td class="tree-empty"></td>
      <td class="tree-empty"></td>
    </tr>`;
}

function rowHtml(t) {
  const progress = effectiveProgress(t);
  const stages = t.stages && typeof t.stages === "object" ? t.stages : {};
  const dl = deadlineStatus(t);
  const stageCfg = getStageConfig(t);
  const taskType = t.taskType === "meeting" ? "meeting" : "development";
  const ownerSubHtml =
    t.ownerSub && t.ownerSub.length
      ? `<div class="owner-sub">부: ${escapeHtml(t.ownerSub.join(", "))}</div>`
      : "";
  return `
    <tr class="leaf-row${t.archived ? " is-archived" : ""}" data-id="${escapeHtml(t.id)}">
      <td class="no-cell">${escapeHtml(t.wbsId)}</td>
      <td class="title-cell">${t.archived ? '<span class="archived-badge">삭제됨</span>' : ""}${
    t.urgent ? '<span class="urgent-badge">즉실행</span>' : ""
  }${escapeHtml(t.title)}</td>
      <td>${escapeHtml(t.owner)}${ownerSubHtml}</td>
      <td>
        <select class="status-select ${statusToneClass(t.status)}" data-field="status">
          ${STATUS_ORDER.map(
            (s) => `<option value="${s}" ${t.status === s ? "selected" : ""}>${s}</option>`
          ).join("")}
        </select>
      </td>
      <td class="stage-cell">
        <select class="type-select" data-field="taskType" title="과제 유형에 따라 진행단계 구성이 달라집니다">
          ${Object.entries(TASK_TYPE_LABELS)
            .map(([v, label]) => `<option value="${v}" ${taskType === v ? "selected" : ""}>${label}</option>`)
            .join("")}
        </select>
        <div class="stage-grid">
          ${stageCfg.keys.map(
            (k) => `
            <label class="stage-chip" title="${stageCfg.labels[k]} (${stageCfg.weights[k]}%)">
              <input type="checkbox" data-field="stage" data-stage="${k}" ${stages[k] ? "checked" : ""} />
              <span>${stageCfg.short[k]} <b>${stageCfg.weights[k]}%</b></span>
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
      <td class="deadline-cell">
        <span class="deadline-badge tone-${dl.tone}" data-role="deadline-badge">${dl.label}</span>
        ${t.erpRequired ? '<span class="erp-badge">D365 개발</span>' : ""}
      </td>
      <td class="issue-cell"><textarea data-field="issue" placeholder="이슈 없음">${escapeHtml(
        t.issue
      )}</textarea></td>
      <td class="remark-cell"><textarea data-field="remark" placeholder="-">${escapeHtml(
        t.remark
      )}</textarea></td>
    </tr>`;
}

function renderTreeTable() {
  if (isEditingActive()) {
    pendingTableRender = true;
    return;
  }
  const leaves = filteredTasks();
  const filtersActive = !!(filters.lv1 || filters.owner || filters.status);
  const tree = buildTree(leaves);

  const rows = [];
  const editableLeaves = [];
  for (const [lv1, lv2Map] of tree) {
    const lv1Leaves = flattenLv2Map(lv2Map);
    const lv1Key = lv1;
    const lv1Open = filtersActive || expandedKeys.has(lv1Key);
    rows.push(groupRowHtml(1, lv1Key, lv1, lv1Leaves, lv1Open));
    if (!lv1Open) continue;
    for (const [lv2, lv3Map] of lv2Map) {
      const lv2Leaves = flattenLv3Map(lv3Map);
      const lv2Key = `${lv1}${KEY_SEP}${lv2}`;
      const lv2Open = filtersActive || expandedKeys.has(lv2Key);
      rows.push(groupRowHtml(2, lv2Key, lv2, lv2Leaves, lv2Open));
      if (!lv2Open) continue;

      if (isPendingDetailGroup(lv3Map)) {
        for (const t of lv3Map.get("미분류")) rows.push(stubRowHtml(t));
        continue;
      }

      for (const [lv3, leafList] of lv3Map) {
        const lv3Key = `${lv1}${KEY_SEP}${lv2}${KEY_SEP}${lv3}`;
        const lv3Open = filtersActive || expandedKeys.has(lv3Key);
        rows.push(groupRowHtml(3, lv3Key, lv3, leafList, lv3Open));
        if (!lv3Open) continue;
        for (const t of leafList) {
          rows.push(rowHtml(t));
          editableLeaves.push(t);
        }
      }
    }
  }

  el("#task-tbody").innerHTML = rows.join("");
  el("#task-tbody")
    .querySelectorAll(".tree-toggle")
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.key;
        if (expandedKeys.has(key)) expandedKeys.delete(key);
        else expandedKeys.add(key);
        renderTreeTable();
      });
    });
  editableLeaves.forEach(attachRowHandlers);
}

el("#task-tbody").addEventListener("focusout", () => {
  setTimeout(() => {
    if (pendingTableRender && !isEditingActive()) {
      pendingTableRender = false;
      renderTreeTable();
    }
  }, 50);
});

function attachRowHandlers(t) {
  const tr = document.querySelector(`tr[data-id="${cssEscape(t.id)}"]`);
  if (!tr) return;

  const statusSel = tr.querySelector('[data-field="status"]');
  statusSel.addEventListener("change", () => {
    saveField(t.id, "status", statusSel.value, tr);
    statusSel.className = `status-select ${statusToneClass(statusSel.value)}`;
    refreshDeadlineBadge(tr, { ...t, status: statusSel.value });
  });

  function bindStageBoxes() {
    tr.querySelectorAll('[data-field="stage"]').forEach((box) => {
      box.addEventListener("change", async () => {
        const stageKey = box.dataset.stage;
        const nextStages = { ...(t.stages || {}), [stageKey]: box.checked };
        t.stages = nextStages;
        const { keys, weights } = getStageConfig(t);
        const newProgress = Math.round(
          keys.reduce((sum, k) => sum + (nextStages[k] ? weights[k] : 0), 0)
        );
        tr.querySelector('[data-role="progress-value"]').textContent = `${newProgress}%`;
        tr.querySelector('[data-role="mini-fill"]').style.width = `${newProgress}%`;
        try {
          await updateDoc(doc(db, "wbsTasks", t.id), {
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
  }
  bindStageBoxes();

  const typeSel = tr.querySelector('[data-field="taskType"]');
  typeSel.addEventListener("change", async () => {
    const nextType = typeSel.value;
    if (nextType === (t.taskType === "meeting" ? "meeting" : "development")) return;
    const confirmed = confirm(
      "과제 유형을 바꾸면 이 과제의 진행단계 체크가 모두 초기화됩니다. 계속할까요?"
    );
    if (!confirmed) {
      typeSel.value = t.taskType === "meeting" ? "meeting" : "development";
      return;
    }
    t.taskType = nextType;
    t.stages = {};
    const stageCfg = getStageConfig(t);
    const stageGrid = tr.querySelector(".stage-grid");
    stageGrid.innerHTML = stageCfg.keys
      .map(
        (k) => `
        <label class="stage-chip" title="${stageCfg.labels[k]} (${stageCfg.weights[k]}%)">
          <input type="checkbox" data-field="stage" data-stage="${k}" />
          <span>${stageCfg.short[k]} <b>${stageCfg.weights[k]}%</b></span>
        </label>`
      )
      .join("");
    bindStageBoxes();
    tr.querySelector('[data-role="progress-value"]').textContent = `0%`;
    tr.querySelector('[data-role="mini-fill"]').style.width = `0%`;
    try {
      await updateDoc(doc(db, "wbsTasks", t.id), {
        taskType: nextType,
        stages: {},
        progress: 0,
        updatedAt: serverTimestamp(),
      });
      tr.classList.add("save-flash");
      setTimeout(() => tr.classList.remove("save-flash"), 600);
    } catch (err) {
      console.error(err);
      alert("저장에 실패했습니다. 네트워크 연결을 확인해주세요.");
    }
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
    await updateDoc(doc(db, "wbsTasks", id), {
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
