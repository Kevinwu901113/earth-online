import {
  scrypt as scryptCb,
  randomBytes,
  timingSafeEqual,
  randomUUID,
} from "node:crypto";
import { promisify } from "node:util";
import { transaction } from "./db.js";
import { initialState, DomainError } from "./domain.js";
import { hash } from "./repository.js";
const scrypt = promisify(scryptCb);
export async function passwordHash(password) {
  const salt = randomBytes(16).toString("hex");
  return (
    salt + ":" + Buffer.from(await scrypt(password, salt, 64)).toString("hex")
  );
}
export async function passwordMatches(password, encoded) {
  const [salt, key] = encoded.split(":");
  const got = Buffer.from(await scrypt(password, salt, 64));
  const want = Buffer.from(key, "hex");
  return want.length === got.length && timingSafeEqual(want, got);
}
export class Auth {
  constructor(pool, days) {
    this.pool = pool;
    this.days = days;
  }
  async register(email, password) {
    const id = randomUUID(),
      encoded = await passwordHash(password);
    try {
      await transaction(this.pool, async (c) => {
        await c.query(
          "INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)",
          [id, email, encoded],
        );
        await c.query("INSERT INTO players(user_id,state) VALUES($1,$2)", [
          id,
          initialState(),
        ]);
      });
    } catch (e) {
      if (e.code === "23505")
        throw new DomainError("账号无法注册，请尝试登录", 409);
      throw e;
    }
    return this.session(id);
  }
  async login(email, password) {
    const {
      rows: [user],
    } = await this.pool.query(
      "SELECT id,password_hash FROM users WHERE email=$1",
      [email],
    );
    const valid = await passwordMatches(
      password,
      user?.password_hash ??
        "00000000000000000000000000000000:" + "00".repeat(64),
    );
    if (!user || !valid) throw new DomainError("邮箱或密码不正确", 401);
    return this.session(user.id);
  }
  async session(uid) {
    const token = randomBytes(32).toString("base64url");
    await this.pool.query(
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+($3*interval '1 day'))",
      [hash(token), uid, this.days],
    );
    return token;
  }
  async user(token) {
    if (!token) return null;
    const {
      rows: [row],
    } = await this.pool.query(
      "SELECT u.id,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()",
      [hash(token)],
    );
    return row ?? null;
  }
  async logout(token) {
    if (token)
      await this.pool.query("DELETE FROM sessions WHERE token_hash=$1", [
        hash(token),
      ]);
  }
}
