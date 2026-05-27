export interface ProxyProvider {
  name: string;
  baseUrl: string;
  getHeaders: () => Record<string, string>;
  // Optional: override the request body before sending
  formatBody?: (body: any) => any;
  // Optional: dynamically fetch available models for this provider
  getModels?: () => Promise<Array<{ id: string; object: string; owned_by: string }>>;
}