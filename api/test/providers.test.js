import { afterEach, describe, expect, it, vi } from "vitest";

process.env.PCLOUD_CLIENT_ID = "pc-id";
process.env.PCLOUD_CLIENT_SECRET = "pc-secret";
const { pcloud } = await import("../src/providers/pcloud.js");
const { koofr } = await import("../src/providers/koofr.js");

const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());

describe("pCloud", () => {
  it("exchanges the code on the account's own data centre (EU vs US)", async () => {
    const fetch = vi.fn(async () => jsonRes({ result: 0, access_token: "tok", token_type: "bearer" }));
    vi.stubGlobal("fetch", fetch);
    const { refreshToken } = await pcloud.exchangeCode("code1", { hostname: "eapi.pcloud.com" });
    expect(fetch.mock.calls[0][0]).toBe("https://eapi.pcloud.com/oauth2_token");
    expect(JSON.parse(refreshToken)).toEqual({ token: "tok", host: "eapi.pcloud.com" });
  });

  it("never sends the code to an unexpected host", async () => {
    const fetch = vi.fn(async () => jsonRes({ result: 0, access_token: "tok" }));
    vi.stubGlobal("fetch", fetch);
    await pcloud.exchangeCode("code1", { hostname: "evil.example" });
    expect(fetch.mock.calls[0][0]).toBe("https://api.pcloud.com/oauth2_token");
  });

  it("maps pCloud's in-body auth errors to 401 so the user is asked to reconnect", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes({ result: 2094, error: "Invalid access_token" })));
    await expect(pcloud.quota(JSON.stringify({ token: "t", host: "api.pcloud.com" }))).rejects.toMatchObject({ status: 401 });
  });

  it("reports quota from userinfo", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes({ result: 0, quota: 10_737_418_240, usedquota: 1_073_741_824 })));
    expect(await pcloud.quota({ token: "t", host: "api.pcloud.com" })).toEqual({ total: 10_737_418_240, used: 1_073_741_824, free: 9_663_676_416 });
  });
});

describe("Koofr", () => {
  it("rejects a wrong app password with a helpful message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    await expect(koofr.verify({ email: "a@b.c", password: "nope" })).rejects.toMatchObject({ code: "bad_credentials" });
  });

  it("stores email + app password and authenticates with Basic auth", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 207 }));
    vi.stubGlobal("fetch", fetch);
    const cred = await koofr.verify({ email: "a@b.c", password: "app-pass" });
    expect(JSON.parse(cred)).toEqual({ email: "a@b.c", password: "app-pass" });
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe(`Basic ${Buffer.from("a@b.c:app-pass").toString("base64")}`);
  });

  const davStatus = (taken) => (_url, init) =>
    new Response("", { status: { MKCOL: 405, PROPFIND: taken ? 207 : 404 }[init.method] ?? 201 });

  it("uploads into OmniCloud/<folder> over WebDAV (existing folders are fine)", async () => {
    const fetch = vi.fn(davStatus(false));
    vi.stubGlobal("fetch", fetch);
    const out = await koofr.upload(JSON.stringify({ email: "a@b.c", password: "p" }), {
      name: "abc def.jpg",
      folder: ["Trips", "Goa"],
      mime: "image/jpeg",
      buffer: Buffer.from("x"),
      hash: "0123456789abcdef",
    });
    expect(out.id).toBe("OmniCloud/Trips/Goa/abc def.jpg");
    expect(fetch.mock.calls.filter(([, i]) => i.method === "MKCOL").map(([u]) => u)).toEqual([
      "https://app.koofr.net/dav/Koofr/OmniCloud",
      "https://app.koofr.net/dav/Koofr/OmniCloud/Trips",
      "https://app.koofr.net/dav/Koofr/OmniCloud/Trips/Goa",
    ]);
    const put = fetch.mock.calls.find(([, i]) => i.method === "PUT");
    expect(put[0]).toBe("https://app.koofr.net/dav/Koofr/OmniCloud/Trips/Goa/abc%20def.jpg");
  });

  it("a same-named file landing at the same moment can't be overwritten (create-only PUT → 412)", async () => {
    const fetch = vi.fn(async (_url, init) =>
      new Response("", {
        status: { MKCOL: 405, PROPFIND: 404 }[init.method] ?? (init.headers["If-None-Match"] === "*" ? 412 : 201),
      })
    );
    vi.stubGlobal("fetch", fetch);
    const out = await koofr.upload(JSON.stringify({ email: "a@b.c", password: "p" }), {
      name: "IMG_1.jpg",
      mime: "image/jpeg",
      buffer: Buffer.from("x"),
      hash: "0123456789abcdef",
    });
    expect(out.name).toBe("IMG_1 (01234567).jpg");
    const puts = fetch.mock.calls.filter(([, i]) => i.method === "PUT");
    expect(puts[0][1].headers["If-None-Match"]).toBe("*");
  });

  it("never overwrites a different file with the same name", async () => {
    vi.stubGlobal("fetch", vi.fn(davStatus(true)));
    const out = await koofr.upload(JSON.stringify({ email: "a@b.c", password: "p" }), {
      name: "IMG_1.jpg",
      mime: "image/jpeg",
      buffer: Buffer.from("x"),
      hash: "0123456789abcdef",
    });
    expect(out).toEqual({ id: "OmniCloud/IMG_1 (01234567).jpg", name: "IMG_1 (01234567).jpg" });
  });

  it("reads quota (MB) from the primary mount", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes({ mounts: [{ isPrimary: true, spaceTotal: 10240, spaceUsed: 1024 }] })));
    const q = await koofr.quota({ email: "a@b.c", password: "p" });
    expect(q.total).toBe(10240 * 1024 * 1024);
    expect(q.used).toBe(1024 * 1024 * 1024);
  });
});
