import nock from "nock";
import { buildServer } from "../src/server";
import { getRedis } from "../src/redisClient";

const BASE = (process.env.TOQAN_BASE_URL || "https://api.coco.prod.toqan.ai/api").replace(/\/+$/, "");

describe("streaming", () => {
  let server: any;
  beforeAll(async () => {
    server = buildServer();
    await server.listen({ port: 0 });
  });

  afterAll(async () => {
    await server.close();
  });

  test("stream yields deltas and done marker", async () => {
    // Clear any existing session data  
    const r = getRedis();
    await r.del("toqan:conv_map");
    
    nock(BASE).post("/create_conversation").reply(200, { conversation_id: "conv-stream", request_id: "req-s" });

    const seq = [
      { status: "processing", answer: "" },
      { status: "processing", answer: "parte1" },
      { status: "processing", answer: "parte1parte2" },
      { status: "finished", answer: "parte1parte2" }
    ];
    let i = 0;
    nock(BASE).get("/get_answer").query(true).times(4).reply(200, () => {
      const resp = seq[i] || seq[seq.length - 1];
      i++;
      return resp;
    });

    const payload = { messages: [{ role: "user", content: "stream" }], conversation_id: "sess-stream" };
    const res = await server.inject({ method: "POST", url: "/v1/complete/stream", payload, headers: { accept: "text/event-stream" } });
    expect(res.statusCode).toBe(200);
    // read raw payload
    const raw = res.raw.payload || res.payload;
    // since server.inject returns buffered payload only after completion, assert content includes some chunk
    expect(raw.toString()).toMatch(/parte1/);
    expect(raw.toString()).toMatch(/"done":true|{"done":true}/);
  });
});
