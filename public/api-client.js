(() => {
  "use strict";
  function failure(message, status, code) {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    return error;
  }
  window.earthApi = {
    async request(path, { body, key, ...opts } = {}) {
      const headers = { ...opts.headers };
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        headers["x-earth-client"] = "web-v1";
      }
      if (key) headers["Idempotency-Key"] = key;
      let response;
      try {
        response = await fetch("/api" + path, {
          ...opts,
          headers,
          credentials: "same-origin",
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch {
        throw failure(
          "连接失败，请确认应用已启动且浏览器允许访问。",
          0,
          "NETWORK_ERROR",
        );
      }
      let text;
      try {
        text = await response.text();
      } catch {
        throw failure(
          "连接中断，请重试。",
          response.status,
          "RESPONSE_INTERRUPTED",
        );
      }
      if (!text.trim())
        throw failure(
          "服务未返回数据，请刷新重试。",
          response.status,
          "EMPTY_RESPONSE",
        );
      let data;
      try {
        data = JSON.parse(text);
        if (data === null || typeof data !== "object") throw new Error();
      } catch {
        // Gateways can return HTML sign-in/error pages. Never expose that body as an API error.
        throw failure(
          "服务返回了异常响应，请检查访问地址或重新登录后重试。",
          response.status,
          "INVALID_RESPONSE",
        );
      }
      if (!response.ok)
        throw failure(
          typeof data.error === "string" ? data.error : "请求失败，请重试。",
          response.status,
          "HTTP_ERROR",
        );
      return data;
    },
  };
})();
