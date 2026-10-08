import { renderPersonalTree } from "./skill-tree/personal-tree-ui.js";
import { skillIcons } from "./skill-tree/skill-icons.js";

const root = document.getElementById("earth-goal-preview");
const $ = (s) => root.querySelector(s);
const main = $(".eg-main"),
  nav = $(".eg-nav"),
  overlay = $(".eg-overlay"),
  dialog = $(".eg-dialog");
const api = window.earthApi.request;
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const ic = (n) => `<i data-lucide="${n}" aria-hidden="true"></i>`;
const icons = () =>
  window.lucide?.createIcons({ attrs: { width: 20, height: 20 } });
const names = ["知识", "胆量", "灵巧", "温柔", "魅力"],
  statIcons = ["book-open", "shield", "hand", "heart", "sparkles"];
let state,
  rules,
  version = 0,
  jobs = [],
  user,
  page = "home",
  tab = "today",
  detailId,
  goalId,
  loading = false,
  snapshot = "",
  modalOpen = false,
  focusBefore,
  authMode = "login";
let intake = { start: null, goalId: null, draft: "", error: "" },
  sending = false,
  confirming = false,
  dialogSignature = "",
  toastTimer;
const requestKeys = new Map();
const day = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: state?.profile.timezone || "Asia/Shanghai",
  }).format(new Date());
const dateOf = (d) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: state?.profile.timezone || "Asia/Shanghai",
  }).format(new Date(d));
const goals = () => state.goals.filter((g) => !g.deletedAt);
const activeGoals = () => goals().filter((g) => g.status === "active");
const status = (s) =>
  ({
    draft: "等待确认",
    active: "进行中",
    paused: "已暂停",
    ended: "已结束",
    completed: "已完成",
    awaiting_external: "等待现实结果",
    queued: "排队中",
    running: "正在生成",
    failed: "生成未完成",
    succeeded: "已生成",
    cancelled: "已取消",
  })[s] || s;
const head = (k, title, icon = "compass", sub = "") =>
  `<div class="eg-page-emblem">${ic(icon)}</div><div class="eg-eyebrow">${k}</div><h1>${esc(title)}</h1>${sub ? `<p class="eg-muted">${esc(sub)}</p>` : ""}`;
const back = (p, label) =>
  `<button class="eg-back-page" data-go="${p}">${ic("arrow-left")}${label}</button>`;
const empty = (text, icon = "sprout") =>
  `<div class="eg-empty">${ic(icon)}<p>${esc(text)}</p></div>`;
const primary = (text, action, id = "") =>
  `<button class="eg-primary" data-act="${action}" data-id="${esc(id)}">${text}</button>`;
function toast(text) {
  clearTimeout(toastTimer);
  $(".eg-toast").textContent = text;
  $(".eg-toast").hidden = false;
  toastTimer = setTimeout(() => ($(".eg-toast").hidden = true), 3500);
}
function busyJob(kind, id) {
  return jobs.find((j) => j.kind === kind && (!id || j.id === id));
}
function jobNotice(kind, id) {
  const j = busyJob(kind, id);
  return j
    ? `<div class="eg-status" role="status">${ic(j.status === "failed" ? "circle-alert" : "hourglass")}<span>${status(j.status)}${j.error ? " · " + esc(j.error) : ""}</span></div>`
    : "";
}
function go(p) {
  page = p;
  $(".eg-toast").hidden = true;
  render();
  window.scrollTo({ top: 0, behavior: "instant" });
}
async function refresh() {
  if (loading) return loading;
  loading = (async () => {
    try {
      const [s, j] = await Promise.all([api("/state"), api("/jobs")]);
      const next = JSON.stringify([s, j]);
      state = s.state;
      version = s.version;
      rules = s.rules;
      jobs = j;
      if (snapshot !== next) {
        snapshot = next;
        if (
          !main.contains(document.activeElement) ||
          !document.activeElement.matches("input,textarea,select")
        )
          render();
        if (modalOpen) renderIntake();
      }
    } finally {
      loading = false;
    }
  })();
  return loading;
}
async function command(cmd, key) {
  const fingerprint = JSON.stringify(cmd);
  key ||= requestKeys.get(fingerprint) || crypto.randomUUID();
  requestKeys.set(fingerprint, key);
  try {
    const result = await api("/commands", {
      method: "POST",
      key,
      body: { expectedVersion: version, command: cmd },
    });
    // A poll started before this write may still hold the previous snapshot.
    if (loading) await loading;
    await refresh();
    requestKeys.delete(fingerprint);
    return result;
  } catch (e) {
    if (e.status && e.status < 500) requestKeys.delete(fingerprint);
    if (e.status === 409) await refresh();
    throw e;
  }
}
function taskList() {
  const list = state.plans
    .filter(
      (p) =>
        p.day === day() &&
        !["cancelled", "paused", "expired"].includes(p.status),
    )
    .map((p) => ({
      ...p,
      key: "plan:" + p.id,
      plan: p.id,
      title: p.name,
      done: state.records.some((r) => r.plan === p.id),
      steps: [],
      resources: [],
      skills: [],
    }));
  for (const g of activeGoals()) {
    const plan = state.skillPlans?.[g.id];
    if (plan) {
      for (const t of plan.tasks) {
        // Scheduled copies use their own completion record, so do not offer a second shortcut.
        if (list.some((p) => p.goal === g.id && p.name === t.name)) continue;
        list.push({
          ...t,
          key: "skill:" + g.id + ":" + t.id,
          skillTaskId: t.id,
          goal: g.id,
          title: t.name,
          plan: null,
          skills: t.skillIds,
          steps: t.actions,
          resources: plan.resources.filter((r) => t.resourceIds.includes(r.id)),
          done: state.records.some(
            (r) => r.goal === g.id && r.skillTaskId === t.id && r.day === day(),
          ),
        });
      }
    } else if (!g.skillJobId) {
      const stage = g.stages[g.stage];
      if (stage)
        list.push({
          key: "stage:" + g.id + ":" + g.revision + ":" + g.stage,
          goal: g.id,
          title: stage.exercise,
          name: stage.exercise,
          minutes: g.minutes,
          stat: g.stat,
          plan: null,
          skills: [],
          steps: [{ name: stage.exercise, detail: stage.steps }],
          resources: [],
          done: state.records.some(
            (r) =>
              r.goal === g.id && r.name === stage.exercise && r.day === day(),
          ),
        });
    }
  }
  return list;
}
function taskRow(t) {
  return `<div class="eg-taskrow"><button class="eg-toggle" data-task="${esc(t.key)}" aria-label="${t.done ? "查看记录" : "查看任务"}：${esc(t.title)}" aria-pressed="${t.done}">${ic(t.done ? "check" : "circle")}</button><button class="eg-taskopen" data-task="${esc(t.key)}"><span class="${t.done ? "eg-done-title" : ""}">${esc(t.title)}</span><small class="eg-inline">${ic("clock-3")}${t.minutes} 分钟 ${ic("chevron-right")}</small></button></div>`;
}
function goalIcon(g) {
  const p = state.skillPlans?.[g.id];
  const n = state.personalTree?.nodes.find(
    (n) => n.id === p?.targetSkillIds?.[0],
  );
  return skillIcons[n?.icon] || "flag";
}
function quest(g, tasks) {
  return `<section class="eg-quest"><div class="eg-quest-head"><span class="eg-symbol">${ic(goalIcon(g))}</span><div style="flex:1;min-width:0"><h3>${esc(g.title)}</h3><small>${status(g.status)} · 每次 ${g.minutes} 分钟</small></div><button class="eg-small-action eg-inline" data-goal="${g.id}">${ic("route")}路线</button></div>${tasks.map(taskRow).join("")}${!tasks.length ? `<p class="eg-muted">${g.status === "draft" ? "路线准备好后，确认开始。" : g.skillJobId ? "正在准备任务与能力分支。" : "从路线中选择下一步。"}</p>` : ""}</section>`;
}
function xpValues() {
  return names.map((_, i) =>
    state.records
      .filter((r) => r.stat === i)
      .reduce((sum, r) => sum + r.gain, 0),
  );
}
function radar() {
  const values = xpValues(),
    cx = 90,
    cy = 93,
    angles = [-90, -18, 54, 126, 198],
    points = (r) =>
      angles.map((a) => [
        cx + Math.cos((a * Math.PI) / 180) * r,
        cy + Math.sin((a * Math.PI) / 180) * r,
      ]);
  const poly = values
    .map((v, i) => {
      const r = 18 + Math.min(1, v / rules.attributeXpPerRank) * 46,
        a = (angles[i] * Math.PI) / 180;
      return `${cx + Math.cos(a) * r},${cy + Math.sin(a) * r}`;
    })
    .join(" ");
  return `<svg class="eg-radar" viewBox="0 0 180 184" role="img" aria-label="${names.map((n, i) => n + " " + values[i] + "经验").join("，")}"><g fill="none" stroke="var(--eg-line)">${[
    22, 43, 64,
  ]
    .map(
      (r) =>
        `<polygon points="${points(r)
          .map((p) => p.join(","))
          .join(" ")}"/>`,
    )
    .join("")}${points(64)
    .map(([x, y]) => `<path d="M90 93L${x} ${y}"/>`)
    .join(
      "",
    )}</g><polygon points="${poly}" fill="var(--eg-soft)" stroke="var(--eg-ink)" stroke-width="1.5"/>${[
    [90, 16, "middle"],
    [178, 68, "end"],
    [136, 171, "middle"],
    [45, 171, "middle"],
    [2, 68, "start"],
  ]
    .map(
      ([x, y, a], i) =>
        `<text x="${x}" y="${y}" text-anchor="${a}">${names[i]} ${1 + Math.floor(values[i] / rules.attributeXpPerRank)}</text>`,
    )
    .join("")}</svg>`;
}
function drawAvatar() {
  const c = $("canvas");
  if (!c) return;
  const x = c.getContext("2d"),
    r = (a, b, w, h, color) => {
      x.fillStyle = color;
      x.fillRect(a, b, w, h);
    };
  x.imageSmoothingEnabled = false;
  r(31, 70, 13, 31, "#3c4c3b");
  r(46, 70, 13, 31, "#344233");
  r(28, 100, 16, 6, "#26362c");
  r(46, 100, 17, 6, "#26362c");
  r(22, 40, 45, 37, "#798f65");
  r(28, 40, 32, 40, "#52694a");
  r(18, 47, 10, 27, "#a4b88a");
  r(63, 46, 9, 27, "#a4b88a");
  r(19, 72, 9, 10, "#dfb897");
  r(63, 71, 9, 10, "#dfb897");
  r(33, 41, 20, 28, "#d4d9b4");
  r(38, 41, 12, 7, "#baa37b");
  r(29, 13, 31, 29, "#e3bd99");
  r(25, 12, 37, 11, "#354235");
  r(29, 8, 27, 11, "#354235");
  r(25, 20, 8, 14, "#354235");
  r(56, 19, 7, 11, "#354235");
  r(36, 26, 3, 3, "#344032");
  r(50, 26, 3, 3, "#344032");
  r(40, 36, 9, 2, "#a4785f");
  r(45, 40, 9, 5, "#cfa888");
  r(27, 77, 35, 4, "#2d3c2e");
  r(43, 76, 7, 5, "#c7b578");
  r(56, 46, 3, 28, "#354c37");
  r(62, 42, 8, 19, "#344a35");
}
function skillTags(ids) {
  return ids
    .map((id) => {
      const n = state.personalTree?.nodes.find((n) => n.id === id);
      return n
        ? `<button class="eg-skill-tag" data-go="growth">${ic(skillIcons[n.icon] || "sprout")}${esc(n.name)}</button>`
        : "";
    })
    .join("");
}
function render() {
  if (!state) return;
  nav.hidden = false;
  $(".eg-date").innerHTML =
    esc(day().slice(5).replace("-", " / ")) + ic("sparkles");
  const list = taskList(),
    todayRecords = state.records.filter((r) => r.day === day());
  if (page === "home") {
    const next = list.find((t) => !t.done) || list[0],
      g = next
        ? goals().find((g) => g.id === next.goal)
        : goals().find((g) => g.status === "draft") || activeGoals()[0];
    main.innerHTML = `<div class="eg-eyebrow">YOUR EVERYDAY ADVENTURE</div><div class="eg-person-title"><h1>${esc(state.profile.name)}</h1><button class="eg-round" data-go="profile" aria-label="查看角色档案">${ic("contact-round")}</button></div><p class="eg-muted eg-greeting">今天，也向想成为的自己靠近一点。</p><div class="eg-hero"><div class="eg-avatar"><canvas width="90" height="114" role="img" aria-label="像素冒险者"></canvas><span>LV. ${String(1 + Math.floor(state.levelXp / rules.xpPerLevel)).padStart(2, "0")} · 探索者</span></div>${radar()}</div><div class="eg-xp"><div class="eg-row"><small class="eg-inline">${ic("sparkles")}距离下一级</small><small>${state.levelXp % rules.xpPerLevel} / ${rules.xpPerLevel} XP</small></div><div class="eg-track"><div style="width:${((state.levelXp % rules.xpPerLevel) / rules.xpPerLevel) * 100}%"></div></div></div><div class="eg-section-title"><h2>今天的小小前进</h2><button class="eg-text-button" data-go="tasks">${list.filter((t) => t.done).length} / ${list.length} · 全部 ↗</button></div>${g ? quest(g, list.filter((t) => t.goal === g.id).slice(0, 2)) : next ? `<section class="eg-quest">${taskRow(next)}</section>` : empty("从下方「＋」开始你的第一条主线。")}<div class="eg-footnote">${ic("sprout")}先做好眼前这一步。</div>`;
  } else if (page === "tasks") {
    main.innerHTML =
      head("QUEST JOURNAL", "我的任务", "scroll-text") +
      `<div class="eg-segments"><button data-tab="today" aria-pressed="${tab === "today"}">${ic("list-checks")}今日待办</button><button data-tab="goals" aria-pressed="${tab === "goals"}">${ic("flag")}全部主线 · ${goals().length}</button></div>` +
      (tab === "today"
        ? list.length
          ? goals()
              .filter((g) => list.some((t) => t.goal === g.id))
              .map((g) =>
                quest(
                  g,
                  list.filter((t) => t.goal === g.id),
                ),
              )
              .join("") +
            list
              .filter((t) => !t.goal)
              .map(taskRow)
              .join("")
          : empty("今天还没有任务。可以新增目标，或查看已有主线。")
        : goals()
            .map((g) => quest(g, []))
            .join("") || empty("你的下一段冒险，从一个想法开始。"));
  } else if (page === "task") {
    const t = list.find((t) => t.key === detailId);
    if (!t) {
      main.innerHTML =
        back("tasks", "任务列表") + empty("这项任务已变更，请返回列表。");
    } else {
      const g = goals().find((g) => g.id === t.goal);
      main.innerHTML =
        back("tasks", "任务列表") +
        head("ONE SMALL STEP", t.title, "footprints", g?.title || "我的行动") +
        `<div class="eg-task-meta"><span>${ic("clock-3")}${t.minutes} 分钟</span><span>${ic(t.done ? "circle-check" : "compass")}${t.done ? "今天已记录" : "按自己的节奏"}</span></div>${t.purpose ? `<p class="eg-muted">${esc(t.purpose)}</p>` : ""}<h3>怎么开始</h3><ol class="eg-steps">${(t.steps.length ? t.steps : [{ name: t.title, detail: g?.stages[g.stage]?.steps || "按你的安排完成这项行动。" }]).map((s) => `<li><h3>${esc(s.name)}</h3><p>${esc(s.detail)}</p></li>`).join("")}</ol>${t.resources.map((r) => `<div class="eg-resource"><small class="eg-inline">${ic("box")}用到什么</small><p>${esc(r.name)}</p><p class="eg-muted">${esc(r.locator)}</p>${r.url && /^https?:\/\//.test(r.url) ? `<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">打开资源 ↗</a>` : ""}${r.question ? `<p>${esc(r.question)}</p>` : ""}</div>`).join("")}${t.readiness === "needs_material" ? `<p class="eg-task-tip">${esc(t.materialQuestion || "开始前，请先准备练习材料。")}</p>` : ""}<div>${skillTags(t.skills)}</div>${t.done ? '<p class="eg-task-tip">今天的投入已记录，经验以服务器记录为准。</p>' : `<form data-form="record"><label for="actual-minutes">实际投入（分钟）</label><input id="actual-minutes" name="minutes" type="number" value="${t.minutes}" min="1" max="1440" required><label for="record-note">想留下的话 · 可选</label><textarea id="record-note" name="note" rows="2" maxlength="3000"></textarea><p class="eg-error" role="alert"></p><button class="eg-primary" type="submit">${ic("check")}我完成了</button></form>`}${g ? `<button class="eg-back" data-goal="${g.id}">查看这条主线的路线</button>` : ""}`;
    }
  } else if (page === "goal") {
    const g = goals().find((g) => g.id === goalId);
    if (!g) {
      go("tasks");
      return;
    }
    const p = state.skillPlans?.[g.id];
    main.innerHTML =
      back("tasks", "我的主线") +
      head("YOUR ROUTE", g.title, "route") +
      `<div class="eg-task-meta"><span>${ic("flag")}${status(g.status)}</span><span>${ic("clock-3")}每次 ${g.minutes} 分钟</span></div><p class="eg-muted">${esc(g.base)}</p>${g.status === "draft" ? jobNotice("route", g.routeJobId) + primary(g.draft ? "查看路线并确认" : "继续准备路线", "resume", g.id) : ""}${(p?.strategy || g.stages.map((s, i) => ({ name: s.name, approach: s.steps, timing: i === g.stage ? "现在" : "接下来" }))).map((s) => `<section class="eg-route-phase"><small>${esc(s.timing)}</small><h3>${esc(s.name)}</h3><p>${esc(s.approach)}</p></section>`).join("")}${
        g.status === "active"
          ? `<h3 style="margin-top:25px">当前任务</h3>${list
              .filter((t) => t.goal === g.id)
              .map(taskRow)
              .join(
                "",
              )}${!p ? jobNotice("skills", g.skillJobId) : ""}${!p && !["queued", "running"].includes(busyJob("skills", g.skillJobId)?.status) ? primary("生成任务与能力分支", "skills", g.id) : ""}`
          : ""
      }<div style="margin-top:20px">${skillTags(p?.targetSkillIds || [])}</div><div class="eg-actions">${["active", "paused"].includes(g.status) ? `<button data-act="status" data-id="${g.id}">${g.status === "paused" ? "恢复主线" : "暂停主线"}</button>` : ""}<a class="eg-full-link" href="advanced.html">更多路线与评估操作 ↗</a></div>`;
  } else if (page === "growth") {
    main.innerHTML =
      head(
        "YOUR GROWTH MAP",
        "能力，慢慢长出来",
        "git-branch",
        "一棵树，连接不同的目标。",
      ) + '<div id="personal-tree"></div>';
    const plans = Object.values(state.skillPlans || {});
    if (state.personalTree)
      renderPersonalTree(
        $("#personal-tree"),
        {
          skills: state.personalTree.nodes,
          targetSkillIds: plans.flatMap((p) => p.targetSkillIds),
          tasks: plans.flatMap((p) => p.tasks),
        },
        state.personalTree.goals,
      );
  } else if (page === "journal") {
    const dates = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(day() + "T12:00:00Z");
        d.setUTCDate(d.getUTCDate() - 6 + i);
        return d.toISOString().slice(0, 10);
      }),
      mins = dates.map((d) =>
        state.records
          .filter((r) => r.day === d)
          .reduce((a, r) => a + r.minutes, 0),
      ),
      max = Math.max(...mins, 1);
    main.innerHTML =
      head("LITTLE THINGS ADD UP", "成长留下的痕迹", "notebook-pen") +
      `<div class="eg-kicker">${mins.reduce((a, b) => a + b, 0)}<small> 分钟</small></div><small>最近七天为自己投入的时间</small><div class="eg-week-bars" role="img" aria-label="近七日投入分钟数：${mins.join("、")}">${dates.map((d, i) => `<div class="eg-week-col ${i === 6 ? "today" : ""}"><small>${mins[i] || "—"}</small><span class="eg-week-bar" style="height:${Math.max(3, (mins[i] / max) * 65)}px"></span><small>${d.slice(5)}</small></div>`).join("")}</div><h3 style="margin-top:25px">行动记录</h3>${
        [...state.records]
          .reverse()
          .slice(0, 30)
          .map(
            (r) =>
              `<div class="eg-log">${ic(statIcons[r.stat] || "check")}<div><small>${esc(r.day)}</small><strong style="display:block">${esc(r.name)}</strong><p class="eg-muted">${r.minutes} 分钟 · +${r.gain} XP${r.note ? " · " + esc(r.note) : ""}</p></div></div>`,
          )
          .join("") || empty("今天的第一页，等你写下。")
      }<a class="eg-full-link" href="advanced.html">查看完整记忆与复盘 ↗</a>`;
  } else if (page === "profile") {
    main.innerHTML =
      back("home", "角色首页") +
      head("CHARACTER SHEET", "我的角色", "contact-round") +
      `<div class="eg-statlist">${xpValues()
        .map(
          (v, i) =>
            `<div class="eg-statitem"><div class="eg-row"><span>${ic(statIcons[i])}${names[i]}</span><small>RANK ${1 + Math.floor(v / rules.attributeXpPerRank)} · ${v} XP</small></div><div class="eg-track"><div style="width:${((v % rules.attributeXpPerRank) / rules.attributeXpPerRank) * 100}%"></div></div></div>`,
        )
        .join(
          "",
        )}</div><form data-form="profile"><label for="profile-name">角色名字</label><input id="profile-name" name="name" maxlength="30" value="${esc(state.profile.name)}" required><label for="profile-daily">每天可以留给自己的时间（分钟）</label><input id="profile-daily" name="daily" type="number" min="5" max="1440" value="${state.profile.daily}" required><p class="eg-error" role="alert"></p><button class="eg-primary" type="submit">保存档案</button></form><a class="eg-full-link" href="advanced.html">时间轴、成果评估与完整管理 ↗</a><button class="eg-back" data-act="logout">退出登录</button>`;
  }
  const active =
    page === "task" || page === "goal"
      ? "tasks"
      : page === "profile"
        ? "home"
        : page;
  nav
    .querySelectorAll("[data-page]")
    .forEach((b) =>
      b.setAttribute(
        "aria-current",
        b.dataset.page === active ? "page" : "false",
      ),
    );
  drawAvatar();
  icons();
  bindForms();
}
function bindForms() {
  const f = main.querySelector("form");
  if (!f) return;
  f.onsubmit = async (e) => {
    e.preventDefault();
    if (!f.reportValidity()) return;
    const b = f.querySelector("[type=submit]"),
      err = f.querySelector(".eg-error");
    b.disabled = true;
    err.textContent = "";
    try {
      const v = Object.fromEntries(new FormData(f));
      if (f.dataset.form === "profile") {
        await command({
          type: "profile.update",
          ...state.profile,
          name: v.name,
          daily: Number(v.daily),
        });
        toast("角色档案已保存");
      } else {
        const t = taskList().find((t) => t.key === detailId);
        if (!t || t.done) throw new Error("任务已变化，请返回列表");
        await command({
          type: "action.record",
          plan: t.plan || null,
          goal: t.goal || null,
          name: t.name,
          minutes: Number(v.minutes),
          day: t.day || day(),
          stat: t.stat,
          note: v.note,
          completion: "done",
          ...(t.skillTaskId ? { skillTaskId: t.skillTaskId } : {}),
        });
        toast("投入已记录，经验已同步。");
      }
      render();
    } catch (e) {
      err.textContent = e.message;
    } finally {
      b.disabled = false;
    }
  };
}
function auth(mode = "login", message = "") {
  authMode = mode;
  nav.hidden = true;
  main.innerHTML = `<section class="eg-auth">${head("YOUR EVERYDAY ADVENTURE", mode === "login" ? "继续你的故事" : "创建你的角色", "orbit")}<p class="eg-muted">把想做的事，变成今天的一小步。</p><form><label for="auth-email">邮箱</label><input id="auth-email" name="email" type="email" autocomplete="username" required><label for="auth-password">密码（至少 12 位）</label><input id="auth-password" name="password" type="password" minlength="12" maxlength="128" autocomplete="${mode === "login" ? "current-password" : "new-password"}" required><p class="eg-error inline-error" role="alert">${esc(message)}</p><button class="eg-primary" type="submit">${mode === "login" ? "登录" : "注册"}</button></form><button class="eg-back" data-auth="${mode === "login" ? "register" : "login"}">${mode === "login" ? "还没有账号？注册" : "已有账号，登录"}</button><p class="eg-muted" style="margin-top:25px">规划时，相关目标与情况会发送给配置的模型服务。请勿提交敏感个人资料。</p></section>`;
  icons();
  main.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.currentTarget,
      b = f.querySelector("[type=submit]");
    b.disabled = true;
    try {
      await api("/auth/" + mode, {
        method: "POST",
        body: Object.fromEntries(new FormData(f)),
      });
      user = await api("/auth/me");
      snapshot = "";
      page = "home";
      await refresh();
    } catch (e) {
      f.querySelector(".eg-error").textContent = e.message;
    } finally {
      b.disabled = false;
    }
  };
}
function intakeMessages() {
  const m = state.messages;
  const start = m.findIndex((m) => m.id === intake.start);
  return start < 0 ? [] : m.slice(start);
}
function latestAnswer() {
  return [...intakeMessages()].reverse().find((m) => m.role === "assistant");
}
function openIntake(id) {
  focusBefore = document.activeElement;
  modalOpen = true;
  overlay.hidden = false;
  main.inert = true;
  nav.inert = true;
  $(".eg-toast").hidden = true;
  if (id) intake.goalId = id;
  dialogSignature = "";
  renderIntake(true);
  $(".eg-close")?.focus();
}
function closeIntake() {
  modalOpen = false;
  overlay.hidden = true;
  main.inert = false;
  nav.inert = false;
  focusBefore?.focus({ preventScroll: true });
}
function intakeHeading(title, body) {
  return `<div class="eg-dialog-top"><small class="eg-inline">${ic("compass")}你的下一段冒险</small><button class="eg-close" data-dismiss aria-label="关闭目标输入">${ic("x")}关闭</button></div><h2 id="eg-dialog-title">${esc(title)}</h2>${body}<p class="eg-error" role="alert">${esc(intake.error)}</p>`;
}
function renderIntake(force = false) {
  if (!modalOpen) return;
  const answer = latestAnswer(),
    messages = intakeMessages(),
    latest = messages.at(-1),
    chatJob =
      jobs.find(
        (j) => j.kind === "chat" && j.input?.messageId === latest?.id,
      ) || jobs.find((j) => j.kind === "chat");
  const g = goals().find((g) => g.id === intake.goalId),
    signature = JSON.stringify([
      answer?.id,
      latest?.id,
      chatJob?.status,
      g?.draft?.id,
      g?.status,
      g?.routeJobId,
      jobs.find((j) => j.id === g?.routeJobId)?.status,
      intake.error,
      sending,
    ]);
  if (!force && signature === dialogSignature) return;
  dialogSignature = signature;
  let title,
    body = "";
  if (g) {
    title = g.draft
      ? "这条路线，适合你吗？"
      : g.status === "draft"
        ? "正在准备你的路线"
        : "主线已加入";
    if (g.draft) {
      const r = g.draft.route;
      body = `<h3>${esc(g.title)}</h3><table class="eg-summary"><tbody><tr><th>起点</th><td>${esc(g.base)}</td></tr><tr><th>节奏</th><td>每次 ${r.minutes} 分钟</td></tr><tr><th>方向</th><td>${esc(r.summary)}</td></tr></tbody></table><ol class="eg-steps">${r.stages.map((s) => `<li><h3>${esc(s.name)}</h3><p>${esc(s.exercise)}</p></li>`).join("")}</ol>${primary("确认路线并加入", "confirm-route", g.id)}<p class="eg-muted">确认后会生成具体任务和能力分支。可以先关闭，稍后继续。</p>`;
    } else
      body =
        jobNotice("route", g.routeJobId) +
        `<p class="eg-muted">${g.status === "draft" ? "可以先关闭，生成完成后从主线继续。" : "任务与能力分支会自动更新。"}</p>` +
        (["failed", "cancelled"].includes(
          busyJob("route", g.routeJobId)?.status,
        )
          ? primary("重新生成路线", "retry-route", g.id)
          : "");
  } else if (
    sending ||
    (latest?.role === "user" && ["queued", "running"].includes(chatJob?.status))
  ) {
    title = "正在理解你的目标";
    body = `<div class="eg-status" role="status">${ic("hourglass")}Agent 正在整理下一步…</div><p class="eg-muted">可以先关闭，回复会保留。</p>`;
  } else if (answer && latest?.role === "assistant") {
    const questions = answer.questions || [],
      proposals = (answer.proposals || []).filter(
        (p) => p.command.type === "goal.create",
      );
    title = questions.length
      ? "再了解你一点"
      : proposals.length
        ? "从这个方向开始？"
        : "一起找到下一步";
    body = `${answer.content ? `<p class="eg-muted">${esc(answer.content)}</p>` : ""}`;
    if (questions.length) {
      body += `<form data-intake-form="answers">${questions.map((q, i) => `<section class="eg-question"><h3>${esc(q.question)}</h3><div class="eg-options">${q.options.map((o) => `<button type="button" class="eg-option" data-answer="${i}" data-value="${esc(o)}" aria-pressed="false">${esc(o)}</button>`).join("")}</div><label for="answer-${i}">补充或自己填写</label><textarea id="answer-${i}" name="answer-${i}" rows="1" maxlength="1200" placeholder="也可以直接告诉我…"></textarea></section>`).join("")}<button class="eg-primary" type="submit">继续 ${ic("arrow-right")}</button></form>`;
    } else if (proposals.length) {
      body +=
        proposals
          .map(
            (p, i) =>
              `<section class="eg-quest"><h3>${esc(p.command.title)}</h3><table class="eg-summary"><tbody><tr><th>起点</th><td>${esc(p.command.base)}</td></tr><tr><th>目标</th><td>${esc(p.command.criterion)}</td></tr><tr><th>节奏</th><td>每天 ${p.command.minutes} 分钟</td></tr></tbody></table>${primary("按此生成路线", "proposal", String(i))}</section>`,
          )
          .join("") + inputForm("还有要调整的？", "补充说明");
    } else body += inputForm("补充你的情况", "发送");
  } else {
    title = intake.start ? "继续补充你的目标" : "下一段冒险，是什么？";
    body =
      inputForm(
        intake.start
          ? "你的上一条消息已保存，可补充或重试。"
          : "比如，我想学英文",
        "开始",
      ) +
      (intake.start
        ? `<p class="eg-muted">${esc(chatJob?.error || "")}</p>`
        : '<div class="eg-actions"><button data-example="我想学英文">' +
          ic("languages") +
          ' 学英文</button><button data-example="我想健身">' +
          ic("dumbbell") +
          ' 健身</button><button data-example="我想学做饭">' +
          ic("cooking-pot") +
          " 做饭</button></div>");
  }
  if (intake.start && !g && !sending)
    body += '<button class="eg-back" data-act="fresh">开始另一个目标</button>';
  dialog.innerHTML = intakeHeading(title, body);
  icons();
  bindIntake();
}
function inputForm(placeholder, submit) {
  return `<form data-intake-form="text"><label for="goal-input">说说你想做的事</label><textarea id="goal-input" name="content" rows="3" maxlength="5000" required placeholder="${esc(placeholder)}">${esc(intake.draft)}</textarea><button class="eg-primary" type="submit">${submit} ${ic("arrow-right")}</button></form>`;
}
function bindIntake() {
  dialog.querySelectorAll("[data-answer]").forEach(
    (b) =>
      (b.onclick = () => {
        dialog
          .querySelectorAll(`[data-answer="${b.dataset.answer}"]`)
          .forEach((n) => n.setAttribute("aria-pressed", String(n === b)));
      }),
  );
  const text = dialog.querySelector("[name=content]");
  if (text) text.oninput = () => (intake.draft = text.value);
  dialog.querySelectorAll("[data-example]").forEach(
    (b) =>
      (b.onclick = () => {
        intake.draft = b.dataset.example;
        renderIntake(true);
      }),
  );
  const form = dialog.querySelector("form");
  if (form)
    form.onsubmit = async (e) => {
      e.preventDefault();
      let content;
      if (form.dataset.intakeForm === "answers") {
        const questions = latestAnswer()?.questions || [];
        const answers = questions.map((q, i) => {
          const option = form.querySelector(
            `[data-answer="${i}"][aria-pressed=true]`,
          )?.dataset.value;
          const extra = form.querySelector(`[name="answer-${i}"]`).value.trim();
          return {
            q: q.question,
            a: [option, extra].filter(Boolean).join("；"),
          };
        });
        if (answers.some((a) => !a.a)) {
          $(".eg-dialog .eg-error").textContent =
            "每题选一个选项，或自己填写即可。";
          return;
        }
        content = answers.map((a) => a.q + "\n" + a.a).join("\n\n");
      } else content = form.querySelector("textarea").value.trim();
      if (!content) return;
      await sendIntake(content);
    };
}
async function sendIntake(content) {
  if (sending) return;
  sending = true;
  intake.error = "";
  renderIntake(true);
  try {
    const before = new Set(state.messages.map((m) => m.id));
    await command({ type: "chat.send", content });
    if (!intake.start)
      intake.start = state.messages.find(
        (m) => m.role === "user" && !before.has(m.id),
      )?.id;
    intake.draft = "";
  } catch (e) {
    intake.error = e.message;
    intake.draft = content;
  } finally {
    sending = false;
    renderIntake(true);
  }
}
async function action(name, id) {
  if (name === "logout") {
    await api("/auth/logout", { method: "POST", body: {} });
    state = null;
    user = null;
    intake = { start: null, goalId: null, draft: "", error: "" };
    snapshot = "";
    auth();
    return;
  }
  if (name === "resume") {
    openIntake(id);
    return;
  }
  if (name === "fresh") {
    intake = { start: null, goalId: null, draft: "", error: "" };
    renderIntake(true);
    return;
  }
  if (name === "proposal") {
    if (confirming) return;
    const p = latestAnswer()?.proposals.filter(
      (p) => p.command.type === "goal.create",
    )[Number(id)];
    if (!p) return;
    confirming = true;
    try {
      const r = await command(
        p.command,
        "goal-proposal-" + latestAnswer().id + "-" + id,
      );
      intake.goalId = r.result.goalId;
      intake.error = "";
      renderIntake(true);
    } finally {
      confirming = false;
    }
    return;
  }
  if (name === "confirm-route") {
    if (confirming) return;
    confirming = true;
    try {
      const g = goals().find((g) => g.id === id);
      if (!g?.draft) throw new Error("路线已变更，请刷新后重试");
      await command({ type: "goal.confirm", id, draftId: g.draft.id });
      closeIntake();
      intake = { start: null, goalId: null, draft: "", error: "" };
      go("home");
      toast("主线已加入，正在生成任务与能力分支。");
    } finally {
      confirming = false;
    }
    return;
  }
  if (name === "retry-route") {
    const g = goals().find((g) => g.id === id);
    await command({
      type: "goal.adjust",
      id,
      minutes: g.minutes,
      reason: "按已收集的目标与基础重新生成路线",
    });
    return;
  }
  if (name === "skills") {
    await command({ type: "skills.generate", id });
    return;
  }
  if (name === "status") {
    const g = goals().find((g) => g.id === id);
    await command({
      type: "goal.status",
      id,
      status: g.status === "paused" ? "active" : "paused",
    });
    return;
  }
}
root.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.matches("[data-dismiss]")) {
    closeIntake();
    return;
  }
  if (b.dataset.auth) {
    auth(b.dataset.auth);
    return;
  }
  if (b.classList.contains("eg-add")) {
    if (state) openIntake();
    return;
  }
  if (b.dataset.page || b.dataset.go) {
    go(b.dataset.page || b.dataset.go);
    return;
  }
  if (b.dataset.tab) {
    tab = b.dataset.tab;
    render();
    return;
  }
  if (b.dataset.task) {
    detailId = b.dataset.task;
    go("task");
    return;
  }
  if (b.dataset.goal) {
    goalId = b.dataset.goal;
    go("goal");
    return;
  }
  if (b.dataset.act) {
    b.disabled = true;
    try {
      await action(b.dataset.act, b.dataset.id);
    } catch (e) {
      if (modalOpen) {
        intake.error = e.message;
        renderIntake(true);
      } else toast(e.message);
    } finally {
      b.disabled = false;
    }
  }
});
overlay.addEventListener("click", (e) => {
  if (e.target === overlay) closeIntake();
});
overlay.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeIntake();
    return;
  }
  if (e.key === "Tab") {
    const nodes = [
      ...dialog.querySelectorAll(
        "button:not(:disabled),textarea,input,a[href]",
      ),
    ];
    if (e.shiftKey && document.activeElement === nodes[0]) {
      e.preventDefault();
      nodes.at(-1)?.focus();
    } else if (!e.shiftKey && document.activeElement === nodes.at(-1)) {
      e.preventDefault();
      nodes[0]?.focus();
    }
  }
});
async function boot() {
  nav.hidden = true;
  main.innerHTML = empty("正在读取你的角色…", "orbit");
  icons();
  try {
    user = await api("/auth/me");
    await refresh();
  } catch (e) {
    if (e.status === 401) auth();
    else {
      auth("login", e.message);
    }
  }
}
setInterval(() => {
  if (state && !document.hidden)
    refresh().catch((e) => {
      if (e.status === 401) {
        closeIntake();
        state = null;
        auth("login", "登录已过期，请重新登录。");
      }
    });
}, 3500);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state) refresh().catch(() => {});
});
boot();
