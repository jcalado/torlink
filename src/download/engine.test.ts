import { EventEmitter } from "node:events";
import { describe, it, expect, vi, afterEach } from "vitest";
import type { TorrentFile } from "webtorrent";

// Build a minimal TorrentFile — pickBestFile only reads name and length.
function file(name: string, length: number): TorrentFile {
  return { name, path: name, length };
}

const constructorCalls: Record<string, unknown>[] = [];

vi.mock("webtorrent", () => {
  return {
    default: class extends EventEmitter {
      torrentPort = 6881;
      constructor(opts?: Record<string, unknown>) {
        super();
        constructorCalls.push(opts ?? {});
      }
      add(): EventEmitter {
        return new EventEmitter();
      }
      destroy(): void {}
    },
  };
});

afterEach(() => {
  constructorCalls.length = 0;
  vi.resetModules();
});

describe("TorrentEngine macOS port-5350 fix (#22)", () => {
  it("passes natPmp:false on macOS so mDNSResponder's port 5350 is never bound", async () => {
    const { TorrentEngine } = await import("./engine");
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const engine = new TorrentEngine();
      engine.add(
        "test-id",
        "magnet:?xt=urn:btih:0000000000000000000000000000000000000000",
        "/downloads",
        {},
      );
      engine.destroy();
    } finally {
      Object.defineProperty(process, "platform", { value: original });
    }
    expect(constructorCalls).toHaveLength(1);
    expect(constructorCalls[0]).toMatchObject({ natPmp: false });
  });

  it("does not disable natPmp on Linux (port 5350 is free)", async () => {
    const { TorrentEngine } = await import("./engine");
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      const engine = new TorrentEngine();
      engine.add(
        "test-id",
        "magnet:?xt=urn:btih:0000000000000000000000000000000000000000",
        "/downloads",
        {},
      );
      engine.destroy();
    } finally {
      Object.defineProperty(process, "platform", { value: original });
    }
    expect(constructorCalls).toHaveLength(1);
    expect(constructorCalls[0]).not.toHaveProperty("natPmp", false);
  });

  it("does not disable natPmp on Windows (port 5350 is free)", async () => {
    const { TorrentEngine } = await import("./engine");
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const engine = new TorrentEngine();
      engine.add(
        "test-id",
        "magnet:?xt=urn:btih:0000000000000000000000000000000000000000",
        "/downloads",
        {},
      );
      engine.destroy();
    } finally {
      Object.defineProperty(process, "platform", { value: original });
    }
    expect(constructorCalls).toHaveLength(1);
    expect(constructorCalls[0]).not.toHaveProperty("natPmp", false);
  });

  it("stats(id) ignores getter errors and returns safe defaults", async () => {
    const { TorrentEngine } = await import("./engine");
    const engine = new TorrentEngine();
    const fakeTorrent = new EventEmitter();
    Object.defineProperty(fakeTorrent, "progress", {
      get() {
        throw new Error("Metadata not ready");
      },
    });
    Object.defineProperty(fakeTorrent, "length", {
      get() {
        throw new Error("Metadata not ready");
      },
    });
    // Inject fakeTorrent directly into private torrents map
    (engine as unknown as { torrents: Map<string, unknown> }).torrents.set("bad-id", fakeTorrent);

    const result = engine.stats("bad-id");
    expect(result).not.toBeNull();
    expect(result?.progress).toBe(0);
    expect(result?.total).toBe(0);
    engine.destroy();
  });
});

describe("pickBestFile (stream target selection)", () => {
  it("returns null for an empty file list", async () => {
    const { pickBestFile } = await import("./engine");
    expect(pickBestFile([])).toBeNull();
  });

  it("prefers the largest media file over a larger non-media file", async () => {
    const { pickBestFile } = await import("./engine");
    const picked = pickBestFile([
      file("readme.txt", 500),
      file("movie.mkv", 100),
      file("bigger.iso", 9000), // largest overall, but not playable
      file("feature.mp4", 200), // largest among media files
    ]);
    expect(picked?.name).toBe("feature.mp4");
  });

  it("falls back to the largest file when none are media", async () => {
    const { pickBestFile } = await import("./engine");
    const picked = pickBestFile([
      file("small.bin", 10),
      file("big.bin", 999),
    ]);
    expect(picked?.name).toBe("big.bin");
  });

  it("matches media extensions case-insensitively", async () => {
    const { pickBestFile } = await import("./engine");
    const picked = pickBestFile([file("notes.txt", 800), file("EPISODE.MKV", 100)]);
    expect(picked?.name).toBe("EPISODE.MKV");
  });
});

describe("TorrentEngine.getStreamUrl", () => {
  it("returns null when the torrent has no metadata yet (no file list)", async () => {
    const { TorrentEngine } = await import("./engine");
    const engine = new TorrentEngine();
    // Mocked add() yields a torrent with no `files` — a magnet pre-metadata.
    engine.add(
      "test-id",
      "magnet:?xt=urn:btih:0000000000000000000000000000000000000000",
      "/downloads",
      {},
    );
    await expect(engine.getStreamUrl("test-id")).resolves.toBeNull();
    engine.destroy();
  });

  it("returns null for an unknown torrent id", async () => {
    const { TorrentEngine } = await import("./engine");
    const engine = new TorrentEngine();
    await expect(engine.getStreamUrl("missing")).resolves.toBeNull();
    engine.destroy();
  });
});

describe("TorrentEngine.filePaths", () => {
  it("lists a torrent's file paths, and nothing for an unknown id", async () => {
    const { TorrentEngine } = await import("./engine");
    const engine = new TorrentEngine();
    const fakeTorrent = Object.assign(new EventEmitter(), {
      files: [{ path: "Course/1.mp4" }, { path: "Course/2.mp4" }],
    });
    (engine as unknown as { torrents: Map<string, unknown> }).torrents.set("course", fakeTorrent);

    expect(engine.filePaths("course")).toEqual(["Course/1.mp4", "Course/2.mp4"]);
    expect(engine.filePaths("missing")).toEqual([]);
    engine.destroy();
  });
});

describe("TorrentEngine uTP opt-out (TORLINK_NO_UTP)", () => {
  it("leaves uTP on by default, the way other BitTorrent clients ship it", async () => {
    const { TorrentEngine } = await import("./engine");
    const original = process.env.TORLINK_NO_UTP;
    delete process.env.TORLINK_NO_UTP;
    try {
      const engine = new TorrentEngine();
      engine.add(
        "test-id",
        "magnet:?xt=urn:btih:0000000000000000000000000000000000000000",
        "/downloads",
        {},
      );
      engine.destroy();
    } finally {
      if (original === undefined) delete process.env.TORLINK_NO_UTP;
      else process.env.TORLINK_NO_UTP = original;
    }
    expect(constructorCalls).toHaveLength(1);
    expect(constructorCalls[0]).not.toHaveProperty("utp", false);
  });

  it("passes utp:false when TORLINK_NO_UTP is set, so utp-native cannot exhaust sockets", async () => {
    const { TorrentEngine } = await import("./engine");
    const original = process.env.TORLINK_NO_UTP;
    process.env.TORLINK_NO_UTP = "1";
    try {
      const engine = new TorrentEngine();
      engine.add(
        "test-id",
        "magnet:?xt=urn:btih:0000000000000000000000000000000000000000",
        "/downloads",
        {},
      );
      engine.destroy();
    } finally {
      if (original === undefined) delete process.env.TORLINK_NO_UTP;
      else process.env.TORLINK_NO_UTP = original;
    }
    expect(constructorCalls).toHaveLength(1);
    expect(constructorCalls[0]).toMatchObject({ utp: false });
  });
});

describe("TorrentEngine ready handler", () => {
  it("calls onReady once webtorrent has checked the pieces on disk", async () => {
    const { TorrentEngine } = await import("./engine");
    const engine = new TorrentEngine();
    const onReady = vi.fn();
    engine.add(
      "test-id",
      "magnet:?xt=urn:btih:0000000000000000000000000000000000000000",
      "/downloads",
      { onReady },
    );
    // The queue starts a restored seed's missing-file watch from this, so a
    // dropped listener would leave those seeds unwatched.
    const torrent = (engine as unknown as { torrents: Map<string, EventEmitter> }).torrents.get("test-id");
    expect(onReady).not.toHaveBeenCalled();
    torrent?.emit("ready");
    expect(onReady).toHaveBeenCalledTimes(1);
    engine.destroy();
  });
});
