import { createHash, randomUUID } from "node:crypto";
import { transaction } from "./db.js";
import {
  applyCommand,
  settleJob,
  DomainError,
  rules,
  expireState,
} from "./domain.js";
export const hash = (x) => createHash("sha256").update(x).digest("hex");
export class Repository {
  constructor(pool, cache) {
    this.pool = pool;
    this.cache = cache;
  }
  async state(uid) {
    const { rows } = await this.pool.query(
      "SELECT state,version FROM players WHERE user_id=$1",
      [uid],
    );
    if (!rows[0]) throw new DomainError("用户不存在", 404);
    return {
      state: expireState(rows[0].state),
      version: Number(rows[0].version),
      rules,
    };
  }
  async command(uid, key, expectedVersion, command) {
    return transaction(this.pool, async (c) => {
      const {
        rows: [player],
      } = await c.query(
        "SELECT state,version FROM players WHERE user_id=$1 FOR UPDATE",
        [uid],
      );
      if (!player) throw new DomainError("用户不存在", 404);
      const fingerprint = hash(JSON.stringify(command));
      const {
        rows: [receipt],
      } = await c.query(
        "SELECT fingerprint,response FROM command_receipts WHERE user_id=$1 AND key=$2",
        [uid, key],
      );
      if (receipt) {
        if (receipt.fingerprint !== fingerprint)
          throw new DomainError("重复请求标识对应了不同操作");
        return receipt.response;
      }
      if (Number(player.version) !== expectedVersion)
        throw new DomainError("数据已在其他页面更新，请刷新后重试");
      const standards =
        command.type === "practice.grade"
          ? (
              await c.query(
                "SELECT id,version,body FROM public_standards WHERE id=$1 AND version=$2",
                [command.standardId, command.standardVersion],
              )
            ).rows
          : [];
      const next = applyCommand(
        player.state,
        command,
        new Date().toISOString(),
        standards,
      );
      if (next.jobs.length) {
        const {
          rows: [counts],
        } = await c.query(
          "SELECT count(*)::int AS n FROM agent_jobs WHERE user_id=$1 AND status IN ('queued','running')",
          [uid],
        );
        if (counts.n >= 3)
          throw new DomainError("已有任务处理中，请稍后再试", 429);
      }
      for (const job of next.jobs)
        await c.query(
          "INSERT INTO agent_jobs(id,user_id,kind,input) VALUES($1,$2,$3,$4)",
          [job.id, uid, job.kind, job.input],
        );
      await this.writeState(c, uid, next.state, next.rewards, command.type, {
        result: next.result,
      });
      const response = { result: next.result, version: expectedVersion + 1 };
      await c.query(
        "INSERT INTO command_receipts(user_id,key,fingerprint,response) VALUES($1,$2,$3,$4)",
        [uid, key, fingerprint, response],
      );
      return response;
    });
  }
  async writeState(c, uid, state, rewards, event, data) {
    for (const r of rewards)
      await c.query(
        "INSERT INTO growth_ledger(id,user_id,source_id,kind,xp,attribute,rule_version) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [r.id, uid, r.sourceId, r.kind, r.xp, r.attribute, r.ruleVersion],
      );
    await c.query(
      "UPDATE players SET state=$2,version=version+1,updated_at=now() WHERE user_id=$1",
      [uid, state],
    );
    await c.query(
      "INSERT INTO domain_events(user_id,type,data) VALUES($1,$2,$3)",
      [uid, event, data],
    );
  }
  async job(uid, id) {
    const {
      rows: [j],
    } = await this.pool.query(
      "SELECT id,kind,status,result,error,created_at,updated_at FROM agent_jobs WHERE id=$1 AND user_id=$2",
      [id, uid],
    );
    if (!j) throw new DomainError("任务不存在", 404);
    return j;
  }
  async jobs(uid) {
    return (
      await this.pool.query(
        "SELECT id,kind,status,error,created_at FROM agent_jobs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50",
        [uid],
      )
    ).rows;
  }
  async cancel(uid, id) {
    return transaction(this.pool, async (c) => {
      await c.query("SELECT user_id FROM players WHERE user_id=$1 FOR UPDATE", [
        uid,
      ]);
      const {
        rows: [j],
      } = await c.query(
        "UPDATE agent_jobs SET status='cancelled',updated_at=now() WHERE id=$1 AND user_id=$2 AND status IN ('queued','running') RETURNING *",
        [id, uid],
      );
      if (!j) throw new DomainError("任务不存在或已结束");
      await this.markAssessmentError(c, j, "评估已取消，可重新提交评估");
      return { id, status: "cancelled" };
    });
  }
  async claim(timeoutMs) {
    return transaction(this.pool, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(718284902)");
      const {
        rows: [j],
      } = await c.query(
        "SELECT j.* FROM agent_jobs j WHERE j.status='queued' AND NOT EXISTS (SELECT 1 FROM agent_jobs busy WHERE busy.user_id=j.user_id AND busy.status='running') ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1",
      );
      if (!j) return null;
      await c.query(
        "UPDATE agent_jobs SET status='running',attempt=attempt+1,lease_until=now()+($2*interval '1 millisecond'),updated_at=now() WHERE id=$1",
        [j.id, timeoutMs + 30000],
      );
      return j;
    });
  }
  async finish(j, output) {
    return transaction(this.pool, async (c) => {
      const {
        rows: [p],
      } = await c.query(
        "SELECT state FROM players WHERE user_id=$1 FOR UPDATE",
        [j.user_id],
      );
      if (!p) return false;
      const {
        rows: [current],
      } = await c.query(
        "SELECT status FROM agent_jobs WHERE id=$1 FOR UPDATE",
        [j.id],
      );
      if (current?.status !== "running") return false;
      const standards = (await c.query("SELECT * FROM public_standards")).rows;
      const next = settleJob(p.state, j, output, standards);
      await this.writeState(
        c,
        j.user_id,
        next.state,
        next.rewards,
        "agent.completed",
        { jobId: j.id, kind: j.kind },
      );
      await c.query(
        "UPDATE agent_jobs SET status='succeeded',result=$2,lease_until=NULL,updated_at=now() WHERE id=$1",
        [j.id, next.result],
      );
      return true;
    });
  }
  async markAssessmentError(c, j, message) {
    if (j.kind !== "assessment") return;
    const {
      rows: [p],
    } = await c.query("SELECT state FROM players WHERE user_id=$1", [
      j.user_id,
    ]);
    const sub = p?.state.submissions.find((s) => s.id === j.input.submissionId);
    if (sub?.status === "pending") {
      sub.status = "error";
      sub.error = message;
      await this.writeState(c, j.user_id, p.state, [], "assessment.failed", {
        jobId: j.id,
      });
    }
  }
  async fail(j, message) {
    return transaction(this.pool, async (c) => {
      await c.query("SELECT user_id FROM players WHERE user_id=$1 FOR UPDATE", [
        j.user_id,
      ]);
      const { rowCount } = await c.query(
        "UPDATE agent_jobs SET status='failed',error=$2,lease_until=NULL,updated_at=now() WHERE id=$1 AND status='running'",
        [j.id, message],
      );
      if (rowCount) await this.markAssessmentError(c, j, message);
    });
  }
  async expire() {
    const { rows } = await this.pool.query(
      "SELECT * FROM agent_jobs WHERE status='running' AND lease_until<now()",
    );
    for (const j of rows)
      await this.fail(j, "执行中断，结果未提交；原始内容已保留，请主动重试。");
    await this.pool.query("DELETE FROM sessions WHERE expires_at<now()");
  }
  async context(uid, job) {
    const { state, version } = await this.state(uid),
      key = `eo:context:${uid}:${version}`;
    let cachedContext;
    try {
      const cached = await this.cache.get(key);
      if (cached) cachedContext = JSON.parse(cached);
    } catch {}
    const compactGoal = (g) => ({
      ...g,
      routeHistory: undefined,
      draft: g.draft
        ? { id: g.draft.id, summary: g.draft.route.summary }
        : null,
    });
    const context = cachedContext ?? {
      profile: state.profile,
      goals: state.goals.slice(-20).map(compactGoal),
      records: state.records
        .slice(-30)
        .map((r) => ({ ...r, note: r.note.slice(0, 500) })),
      notes: state.notes.slice(-20).map((n) => ({
        ...n,
        previousBody: undefined,
        body: n.body.slice(0, 1000),
      })),
      messages: state.messages.slice(-12),
      submissions: [],
      achievements: state.achievements.slice(-30),
    };
    if (!cachedContext) {
      try {
        await this.cache.set(key, JSON.stringify(context), { EX: 1800 });
      } catch {}
    }
    if (job?.kind === "route") {
      const goal = state.goals.find((g) => g.id === job.input.goalId);
      context.goals = goal ? [compactGoal(goal)] : [];
    }
    if (job?.kind === "review") {
      const records = state.records.filter((r) => r.day === job.input.day);
      context.records = records
        .slice(-50)
        .map((r) => ({ ...r, note: r.note.slice(0, 500) }));
      context.reviewTotals = {
        recordCount: records.length,
        minutes: records.reduce((n, r) => n + r.minutes, 0),
        xp: records.reduce((n, r) => n + r.gain, 0),
        detailsTruncated: records.length > 50,
      };
    }

    if (job?.kind === "assessment") {
      const sub = state.submissions.find(
        (s) => s.id === job.input.submissionId,
      );
      if (sub) {
        context.submissions = [sub];
        const goal = state.goals.find((g) => g.id === sub.goal);
        context.goals = goal ? [compactGoal(goal)] : [];
      }
    }
    if (job?.kind === "chat") {
      const message = state.messages.find((s) => s.id === job.input.messageId);
      if (message && !context.messages.some((s) => s.id === message.id))
        context.messages.push(message);
    }
    return context;
  }
}
