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
    poll;
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
    `<label>${title}<textarea name="${name}" maxlength="${max}" required>${esc(value)}</textarea></label>`;
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
    try {
      const r = await api("/commands", { method: "POST", body: payload, key });
      await refresh();
      pendingRequests.delete(fingerprint);
      return r;
    } catch (e) {
      if (e.status && e.status < 500) pendingRequests.delete(fingerprint);
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
        if (after) after(result);
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
    if ($(".chat-history")) $(".chat-history").innerHTML = chatHistory();
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
      `${state.goals.filter((g) => g.status === "active").length} 条主线进行中 · ${state.records.filter((r) => r.day === day()).length} 条今日记录`;
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
    if (page !== "self") $(".journey-page").innerHTML = pages[page]();
  }
  const pages = {
    quests: () =>
      heading("QUESTS", "任务日志") +
      btn("开启新主线", "newGoal", "", "solid") +
      state.goals
        .map(
          (g) =>
            `<article class="entry quest-tile"><span class="quest-tag">${g.status === "draft" ? planningTitle(g) : label(g.status)}</span><h2>${esc(g.title)}</h2><p>${esc(g.stages[g.stage]?.name ?? planningTitle(g))}</p>${planningNotice(g)}${btn(g.draft ? "查看路线草案" : "查看目标", "goal", g.id)}${canRetryPlanning(g) ? btn("重试规划", "adjustGoal", g.id) : ""}</article>`,
        )
        .join("") +
      (!state.goals.length
        ? '<p class="guide-note">从你真正想做的事开始。目标、基础、时间与完成条件会一起决定路线。</p>'
        : "") +
      btn("后台任务", "jobs"),
    actions: () =>
      heading("ACTIONS", "今天怎么过") +
      `<div class="row">${btn("安排时间", "newPlan")}${btn("记录投入", "record")}${btn("生活事件", "events")}</div>` +
      state.plans
        .filter(
          (p) => p.day >= day() || ["planned", "paused"].includes(p.status),
        )
        .map(
          (p) =>
            `<article class="entry"><small>${esc(p.day)} ${esc(p.time)} · ${label(p.status)}</small><h3>${esc(p.name)}</h3><p>${p.minutes} 分钟</p><div class="row">${p.status === "planned" ? btn("留下记录", "record", p.id) + btn("暂停", "pausePlan", p.id) : p.status === "paused" ? btn("恢复", "resumePlan", p.id) : ""}${["planned", "paused"].includes(p.status) ? btn("取消", "cancelPlan", p.id) : ""}</div></article>`,
        )
        .join("") +
      `<h3>今日投入</h3>` +
      state.records
        .filter((r) => r.day === day())
        .map(
          (r) =>
            `<div class="entry">${esc(r.name)} · ${r.minutes} 分钟 · +${r.gain} XP${prose(r.note)}</div>`,
        )
        .join("") +
      btn("生成今日复盘", "review") +
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
  function newGoal() {
    form(
      "开启新主线",
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
    const stage = g.stages[g.stage];
    const stagesCompleted = ["completed", "awaiting_external"].includes(
      g.status,
    );
    open(
      heading("QUEST", esc(g.title)) +
        `<p class="status">${label(g.status)} · 每天 ${g.minutes} 分钟 · 路线版本 ${g.revision}</p><h4>完成条件</h4>${prose(g.criterion)}<h4>起点</h4>${prose(g.base)}` +
        planningNotice(g) +
        (g.draft
          ? `<h3>待确认的${g.revision ? "调整" : "路线"}</h3>${prose(g.draft.route.summary)}<p>每天 ${g.draft.route.minutes} 分钟</p>${g.draft.route.stages.map((s, i) => `<div class="entry"><b>${g.stage + i + 1}. ${esc(s.name)}</b>${prose(s.criterion)}${prose(s.steps)}</div>`).join("")}<p class="tiny-note">确认后开始执行；已完成阶段保留。${g.revision ? "下方展示当前路线，便于比较。" : ""}</p>${sources(g.draft.route.sources)}${btn("确认这条路线", "confirmGoal", g.id, "solid")}`
          : "") +
        g.stages
          .map(
            (s, i) =>
              `<div class="entry"><small>${i < g.stage || stagesCompleted ? "已通过" : i === g.stage ? "当前阶段" : "后续阶段"}</small><h4>${esc(s.name)}</h4>${prose(s.criterion)}${i === g.stage && !stagesCompleted ? prose(s.steps) + `<p>挑战：${esc(s.challenge)}</p>` : ""}</div>`,
          )
          .join("") +
        sources(g.sources ?? []) +
        `<div class="row">${g.status === "active" && stage ? btn("安排练习", "goalPlan", id) + btn("提交成果", "submit", id) + btn("暂停主线", "pauseGoal", id) : g.status === "paused" ? btn("恢复主线", "resumeGoal", id) : ""}${["draft", "active", "paused"].includes(g.status) ? (planningBusy(g) ? btn("取消本次规划", "cancelPlanning", id) : btn(canRetryPlanning(g) ? "重试规划" : g.draft ? "重新规划" : "调整／重试规划", "adjustGoal", id)) : ""}${g.status === "awaiting_external" ? btn("提交外部证据", "external", id) : ""}${!["ended", "completed"].includes(g.status) ? btn("结束目标", "endGoal", id) : ""}</div>` +
        state.submissions
          .filter((s) => s.goal === id)
          .reverse()
          .map(
            (s) =>
              `<div class="entry"><small>${s.kind === "challenge" ? "挑战" : "练习"} · ${label(s.status)}</small>${prose(s.content)}${s.assessment ? `<b>${label(s.assessment.outcome)}</b>${prose(s.assessment.feedback)}` : ""}${s.status === "error" ? `<div class="assessment-error" role="status">${prose(s.error || "评估未完成；内容已保存，可重试。")}</div>` + btn("重试评估", "retrySubmission", s.id) : ""}</div>`,
          )
          .join("") +
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
  function sources(items) {
    return items.length
      ? "<h4>参考来源</h4>" +
          items
            .map((s) =>
              /^https?:\/\//i.test(s.url)
                ? `<p class="source"><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a> · ${esc(s.note)}</p>`
                : "",
            )
            .join("")
      : '<p class="tiny-note">暂无经检索确认的参考来源。</p>';
  }
  function goalOptions(value) {
    return `<label>关联主线<select name="goal"><option value="">自由行动</option>${state.goals
      .filter((g) => g.status === "active")
      .map(
        (g) =>
          `<option value="${g.id}" ${value === g.id ? "selected" : ""}>${esc(g.title)}</option>`,
      )
      .join("")}</select></label>`;
  }
  function statOptions(value = 0) {
    return `<label>投入方向<select name="stat">${names.map((n, i) => `<option value="${i}" ${+value === i ? "selected" : ""}>${n}</option>`).join("")}</select></label>`;
  }
  function planForm(goalId) {
    const g = state.goals.find((g) => g.id === goalId);
    form(
      "给行动留一点时间",
      goalOptions(goalId) +
        field(
          "name",
          "行动",
          g?.stages[g.stage]?.exercise ?? "",
          "text",
          'required maxlength="200"',
        ) +
        field(
          "minutes",
          "计划分钟",
          g?.minutes ?? 20,
          "number",
          'min="1" max="1440" required',
        ) +
        field("day", "日期", day(), "date", "required") +
        field("time", "开始时间", "19:00", "time", "required") +
        statOptions(g?.stat),
      (v) => ({
        type: "plan.create",
        goal: v.goal || null,
        name: v.name,
        minutes: +v.minutes,
        day: v.day,
        time: v.time,
        stat: +v.stat,
      }),
    );
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
  function chatHistory() {
    return state.messages
      .slice(-20)
      .map(
        (m) =>
          `<div class="entry"><small>${m.role === "user" ? "你" : "管家"}</small>${prose(m.content)}${(m.proposals ?? []).map((p, i) => btn(p.label, "proposal", m.id + ":" + i)).join("")}</div>`,
      )
      .join("");
  }
  function chat() {
    open(
      heading("GUIDE", "和管家聊聊") +
        '<div class="chat-history">' +
        chatHistory() +
        "</div>" +
        `<form>${area("content", "说说你的想法", "", 5000)}<p class="inline-error" role="alert"></p><button class="solid wide" type="submit">发送</button></form>${btn("刷新对话", "chat")}${btn("后台任务", "jobs")}`,
    );
    const f = $(".sheet-content form");
    const key = crypto.randomUUID();
    f.onsubmit = async (e) => {
      e.preventDefault();
      const b = f.querySelector("[type=submit]");
      b.disabled = true;
      try {
        await send(
          { type: "chat.send", content: new FormData(f).get("content") },
          key,
        );
        chat();
        toast("消息已保存，回复处理中");
      } catch (e) {
        f.querySelector(".inline-error").textContent = e.message;
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
    login: () => auth(),
    register: () => auth("register"),
    newGoal,
    goal,
    newPlan: () => planForm(),
    goalPlan: planForm,
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
    proposal: (id) => {
      const [message, index] = id.split(":"),
        p = state.messages.find((m) => m.id === message)?.proposals?.[+index];
      if (!p) return;
      confirm(p.label, proposalSummary(p.command), () => send(p.command));
    },
  };
  let eventKey, eventTime;
  function proposalSummary(c) {
    const goal = state.goals.find((g) => g.id === (c.id ?? c.goal));
    const plan = state.plans.find((p) => p.id === c.id);
    switch (c.type) {
      case "goal.create":
        return `新目标：${c.title}\n当前基础：${c.base}\n每天 ${c.minutes} 分钟\n完成条件：${c.criterion}\n需要外部结果：${c.requiresExternal ? "是" : "否"}`;
      case "goal.adjust":
        return `调整目标：${goal?.title ?? "目标已变化"}\n原因：${c.reason}\n每天 ${c.minutes} 分钟\n这会生成新草案，仍需再次确认。`;
      case "goal.status":
        return `目标：${goal?.title ?? "目标已变化"}\n改为：${label(c.status)}`;
      case "plan.create":
        return `行动：${c.name}\n${c.day} ${c.time} · ${c.minutes} 分钟\n主线：${goal?.title ?? "自由行动"}`;
      case "plan.status":
        return `行动：${plan?.name ?? "行动已变化"}\n改为：${label(c.status)}`;
      case "review.create":
        return `根据 ${c.day} 的实际记录生成复盘。`;
      case "standard.propose":
        return `建议标准：${c.name}\n适用范围：${c.scope}\n标准：${c.criteria}\n仅提交候选，等待运营审核。`;
      default:
        return "请返回对应功能完成操作。";
    }
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
  root.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-action]");
    if (!b || b.dataset.action === "confirmNow") return;
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
      if (document.hidden || !user) return;
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
