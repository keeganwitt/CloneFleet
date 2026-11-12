import { describe, expect, it } from "vitest";
import {
  findAndReplace,
  formatWebHosts,
  parseWebHosts,
  webUrl,
  httpsToSsh,
  parseRemoteUrl,
  planUrlChanges,
  sshToHttps,
} from "./remoteUrls";

describe("parseRemoteUrl", () => {
  it("parses scp-like, ssh, and https URLs including GitLab subgroups", () => {
    expect(parseRemoteUrl("git@github.com:org/repo.git")).toEqual({
      protocol: "ssh",
      user: "git",
      host: "github.com",
      port: null,
      path: "org/repo.git",
    });
    expect(parseRemoteUrl("ssh://git@gitlab.example.com:2222/group/sub/repo.git")).toEqual({
      protocol: "ssh",
      user: "git",
      host: "gitlab.example.com",
      port: "2222",
      path: "group/sub/repo.git",
    });
    expect(parseRemoteUrl("https://github.com/org/repo")).toMatchObject({
      protocol: "https",
      host: "github.com",
      path: "org/repo",
    });
  });

  it("rejects local paths and unknown schemes", () => {
    expect(parseRemoteUrl("/srv/git/repo.git")).toBeNull();
    expect(parseRemoteUrl("C:\\\\repos\\\\x")).toBeNull();
    expect(parseRemoteUrl("file:///srv/repo.git")).toBeNull();
  });
});

describe("conversions", () => {
  it("converts between HTTPS and SSH", () => {
    expect(httpsToSsh("https://github.com/org/repo.git")).toBe("git@github.com:org/repo.git");
    expect(sshToHttps("git@github.com:org/repo.git")).toBe("https://github.com/org/repo.git");
    expect(sshToHttps("ssh://git@host:2222/g/r.git")).toBe("https://host/g/r.git");
    expect(httpsToSsh("git@github.com:org/repo.git")).toBeNull();
    expect(sshToHttps("https://github.com/org/repo.git")).toBeNull();
  });

  it("finds and replaces literal text", () => {
    const rename = findAndReplace("github.com/old-org/", "github.com/new-org/");
    expect(rename("https://github.com/old-org/a.git")).toBe("https://github.com/new-org/a.git");
    expect(rename("https://github.com/other/a.git")).toBeNull();
    expect(findAndReplace("", "x")("anything")).toBeNull();
  });
});

describe("planUrlChanges", () => {
  it("keeps only rows the transform actually changes", () => {
    const rows = [
      { repo: "/a", remote: "origin", url: "https://github.com/org/a.git" },
      { repo: "/b", remote: "origin", url: "git@github.com:org/b.git" },
    ];
    expect(planUrlChanges(rows, httpsToSsh)).toEqual([
      { ...rows[0], newUrl: "git@github.com:org/a.git" },
    ]);
  });
});

describe("webUrl", () => {
  it("derives a web address from any remote form, including private GitLab subgroups", () => {
    expect(webUrl("git@github.com:org/repo.git", [])).toBe("https://github.com/org/repo");
    expect(webUrl("ssh://git@gitlab.corp.example:2222/group/sub/repo.git", [])).toBe(
      "https://gitlab.corp.example/group/sub/repo",
    );
    expect(webUrl("https://gitlab.corp.example/group/repo/", [])).toBe(
      "https://gitlab.corp.example/group/repo",
    );
    expect(webUrl("/srv/git/repo.git", [])).toBeNull();
  });

  it("maps SSH aliases and odd hosts to their web base URL", () => {
    const hosts = parseWebHosts(
      "gitlab-work = https://gitlab.example.com/\nbroken line\nssh.git.example.com = https://example.com/gitlab",
    );
    expect(hosts).toEqual([
      { host: "gitlab-work", webUrl: "https://gitlab.example.com/" },
      { host: "ssh.git.example.com", webUrl: "https://example.com/gitlab" },
    ]);
    expect(webUrl("git@gitlab-work:team/app.git", hosts)).toBe(
      "https://gitlab.example.com/team/app",
    );
    expect(webUrl("git@ssh.git.example.com:a/b.git", hosts)).toBe("https://example.com/gitlab/a/b");
    expect(formatWebHosts(hosts)).toBe(
      "gitlab-work = https://gitlab.example.com/\nssh.git.example.com = https://example.com/gitlab",
    );
  });
});
