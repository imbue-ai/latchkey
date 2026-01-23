import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ApiCredentialStore } from "../src/apiCredentialStore.js";
import {
  AuthorizationBearer,
  AuthorizationBare,
  SlackApiCredentials,
} from "../src/apiCredentials.js";

describe("ApiCredentialStore", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "latchkey-test-"));
    storePath = join(tempDir, "credentials.json");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("get", () => {
    it("should return null for non-existent store file", () => {
      const store = new ApiCredentialStore(storePath);
      expect(store.get("slack")).toBeNull();
    });

    it("should return null for non-existent service", () => {
      const store = new ApiCredentialStore(storePath);
      store.save("discord", new AuthorizationBare("token"));
      expect(store.get("slack")).toBeNull();
    });

    it("should retrieve saved AuthorizationBearer credentials", () => {
      const store = new ApiCredentialStore(storePath);
      const credentials = new AuthorizationBearer("test-token");
      store.save("github", credentials);

      const retrieved = store.get("github");
      expect(retrieved).toBeInstanceOf(AuthorizationBearer);
      expect((retrieved as AuthorizationBearer).token).toBe("test-token");
    });

    it("should retrieve saved AuthorizationBare credentials", () => {
      const store = new ApiCredentialStore(storePath);
      const credentials = new AuthorizationBare("discord-token");
      store.save("discord", credentials);

      const retrieved = store.get("discord");
      expect(retrieved).toBeInstanceOf(AuthorizationBare);
      expect((retrieved as AuthorizationBare).token).toBe("discord-token");
    });

    it("should retrieve saved SlackApiCredentials", () => {
      const store = new ApiCredentialStore(storePath);
      const credentials = new SlackApiCredentials("xoxc-token", "d-cookie");
      store.save("slack", credentials);

      const retrieved = store.get("slack");
      expect(retrieved).toBeInstanceOf(SlackApiCredentials);
      expect((retrieved as SlackApiCredentials).token).toBe("xoxc-token");
      expect((retrieved as SlackApiCredentials).dCookie).toBe("d-cookie");
    });
  });

  describe("save", () => {
    it("should create the store file if it does not exist", () => {
      const store = new ApiCredentialStore(storePath);
      store.save("github", new AuthorizationBearer("token"));
      expect(existsSync(storePath)).toBe(true);
    });

    it("should create parent directories if they do not exist", () => {
      const nestedPath = join(tempDir, "nested", "deep", "credentials.json");
      const store = new ApiCredentialStore(nestedPath);
      store.save("github", new AuthorizationBearer("token"));
      expect(existsSync(nestedPath)).toBe(true);
    });

    it("should overwrite existing credentials for the same service", () => {
      const store = new ApiCredentialStore(storePath);
      store.save("github", new AuthorizationBearer("old-token"));
      store.save("github", new AuthorizationBearer("new-token"));

      const retrieved = store.get("github");
      expect((retrieved as AuthorizationBearer).token).toBe("new-token");
    });

    it("should preserve other services when saving", () => {
      const store = new ApiCredentialStore(storePath);
      store.save("github", new AuthorizationBearer("github-token"));
      store.save("discord", new AuthorizationBare("discord-token"));

      expect(store.get("github")).not.toBeNull();
      expect(store.get("discord")).not.toBeNull();
    });

    it("should write valid JSON", () => {
      const store = new ApiCredentialStore(storePath);
      store.save("github", new AuthorizationBearer("token"));

      const content = readFileSync(storePath, "utf-8");
      expect(() => JSON.parse(content)).not.toThrow();
    });
  });

  describe("delete", () => {
    it("should return false for non-existent service", () => {
      const store = new ApiCredentialStore(storePath);
      expect(store.delete("github")).toBe(false);
    });

    it("should return false for non-existent store file", () => {
      const store = new ApiCredentialStore(storePath);
      expect(store.delete("github")).toBe(false);
    });

    it("should delete existing credentials and return true", () => {
      const store = new ApiCredentialStore(storePath);
      store.save("github", new AuthorizationBearer("token"));
      expect(store.delete("github")).toBe(true);
      expect(store.get("github")).toBeNull();
    });

    it("should preserve other services when deleting", () => {
      const store = new ApiCredentialStore(storePath);
      store.save("github", new AuthorizationBearer("github-token"));
      store.save("discord", new AuthorizationBare("discord-token"));

      store.delete("github");

      expect(store.get("github")).toBeNull();
      expect(store.get("discord")).not.toBeNull();
    });
  });

  describe("multiple credential types", () => {
    it("should store and retrieve different credential types", () => {
      const store = new ApiCredentialStore(storePath);

      store.save("github", new AuthorizationBearer("github-token"));
      store.save("discord", new AuthorizationBare("discord-token"));
      store.save("slack", new SlackApiCredentials("slack-token", "slack-cookie"));

      const github = store.get("github");
      const discord = store.get("discord");
      const slack = store.get("slack");

      expect(github).toBeInstanceOf(AuthorizationBearer);
      expect(discord).toBeInstanceOf(AuthorizationBare);
      expect(slack).toBeInstanceOf(SlackApiCredentials);
    });
  });
});
