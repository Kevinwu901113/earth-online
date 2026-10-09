import { planningText } from "./planning-copy.js";
import { renderPersonalTree } from "./skill-tree/personal-tree-ui.js";
(() => {
  "use strict";
  const root = document.getElementById("earth-journey"),
    $ = (s) => root.querySelector(s),
    $$ = (s) => [...root.querySelectorAll(s)];
  const esc = (x) =>
    String(x ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const names = window.earthArt.names;
  let state,
    version = 0,
    rules,
    page = "self",
    jobs = [],
    modal = false,
    modalGoalId = null,
    focusBefore,
    user,
    refreshing = false,
    renderedSnapshot,
    poll,
    timelineDay,
    resizing = null,
    moving = null,
    suppressedPlanClick = null;
  const labels = {
    draft: "等待路线",
    active: "进行中",
    paused: "已暂停",
    ended: "已结束",
    completed: "已完成",
    awaiting_external: "等待现实结果",
    planned: "已安排",
    done: "已记录",
    partial: "部分完成",
    cancelled: "已取消",
    expired: "已过期",
    pending: "待评估",
    evaluated: "已评估",
    error: "可重试",
    queued: "排队中",
    running: "处理中",
    succeeded: "已完成",
    failed: "失败",
    passed: "通过",
    not_passed: "暂未通过",
    insufficient: "证据不足",
    offered: "待领取",
    claimed: "已领取",
    recorded: "已记录",
  };
  const label = (s) => labels[s] ?? s;
  const btn = (title, action, id = "", style = "outline") =>
    `<button type="button" class="${style}" data-action="${action}" data-id="${esc(id)}">${esc(title)}</button>`;
  const field = (name, title, value = "", type = "text", extra = "") =>
    `<label>${title}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
  const area = (name, title, value = "", max = 3000) =>
    `<label>${title}<textarea aria-label="${esc(title)}" name="${name}" maxlength="${max}" required>${esc(value)}</textarea></label>`;
  const heading = (a, b) =>
    `<div class="eyebrow">EARTH / ${a}</div><h3>${b}</h3>`;
  const prose = (s) => `<div class="prose">${esc(s)}</div>`;
  function localDate(value) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: state?.profile.timezone ?? "Asia/Shanghai",
    }).format(new Date(value));
  }
  function day() {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: state?.profile.timezone ?? "Asia/Shanghai",
    }).format(new Date());
  }
  function toast(message) {
    $(".notice")?.remove();
    const n = document.createElement("div");
    n.className = "notice";
    n.setAttribute("role", "status");
    n.textContent = message;
    root.append(n);
    setTimeout(() => n.remove(), 6000);
  }
  const api = window.earthApi.request;
  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const [snapshot, nextJobs] = await Promise.all([
          api("/state"),
          api("/jobs"),
        ]);
        const serialized = JSON.stringify([snapshot, nextJobs]);
        const changed = renderedSnapshot !== serialized;
        state = snapshot.state;
        version = snapshot.version;
        rules = snapshot.rules;
        jobs = nextJobs;
        if (changed) {
          renderedSnapshot = serialized;
          render();
          if (modalGoalId) goal(modalGoalId);
        }
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }
  // A form retains its key until a response is received. Retrying a lost response never creates a second action.
  const pendingRequests = new Map();
  async function send(command, key) {
    const fingerprint = JSON.stringify(command);
    key = key ?? pendingRequests.get(fingerprint) ?? crypto.randomUUID();
    pendingRequests.set(fingerprint, key);
    const payload = { expectedVersion: version, command };
    let commandAccepted = false;
    try {
      const r = await api("/commands", { method: "POST", body: payload, key });
      commandAccepted = true;
      await refresh();
      pendingRequests.delete(fingerprint);
      return r;
    } catch (e) {
      if (!commandAccepted && e.status && e.status < 500)
        pendingRequests.delete(fingerprint);
      if (e.status === 409) await refresh();
      throw e;
    }
  }
  function open(html, goalId = null) {
    const updating = goalId && modalGoalId === goalId;
    const focusedAction = updating
      ? document.activeElement?.dataset.action
      : null;
    const scroll = $(".sheet").scrollTop;
    if (!modal) focusBefore = document.activeElement;
    modal = true;
    modalGoalId = goalId;
    $(".sheet-content").innerHTML = html;
    const title = $(".sheet-content h3");
    if (title) title.id = "ep-sheet-title";
    $(".overlay").hidden = false;
    [".main-home", ".journey-page", "nav", ".guide-bar"].forEach(
      (s) => ($(s).inert = true),
    );
    if (updating) {
      $(".sheet").scrollTop = scroll;
      const button = $$(".sheet-content button").find(
        (b) => b.dataset.action === focusedAction,
      );
      (button ?? $(".close")).focus({ preventScroll: true });
    } else $(".close").focus();
  }
  function close() {
    modal = false;
    modalGoalId = null;
    $(".overlay").hidden = true;
    [".main-home", ".journey-page", "nav", ".guide-bar"].forEach(
      (s) => ($(s).inert = false),
    );
    if (focusBefore?.isConnected) focusBefore.focus();
  }
  function form(title, html, build, { after, submit = "保存" } = {}) {
    open(
      heading("JOURNEY", title) +
        `<form>${html}<p class="inline-error" role="alert"></p><button class="solid wide" type="submit">${submit}</button></form>`,
    );
    const f = $(".sheet-content form");
    let key = crypto.randomUUID(),
      last;
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (!f.reportValidity()) return;
      const b = f.querySelector("[type=submit]"),
        err = f.querySelector(".inline-error");
      b.disabled = true;
      err.textContent = "";
      try {
        const values = Object.fromEntries(new FormData(f));
        const cmd = build(values, f),
          encoded = JSON.stringify(cmd);
        if (last && last !== encoded) key = crypto.randomUUID();
        last = encoded;
        const result = await send(cmd, key);
        close();
        toast(result.result?.jobId ? "已保存，正在处理" : "已保存");
        if (after) after(result, values);
      } catch (e) {
        err.textContent = e.message;
      } finally {
        b.disabled = false;
      }
    };
  }
  function auth(mode = "login") {
    open(
      heading("WELCOME", mode === "login" ? "继续你的故事" : "创建你的角色") +
        `<form>${field("email", "邮箱", "", "email", 'required autocomplete="username"')}${field("password", "密码（至少 12 位）", "", "password", `required minlength="12" maxlength="128" autocomplete="${mode === "login" ? "current-password" : "new-password"}"`)}<p class="inline-error" role="alert"></p><button class="solid wide" type="submit">${mode === "login" ? "登录" : "注册"}</button></form><p class="tiny-note">档案、记录与成果会保存在你的账号。规划与评估时，相关内容会发送给配置的模型服务。请勿提交敏感个人资料。</p>${btn(mode === "login" ? "还没有账号？注册" : "已有账号，登录", mode === "login" ? "register" : "login")}`,
    );
    $(".sheet-content form").onsubmit = async (e) => {
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
        close();
        await refresh();
        startPolling();
      } catch (e) {
        f.querySelector(".inline-error").textContent = e.message;
      } finally {
        b.disabled = false;
      }
    };
  }
  function render() {
    if (!state) return;
    updateChatHistory();
    $(".nameplate strong").textContent = state.profile.name;
    $("#ep-level").textContent = String(
      1 + Math.floor(state.levelXp / rules.xpPerLevel),
    ).padStart(2, "0");
    earthArt.update(
      names.map((_, i) =>
        state.records
          .filter((r) => r.stat === i)
          .reduce((a, r) => a + r.gain, 0),
      ),
      rules.attributeXpPerRank,
    );
    $(".home-summary").textContent =
      `${state.goals.filter((g) => !g.deletedAt && g.status === "active" && g.kind !== "side").length} 条主线 · ${state.goals.filter((g) => !g.deletedAt && g.status === "active" && g.kind === "side").length} 条支线 · ${state.records.filter((r) => r.day === day()).length} 条今日记录`;
    $(".storage-status").textContent = "已连接账号 · 数据保存在服务器";
    $(".date>span").textContent = day().slice(5).replace("-", " / ");
    $(".date>div").innerHTML =
      new Intl.DateTimeFormat("en", {
        weekday: "long",
        timeZone: state.profile.timezone,
      })
        .format(new Date())
        .toUpperCase() + "<br><b>自由行动日</b>";
    $(".main-home").hidden = page !== "self";
    $(".journey-page").hidden = page === "self";
    $$("[data-nav]").forEach((b) => {
      b.classList.toggle("active", b.dataset.nav === page);
      b.setAttribute("aria-current", b.dataset.nav === page ? "page" : "false");
    });
    if (page !== "self" && !resizing && !moving) {
      const previousDay = $(".timeline-scroll")?.dataset.day;
      const previousScroll = $(".timeline-scroll")?.scrollTop;
      const expanded = ["block-list", "deleted-goals"].filter(
        (name) => $(`.journey-page .${name}`)?.open,
      );
      $(".journey-page").innerHTML = pages[page]();
      if (page === "skills" && state.personalTree) {
        const plans = Object.values(state.skillPlans ?? {}),
          latest = plans.at(-1);
        renderPersonalTree(
          $("#personal-tree"),
          {
            skills: state.personalTree.nodes,
            targetSkillIds: latest?.targetSkillIds ?? [],
            tasks: latest?.tasks ?? [],
          },
          state.personalTree.goals,
        );
      }

      for (const name of expanded) {
        const section = $(`.journey-page .${name}`);
        if (section) section.open = true;
      }
      const timeline = $(".timeline-scroll");
      if (timeline) {
        const first = dayPlans().find((p) => p.status === "planned");
        timeline.scrollTop =
          previousDay === selectedDay() && previousScroll != null
            ? previousScroll
            : Math.max(0, (first?.start ?? 8 * 60) * TIME_SCALE - 34);
      }
    }
  }
  const TIME_SCALE = 2;
  const selectedDay = () => timelineDay ?? day();
  const questKind = (g) => (g?.kind === "side" ? "支线任务" : "主线任务");
  const clock = (minute) =>
    `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  const stageActions = (stage, minutes) =>
    stage?.actions?.length
      ? stage.actions
      : stage
        ? [{ name: stage.exercise, minutes }]
        : [];
  const dayPlans = () =>
    state.plans
      .filter(
        (p) =>
          p.day === selectedDay() &&
          !["cancelled", "paused"].includes(p.status),
      )
      .sort((a, b) => a.start - b.start);
  function changeDay(offset) {
    const date = new Date(selectedDay() + "T12:00:00Z");
    date.setUTCDate(date.getUTCDate() + offset);
    timelineDay = date.toISOString().slice(0, 10);
    render();
  }
  function freeStart(date, minutes) {
    const planned = state.plans
      .filter((p) => p.day === date && p.status === "planned")
      .sort((a, b) => a.start - b.start);
    for (const initial of [480, 0]) {
      let start = initial;
      for (const p of planned) {
        if (start + minutes <= p.start) break;
        if (start < p.start + p.minutes) start = p.start + p.minutes;
      }
      if (start + minutes <= 1440) return clock(start);
    }
    return "00:00";
  }
  function layoutBlocks(plans) {
    const result = [];
    let group = [],
      groupEnd = -1;
    function finish() {
      const ends = [];
      for (const p of group) {
        let lane = ends.findIndex((end) => end <= p.start);
        if (lane === -1) lane = ends.length;
        ends[lane] = p.start + p.minutes;
        result.push({ plan: p, lane, group });
      }
      for (const x of result.filter((x) => x.group === group))
        x.lanes = ends.length;
      group = [];
    }
    for (const p of plans) {
      if (p.start >= groupEnd && group.length) finish();
      group.push(p);
      groupEnd = Math.max(
        group.length === 1 ? -1 : groupEnd,
        p.start + p.minutes,
      );
    }
    if (group.length) finish();
    return result;
  }
  function resizeLimit(plan) {
    const next = state.plans
      .filter(
        (p) =>
          p.id !== plan.id &&
          p.status === "planned" &&
          p.day === plan.day &&
          p.start >= plan.start,
      )
      .sort((a, b) => a.start - b.start)[0];
    return Math.max(1, (next?.start ?? 1440) - plan.start);
  }
  function dayTimeline() {
    const plans = dayPlans();
    const planned = plans.filter((p) => p.status === "planned");
    const minutes = planned.reduce((sum, p) => sum + p.minutes, 0);
    const editableDay = selectedDay() >= day();
    const ticks = Array.from(
      { length: 25 },
      (_, hour) =>
        `<div class="time-tick" style="top:${hour * 60 * TIME_SCALE}px"><span>${clock(hour * 60)}</span></div>`,
    ).join("");
    const blocks = layoutBlocks(plans)
      .map(({ plan: p, lane, lanes }) => {
        const g = state.goals.find((g) => g.id === p.goal);
        const editable =
          editableDay && p.status === "planned" && canEditPlan(p);
        const short = p.minutes < 25;
        return `<article class="time-block ${g ? (g.kind === "side" ? "side-block" : "main-block") : "free-block"} ${short ? "short-block" : ""} ${p.status !== "planned" ? "finished-block" : ""}" data-plan-id="${p.id}" data-minutes="${p.minutes}" style="top:${p.start * TIME_SCALE}px;height:${p.minutes * TIME_SCALE}px;left:calc(52px + (100% - 62px) * ${lane / lanes});width:calc((100% - 62px) / ${lanes} - 4px)">
        <button type="button" class="block-face" ${editable ? `data-action="editPlan" data-id="${p.id}" data-move-id="${p.id}" aria-describedby="timeline-move-hint" title="拖动移动时间；方向键移动5分钟；点击编辑"` : ""} aria-label="${esc(p.name)}，${p.time} 到 ${clock(p.start + p.minutes)}，${p.minutes} 分钟，${label(p.status)}">
          <span class="block-category">${g ? questKind(g) : "自由行动"}</span><strong>${esc(p.name)}</strong><span class="block-time">${esc(p.time)}–${clock(p.start + p.minutes)} · <b data-block-duration>${p.minutes} 分钟</b></span>
        </button>
        ${editable ? `<button type="button" class="resize-handle" data-resize-id="${p.id}" role="slider" aria-label="调整${esc(p.name)}的时长" aria-valuemin="1" aria-valuemax="${resizeLimit(p)}" aria-valuenow="${p.minutes}" aria-valuetext="${p.minutes} 分钟" title="上下拖动调整时长；方向键调整 5 分钟"><span></span></button>` : ""}
      </article>`;
      })
      .join("");
    const paused = state.plans.filter(
      (p) => p.day === selectedDay() && p.status === "paused",
    );
    return `<section class="timeline-section" aria-label="每日时间块">
      <div class="timeline-date"><button type="button" class="day-arrow" data-action="previousDay" aria-label="前一天">‹</button><label><span>DAY / ${selectedDay() === day() ? "今天" : "一天"}</span><input type="date" data-timeline-day aria-label="时间轴日期" value="${selectedDay()}"></label><button type="button" class="day-arrow" data-action="nextDay" aria-label="后一天">›</button>${btn("今天", "todayTimeline", "", "quiet")}</div>
      <div class="timeline-caption"><div class="timeline-total"><strong>${Math.floor(minutes / 60)}<small>小时</small>${minutes % 60 ? `${minutes % 60}<small>分钟</small>` : ""}</strong><span>${planned.length} 个事件块 · 今天的投入</span></div>${editableDay ? btn("添加事件块", "newPlan", "", "solid") : ""}</div>
      <div class="day-overview" aria-label="全天安排概览"><div class="day-overview-track">${planned.map((p) => `<button type="button" class="overview-block ${state.goals.find((g) => g.id === p.goal)?.kind === "side" ? "side-block" : p.goal ? "main-block" : "free-block"}" data-action="focusPlan" data-id="${p.id}" style="left:${(p.start / 1440) * 100}%;width:${(p.minutes / 1440) * 100}%" aria-label="定位${esc(p.name)}，${p.time}"></button>`).join("")}</div><div class="overview-hours"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div></div>
      <div class="timeline-legend"><span class="main-dot">主线</span><span class="side-dot">支线</span><span class="free-dot">自由行动</span><span>全天 00:00–24:00</span></div>
      <div class="timeline-scroll" data-day="${selectedDay()}" tabindex="0" aria-label="全天时间轴，可上下滚动"><div class="day-timeline" style="height:${1440 * TIME_SCALE + 16}px">${ticks}${blocks}${!plans.length ? '<div class="timeline-empty" style="top:960px"><b>这一天，还留着很多可能</b><p>添加事件块，或从下面的任务安排事项。</p></div>' : ""}</div></div>
      <p class="timeline-hint" id="timeline-move-hint"><span>↕ 拖动整块移动时间</span><span>⇵ 拖动底边调整时长</span></p>
      ${plans.length ? `<details class="block-list"><summary>查看事项与记录 <span>${plans.length}</span></summary>${plans.map(planSummary).join("")}</details>` : ""}
      ${paused.length ? `<details class="task-details"><summary>暂存的事件块（${paused.length}）</summary>${paused.map(planSummary).join("")}</details>` : ""}
    </section>`;
  }
  function planEditReason(p) {
    if (p.day < day()) return "过去的安排只保留记录";
    if (!p.goal) return "";
    const g = state.goals.find((g) => g.id === p.goal);
    if (!g || g.deletedAt) return "关联任务已删除";
    if (g.status === "paused") return "恢复任务后可编辑";
    if (g.status !== "active") return "任务已结束，这个安排可移除";
    if (p.stage !== g.stage || p.revision !== g.revision)
      return "路线已变化，请重新安排";
    return "";
  }
  function canEditPlan(p) {
    return ["planned", "paused"].includes(p.status) && !planEditReason(p);
  }
  function planSummary(p) {
    const g = state.goals.find((g) => g.id === p.goal);
    const editable = canEditPlan(p);
    const unfinished = ["planned", "paused"].includes(p.status);
    const reason = unfinished ? planEditReason(p) : "";
    return `<article class="block-summary" data-summary-id="${p.id}"><span class="summary-stripe ${g ? (g.kind === "side" ? "side-block" : "main-block") : "free-block"}"></span><div><b>${esc(p.name)}</b><small>${p.time}–${clock(p.start + p.minutes)} · ${p.minutes} 分钟 · ${label(p.status)}</small>${reason ? `<small>${reason}</small>` : ""}<div class="block-controls">${editable ? btn("编辑", "editPlan", p.id, "quiet") : ""}${editable && p.status === "planned" && p.day <= day() ? btn("留下记录", "record", p.id, "quiet") : ""}${editable && p.status === "paused" ? btn("恢复", "resumePlan", p.id, "quiet") : ""}${unfinished ? btn("删除事件块", "deletePlan", p.id, "quiet") : ""}</div></div></article>`;
  }
  function actionCards(items, goal, arrange = false) {
    const total = items.reduce((sum, item) => sum + item.minutes, 0);
    return `<div class="action-cards">${items.map((item, index) => `<div class="action-card ${goal.kind === "side" ? "side-action" : ""}"><div><span class="action-number">${String(index + 1).padStart(2, "0")}</span><strong>${esc(item.name)}</strong><span class="action-minutes">${item.minutes} 分钟</span></div><div class="action-duration" aria-hidden="true"><span style="width:${(item.minutes / total) * 100}%"></span></div>${arrange ? btn("安排", "scheduleItem", goal.id + ":" + index, "quiet") : ""}</div>`).join("")}</div>`;
  }
  function questCard(g) {
    const stage = g.draft?.route.stages[0] ?? g.stages[g.stage];
    const finished = ["completed", "ended"].includes(g.status);
    const available = g.status === "active" && !g.draft && stage;
    return `<article class="entry quest-tile ${finished ? "finished-quest" : ""}" data-goal-id="${g.id}"><div class="quest-card-top"><span class="task-kind">${questKind(g)}</span><span class="quest-tag">${g.status === "draft" ? planningTitle(g) : label(g.status)}</span></div><h2>${esc(g.title)}</h2><p>${finished ? (g.status === "completed" ? "已完成，成长与成果已留下记录" : "已结束，已有记录已保留") : esc(stage?.name ?? planningTitle(g))}</p>${finished ? "" : planningNotice(g)}${stage && !finished ? actionCards(stageActions(stage, g.draft?.route.minutes ?? g.minutes), g) : ""}<div class="quest-card-buttons">${available ? btn("安排这些时间块", "scheduleGoal", g.id, "solid") : ""}${btn(g.draft ? "查看路线草案" : "查看目标", "goal", g.id)}${!finished && canRetryPlanning(g) ? btn("重试规划", "adjustGoal", g.id) : ""}${btn("删除任务", "deleteGoal", g.id, "quiet")}</div></article>`;
  }
  function stageCard(stage, g, index, draft, completed = false) {
    const current = !draft && !completed && index === g.stage;
    return `<section class="stage-card"><div class="stage-card-title"><span class="stage-index">${String(index + 1).padStart(2, "0")}</span><div><small>${draft ? "待确认" : index < g.stage || completed ? "已通过" : current ? "当前阶段" : "后续阶段"}</small><h4>${esc(stage.name)}</h4></div></div>${actionCards(stageActions(stage, draft ? g.draft.route.minutes : g.minutes), g, current && g.status === "active")}<details class="task-details"><summary>完成标准与挑战</summary>${prose(stage.criterion)}<p>挑战：${esc(stage.challenge)}</p></details>${stage.steps ? `<details class="task-details"><summary>练习提示</summary>${prose(planningText(stage.steps))}</details>` : ""}</section>`;
  }
  function scheduleGoal(id) {
    const g = state.goals.find((g) => g.id === id);
    if (!g || g.status !== "active") return;
    const blocks = stageActions(g.stages[g.stage], g.minutes);
    const total = blocks.reduce((sum, item) => sum + item.minutes, 0);
    const date = selectedDay() < day() ? day() : selectedDay();
    form(
      "把事项放进一天里",
      `<p class="status">${questKind(g)} · ${esc(g.title)}</p><div class="form-columns">${field("day", "日期", date, "date", `required min="${day()}"`)}${field("time", "开始时间", freeStart(date, total), "time", "required")}</div><div class="schedule-preview" aria-label="事项安排预览"></div><p class="tiny-note">连续安排 ${blocks.length} 个事件块，共 ${total} 分钟。保存后可分别修改或删除。</p>`,
      (v) => ({
        type: "plan.batch",
        goal: id,
        stage: g.stage,
        revision: g.revision,
        day: v.day,
        time: v.time,
        blocks,
      }),
      {
        submit: "加入时间轴",
        after: (_result, values) => {
          timelineDay = values.day;
          page = "quests";
          render();
        },
      },
    );
    const update = () => {
      let start = $(".sheet-content [name=time]")
        .value.split(":")
        .reduce((a, n, i) => a + +n * (i ? 1 : 60), 0);
      $(".schedule-preview").innerHTML = blocks
        .map((b) => {
          const html = `<div class="schedule-preview-item"><div><strong>${esc(b.name)}</strong><small>${clock(start)}–${clock(start + b.minutes)} · ${b.minutes} 分钟</small></div><div class="schedule-preview-block ${g.kind === "side" ? "side-block" : "main-block"}" style="width:${(b.minutes / total) * 100}%;height:12px" aria-hidden="true"></div></div>`;
          start += b.minutes;
          return html;
        })
        .join("");
    };
    $(".sheet-content [name=time]").addEventListener("input", update);
    $(".sheet-content [name=day]").addEventListener("input", update);
    update();
  }

  const pages = {
    skills: () =>
      heading("ABILITIES", "我的技能树") +
      '<p class="prose">不同目标，共用一棵能力树。点击分支探索，滚轮缩放，拖动平移。</p><div id="personal-tree"></div>' +
      state.goals
        .filter(
          (g) =>
            !g.deletedAt && ["draft", "active", "paused"].includes(g.status),
        )
        .map((g) => {
          const plan = state.skillPlans?.[g.id],
            job = jobs.find((j) => j.id === g.skillJobId),
            pending = job && ["queued", "running"].includes(job.status);
          return `<section class="skill-goal"><h4>${esc(g.title)}</h4>${pending ? '<p role="status">正在生成能力分支…</p>' : btn(plan ? "更新能力分支" : "生成能力分支", "generateSkills", g.id)}${job?.status === "failed" ? '<p role="alert">本次生成未完成，可重新生成；已有技能保留。</p>' : ""}${plan ? prose(planningText(plan.summary)) + plan.tasks.map((t) => `<details><summary>${esc(t.name)} · ${t.minutes} 分钟</summary>${prose(planningText(t.purpose))}<ol>${t.actions.map((a) => `<li><strong>${esc(a.name)} · ${a.minutes} 分钟</strong>${prose(planningText(a.detail))}</li>`).join("")}</ol>${t.materialQuestion ? prose(planningText(t.materialQuestion, "开始前，请先准备练习材料。")) : ""}</details>`).join("") : ""}</section>`;
        })
        .join("") +
      (!state.goals.some((g) => !g.deletedAt)
        ? '<p class="prose">先在任务日志建立目标。确认路线后，Agent 会为你拓展对应能力分支。</p>'
        : "") +
      btn("后台任务", "jobs"),

    quests: () =>
      heading("QUESTS", "任务日志") +
      dayTimeline() +
      `<div class="task-section-head"><h2>我的任务</h2><div>${btn("开启新主线", "newGoal", "", "quiet")}${btn("开启支线", "newSideGoal", "", "quiet")}</div></div>` +
      state.goals
        .filter((g) => !g.deletedAt)
        .map(questCard)
        .join("") +
      (!state.goals.some((g) => !g.deletedAt)
        ? '<div class="journal-empty"><b>先说说你想完成什么</b><p>AI 会把任务拆成小事。确认路线后，把事项放进当天的时间轴。</p></div>'
        : "") +
      deletedGoals() +
      btn("后台任务", "jobs", "", "quiet"),
    actions: () =>
      heading("ACTIONS", "今天怎么过") +
      dayTimeline() +
      `<div class="row">${btn("记录投入", "record")}${btn("生活事件", "events")}</div>` +
      `<h4>${esc(selectedDay())} 的投入</h4>` +
      state.records
        .filter((r) => r.day === selectedDay())
        .map(
          (r) =>
            `<div class="entry">${esc(r.name)} · ${r.minutes} 分钟 · +${r.gain} XP${prose(r.note)}</div>`,
        )
        .join("") +
      (selectedDay() === day() ? btn("生成今日复盘", "review") : "") +
      btn("后台任务", "jobs"),
    memory: () =>
      heading("MEMORY", "那些留下来的") +
      `<div class="row">${btn("公开标准", "standards")}${btn("成长记录", "growth")}${btn("后台任务", "jobs")}</div>` +
      state.notes
        .slice()
        .reverse()
        .map(
          (n) =>
            `<article class="entry"><small>${esc(localDate(n.createdAt))} · ${esc(n.source ?? "系统记录")}</small><h3>${esc(n.name)}</h3>${prose(n.body)}${n.correctedAt ? "<small>已由你修正，原始业务证据保持不变</small>" : ""}<div class="row">${btn("修正记忆", "editNote", n.id)}${btn("删除记忆", "deleteNote", n.id)}</div></article>`,
        )
        .join("") +
      (!state.notes.length
        ? '<p class="guide-note">确认路线、提交成果或写下生活记录后，这里会留下记忆。</p>'
        : ""),
  };
  function deletedGoals() {
    const goals = state.goals.filter((g) => g.deletedAt);
    return goals.length
      ? `<details class="deleted-goals"><summary>已删除的任务 <span>${goals.length}</span></summary><p class="tiny-note">已有成长与成果保留。恢复任务后，可重新安排事项。</p>${goals.map((g) => `<div class="deleted-goal"><div><small>${questKind(g)} · ${label(g.status)}</small><strong>${esc(g.title)}</strong></div>${btn("恢复任务", "restoreGoal", g.id, "outline")}</div>`).join("")}</details>`
      : "";
  }
  function newGoal(kind = "main") {
    form(
      kind === "side" ? "开启支线" : "开启新主线",
      `<label>任务类型<select name="kind"><option value="main" ${kind === "main" ? "selected" : ""}>主线任务 · 长期目标</option><option value="side" ${kind === "side" ? "selected" : ""}>支线任务 · 小探索</option></select></label>` +
        field("title", "想完成什么", "", "text", 'required maxlength="120"') +
        area("base", "现在的基础与条件（不了解可以写未知）", "", 1000) +
        field(
          "minutes",
          "每天能投入的分钟数",
          state.profile.daily,
          "number",
          'min="5" max="240" required',
        ) +
        area("criterion", "怎样才算完成？留下什么可判断的成果？", "", 1500) +
        '<label><input name="external" type="checkbox">最终需要录取、证书等外部结果确认</label>',
      (v) => ({
        type: "goal.create",
        kind: v.kind,
        title: v.title,
        base: v.base,
        minutes: +v.minutes,
        criterion: v.criterion,
        requiresExternal: !!v.external,
      }),
      { submit: "生成路线草案" },
    );
  }
  function goal(id) {
    const g = state.goals.find((g) => g.id === id);
    if (!g) return;
    if (g.deletedAt) {
      close();
      return;
    }
    const stage = g.stages[g.stage];
    const stagesCompleted = ["completed", "awaiting_external"].includes(
      g.status,
    );
    open(
      heading("QUEST", esc(g.title)) +
        `<p class="status">${questKind(g)} · ${label(g.status)} · 每天 ${g.minutes} 分钟 · 路线版本 ${g.revision}</p><details class="task-details"><summary>完成条件与起点</summary><h4>完成条件</h4>${prose(g.criterion)}<h4>起点</h4>${prose(g.base)}</details>` +
        planningNotice(g) +
        (g.draft
          ? `<h4>待确认的${g.revision ? "调整" : "路线"}</h4><details class="task-details"><summary>规划说明</summary>${prose(planningText(g.draft.route.summary, "从第一阶段开始，按你的时间逐步练习。"))}</details>${g.draft.route.stages.map((s, i) => stageCard(s, g, g.stage + i, true)).join("")}<p class="tiny-note">确认后可以把事项安排到一天里，再调整时间块。</p>${sources(g.draft.route.sources)}${btn("确认这条路线", "confirmGoal", g.id, "solid")}`
          : "") +
        g.stages
          .map((s, i) => stageCard(s, g, i, false, stagesCompleted))
          .join("") +
        sources(g.sources ?? []) +
        `<div class="row">${g.status === "active" && stage ? btn("安排这些时间块", "scheduleGoal", id, "solid") + btn("安排练习", "goalPlan", id) + btn("提交成果", "submit", id) + btn(g.kind === "side" ? "暂停支线" : "暂停主线", "pauseGoal", id) : g.status === "paused" ? btn(g.kind === "side" ? "恢复支线" : "恢复主线", "resumeGoal", id) : ""}${["draft", "active", "paused"].includes(g.status) ? (planningBusy(g) ? btn("取消本次规划", "cancelPlanning", id) : btn(canRetryPlanning(g) ? "重试规划" : g.draft ? "重新规划" : "调整／重试规划", "adjustGoal", id)) : ""}${g.status === "awaiting_external" ? btn("提交外部证据", "external", id) : ""}${!["ended", "completed"].includes(g.status) ? btn("结束目标", "endGoal", id) : ""}</div>` +
        state.submissions
          .filter((s) => s.goal === id)
          .reverse()
          .map(
            (s) =>
              `<div class="entry"><small>${s.kind === "challenge" ? "挑战" : "练习"} · ${label(s.status)}</small>${prose(s.content)}${s.assessment ? `<b>${label(s.assessment.outcome)}</b>${prose(s.assessment.feedback)}` : ""}${s.status === "error" ? `<div class="assessment-error" role="status">${prose(s.error || "评估未完成；内容已保存，可重试。")}</div>` + btn("重试评估", "retrySubmission", s.id) : ""}</div>`,
          )
          .join("") +
        `<div class="goal-delete-row">${btn("删除任务", "deleteGoal", id, "quiet")}<small>可恢复，保留成长与成果</small></div>` +
        btn("后台处理进度", "jobs"),
      id,
    );
  }
  const planningBusy = (g) =>
    ["queued", "running"].includes(g.planning?.status);
  const canRetryPlanning = (g) =>
    ["failed", "cancelled"].includes(g.planning?.status);
  function planningTitle(g) {
    if (g.draft) return "路线待确认";
    return (
      {
        queued: "规划排队中",
        running: "正在生成路线",
        failed: "路线规划失败",
        cancelled: "路线规划已取消",
      }[g.planning?.status] ?? "尚无可用路线"
    );
  }
  function planningNotice(g) {
    const p = g.planning;
    if (!p || p.status === "succeeded") return "";
    const message =
      p.status === "failed"
        ? (p.error ?? "路线生成失败，可重试。")
        : p.status === "cancelled"
          ? "本次规划已取消，目标内容已保存，可重试。"
          : p.status === "queued"
            ? "规划正在排队，完成后会显示可确认的草案。"
            : "正在生成路线，完成后会显示可确认的草案。";
    return `<div class="planning-status" role="status"><b>${planningTitle(g)}</b>${prose(message)}${g.revision && canRetryPlanning(g) ? "<p>已确认的路线仍然保留。</p>" : ""}</div>`;
  }
  function sourceText(value, max = 150) {
    const text = String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length <= max) return text;
    const sentence = text.match(
      new RegExp(`^.{1,${max - 10}}?[。！？!?]`, "u"),
    )?.[0];
    return sentence ?? `${text.slice(0, max - 1)}…`;
  }
  function sources(items, { empty = true } = {}) {
    const seen = new Set();
    const references = (Array.isArray(items) ? items : []).flatMap((s) => {
      if (!s || typeof s.url !== "string") return [];
      try {
        const url = new URL(s.url);
        if (!["http:", "https:"].includes(url.protocol) || seen.has(url.href))
          return [];
        seen.add(url.href);
        return [
          {
            ...s,
            note: planningText(s.note),
            url: url.href,
            domain: url.hostname.replace(/^www\./, ""),
          },
        ];
      } catch {
        return [];
      }
    });
    if (!references.length) return "";
    return `<details class="source-disclosure" data-chat-details="sources"><summary><span>规划依据</span><small>${references.length} 条来源</small></summary><div class="source-list">${references.map((s) => `<article class="source-card"><a class="source-title" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" title="${esc(s.title ?? s.domain)}">${esc(sourceText(s.title || s.domain, 90))}<span aria-hidden="true"> ↗</span></a><div class="source-meta"><span>${esc(s.domain)}</span>${s.retrievedAt && Number.isFinite(Date.parse(s.retrievedAt)) ? `<time datetime="${esc(s.retrievedAt)}">检索 ${esc(localDate(s.retrievedAt))}</time>` : ""}</div>${s.note ? `<p class="source-reason">${esc(sourceText(planningText(s.note)))}</p>` : ""}</article>`).join("")}</div></details>`;
  }
  function goalOptions(value) {
    return `<label>关联任务<select name="goal"><option value="">自由行动</option>${state.goals
      .filter((g) => !g.deletedAt && g.status === "active")
      .map(
        (g) =>
          `<option value="${g.id}" ${value === g.id ? "selected" : ""}>${esc(g.title)}</option>`,
      )
      .join("")}</select></label>`;
  }
  function statOptions(value = 0) {
    return `<label>投入方向<select name="stat">${names.map((n, i) => `<option value="${i}" ${+value === i ? "selected" : ""}>${n}</option>`).join("")}</select></label>`;
  }
  function planForm(goalId, item, planId) {
    const p = state.plans.find((p) => p.id === planId);
    const g = state.goals.find((g) => g.id === (p?.goal ?? goalId));
    const date = p?.day ?? selectedDay();
    const minutes = item?.minutes ?? g?.minutes ?? 20;
    form(
      p ? "编辑事件块" : "添加事件块",
      (p
        ? `<p class="status">${esc(g?.title ?? "自由行动")} · ${label(p.status)}</p>`
        : goalOptions(goalId)) +
        field(
          "name",
          "行动",
          p?.name ?? item?.name ?? g?.stages[g.stage]?.exercise ?? "",
          "text",
          'required maxlength="200"',
        ) +
        `<div class="form-columns">${field("day", "日期", date, "date", `required min="${day()}"`)}${field("time", "开始时间", p?.time ?? freeStart(date, minutes), "time", "required")}</div>` +
        field(
          "minutes",
          "计划分钟",
          p?.minutes ?? minutes,
          "number",
          'min="1" max="1440" required',
        ) +
        (p ? "" : statOptions(g?.stat)) +
        '<p class="tiny-note">块的长度表示占用的时间，保存时会检查与其他安排的冲突。</p>',
      (v) =>
        p
          ? {
              type: "plan.update",
              id: p.id,
              name: v.name,
              minutes: +v.minutes,
              day: v.day,
              time: v.time,
            }
          : {
              type: "plan.create",
              goal: v.goal || null,
              name: v.name,
              minutes: +v.minutes,
              day: v.day,
              time: v.time,
              stat: +v.stat,
            },
      {
        after: (_result, values) => {
          timelineDay = values.day;
          render();
        },
      },
    );
    const minutesInput = $(".sheet-content [name=minutes]");
    const preview = document.createElement("div");
    preview.className = "duration-preview";
    preview.innerHTML = "<span></span><small></small>";
    minutesInput.parentElement.after(preview);
    const update = () => {
      const n = +minutesInput.value;
      preview.querySelector("span").style.width =
        `${Math.max(1, Math.min(100, (n / 120) * 100))}%`;
      preview.querySelector("small").textContent = `${n || 0} 分钟`;
    };
    minutesInput.addEventListener("input", update);
    update();
  }
  function recordForm(planId) {
    const p = state.plans.find((p) => p.id === planId);
    form(
      "留下这次投入",
      (p
        ? `<p>${esc(p.name)} · ${p.day}</p>`
        : field("name", "做了什么", "", "text", 'required maxlength="200"') +
          goalOptions() +
          field("day", "日期", day(), "date", "required") +
          statOptions()) +
        field(
          "minutes",
          "实际投入分钟",
          p?.minutes ?? 20,
          "number",
          'min="0" max="1440" required',
        ) +
        `<label>完成情况<select name="completion"><option value="done">完成本次行动</option><option value="partial">做了一部分</option><option value="rest">休息，不计 XP</option></select></label>` +
        area("note", "留下过程、收获或遇到的问题（也可以写无）") +
        '<p class="tiny-note">投入增加成长记录，不直接证明能力或完成主线。</p>',
      (v) => ({
        type: "action.record",
        plan: p?.id ?? null,
        goal: p?.goal ?? (v.goal || null),
        name: p?.name ?? v.name,
        minutes: +v.minutes,
        day: p?.day ?? v.day,
        stat: p?.stat ?? +v.stat,
        note: v.note,
        completion: v.completion,
      }),
    );
  }
  function profile() {
    form(
      "角色档案",
      field(
        "name",
        "怎么称呼你",
        state.profile.name,
        "text",
        'required maxlength="30"',
      ) +
        field(
          "daily",
          "每天可用分钟",
          state.profile.daily,
          "number",
          'required min="5" max="1440"',
        ) +
        field("timezone", "时区", state.profile.timezone, "text", "required") +
        area(
          "preferences",
          "偏好与限制（可填未知）",
          state.profile.preferences || "未知",
          2000,
        ) +
        `<p class="tiny-note">画像来自你填写的内容，可随时修正。</p><div class="row"><a class="outline" href="/api/export" download>导出我的数据</a>${btn("退出登录", "logout")}</div>`,
      (v) => ({
        type: "profile.update",
        name: v.name,
        daily: +v.daily,
        timezone: v.timezone,
        preferences: v.preferences,
      }),
    );
  }
  let chatDraft = "",
    chatDraftRevision = 0;
  function rememberChatDraft() {
    const input = $(".chat-composer [name=content]");
    if (input && input.value !== chatDraft) {
      chatDraft = input.value;
      chatDraftRevision++;
    }
  }
  function chatHistory() {
    const messages = state.messages.slice(-20);
    const busy = jobs.some(
      (j) => j.kind === "chat" && ["queued", "running"].includes(j.status),
    );
    const latestChat = jobs.find((j) => j.kind === "chat");
    return (
      (messages.length
        ? messages
            .map((m) => {
              if (m.role === "user")
                return `<article class="chat-message chat-user" data-message-id="${esc(m.id)}"><small>你说</small>${prose(m.content)}</article>`;
              const guidance = m.guidance;
              const proposals = m.proposals ?? [];
              const structured = guidance || proposals.length;
              const reply = [
                planningText(m.content),
                ...(m.questions ?? []).map(
                  (q) =>
                    `${q.question}\n${q.options.join(" / ")}\n也可以直接补充。`,
                ),
              ]
                .filter(Boolean)
                .join("\n\n");
              return `<article class="chat-message chat-assistant" data-message-id="${esc(m.id)}"><div class="chat-speaker"><span>✦</span><small>管家的建议</small></div>${guidance ? guidanceView(guidance) : `<div class="chat-answer"><p>${esc(shortChatText(reply))}</p></div>`}${structured ? `<details class="chat-explanation" data-chat-details="reply"><summary>查看管家的说明</summary>${prose(reply)}</details>` : reply.length > 160 ? `<details class="chat-explanation" data-chat-details="reply"><summary>展开完整回复</summary>${prose(reply)}</details>` : ""}${proposals.length ? `<div class="chat-proposals"><div class="chat-section-label">可以这样开始 <span>确认后才会保存</span></div>${proposals.map((p, i) => proposalCard(p, m.id + ":" + i, m.at)).join("")}</div>` : guidance ? '<p class="chat-suggestion-note">以上是行动建议。继续告诉管家你的目标与可用时间，可以生成任务或日程提案。</p>' : ""}</article>`;
            })
            .join("")
        : '<div class="chat-welcome"><span>✦</span><h4>把你的情况说给我听</h4><p>你想完成什么？每天能留出多久？<br>我会把下一步拆成看得见的小事。</p><div><span>主线任务</span><span>具体事项</span><span>一天的安排</span></div></div>') +
      (busy
        ? '<div class="chat-processing" role="status"><span class="chat-pulse"></span><div><b>正在整理下一步</b><small>回复会自动显示，你可以继续补充。</small></div></div>'
        : latestChat?.status === "failed"
          ? '<div class="chat-processing chat-failed" role="status"><div><b>这次回复未完成</b><small>你的消息已经保存，可以重新发送或查看后台进度。</small></div></div>'
          : "")
    );
  }
  function shortChatText(value) {
    const text = value
      .replace(/^[#*>\s]+/gm, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length <= 160) return text;
    const first = text.match(/^.{1,140}?[。！？!?](?:\s|$)?/u)?.[0];
    return first ?? `${text.slice(0, 140)}…`;
  }
  function chatKind(kind) {
    return { main: "主线", side: "支线", free: "自由行动" }[kind] ?? "主线";
  }
  function chatDuration(minutes, total = 60, kind = "main") {
    const width = Math.max(
      0,
      Math.min(100, (minutes / Math.max(total, 1)) * 100),
    );
    return `<div class="chat-duration ${kind}" aria-hidden="true"><span style="width:${width}%"></span></div>`;
  }
  function guidanceView(g) {
    const total = g.steps.reduce((sum, s) => sum + s.minutes, 0);
    return `<section class="chat-guidance" aria-label="可视化行动建议"><div class="guidance-heading"><div><small>下一步 · 建议</small><h4>${esc(g.title)}</h4></div><span>${total}<small>分钟</small></span></div><p>${esc(planningText(g.summary))}</p><ol class="guidance-steps">${g.steps.map((s, i) => `<li class="guidance-step ${s.kind}"><div class="guidance-step-top"><span class="guidance-number">${String(i + 1).padStart(2, "0")}</span><span class="chat-kind ${s.kind}">${chatKind(s.kind)}</span><span class="guidance-minutes">${s.minutes} 分钟</span></div><b>${esc(s.title)}</b>${chatDuration(s.minutes, total, s.kind)}${s.detail ? `<details class="chat-step-detail" data-chat-details="step-${i}"><summary>怎么做</summary><p>${esc(planningText(s.detail))}</p></details>` : ""}</li>`).join("")}</ol><div class="guidance-footnote"><span>块的长度表示建议时长</span><span>尚未安排</span></div>${sources(g.sources ?? [], { empty: false })}</section>`;
  }
  function proposalState(c, at) {
    const g = state.goals.find((g) => g.id === (c.goal ?? c.id));
    const p = state.plans.find((p) => p.id === c.id);
    if (c.type === "goal.create") {
      const existing = state.goals.find(
        (g) =>
          g.title === c.title &&
          g.base === c.base &&
          g.criterion === c.criterion &&
          g.minutes === c.minutes &&
          g.requiresExternal === c.requiresExternal &&
          (g.kind ?? "main") === (c.kind ?? "main") &&
          g.createdAt >= at &&
          !g.deletedAt,
      );
      if (existing)
        return { applied: true, goal: existing, text: "任务已创建" };
    }
    if (c.type === "goal.delete" && g?.deletedAt)
      return { applied: true, text: "任务已删除" };
    if (c.type === "goal.restore") {
      if (!g) return { unavailable: true, text: "这个任务已不存在" };
      if (!g.deletedAt) return { applied: true, goal: g, text: "任务已恢复" };
    }
    if (
      ["goal.adjust", "goal.status", "goal.delete", "plan.batch"].includes(
        c.type,
      ) ||
      (c.type === "plan.create" && c.goal)
    ) {
      if (!g || g.deletedAt)
        return { unavailable: true, text: "关联任务已删除" };
      if (c.type === "goal.status" && g.status === c.status)
        return { applied: true, goal: g, text: "已应用" };
    }
    if (c.type === "plan.batch") {
      let start = c.time
        .split(":")
        .reduce((sum, n, i) => sum + +n * (i ? 1 : 60), 0);
      const existing = c.blocks.every((b) => {
        const match = state.plans.some(
          (p) =>
            p.goal === c.goal &&
            p.day === c.day &&
            p.start === start &&
            p.name === b.name &&
            p.minutes === b.minutes &&
            p.stage === c.stage &&
            p.revision === c.revision &&
            p.createdAt >= at &&
            p.status !== "cancelled",
        );
        start += b.minutes;
        return match;
      });
      if (existing) return { applied: true, day: c.day, text: "已加入时间轴" };
      if (
        g.status !== "active" ||
        g.stage !== c.stage ||
        g.revision !== c.revision
      )
        return { unavailable: true, text: "任务路线已变化，请重新安排" };
    }
    if (c.type === "plan.create") {
      const existing = state.plans.some(
        (p) =>
          p.goal === c.goal &&
          p.name === c.name &&
          p.day === c.day &&
          p.time === c.time &&
          p.minutes === c.minutes &&
          p.createdAt >= at &&
          p.status !== "cancelled",
      );
      if (existing) return { applied: true, day: c.day, text: "已加入时间轴" };
    }
    if (["plan.update", "plan.status"].includes(c.type)) {
      if (!p) return { unavailable: true, text: "这个事件块已不存在" };
      if (
        (c.type === "plan.status" && p.status === c.status) ||
        (c.type === "plan.update" &&
          ["name", "day", "time", "minutes"].every((key) => p[key] === c[key]))
      )
        return { applied: true, day: p.day, text: "已应用" };
      if (c.type === "plan.update" && !canEditPlan(p))
        return {
          unavailable: true,
          text: planEditReason(p) || "这个事件块已结束",
        };
    }
    if (
      ["plan.create", "plan.update", "plan.batch"].includes(c.type) &&
      c.day < day()
    )
      return { unavailable: true, text: "这个安排日期已过去，请重新规划" };
    return {};
  }
  function proposalButtonLabel(c) {
    return (
      {
        "goal.create": `开始规划这条${chatKind(c.kind)}`,
        "goal.adjust": "生成调整草案",
        "goal.delete": "删除这个任务",
        "goal.restore": "恢复这个任务",
        "goal.status": "应用任务调整",
        "plan.batch": "放入任务日志",
        "plan.create": "放入任务日志",
        "plan.update": "调整这个事件块",
        "plan.status":
          c.status === "cancelled" ? "移除这个事件块" : "应用事件调整",
        "review.create": "生成这天的复盘",
        "standard.propose": "提交标准建议",
      }[c.type] ?? "查看并确认"
    );
  }
  function proposalCard(p, id = null, at = "") {
    const c = p.command;
    const g = state.goals.find(
      (g) =>
        g.id === (c.goal ?? c.id) &&
        (!g.deletedAt || c.type === "goal.restore"),
    );
    const planned = state.plans.find((plan) => plan.id === c.id);
    const kind = c.kind ?? g?.kind ?? "free";
    const status = id ? proposalState(c, at) : {};
    let title = p.label,
      meta = "待确认",
      body = "";
    switch (c.type) {
      case "goal.create":
        title = c.title;
        meta = `${chatKind(c.kind)}任务 · 每天 ${c.minutes} 分钟`;
        body = `${chatDuration(c.minutes, state.profile.daily, c.kind)}<details class="chat-proposal-detail" data-chat-details="proposal-${id}"><summary>起点与完成条件</summary><small>当前基础</small>${prose(c.base)}<small>完成条件</small>${prose(c.criterion)}${c.requiresExternal ? "<p>需要现实中的结果作为证据。</p>" : ""}</details>`;
        break;
      case "plan.batch": {
        title = g?.title ?? "安排这些小事";
        const total = c.blocks.reduce((sum, b) => sum + b.minutes, 0);
        let start = c.time
          .split(":")
          .reduce((sum, n, i) => sum + +n * (i ? 1 : 60), 0);
        meta = `${c.day} · ${c.time}–${clock(start + total)} · ${total} 分钟`;
        body = `<div class="chat-schedule" aria-label="提议的连续事件块">${c.blocks
          .map((b) => {
            const row = `<div class="chat-schedule-item ${kind}"><small>${clock(start)}–${clock(start + b.minutes)}</small><div><b>${esc(b.name)}</b><span>${b.minutes} 分钟</span>${chatDuration(b.minutes, total, kind)}</div></div>`;
            start += b.minutes;
            return row;
          })
          .join("")}</div>`;
        break;
      }
      case "plan.create":
      case "plan.update":
        title = c.name;
        meta = `${c.day} · ${c.time} · ${c.minutes} 分钟`;
        body = chatDuration(c.minutes, state.profile.daily, kind);
        if (c.type === "plan.update" && planned)
          body += `<p class="chat-change-from">原安排：${esc(planned.day)} ${esc(planned.time)} · ${planned.minutes} 分钟</p>`;
        break;
      case "goal.adjust":
        title = g?.title ?? "调整任务";
        meta = `调整路线 · 每天 ${c.minutes} 分钟`;
        body = `<p>${esc(shortChatText(c.reason))}</p><details class="chat-proposal-detail" data-chat-details="proposal-${id}"><summary>调整原因</summary>${prose(c.reason)}</details>`;
        break;
      case "goal.status":
        title = g?.title ?? "调整任务状态";
        meta = `${g ? label(g.status) : "当前状态"} → ${label(c.status)}`;
        break;
      case "goal.delete":
        title = g?.title ?? "删除任务";
        meta = "从任务日志移除 · 可恢复";
        body = "<p>已有成长与成果会保留。</p>";
        break;
      case "goal.restore":
        title = g?.title ?? "恢复任务";
        meta = "重新显示在任务日志中";
        body = "<p>恢复后可以继续查看原有路线与成果。</p>";
        break;
      case "plan.status":
        title = planned?.name ?? "调整事件块";
        meta = `${planned ? label(planned.status) : "当前状态"} → ${label(c.status)}`;
        break;
      case "review.create":
        title = "回看这一天";
        meta = c.day;
        body = "<p>根据已经留下的记录生成复盘。</p>";
        break;
      case "standard.propose":
        title = c.name;
        meta = "标准建议 · 待审核";
        body = `<details class="chat-proposal-detail" data-chat-details="proposal-${id}"><summary>适用范围与标准</summary>${prose(c.scope)}${prose(c.criteria)}</details>`;
        break;
    }
    const footer = !id
      ? ""
      : status.applied
        ? `<div class="chat-proposal-status"><span>✓ ${status.text}</span>${status.goal ? btn("查看任务", "goal", status.goal.id, "quiet") : status.day ? btn("查看这一天", "chatSchedule", status.day, "quiet") : ""}</div>`
        : status.unavailable
          ? `<div class="chat-proposal-status">${esc(status.text)}</div>`
          : btn(proposalButtonLabel(c), "proposal", id, "solid");
    return `<article class="chat-proposal ${kind}" data-proposal-type="${esc(c.type)}"><div class="chat-proposal-top"><span>${esc(meta)}</span>${id ? "<small>提案</small>" : ""}</div><h4>${esc(title)}</h4>${body}${footer}</article>`;
  }
  function updateChatHistory(scrollToEnd = false) {
    const history = $(".chat-history");
    if (!history || !state) return;
    const signature = JSON.stringify([
      state.messages.slice(-20),
      jobs.filter((j) => j.kind === "chat").map((j) => [j.id, j.status]),
      state.goals.map((g) => [
        g.id,
        g.status,
        g.deletedAt,
        g.stage,
        g.revision,
      ]),
      state.plans.map((p) => [
        p.id,
        p.name,
        p.day,
        p.time,
        p.minutes,
        p.status,
      ]),
    ]);
    if (history.chatSnapshot === signature && !scrollToEnd) return;
    const sheet = $(".sheet");
    const focused = document.activeElement;
    const composerFocused = focused?.matches(".chat-composer textarea");
    const focusTop = composerFocused
      ? focused.getBoundingClientRect().top
      : null;
    const wasInHistory = history.contains(focused);
    const action = wasInHistory ? focused.dataset.action : null;
    const actionId = focused?.dataset.id;
    const focusedDetail =
      wasInHistory && focused.tagName === "SUMMARY"
        ? `${focused.closest("[data-message-id]")?.dataset.messageId}:${focused.parentElement.dataset.chatDetails}`
        : null;
    const expanded = new Set(
      [...history.querySelectorAll("details[open]")].map(
        (d) =>
          `${d.closest("[data-message-id]")?.dataset.messageId}:${d.dataset.chatDetails}`,
      ),
    );
    history.innerHTML = chatHistory();
    history.chatSnapshot = signature;
    history.querySelectorAll("details").forEach((d) => {
      d.open = expanded.has(
        `${d.closest("[data-message-id]")?.dataset.messageId}:${d.dataset.chatDetails}`,
      );
    });
    if (wasInHistory) {
      const replacement = action
        ? [...history.querySelectorAll("button[data-action]")].find(
            (b) => b.dataset.action === action && b.dataset.id === actionId,
          )
        : focusedDetail
          ? [...history.querySelectorAll("details")]
              .find(
                (d) =>
                  `${d.closest("[data-message-id]")?.dataset.messageId}:${d.dataset.chatDetails}` ===
                  focusedDetail,
              )
              ?.querySelector("summary")
          : null;
      (replacement ?? $(".close")).focus({ preventScroll: true });
    }
    if (composerFocused)
      sheet.scrollTop += focused.getBoundingClientRect().top - focusTop;
    else if (scrollToEnd)
      $(".chat-composer")?.scrollIntoView({ block: "end", behavior: "smooth" });
  }
  function chat() {
    rememberChatDraft();
    open(
      `<div class="chat-header">${heading("GUIDE", "和管家聊聊")}<p>说清你的情况，一起把下一步画出来。</p></div><div class="chat-history" aria-label="对话与行动建议"></div><form class="chat-composer">${area("content", "说说你的目标、时间和目前的情况", chatDraft, 5000)}<p class="inline-error" role="alert"></p><button class="solid wide" type="submit">发送</button></form><div class="chat-footer">${btn("刷新对话", "chat", "", "quiet")}${btn("后台任务", "jobs", "", "quiet")}</div>`,
    );
    updateChatHistory();
    const f = $(".sheet-content form");
    const input = f.querySelector("[name=content]");
    input.addEventListener("input", () => {
      chatDraft = input.value;
      chatDraftRevision++;
    });
    let key = crypto.randomUUID(),
      lastContent;
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (!f.reportValidity()) return;
      const b = f.querySelector("[type=submit]");
      const content = input.value;
      rememberChatDraft();
      const submittedDraftRevision = chatDraftRevision;
      if (lastContent && lastContent !== content) key = crypto.randomUUID();
      lastContent = content;
      b.disabled = true;
      f.querySelector(".inline-error").textContent = "";
      try {
        await send({ type: "chat.send", content }, key);
        key = crypto.randomUUID();
        if (f.isConnected) rememberChatDraft();
        if (chatDraftRevision === submittedDraftRevision) {
          chatDraft = "";
          chatDraftRevision++;
          if (f.isConnected) input.value = "";
        }
        updateChatHistory(true);
        toast("已收到，正在整理行动建议");
      } catch (e) {
        f.querySelector(".inline-error").textContent = e.message;
      } finally {
        b.disabled = false;
      }
    };
  }
  function showJobs() {
    open(
      heading("PROGRESS", "后台任务") +
        jobs
          .map(
            (j) =>
              `<div class="job"><b>${{ route: "路线规划", assessment: "成果评估", chat: "管家回复", review: "每日复盘" }[j.kind]}</b> · ${label(j.status)}${j.error ? prose(j.error) : ""}${["queued", "running"].includes(j.status) ? btn("取消", "cancelJob", j.id) : ""}</div>`,
          )
          .join("") +
        btn("刷新进度", "jobs") +
        '<p class="tiny-note">失败不会扣除成长或丢失提交内容。回到目标可重试规划或评估，复盘和对话可重新发起。</p>',
    );
  }
  function events() {
    open(
      heading("LIFE", "生活里发生的事") +
        btn("记一件事", "newEvent") +
        state.events
          .slice()
          .reverse()
          .map(
            (e) =>
              `<article class="entry"><small>${label(e.status)} · ${esc(localDate(e.occurredAt))}</small>${prose(e.content)}${e.claimBy ? `<p class="tiny-note">领取期限 ${esc(e.claimBy)}<br>执行期限 ${esc(e.executeBy)}</p>` : ""}${e.status === "offered" ? btn("领取机会", "claimEvent", e.id) : e.status === "claimed" ? btn("记录执行", "completeEvent", e.id) : ""}</article>`,
          )
          .join(""),
    );
  }
  const actions = {
    generateSkills: async (id) => {
      await send({ type: "skills.generate", id });
      toast("正在生成能力分支");
    },

    login: () => auth(),
    register: () => auth("register"),
    newGoal: () => newGoal(),
    newSideGoal: () => newGoal("side"),
    goal,
    newPlan: () => planForm(),
    goalPlan: (id) => planForm(id),
    editPlan: (id) => planForm(null, null, id),
    scheduleGoal,
    scheduleItem: (key) => {
      const [id, index] = key.split(":");
      const g = state.goals.find((g) => g.id === id);
      if (g) planForm(id, stageActions(g.stages[g.stage], g.minutes)[+index]);
    },
    previousDay: () => changeDay(-1),
    nextDay: () => changeDay(1),
    todayTimeline: () => {
      timelineDay = day();
      render();
    },
    deletePlan: async (id) => {
      await send({ type: "plan.status", id, status: "cancelled" });
      toast("事件块已移除");
    },
    focusPlan: (id) => {
      const p = state.plans.find((p) => p.id === id);
      if (p && $(".timeline-scroll")) {
        $(".timeline-scroll").scrollTo({
          top: Math.max(0, p.start * TIME_SCALE - 34),
          behavior: "smooth",
        });
        $(`[data-move-id="${id}"]`)?.focus({ preventScroll: true });
      }
    },
    deleteGoal: async (id) => {
      await send({ type: "goal.delete", id });
      if (modalGoalId === id) close();
      toast("任务已删除，可在已删除的任务中恢复");
    },
    restoreGoal: async (id) => {
      await send({ type: "goal.restore", id });
      toast("任务已恢复");
    },
    record: recordForm,
    profile,
    chat: async () => {
      await refresh();
      chat();
    },
    jobs: async () => {
      await refresh();
      showJobs();
    },
    events,
    confirmGoal: async (id) => {
      const g = state.goals.find((g) => g.id === id);
      await send({ type: "goal.confirm", id, draftId: g.draft.id });
      goal(id);
    },
    pauseGoal: async (id) => {
      await send({ type: "goal.status", id, status: "paused" });
      goal(id);
    },
    resumeGoal: async (id) => {
      await send({ type: "goal.status", id, status: "active" });
      goal(id);
    },
    endGoal: (id) =>
      confirm("结束目标", "结束后保留已有投入与证据，不会标记为达成。", () =>
        send({ type: "goal.status", id, status: "ended" }),
      ),
    adjustGoal: (id) => {
      const g = state.goals.find((g) => g.id === id);
      form(
        "调整路线",
        area("reason", "变化与原因", "希望重新规划当前未完成的部分", 1500) +
          field(
            "minutes",
            "每天可用分钟",
            g.planning?.minutes ?? g.minutes,
            "number",
            'min="5" max="240" required',
          ),
        (v) => ({
          type: "goal.adjust",
          id,
          reason: v.reason,
          minutes: +v.minutes,
        }),
        { submit: "生成新草案", after: () => goal(id) },
      );
    },
    submit: (id) =>
      form(
        "提交一份真实成果",
        `<label>用途<select name="kind"><option value="practice">练习反馈，不推进阶段</option><option value="challenge">独立挑战，按固定标准评估</option></select></label>` +
          area("content", "粘贴文字成果与必要说明", "", 12000) +
          '<label><input name="help" type="checkbox">本次挑战使用了他人或 AI 的帮助</label><p class="tiny-note">目前只评估文字。链接、音频、视频与现实证书会保留为待核实证据，不会假装验证。</p>',
        (v) => ({
          type: "submission.create",
          goal: id,
          kind: v.kind,
          content: v.content,
          helpUsed: !!v.help,
        }),
        { submit: "提交评估" },
      ),
    external: (id) =>
      form(
        "提交外部结果",
        area("content", "提供证据内容与核实线索", "", 6000) +
          "<p>提交后待运营核实，核实前不会标为完成。</p>",
        (v) => ({ type: "goal.external", id, content: v.content }),
      ),
    retrySubmission: async (id) => {
      await send({ type: "submission.retry", id });
      toast("已重新排队");
    },
    pausePlan: async (id) => {
      await send({ type: "plan.status", id, status: "paused" });
    },
    resumePlan: async (id) => {
      await send({ type: "plan.status", id, status: "planned" });
    },
    cancelPlan: (id) =>
      confirm("取消安排", "保留历史记录，不扣成长。", () =>
        send({ type: "plan.status", id, status: "cancelled" }),
      ),
    review: async () => {
      await send({ type: "review.create", day: day() });
      toast("正在生成复盘，可在记忆与后台任务查看");
    },
    editNote: (id) =>
      form(
        "修正这条记忆",
        area(
          "body",
          "修正后的内容",
          state.notes.find((n) => n.id === id).body,
          4000,
        ),
        (v) => ({ type: "memory.correct", id, body: v.body }),
      ),
    deleteNote: (id) =>
      confirm(
        "删除这条记忆",
        "删除摘要；原始行动、提交成果与成长账本仍会保留。",
        () => send({ type: "memory.delete", id }),
      ),
    cancelJob: async (id) => {
      await api("/jobs/" + id + "/cancel", { method: "POST", body: {} });
      await refresh();
      showJobs();
    },
    cancelPlanning: async (id) => {
      const g = state.goals.find((g) => g.id === id);
      await api("/jobs/" + g.planning.jobId + "/cancel", {
        method: "POST",
        body: {},
      });
      await refresh();
      goal(id);
    },
    logout: async () => {
      await api("/auth/logout", { method: "POST", body: {} });
      clearInterval(poll);
      state = null;
      user = null;
      location.reload();
    },
    newEvent: () =>
      form(
        "记一件生活事件",
        area("content", "发生了什么") +
          `<label>类型<select name="kind"><option value="note">生活记录</option><option value="completed">已发生的活动（不重复发 XP）</option><option value="opportunity">有期限的机会</option></select></label>` +
          field("claimBy", "领取期限（机会必填）", "", "datetime-local") +
          field("executeBy", "执行期限（机会必填）", "", "datetime-local"),
        (v) => ({
          type: "event.create",
          externalId: eventKey,
          content: v.content,
          occurredAt: eventTime,
          kind: v.kind,
          ...(v.claimBy ? { claimBy: new Date(v.claimBy).toISOString() } : {}),
          ...(v.executeBy
            ? { executeBy: new Date(v.executeBy).toISOString() }
            : {}),
        }),
      ),
    claimEvent: async (id) => {
      await send({ type: "event.claim", id });
      events();
    },
    completeEvent: (id) =>
      form("记录机会执行", area("note", "实际做了什么"), (v) => ({
        type: "event.complete",
        id,
        note: v.note,
      })),
    standards: async () => {
      const data = await api("/standards");
      open(
        heading("STANDARDS", "公共标准") +
          (data.items.length
            ? data.items
                .map(
                  (s) =>
                    `<div class="entry"><b>${esc(s.body.name)} · v${s.version}</b>${prose(s.body.criteria)}${(s.body.questions ?? []).map((q, i) => btn("练习 " + (i + 1), "quiz", s.id + ":" + s.version + ":" + q.id)).join("")}</div>`,
                )
                .join("")
            : "<p>目前尚无已发布标准。个人目标阶段不等同于公共能力认证。</p>") +
          btn("建议一个标准", "proposeStandard"),
      );
    },
    quiz: async (id) => {
      const [sid, version, qid] = id.split(":"),
        data = await api("/standards"),
        standard = data.items.find(
          (s) => s.id === sid && s.version === +version,
        );
      if (!standard) return;
      const q = standard.body.questions.find((q) => q.id === qid);
      if (!q) return;
      form(
        "客观练习",
        prose(q.prompt) +
          `<label>选择答案<select name="choiceId">${q.choices.map((c) => `<option value="${esc(c.id)}">${esc(c.text)}</option>`).join("")}</select></label><p>按已审核答案判分，练习不直接认定能力。</p>`,
        (v) => ({
          type: "practice.grade",
          standardId: sid,
          standardVersion: +version,
          questionId: q.id,
          choiceId: v.choiceId,
        }),
        {
          submit: "检查答案",
          after: (r) =>
            open(
              heading("PRACTICE", r.result.correct ? "回答正确" : "再想一想") +
                prose(r.result.explanation),
            ),
        },
      );
    },
    proposeStandard: () =>
      form(
        "提出标准建议",
        field("name", "名称", "", "text", 'required maxlength="200"') +
          area("scope", "适用范围", "", 2000) +
          area("criteria", "可核实的判断标准"),
        (v) => ({ type: "standard.propose", ...v }),
      ),
    growth: async () => {
      const d = await api("/growth");
      open(
        heading("GROWTH", "成长记录") +
          `<p>当前规则 ${esc(rules.version)}：每 ${rules.minutesPerXp} 分钟 1 XP，单次上限 ${rules.maxActionXp}，每日上限 ${rules.dailyXpCap}。休息不扣分。</p>` +
          d.items
            .map(
              (r) =>
                `<p>+${r.xp} XP · ${names[r.attribute]} · ${esc(localDate(r.created_at))}</p>`,
            )
            .join(""),
      );
    },
    chatSchedule: (date) => {
      timelineDay = date;
      page = "quests";
      close();
      render();
    },
    proposal: (id) => {
      const [message, index] = id.split(":"),
        m = state.messages.find((m) => m.id === message),
        p = m?.proposals?.[+index];
      if (!p) return;
      const status = proposalState(p.command, m.at);
      if (status.applied || status.unavailable) return toast(status.text);
      confirmProposal(p, id);
    },
  };
  let eventKey, eventTime;
  function proposalKey(id) {
    const [message, index] = id.split(":");
    // Message IDs are server-generated UUIDs. Each proposal has a stable, distinct key across reloads.
    const suffix = (parseInt(message.slice(-2), 16) ^ (+index + 1))
      .toString(16)
      .padStart(2, "0");
    return message.slice(0, -2) + suffix;
  }
  function confirmProposal(p, id) {
    rememberChatDraft();
    const c = p.command;
    const startGoal = c.type === "goal.create";
    const schedule = ["plan.create", "plan.batch"].includes(c.type);
    const submit = startGoal
      ? "确认并开始规划"
      : schedule
        ? "确认加入时间轴"
        : "确认应用";
    open(
      `<div class="chat-confirm">${heading("NEXT STEP", "确认这一步")}${proposalCard(p)}<p class="tiny-note">${startGoal ? "确认后将生成路线草案；确认路线后，可以把事项排入一天的时间轴。" : c.type === "goal.adjust" ? "将生成调整草案，仍需确认新路线。" : schedule ? "确认后，这些事件块会加入任务日志。你可以继续移动或调整它们。" : "确认后将保存这项调整。"}</p><p class="inline-error" role="alert"></p><div class="chat-confirm-buttons">${btn("返回对话", "chat", "", "outline")}${btn(submit, "confirmProposal", "", "solid")}</div></div>`,
    );
    $(".sheet-content [data-action=confirmProposal]").onclick = async (
      event,
    ) => {
      event.stopPropagation();
      const button = event.currentTarget;
      const error = $(".sheet-content .inline-error");
      button.disabled = true;
      error.textContent = "";
      try {
        const result = await send(c, proposalKey(id));
        if (startGoal && result.result?.goalId) {
          goal(result.result.goalId);
          toast("任务已创建，正在生成路线草案");
        } else {
          chat();
          toast(
            result.result?.jobId
              ? "已保存，正在处理"
              : schedule
                ? "事件块已加入任务日志"
                : "调整已保存",
          );
        }
      } catch (err) {
        error.textContent = err.message;
        button.disabled = false;
      }
    };
  }
  function confirm(title, body, execute) {
    open(
      heading("CONFIRM", esc(title)) +
        prose(body) +
        btn("确认", "confirmNow", "", "solid"),
    );
    $(".sheet-content [data-action=confirmNow]").onclick = async (e) => {
      e.stopPropagation();
      const button = e.currentTarget;
      button.disabled = true;
      try {
        await execute();
        close();
        toast("已保存");
      } catch (err) {
        toast(err.message);
        button.disabled = false;
      }
    };
  }
  root.addEventListener("change", (event) => {
    if (!event.target.matches("[data-timeline-day]")) return;
    if (/^\d{4}-\d{2}-\d{2}$/.test(event.target.value)) {
      timelineDay = event.target.value;
      render();
    }
  });
  function previewResize(value) {
    const r = resizing;
    if (!r) return;
    r.minutes = Math.max(1, Math.min(resizeLimit(r.plan), value));
    r.block.style.height = `${r.minutes * TIME_SCALE}px`;
    r.block.classList.toggle("short-block", r.minutes < 25);
    r.block.dataset.minutes = r.minutes;
    r.block.querySelector("[data-block-duration]").textContent =
      `${r.minutes} 分钟`;
    r.handle.setAttribute("aria-valuenow", r.minutes);
    r.handle.setAttribute("aria-valuetext", `${r.minutes} 分钟`);
    r.block.classList.add("resizing");
    let preview = r.block.querySelector(".resize-readout");
    if (!preview) {
      preview = document.createElement("span");
      preview.className = "resize-readout";
      preview.setAttribute("aria-hidden", "true");
      r.block.append(preview);
    }
    preview.textContent = `${clock(r.plan.start + r.minutes)} · ${r.minutes} 分钟`;
  }
  async function commitResize() {
    const r = resizing;
    if (!r || r.saving) return;
    clearTimeout(r.timer);
    r.saving = true;
    try {
      if (r.minutes !== r.plan.minutes) {
        assertCurrentPlan(r.plan);
        await send({
          type: "plan.update",
          id: r.plan.id,
          name: r.plan.name,
          day: r.plan.day,
          time: r.plan.time,
          minutes: r.minutes,
        });
        toast(`已调整为 ${r.minutes} 分钟`);
      }
    } catch (error) {
      toast(error.message);
    } finally {
      resizing = null;
      render();
      $(`[data-resize-id="${r.plan.id}"]`)?.focus({ preventScroll: true });
    }
  }
  root.addEventListener("pointerdown", (event) => {
    const handle = event.target.closest("[data-resize-id]");
    if (!handle || resizing || moving || event.button !== 0) return;
    const plan = state.plans.find((p) => p.id === handle.dataset.resizeId);
    if (!plan || plan.status !== "planned" || !canEditPlan(plan)) return;
    event.preventDefault();
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(event.pointerId);
    resizing = {
      plan,
      block: handle.closest(".time-block"),
      handle,
      y: event.clientY,
      scroll: $(".timeline-scroll").scrollTop,
      minutes: plan.minutes,
      pointer: event.pointerId,
    };
    previewResize(plan.minutes);
  });
  root.addEventListener("pointermove", (event) => {
    if (!resizing || resizing.pointer !== event.pointerId || resizing.saving)
      return;
    const delta =
      event.clientY -
      resizing.y +
      $(".timeline-scroll").scrollTop -
      resizing.scroll;
    previewResize(
      Math.round((resizing.plan.minutes + delta / TIME_SCALE) / 5) * 5,
    );
  });
  root.addEventListener("pointerup", (event) => {
    if (!resizing || resizing.pointer !== event.pointerId) return;
    if (resizing.handle.hasPointerCapture(event.pointerId))
      resizing.handle.releasePointerCapture(event.pointerId);
    void commitResize();
  });
  root.addEventListener("pointercancel", (event) => {
    if (!resizing || resizing.pointer !== event.pointerId) return;
    resizing = null;
    render();
  });
  root.addEventListener("keydown", (event) => {
    const handle = event.target.closest("[data-resize-id]");
    if (
      !handle ||
      ![
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
        "Escape",
      ].includes(event.key)
    )
      return;
    event.preventDefault();
    if (moving) {
      if (event.key === "Escape") cancelMove();
      else if (moving.pointer == null) void commitMove();
      return;
    }
    if (resizing?.saving) return;
    if (event.key === "Escape") {
      clearTimeout(resizing?.timer);
      const id = handle.dataset.resizeId;
      resizing = null;
      render();
      $(`[data-resize-id="${id}"]`)?.focus({ preventScroll: true });
      return;
    }
    if (resizing?.saving || resizing?.pointer != null) return;
    if (resizing && resizing.handle !== handle) {
      void commitResize();
      return;
    }
    if (!resizing) {
      const plan = state.plans.find((p) => p.id === handle.dataset.resizeId);
      if (!plan) return;
      resizing = {
        plan,
        block: handle.closest(".time-block"),
        handle,
        minutes: plan.minutes,
      };
    }
    const step = event.shiftKey ? 15 : 5;
    const next =
      event.key === "Home"
        ? 1
        : event.key === "End"
          ? resizeLimit(resizing.plan)
          : resizing.minutes +
            (["ArrowUp", "ArrowRight"].includes(event.key) ? step : -step);
    previewResize(next);
    clearTimeout(resizing.timer);
    resizing.timer = setTimeout(() => void commitResize(), 300);
  });

  function moveConflicts(plan, start) {
    return state.plans.some(
      (p) =>
        p.id !== plan.id &&
        p.day === plan.day &&
        p.status === "planned" &&
        start < p.start + p.minutes &&
        p.start < start + plan.minutes,
    );
  }
  function assertCurrentPlan(plan) {
    const current = state.plans.find((p) => p.id === plan.id);
    if (
      !current ||
      !canEditPlan(current) ||
      [
        "name",
        "day",
        "time",
        "minutes",
        "status",
        "goal",
        "stage",
        "revision",
      ].some((key) => current[key] !== plan[key])
    )
      throw new Error("这个事件块已在其他地方更新，已刷新，请重新调整");
  }
  function previewMove(start) {
    const r = moving;
    if (!r) return;
    r.start = Math.max(
      0,
      Math.min(1440 - r.plan.minutes, Math.round(start / 5) * 5),
    );
    r.block.style.top = `${r.start * TIME_SCALE}px`;
    r.block.classList.add("moving");
    r.block.classList.toggle("move-conflict", moveConflicts(r.plan, r.start));
    r.face.setAttribute(
      "aria-label",
      `${r.plan.name}，${clock(r.start)} 到 ${clock(r.start + r.plan.minutes)}，${r.plan.minutes} 分钟，移动中`,
    );
    r.block.querySelector(".block-time").innerHTML =
      `${clock(r.start)}–${clock(r.start + r.plan.minutes)} · <b data-block-duration>${r.plan.minutes} 分钟</b>`;
    let readout = r.block.querySelector(".move-readout");
    if (!readout) {
      readout = document.createElement("span");
      readout.className = "move-readout";
      readout.setAttribute("aria-hidden", "true");
      r.block.append(readout);
    }
    readout.textContent = `${clock(r.start)}–${clock(r.start + r.plan.minutes)}${moveConflicts(r.plan, r.start) ? " · 时段已占用" : ""}`;
  }
  function moveFromPointer() {
    const r = moving;
    if (!r) return;
    previewMove(
      r.plan.start +
        (r.lastY - r.y + r.viewport.scrollTop - r.scroll) / TIME_SCALE,
    );
  }
  function scrollWhileMoving() {
    const r = moving;
    if (!r || !r.active || r.pointer == null || r.saving) return;
    const rect = r.viewport.getBoundingClientRect();
    const edge = 38;
    const speed =
      r.lastY < rect.top + edge
        ? -Math.min(12, (rect.top + edge - r.lastY) / 3)
        : r.lastY > rect.bottom - edge
          ? Math.min(12, (r.lastY - rect.bottom + edge) / 3)
          : 0;
    if (speed) {
      r.viewport.scrollTop += speed;
      moveFromPointer();
    }
    r.frame = requestAnimationFrame(scrollWhileMoving);
  }
  async function commitMove() {
    const r = moving;
    if (!r || r.saving) return;
    clearTimeout(r.timer);
    cancelAnimationFrame(r.frame);
    r.saving = true;
    try {
      if (r.start !== r.plan.start) {
        assertCurrentPlan(r.plan);
        await send({
          type: "plan.update",
          id: r.plan.id,
          name: r.plan.name,
          day: r.plan.day,
          time: clock(r.start),
          minutes: r.plan.minutes,
        });
        toast(`已移到 ${clock(r.start)}，时长保持 ${r.plan.minutes} 分钟`);
      }
    } catch (error) {
      toast(error.message);
    } finally {
      moving = null;
      r.origin?.remove();
      render();
      $(`[data-move-id="${r.plan.id}"]`)?.focus({ preventScroll: true });
    }
  }
  function cancelMove() {
    const r = moving;
    if (!r || r.saving) return;
    clearTimeout(r.timer);
    cancelAnimationFrame(r.frame);
    if (r.pointer != null && r.face.hasPointerCapture(r.pointer))
      r.face.releasePointerCapture(r.pointer);
    moving = null;
    r.origin?.remove();
    render();
    $(`[data-move-id="${r.plan.id}"]`)?.focus({ preventScroll: true });
  }
  root.addEventListener("pointerdown", (event) => {
    const face = event.target.closest("[data-move-id]");
    if (!face || resizing || moving || event.button !== 0) return;
    const plan = state.plans.find((p) => p.id === face.dataset.moveId);
    if (!plan || !canEditPlan(plan) || plan.status !== "planned") return;
    event.preventDefault();
    face.focus({ preventScroll: true });
    face.setPointerCapture(event.pointerId);
    const viewport = $(".timeline-scroll");
    moving = {
      plan,
      face,
      block: face.closest(".time-block"),
      viewport,
      y: event.clientY,
      lastY: event.clientY,
      scroll: viewport.scrollTop,
      start: plan.start,
      pointer: event.pointerId,
      active: false,
    };
  });
  root.addEventListener("pointermove", (event) => {
    const r = moving;
    if (!r || r.pointer !== event.pointerId || r.saving) return;
    r.lastY = event.clientY;
    if (!r.active) {
      if (Math.abs(event.clientY - r.y) < 4) return;
      r.active = true;
      const origin = document.createElement("div");
      origin.className = "move-origin";
      origin.style.cssText = r.block.style.cssText;
      origin.setAttribute("aria-hidden", "true");
      r.block.before(origin);
      r.origin = origin;
      r.frame = requestAnimationFrame(scrollWhileMoving);
    }
    moveFromPointer();
  });
  root.addEventListener("pointerup", (event) => {
    const r = moving;
    if (!r || r.pointer !== event.pointerId || r.saving) return;
    cancelAnimationFrame(r.frame);
    if (r.face.hasPointerCapture(event.pointerId))
      r.face.releasePointerCapture(event.pointerId);
    if (!r.active) {
      moving = null;
      return;
    }
    const suppression = { id: r.plan.id };
    suppressedPlanClick = suppression;
    setTimeout(() => {
      if (suppressedPlanClick === suppression) suppressedPlanClick = null;
    }, 0);
    void commitMove();
  });
  root.addEventListener("pointercancel", (event) => {
    if (moving?.pointer === event.pointerId) cancelMove();
  });
  root.addEventListener("keydown", (event) => {
    const face = event.target.closest("[data-move-id]");
    if (
      !face ||
      !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Escape"].includes(
        event.key,
      )
    )
      return;
    event.preventDefault();
    if (event.key === "Escape") {
      cancelMove();
      return;
    }
    if (resizing || moving?.saving || moving?.pointer != null) return;
    if (moving && moving.face !== face) {
      void commitMove();
      return;
    }
    if (!moving) {
      const plan = state.plans.find((p) => p.id === face.dataset.moveId);
      if (!plan || !canEditPlan(plan)) return;
      moving = {
        plan,
        face,
        block: face.closest(".time-block"),
        start: plan.start,
        active: true,
      };
    }
    previewMove(
      moving.start +
        (["ArrowUp", "ArrowLeft"].includes(event.key) ? -1 : 1) *
          (event.shiftKey ? 15 : 5),
    );
    clearTimeout(moving.timer);
    moving.timer = setTimeout(() => void commitMove(), 300);
  });

  root.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-action]");
    if (!b || b.dataset.action === "confirmNow") return;
    if (
      b.dataset.moveId &&
      e.detail > 0 &&
      suppressedPlanClick?.id === b.dataset.id
    ) {
      suppressedPlanClick = null;
      e.preventDefault();
      return;
    }
    const action = b.dataset.action;
    if (!actions[action]) return;
    if (!state && !["login", "register"].includes(action)) {
      auth();
      return;
    }
    b.disabled = true;
    try {
      if (action === "newEvent") {
        eventKey = crypto.randomUUID();
        eventTime = new Date().toISOString();
      }
      await actions[action](b.dataset.id);
    } catch (err) {
      toast(err.message);
    } finally {
      b.disabled = false;
    }
  });
  $$("[data-nav]").forEach(
    (b) =>
      (b.onclick = () => {
        if (!state) {
          auth();
          return;
        }
        page = b.dataset.nav;
        render();
      }),
  );
  $(".today").onclick = () => {
    if (!state) return auth();
    page = "actions";
    render();
  };
  $(".profile-button").onclick = () => (state ? profile() : auth());
  $(".guide-bar").onclick = () => (state ? chat() : auth());
  $$(".stat").forEach(
    (b, i) =>
      (b.onclick = () => {
        earthArt.select(i);
        if (state) actions.growth().catch((e) => toast(e.message));
      }),
  );
  $(".close").onclick = close;
  $(".overlay").onclick = (e) => {
    if (e.target === $(".overlay")) close();
  };
  document.addEventListener("keydown", (e) => {
    if (!modal) return;
    if (e.key === "Escape") close();
    if (e.key === "Tab") {
      const a = [
        ...$(".sheet").querySelectorAll("button,input,textarea,select,a[href]"),
      ].filter((x) => !x.disabled);
      const first = a[0],
        last = a.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });
  function startPolling() {
    clearInterval(poll);
    poll = setInterval(async () => {
      if (document.hidden || !user || resizing) return;
      try {
        const before = jobs
          .filter((j) => ["queued", "running"].includes(j.status))
          .map((j) => j.id);
        await refresh();
        const done = jobs.filter(
          (j) =>
            before.includes(j.id) && !["queued", "running"].includes(j.status),
        );
        if (done.length) toast("后台任务已更新，可查看进度或返回对应目标");
      } catch (e) {
        if (e.status === 401) {
          clearInterval(poll);
          user = null;
          auth();
        }
      }
    }, 4000);
  }
  (async () => {
    try {
      user = await api("/auth/me");
      await refresh();
      startPolling();
    } catch (e) {
      if (e.status !== 401) toast(e.message);
      auth();
    }
    window.lucide?.createIcons();
  })();
})();
