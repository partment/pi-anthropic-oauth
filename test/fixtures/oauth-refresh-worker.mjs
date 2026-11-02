import { refreshAnthropicToken } from "../../.test-dist/auth.js";
import { AuthStorage } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";
import { resolveProviderAuth } from "../../node_modules/@earendil-works/pi-ai/dist/auth/resolve.js";

const store = AuthStorage.create(process.argv[2]);
// The parent simulates token exchange over IPC. Never contact Anthropic.
globalThis.fetch = async (_url, init) => {
  const reply = new Promise((resolve) => process.once("message", resolve));
  process.send({ type: "refresh", token: JSON.parse(init.body).refresh_token });
  const response = await reply;
  if (response.networkError) throw new TypeError("simulated network failure");
  return Response.json(response.body, { status: response.status });
};
const start = new Promise((resolve) => process.once("message", resolve));
process.send({ type: "ready" });
await start;
try {
  const result = await resolveProviderAuth({
    id: "anthropic",
    auth: { oauth: {
      refresh: async (credential, signal) => ({
        ...await refreshAnthropicToken(credential, signal), type: "oauth",
      }),
      toAuth: async (credential) => ({ apiKey: credential.access }),
    } },
  }, store, {});
  process.send({ type: "result", access: result.auth.apiKey });
} catch (error) {
  process.send({ type: "failure", message: error.message });
  process.exitCode = 1;
}
process.disconnect();
