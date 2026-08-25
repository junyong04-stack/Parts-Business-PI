import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  getFirestore,
  collection,
  onSnapshot,
  doc,
  updateDoc,
  setDoc,
  addDoc,
  query,
  orderBy,
  limit,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const tasksCol = collection(db, "wbsExecTasks");
const snapshotsCol = collection(db, "wbsExecSnapshots");
const changeLogCol = collection(db, "wbsExecChangeLog");

try {
  await signInAnonymously(auth);
} catch (err) {
  console.error("anonymous sign-in failed", err);
  document.querySelector("#sync-status").textContent =
    "로그인 실패 — Firebase 콘솔에서 익명 로그인이 켜져 있는지 확인하세요";
}

const FIELD_LABELS = { progress: "진척률", erpRequired: "D365", issue: "이슈 현황" };

function currentUserName() {
  const v = (el("#user-name").value || "").trim();
  return v || "익명";
}

function formatLogValue(field, value) {
  if (field === "progress") return `${value}%`;
  if (field === "erpRequired") return value ? "체크" : "해제";
  if (field === "issue") return value ? `"${value}"` : "(빈칸)";
  return String(value);
}

async function logChange(t, field, oldValue, newValue) {
  if (oldValue === newValue) return;
  try {
    await addDoc(changeLogCol, {
      taskId: t.id,
      wbsId: t.wbsId,
      lv3: t.lv3,
      field,
      fieldLabel: FIELD_LABELS[field] || field,
      oldValueText: formatLogValue(field, oldValue),
      newValueText: formatLogValue(field, newValue),
      changedBy: currentUserName(),
      changedAt: serverTimestamp(),
    });
  } catch (err) {
    console.error("change log write failed", err);
  }
}

const STATUS_ORDER = ["완료", "진행중", "검토", "-"];
const STATUS_COLOR = {
  완료: "var(--status-good)",
  진행중: "var(--series-blue)",
  검토: "var(--status-warning)",
  "-": "var(--status-neutral)",
};

function statusToneClass(status) {
  if (status === "완료") return "tone-good";
  if (status === "진행중") return "tone-blue";
  if (status === "검토") return "tone-warning";
  return "tone-neutral";
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

function clampPct(v) {
  let n = Number(v);
  if (Number.isNaN(n)) n = 0;
  return Math.max(0, Math.min(100, n));
}

function weightedAvg(items, weightFn, valueFn) {
  const totalWeight = items.reduce((s, it) => s + (Number(weightFn(it)) || 0), 0);
  if (!totalWeight) return 0;
  const sum = items.reduce((s, it) => s + (Number(weightFn(it)) || 0) * clampPct(valueFn(it)), 0);
  return sum / totalWeight;
}

// aggregate a group's "status" from its children: any 진행중 wins, else all-완료, else any 검토, else "-"
function deriveStatus(items, statusFn) {
  const statuses = items.map(statusFn);
  if (statuses.some((s) => s === "진행중")) return "진행중";
  if (statuses.length && statuses.every((s) => s === "완료")) return "완료";
  if (statuses.some((s) => s === "검토")) return "검토";
  return "-";
}

// linear schedule assumption: (today - start) / (end - start) * 100, clamped to [0,100]
function plannedProgressFor(t) {
  if (!t.startDate || !t.endDate) return 0;
  const start = new Date(`${t.startDate}T00:00:00`);
  const end = new Date(`${t.endDate}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return 0;
  if (today <= start) return 0;
  if (today >= end) return 100;
  return ((today - start) / (end - start)) * 100;
}

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ---------- donut ----------

function donutSvg(pct, size = 120, stroke = 14, color = "var(--series-blue)", track = "var(--series-blue-track)") {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const filled = (Math.max(0, Math.min(100, pct)) / 100) * c;
  const center = size / 2;
  return `
    <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
      <circle cx="${center}" cy="${center}" r="${r}" fill="none" stroke="${track}" stroke-width="${stroke}" />
      <circle cx="${center}" cy="${center}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}"
        stroke-linecap="round" stroke-dasharray="${filled} ${c}" transform="rotate(-90 ${center} ${center})" />
    </svg>`;
}

function barRowHtml(name, avg, status, opts = {}) {
  const color = status ? STATUS_COLOR[status] || "var(--series-blue)" : "var(--series-blue)";
  return `
    <div class="cat-bar-row${opts.rowClass ? ` ${opts.rowClass}` : ""}">
      <div class="cat-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
      <div class="cat-track">
        <div class="grid-tick" style="left:25%"></div>
        <div class="grid-tick" style="left:50%"></div>
        <div class="grid-tick" style="left:75%"></div>
        <div class="cat-fill" style="width:${avg}%; background:${color}"></div>
      </div>
      <div class="cat-value">${avg.toFixed(0)}%</div>
    </div>`;
}

// ---------- state ----------

let allTasks = [];
let snapshots = [];
let changeLog = [];
let expandedKeys = new Set();
let pendingRender = false;
let autoExpandDone = false;
let erpOnlyFilter = false;

const userNameInput = el("#user-name");
userNameInput.value = localStorage.getItem("wbsExecUserName") || "";
userNameInput.addEventListener("change", () => {
  localStorage.setItem("wbsExecUserName", userNameInput.value.trim());
});

onSnapshot(
  query(changeLogCol, orderBy("changedAt", "desc"), limit(50)),
  (snap) => {
    changeLog = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderChangeLog();
  },
  (err) => console.error(err)
);

function renderChangeLog() {
  const listEl = el("#changelog");
  if (!changeLog.length) {
    listEl.innerHTML = `<p class="empty-note">아직 기록된 변경 이력이 없습니다.</p>`;
    return;
  }
  listEl.innerHTML = `<div class="changelog-list">${changeLog
    .map((c) => {
      const when = c.changedAt && typeof c.changedAt.toDate === "function"
        ? c.changedAt.toDate().toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
        : "";
      return `
        <div class="changelog-item">
          <span class="cl-who">${escapeHtml(c.changedBy || "익명")}</span>
          <span class="cl-what">${escapeHtml(c.wbsId)} ${escapeHtml(c.lv3)} · ${escapeHtml(c.fieldLabel)}</span>
          <span class="cl-diff"><span class="from">${escapeHtml(c.oldValueText)}</span> → <span class="to">${escapeHtml(c.newValueText)}</span></span>
          <span class="cl-when">${escapeHtml(when)}</span>
        </div>`;
    })
    .join("")}</div>`;
}

onSnapshot(
  tasksCol,
  (snap) => {
    allTasks = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((t) => !t.archived)
      .sort((a, b) => (a.wbsId || "").localeCompare(b.wbsId || "", "en", { numeric: true }));
    allTasks.forEach((t) => {
      t.plannedProgress = plannedProgressFor(t);
      t.delayed = t.plannedProgress > clampPct(t.progress);
    });
    el("#sync-status").textContent = `실시간 연결됨 · 마지막 갱신 ${new Date().toLocaleTimeString("ko-KR")}`;
    renderAll();
  },
  (err) => {
    el("#sync-status").textContent = "연결 실패 — firebase-config.js 설정을 확인하세요";
    console.error(err);
  }
);

onSnapshot(
  query(snapshotsCol, orderBy("dateKey", "desc"), limit(10)),
  (snap) => {
    snapshots = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (allTasks.length) renderAll();
  },
  (err) => console.error(err)
);

el("#snapshot-btn").addEventListener("click", async () => {
  const { lv1Map, overall } = computeRollups(allTasks);
  const lv1Snapshot = {};
  for (const g of lv1Map.values()) lv1Snapshot[g.lv1] = Math.round(g.progress * 10) / 10;
  const key = todayKey();
  try {
    await setDoc(doc(db, "wbsExecSnapshots", key), {
      dateKey: key,
      overall: Math.round(overall * 10) / 10,
      lv1: lv1Snapshot,
      takenAt: serverTimestamp(),
    });
    alert(`${key} 스냅샷을 저장했습니다. (전체 ${overall.toFixed(1)}%)`);
  } catch (err) {
    console.error(err);
    alert("스냅샷 저장에 실패했습니다. 네트워크 연결을 확인해주세요.");
  }
});

// ---------- rollups ----------

function computeRollups(tasks) {
  const lv2Map = new Map();
  for (const t of tasks) {
    if (!lv2Map.has(t.lv2Id)) {
      lv2Map.set(t.lv2Id, {
        lv2Id: t.lv2Id,
        lv2: t.lv2,
        lv1: t.lv1,
        lv2Weight: Number(t.lv2Weight) || 0,
        lv2KeyTask: !!t.lv2KeyTask,
        items: [],
      });
    }
    lv2Map.get(t.lv2Id).items.push(t);
  }
  for (const g of lv2Map.values()) {
    g.progress = weightedAvg(g.items, (t) => t.weight, (t) => t.progress);
    g.plannedProgress = weightedAvg(g.items, (t) => t.weight, (t) => t.plannedProgress);
    // lv2Status comes straight from the sheet (real data); fall back to a derived
    // aggregate only for older rows that predate that column.
    g.status = g.items[0] && g.items[0].lv2Status ? g.items[0].lv2Status : deriveStatus(g.items, (t) => t.status);
  }

  const lv1Map = new Map();
  for (const g of lv2Map.values()) {
    if (!lv1Map.has(g.lv1)) lv1Map.set(g.lv1, { lv1: g.lv1, lv1Weight: 0, lv2Groups: [] });
    lv1Map.get(g.lv1).lv2Groups.push(g);
  }
  for (const t of tasks) {
    if (lv1Map.has(t.lv1)) lv1Map.get(t.lv1).lv1Weight = Number(t.lv1Weight) || 0;
  }
  for (const g of lv1Map.values()) {
    g.progress = weightedAvg(g.lv2Groups, (x) => x.lv2Weight, (x) => x.progress);
    g.plannedProgress = weightedAvg(g.lv2Groups, (x) => x.lv2Weight, (x) => x.plannedProgress);
    g.status = deriveStatus(g.lv2Groups, (x) => x.status);
  }

  const lv1Groups = [...lv1Map.values()];
  const overall = weightedAvg(lv1Groups, (x) => x.lv1Weight, (x) => x.progress);
  const overallPlanned = weightedAvg(lv1Groups, (x) => x.lv1Weight, (x) => x.plannedProgress);

  const ownerMap = new Map();
  for (const t of tasks) {
    const owner = t.owner || "미지정";
    if (!ownerMap.has(owner)) ownerMap.set(owner, []);
    ownerMap.get(owner).push(t);
  }
  const owners = [...ownerMap.entries()].map(([owner, items]) => ({
    owner,
    items,
    progress: weightedAvg(items, (t) => t.weight, (t) => t.progress),
    weightSum: items.reduce((s, t) => s + (Number(t.weight) || 0), 0),
  }));
  owners.sort((a, b) => b.weightSum - a.weightSum);

  return { lv1Map, lv2Map, overall, overallPlanned, owners };
}

function renderAll() {
  const { lv1Map, lv2Map, overall, overallPlanned, owners } = computeRollups(allTasks);
  const lv1Groups = [...lv1Map.values()];
  const lv2Groups = [...lv2Map.values()];

  // hero
  el("#hero-donut").innerHTML = `${donutSvg(overall, 116)}<div class="donut-center"><div class="pct">${overall.toFixed(1)}%</div></div>`;
  const totalWeight = allTasks.reduce((s, t) => s + (Number(t.weight) || 0), 0);
  el("#hero-sub").textContent = `세부과제 ${allTasks.length}건 · 가중치 합계 ${totalWeight.toFixed(1)}`;

  // plan-vs-actual gap (linear schedule assumption)
  const gap = overall - overallPlanned;
  const gapEl = el("#plan-gap");
  gapEl.textContent = `계획(선형가정) 대비 ${gap >= 0 ? "+" : ""}${gap.toFixed(1)}%p`;
  gapEl.className = `plan-gap ${gap >= 0 ? "ahead" : "behind"}`;

  // week-over-week trend, vs most recent snapshot that isn't today's
  const baseline = snapshots.find((s) => s.dateKey !== todayKey());
  const trendEl = el("#trend-gap");
  if (baseline) {
    const diff = overall - baseline.overall;
    trendEl.textContent = `전주(${baseline.dateKey}) 대비 ${diff >= 0 ? "+" : ""}${diff.toFixed(1)}%p`;
    trendEl.className = `trend-gap ${diff > 0 ? "up" : diff < 0 ? "down" : ""}`;
  } else {
    trendEl.textContent = "저장된 스냅샷이 없습니다 — 우측 상단 버튼으로 이번 주 스냅샷을 저장해보세요";
    trendEl.className = "trend-gap";
  }

  // KPI
  const tiles = [
    { label: "총 세부과제", value: allTasks.length, color: null },
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
        <div class="label">${t.color ? `<span class="dot" style="background:${t.color}"></span>` : ""}${escapeHtml(t.label)}</div>
        <div class="value">${t.value}</div>
      </div>`
    )
    .join("");

  // LV1(전략과제) bar chart — colored by each pillar's derived status, natural 1→4 order
  el("#lv1-chart").innerHTML = lv1Groups.map((g) => barRowHtml(g.lv1, g.progress, g.status)).join("");

  // LV2(실행과제) bar chart — 14 items, natural wbsId order
  el("#lv2-chart").innerHTML = lv2Groups.map((g) => barRowHtml(`${g.lv2Id} ${g.lv2}`, g.progress, g.status)).join("");

  // owner bar chart — "미지정"(unassigned) gets a distinct muted/italic treatment so it isn't confused with an assigned owner sitting at 0%
  el("#owner-chart").innerHTML = owners.length
    ? owners
        .map((o) =>
          barRowHtml(
            o.owner === "미지정" ? "미지정 (담당자 미배정)" : o.owner,
            o.progress,
            null,
            o.owner === "미지정" ? { rowClass: "owner-unassigned" } : {}
          )
        )
        .join("")
    : `<p class="empty-note">담당자 데이터가 없습니다.</p>`;

  // status distribution
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

  // D365 donut — only over tasks the user has manually checked as erpRequired
  renderErpDonut();

  // delay/issue watchlist
  renderWatchlist();

  renderTable(lv1Groups);
}

function renderErpDonut() {
  const tasks = allTasks.filter((t) => t.erpRequired);
  const avg = weightedAvg(tasks, (t) => t.weight, (t) => t.progress);
  const el2 = el("#erp-donut");
  if (!tasks.length) {
    el2.innerHTML = `<p class="empty-note">D365 개발이 필요한 과제가 아직 표시되지 않았습니다. 아래 표에서 세부과제별로 D365 체크박스를 선택해 주세요.</p>`;
    return;
  }
  el2.innerHTML = `
    <div class="donut-figure">
      ${donutSvg(avg, 120, 14, "#7c3aed", "rgba(124, 58, 237, 0.18)")}
      <div class="donut-center">
        <div class="pct">${avg.toFixed(0)}%</div>
        <div class="cnt">${tasks.length}건</div>
      </div>
    </div>`;
}

function renderWatchlist() {
  const withIssue = allTasks.filter((t) => t.issue && t.issue.trim());
  const delayed = allTasks
    .filter((t) => t.delayed)
    .sort((a, b) => b.plannedProgress - b.progress - (a.plannedProgress - a.progress));

  const seen = new Set();
  const combined = [...delayed, ...withIssue].filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });

  const listEl = el("#watchlist");
  if (!combined.length) {
    listEl.innerHTML = `<p class="empty-note">지연 위험이나 등록된 이슈가 있는 세부과제가 없습니다.</p>`;
    return;
  }
  listEl.innerHTML = combined
    .slice(0, 8)
    .map((t) => {
      const badges = [
        t.delayed ? `<span class="watchlist-badge delay">지연</span>` : "",
        t.issue && t.issue.trim() ? `<span class="watchlist-badge issue">이슈</span>` : "",
      ].join("");
      return `
        <div class="watchlist-item">
          <div class="wl-title">${badges}${escapeHtml(t.wbsId)} ${escapeHtml(t.lv3)}</div>
          <div class="wl-meta">${escapeHtml(t.owner || "미지정")} · 진척률 ${clampPct(t.progress)}% (계획 ${t.plannedProgress.toFixed(0)}%) · ${escapeHtml(t.endDate)}까지${t.issue ? ` · ${escapeHtml(t.issue)}` : ""}</div>
        </div>`;
    })
    .join("");
}

// ---------- tree table ----------

function renderTable(lv1Groups) {
  if (isEditingActive()) {
    pendingRender = true;
    return;
  }

  if (!autoExpandDone) {
    autoExpandDone = true;
    for (const lv1g of lv1Groups) {
      for (const lv2g of lv1g.lv2Groups) {
        const flagged = lv2g.items.some((t) => t.delayed || (t.issue && t.issue.trim()));
        if (flagged) {
          expandedKeys.add(`lv1:${lv1g.lv1}`);
          expandedKeys.add(`lv2:${lv2g.lv2Id}`);
        }
      }
    }
  }

  const rows = [];
  for (const lv1g of lv1Groups) {
    const lv2sForView = erpOnlyFilter
      ? lv1g.lv2Groups.filter((g) => g.items.some((t) => t.erpRequired))
      : lv1g.lv2Groups;
    if (erpOnlyFilter && !lv2sForView.length) continue;

    const lv1Key = `lv1:${lv1g.lv1}`;
    const lv1Open = expandedKeys.has(lv1Key);
    const lv3CountLv1 = lv1g.lv2Groups.reduce((s, g) => s + g.items.length, 0);
    rows.push(`
      <tr class="tree-group lv1">
        <td colspan="6">
          <div class="tree-group-cell">
            <button type="button" class="tree-toggle" data-key="${escapeHtml(lv1Key)}">${lv1Open ? "▾" : "▸"}</button>
            <span>${escapeHtml(lv1g.lv1)}</span>
            <span class="tree-count">실행과제 ${lv1g.lv2Groups.length}건 · 세부과제 ${lv3CountLv1}건 · 가중치 ${lv1g.lv1Weight}</span>
          </div>
        </td>
        <td class="progress-cell">
          <div class="progress-value">${lv1g.progress.toFixed(0)}%</div>
          <div class="mini-track"><div class="mini-fill" style="width:${lv1g.progress}%; background:${STATUS_COLOR[lv1g.status]}"></div></div>
        </td>
        <td colspan="4"></td>
      </tr>`);
    if (!lv1Open) continue;

    for (const lv2g of lv2sForView) {
      const lv2Key = `lv2:${lv2g.lv2Id}`;
      const lv2Open = expandedKeys.has(lv2Key);
      rows.push(`
        <tr class="tree-group lv2">
          <td colspan="6">
            <div class="tree-group-cell" style="padding-left:18px">
              <button type="button" class="tree-toggle" data-key="${escapeHtml(lv2Key)}">${lv2Open ? "▾" : "▸"}</button>
              <span>${escapeHtml(lv2g.lv2Id)} ${escapeHtml(lv2g.lv2)}${lv2g.lv2KeyTask ? '<span class="keytask-badge">핵심</span>' : ""}</span>
              <span class="tree-count">세부과제 ${lv2g.items.length}건 · 가중치 ${lv2g.lv2Weight}</span>
            </div>
          </td>
          <td class="progress-cell">
            <div class="progress-value">${lv2g.progress.toFixed(0)}%</div>
            <div class="mini-track"><div class="mini-fill" style="width:${lv2g.progress}%; background:${STATUS_COLOR[lv2g.status]}"></div></div>
          </td>
          <td colspan="4"></td>
        </tr>`);
      if (!lv2Open) continue;

      const leaves = erpOnlyFilter ? lv2g.items.filter((t) => t.erpRequired) : lv2g.items;
      for (const t of leaves) {
        rows.push(leafRowHtml(t));
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
        renderTable(lv1Groups);
      });
    });

  allTasks.forEach((t) => attachRowHandlers(t));
}

function leafRowHtml(t) {
  const progress = clampPct(t.progress);
  const color = STATUS_COLOR[t.status] || "var(--status-neutral)";
  return `
    <tr class="leaf-row exec-lv3-row" data-id="${escapeHtml(t.id)}">
      <td class="no-cell">${escapeHtml(t.wbsId)}</td>
      <td class="title-cell lv3-cell">${escapeHtml(t.lv3)}</td>
      <td>${escapeHtml(t.owner)}</td>
      <td><span class="exec-status ${statusToneClass(t.status)}">${escapeHtml(t.status)}</span></td>
      <td>${t.delayed ? '<span class="delay-badge">지연</span>' : ""}</td>
      <td>${t.weight}</td>
      <td class="progress-cell">
        <input type="number" class="progress-input" data-field="progress" min="0" max="100" step="1" value="${progress}" />
        <div class="mini-track"><div class="mini-fill" style="width:${progress}%; background:${color}"></div></div>
      </td>
      <td style="text-align:center">
        <input type="checkbox" class="erp-checkbox" data-field="erpRequired" ${t.erpRequired ? "checked" : ""} />
      </td>
      <td>${escapeHtml(t.startDate)}</td>
      <td>${escapeHtml(t.endDate)}</td>
      <td class="issue-cell"><textarea data-field="issue" placeholder="이슈 없음">${escapeHtml(t.issue)}</textarea></td>
    </tr>`;
}

function isEditingActive() {
  const activeEl = document.activeElement;
  return (
    activeEl &&
    activeEl.closest &&
    activeEl.closest("#task-tbody") &&
    ["INPUT", "TEXTAREA"].includes(activeEl.tagName)
  );
}

function attachRowHandlers(t) {
  const tr = document.querySelector(`tr[data-id="${cssEscape(t.id)}"]`);
  if (!tr) return;

  const progressInput = tr.querySelector('[data-field="progress"]');
  if (progressInput) {
    progressInput.addEventListener("change", async () => {
      const value = clampPct(progressInput.value);
      progressInput.value = value;
      const oldValue = clampPct(t.progress);
      try {
        await updateDoc(doc(db, "wbsExecTasks", t.id), {
          progress: value,
          updatedAt: serverTimestamp(),
        });
        logChange(t, "progress", oldValue, value);
        tr.classList.add("save-flash");
        setTimeout(() => tr.classList.remove("save-flash"), 600);
      } catch (err) {
        console.error(err);
        alert("저장에 실패했습니다. 네트워크 연결을 확인해주세요.");
      }
    });
  }

  const erpCheckbox = tr.querySelector('[data-field="erpRequired"]');
  if (erpCheckbox) {
    erpCheckbox.addEventListener("change", async () => {
      const oldValue = !!t.erpRequired;
      const newValue = erpCheckbox.checked;
      try {
        await updateDoc(doc(db, "wbsExecTasks", t.id), {
          erpRequired: newValue,
          updatedAt: serverTimestamp(),
        });
        logChange(t, "erpRequired", oldValue, newValue);
        tr.classList.add("save-flash");
        setTimeout(() => tr.classList.remove("save-flash"), 600);
      } catch (err) {
        console.error(err);
        alert("저장에 실패했습니다. 네트워크 연결을 확인해주세요.");
      }
    });
  }

  const issueInput = tr.querySelector('[data-field="issue"]');
  if (issueInput) {
    issueInput.addEventListener("blur", async () => {
      const oldValue = t.issue || "";
      const newValue = issueInput.value;
      try {
        await updateDoc(doc(db, "wbsExecTasks", t.id), {
          issue: newValue,
          updatedAt: serverTimestamp(),
        });
        logChange(t, "issue", oldValue, newValue);
        tr.classList.add("save-flash");
        setTimeout(() => tr.classList.remove("save-flash"), 600);
      } catch (err) {
        console.error(err);
        alert("저장에 실패했습니다. 네트워크 연결을 확인해주세요.");
      }
    });
  }
}

el("#filter-erp-only").addEventListener("change", (e) => {
  erpOnlyFilter = e.target.checked;
  if (allTasks.length) renderAll();
});

el("#task-tbody").addEventListener("focusout", () => {
  setTimeout(() => {
    if (pendingRender && !isEditingActive()) {
      pendingRender = false;
      renderAll();
    }
  }, 50);
});
