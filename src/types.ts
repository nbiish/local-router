export interface ProxyProvider {
  name: string;
  baseUrl: string;
  getHeaders: () => Record<string, string>;
  /** Async variant. When present, the proxy will await this and use its
   *  result instead of `getHeaders()`. Required for OAuth providers whose
   *  access tokens expire and need a refresh round-trip. */
  getHeadersAsync?: () => Promise<Record<string, string>>;
  // Optional: override the request body before sending
  formatBody?: (body: any) => any;
  // Optional: dynamically fetch available models for this provider
  getModels?: () => Promise<Array<{ id: string; object: string; owned_by: string }>>;
}