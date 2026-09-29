import { proxyPluginAdmin } from "@/lib/plugin-admin";

export function GET() {
  return proxyPluginAdmin("/admin/plugins/catalog");
}
