import nock from "nock";
import { buildServer } from "../src/server";
import { getRedis } from "../src/redisClient";

const BASE = (process.env.TOQAN_BASE_URL || "https://api.coco.prod.toqan.ai/api").replace(/\/+$/, "");

describe("complete flow", () => {
  let server: any;
  beforeAll(async () => {
    server = buildServer();
    await server.listen({ port: 0 }); // ephemeral port
  });

  afterAll(async () => {
    await server.close();
    const r = getRedis();
    try { (await r).disconnect(); } catch {}
  });

  test("create -> get_answer -> complete", async () => {
    // Clear any existing session data
    const r = getRedis();
    await r.del("toqan:conv_map");
    
    // Mock create conversation for new session
    nock(BASE)
      .post("/create_conversation")
      .reply(200, { conversation_id: "conv-1", request_id: "req-1" });

    // first get_answer returns processing, then finished
    let calls = 0;
    nock(BASE)
      .get("/get_answer")
      .query(true)
      .times(2)
      .reply(function () {
        calls++;
        if (calls === 1) return [200, { status: "processing", answer: "" }];
        return [200, { status: "finished", answer: "ola" }];
      });

    const payload = {
      model: "claude",
      messages: [{ role: "user", content: "oi" }],
      conversation_id: "session-test-1"
    };

    const res = await server.inject({
      method: "POST",
      url: "/v1/complete",
      payload
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.completion).toBe("ola");
  });
});
