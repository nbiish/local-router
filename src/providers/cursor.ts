import { ProxyProvider } from "../types";
import {
  fetchOAuthProviderModels,
  getOAuthUpstreamHeaders
} from "../oauth-providers";

const provider: ProxyProvider = {
  name: "cursor",
  baseUrl: "https://api2.cursor.sh/v1",
  getHeaders: () => {
    throw new Error("Cursor requires async headers — login first via /config");
  },
  getHeadersAsync: async (opts) => getOAuthUpstreamHeaders("cursor", opts),
  getModels: async () => fetchOAuthProviderModels("cursor")
};

export default provider;
