export interface ProxyProvider {
    name: string;
    baseUrl: string;
    getHeaders: () => Record<string, string>;
    formatBody?: (body: any) => any;
    getModels?: () => Promise<Array<{
        id: string;
        object: string;
        owned_by: string;
    }>>;
}
//# sourceMappingURL=types.d.ts.map