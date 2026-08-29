import { ProxyProvider } from "../types";

export function getModalProxyBaseUrl(): string {
  const customUrl = process.env.MODAL_PROXY_ENDPOINT || process.env.MODAL_PROXY_URL;
  if (customUrl) {
    return customUrl.replace(/\/+$/, "");
  }
  return "https://nbiish--ep-glm-5-3-flash-server.us-west.modal.direct/v1";
}

export function getModalProxyApiKey(): string {
  if (process.env.MODAL_PROXY_TOKEN_ID && process.env.MODAL_PROXY_TOKEN_SECRET) {
    return `${process.env.MODAL_PROXY_TOKEN_ID}.${process.env.MODAL_PROXY_TOKEN_SECRET}`;
  }
  return process.env.MODAL_PROXY_API_KEY || process.env.LOCALROUTER_MODAL_PROXY_API_KEY || "";
}

const provider: ProxyProvider = {
  name: "modal-proxy",
  baseUrl: getModalProxyBaseUrl(),
  getHeaders: () => {
    const key = getModalProxyApiKey();
    if (!key) {
      throw new Error("MODAL_PROXY_API_KEY (or MODAL_PROXY_TOKEN_ID + MODAL_PROXY_TOKEN_SECRET) is not set");
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`
    };
    const sessionId = process.env.MODAL_SESSION_ID || process.env.LOCALROUTER_MODAL_SESSION_ID;
    if (sessionId) {
      headers["Modal-Session-ID"] = sessionId;
    }
    return headers;
  },
  getModels: async () => {
    const key = getModalProxyApiKey();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (key) {
      headers.Authorization = `Bearer ${key}`;
    }
    const sessionId = process.env.MODAL_SESSION_ID || process.env.LOCALROUTER_MODAL_SESSION_ID;
    if (sessionId) {
      headers["Modal-Session-ID"] = sessionId;
    }

    try {
      const res = await fetch(`${getModalProxyBaseUrl()}/models`, {
        headers,
        signal: AbortSignal.timeout(6000)
      });
      if (res.ok) {
        const payload = await res.json() as any;
        const list = Array.isArray(payload?.data)
          ? payload.data
          : Array.isArray(payload?.models)
            ? payload.models
            : Array.isArray(payload)
              ? payload
              : [];
        const models = list
          .map((m: any) => m?.id ?? m?.name ?? m?.model)
          .filter((id: unknown): id is string => typeof id === "string" && id.trim().length > 0)
          .map((id: string) => ({ id: id.trim(), object: "model", owned_by: "modal-proxy" }));
        if (models.length > 0) return models;
      }
    } catch {
      // Fall through to registry defaults
    }

    return [
      { id: "zai-org/GLM-5.3-Flash", object: "model", owned_by: "modal-proxy" },
      { id: "GLM-5.3-Flash", object: "model", owned_by: "modal-proxy" },
      { id: "glm-5.3-flash", object: "model", owned_by: "modal-proxy" },
      { id: "moonshotai/Kimi-K3", object: "model", owned_by: "modal-proxy" },
      { id: "kimi-k3", object: "model", owned_by: "modal-proxy" }
    ];
  }
};

export default provider;
