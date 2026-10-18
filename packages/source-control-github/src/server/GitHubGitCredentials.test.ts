import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FileSystem from "effect/FileSystem";
import * as TestClock from "effect/testing/TestClock";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  DEFAULT_SERVER_SETTINGS,
  SourceControlProviderKind,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubQuota from "./GitHubQuota.ts";
import * as GitHubSourceControlProvider from "./GitHubSourceControlProvider.ts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";

const output = (
  stdout: string,
  extra: Partial<SourceControlHost.SourceControlProcessOutput> = {},
) => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  ...extra,
});
const response = (path: string, token = "fake-token") =>
  `protocol=https\nhost=github.com\npath=${path}\nusername=Chinoman10\npassword=${token}\n`;

function harness(
  options: {
    enabled?: boolean;
    disabledHost?: boolean;
    cwd?: string;
    run?: SourceControlHost.SourceControlHost["Service"]["process"]["run"];
  } = {},
) {
  const calls: SourceControlHost.SourceControlProcessInput[] = [];
  const run: SourceControlHost.SourceControlHost["Service"]["process"]["run"] = (input) => {
    calls.push(input);
    return (
      options.run?.(input) ??
      Effect.succeed(
        output(
          response(/path=(.*)\n/.exec(input.stdin ?? "")?.[1] ?? "missing", `fake-${calls.length}`),
        ),
      )
    );
  };
  const layer = GitHubCredentials.layer.pipe(
    Layer.provideMerge(
      TestSourceControlHost.layer({
        process: { run },
        settings: applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
          sourceControlHosts: {
            github: {
              tokens: { "github.com": "settings-token" },
              hosts: {
                "github.com": { enabled: !options.disabledHost },
              },
            },
          },
        }),
      }),
    ),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(
      Layer.succeed(HostProcess.Environment, {
        T3CODE_GITHUB_USE_GIT_CREDENTIALS: options.enabled === false ? "0" : "1",
        GH_TOKEN: "env-token",
      }),
    ),
    Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, options.cwd ?? "/trusted-server")),
  );
  return { calls, layer };
}

describe("repository Git credentials", () => {
  it.effect(
    "honors real global owner stores with useHttpPath=false and ignores repository helpers",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-git-owner-credentials-",
        });
        const globalConfig = `${directory}/global-config`;
        const run: SourceControlHost.SourceControlHost["Service"]["process"]["run"] = (input) =>
          Effect.scoped(
            Effect.gen(function* () {
              const child = yield* spawner.spawn(
                ChildProcess.make(input.command, input.args, {
                  cwd: input.cwd,
                  env: {
                    ...process.env,
                    HOME: directory,
                    XDG_CONFIG_HOME: directory,
                    GIT_CONFIG_GLOBAL: globalConfig,
                    GIT_CONFIG_SYSTEM: "/dev/null",
                    ...input.env,
                  },
                  stdin: Stream.encodeText(Stream.make(input.stdin ?? "")),
                }),
              );
              const text = (stream: typeof child.stdout) =>
                stream.pipe(
                  Stream.decodeText,
                  Stream.runFold(
                    () => "",
                    (all, chunk) => all + chunk,
                  ),
                );
              const [stdout, stderr, exitCode] = yield* Effect.all(
                [text(child.stdout), text(child.stderr), child.exitCode],
                { concurrency: "unbounded" },
              );
              return output(stdout, { stderr, exitCode });
            }),
          ).pipe(Effect.orDie);
        yield* fs.writeFileString(
          globalConfig,
          `[credential]\n\thelper =\n\tuseHttpPath = true\n` +
            ["OwnerA", "OwnerB"]
              .map(
                (owner) =>
                  `[credential "https://github.com/${owner}"]\n\thelper = store --file=${directory}/${owner}.store\n\tuseHttpPath = false\n`,
              )
              .join(""),
        );
        for (const owner of ["OwnerA", "OwnerB"])
          yield* fs.writeFileString(
            `${directory}/${owner}.store`,
            `https://Chinoman10:fake-${owner}@github.com\n`,
          );
        yield* run({
          operation: "fixture",
          command: "git",
          args: ["init", "--quiet"],
          cwd: directory,
        });
        yield* fs.writeFileString(
          `${directory}/.git/config`,
          '[credential]\n\thelper = "!f() { echo username=local; echo password=repo-local; }; f"\n',
        );
        let remotes = "";
        let resolved = "";
        let helperReady: Deferred.Deferred<void> | undefined;
        const { layer, calls } = harness({
          cwd: directory,
          run: (input) =>
            input.operation === "GitHubSourceControlProvider.resolveRepository"
              ? Effect.succeed(output(input.args[0] === "remote" ? remotes : resolved))
              : run(input).pipe(
                  Effect.tap(() =>
                    helperReady === undefined
                      ? Effect.void
                      : Deferred.succeed(helperReady, undefined),
                  ),
                ),
        });
        yield* Effect.gen(function* () {
          const credentials = yield* GitHubCredentials.GitHubCredentials;
          expect(Redacted.value((yield* credentials.get("github.com", "OwnerA/Repo")).token)).toBe(
            "fake-OwnerA",
          );
          expect(Redacted.value((yield* credentials.get("github.com", "OwnerB/Repo")).token)).toBe(
            "fake-OwnerB",
          );
        }).pipe(Effect.provide(layer));
        const authorizations: Array<string | undefined> = [];
        const http = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            authorizations.push(request.headers.authorization);
            if (request.url.endsWith("/graphql")) {
              expect(request.body._tag).toBe("Uint8Array");
              if (request.body._tag === "Uint8Array") {
                const payload = JSON.parse(new TextDecoder().decode(request.body.body)) as {
                  variables: Record<string, unknown>;
                };
                const names = Object.entries(payload.variables)
                  .filter(([key]) => key === "name" || key.endsWith("_name"))
                  .map(([, value]) => value);
                expect(names).toEqual(["Repo"]);
              }
            } else {
              expect(new URL(request.url).pathname).toMatch(/^\/repos\/OwnerA\/Repo(?:\/|$)/);
            }
            const body = request.url.endsWith("/graphql")
              ? {
                  data: {
                    repository: { pullRequests: { nodes: [] } },
                    _0_repository: { pullRequests: { nodes: [] } },
                  },
                }
              : {
                  full_name: "OwnerA/Repo",
                  html_url: "https://github.com/OwnerA/Repo",
                  ssh_url: "git@github.com:OwnerA/Repo.git",
                  default_branch: "main",
                };
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(JSON.stringify(body), {
                  headers: { "content-type": "application/json" },
                }),
              ),
            );
          }),
        );
        const transport = GitHubRest.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(layer, http, GitHubQuota.layer, SourceControlRateLimit.layer),
          ),
        );
        yield* Effect.gen(function* () {
          const credentials = yield* GitHubCredentials.GitHubCredentials;
          const provider = yield* GitHubSourceControlProvider.make;
          const bodyFile = `${directory}/pr-body`;
          yield* fs.writeFileString(bodyFile, "fixture pull request");
          for (const scenario of [
            { remote: "https://github.com/OwnerA/Repo.git", contextOnly: true },
            { remote: "git@github-work:OwnerA/Repo.git", contextOnly: true },
            { remote: "https://github.com/OwnerA/Repo.git" },
            { remote: "ssh://git@github.com/OwnerA/Repo.git" },
            { remote: "git@github.com:OwnerA/Repo.git" },
            { remote: "git@github-work:OwnerA/Repo.git" },
            { remote: "https://github.com/OwnerA/Repo.git/", contextOnly: true },
            { remote: "ssh://git@github.com/OwnerA/Repo.git/" },
            { remote: "git@github.com:OwnerA/Repo.git/" },
            { remote: "git@github-work:OwnerA/Repo.git/" },
            { remote: "git@github.com:OwnerA/Repo.git", resolved: "base" },
            { remote: "git@github.com:Other/Repo.git", resolved: "OwnerA/Repo" },
          ]) {
            remotes = scenario.contextOnly ? "" : `origin\t${scenario.remote} (fetch)`;
            resolved =
              scenario.resolved === undefined
                ? ""
                : `remote.origin.gh-resolved ${scenario.resolved}`;
            const context = {
              provider: {
                kind: SourceControlProviderKind.make("github"),
                name: "GitHub",
                baseUrl: "https://github.com",
              },
              remoteName: "origin",
              remoteUrl: scenario.remote,
            };
            yield* credentials.invalidate("github.com", "OwnerA/Repo");
            expect(yield* provider.getDefaultBranch({ cwd: directory, context })).toBe("main");
            yield* credentials.invalidate("github.com", "OwnerA/Repo");
            helperReady = yield* Deferred.make<void>();
            const pending = yield* provider
              .listChangeRequests({
                cwd: directory,
                context,
                headSelector: "feature",
                state: "open",
              })
              .pipe(Effect.forkChild);
            yield* Deferred.await(helperReady);
            yield* TestClock.adjust("500 millis");
            expect(yield* Fiber.join(pending)).toEqual([]);
            helperReady = undefined;
            yield* provider.createChangeRequest({
              cwd: directory,
              context,
              baseRefName: "main",
              headSelector: "feature",
              title: "fixture",
              bodyFile,
            });
          }
          expect(authorizations).toHaveLength(36);
          expect(authorizations.every((value) => value === "Bearer fake-OwnerA")).toBe(true);
          const paths = calls
            .filter((input) => input.operation === "GitHubCredentials.git")
            .map((input) => /path=(.*)\n/.exec(input.stdin ?? "")?.[1]);
          expect(paths.slice(2)).toEqual(Array(24).fill("OwnerA/Repo.git"));
        }).pipe(
          Effect.provide(transport),
          Effect.provideService(HostProcess.Environment, {
            T3CODE_GITHUB_USE_GIT_CREDENTIALS: "1",
          }),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps legacy precedence when off, and host-only operations use Settings", () => {
    const { layer, calls } = harness({ enabled: false });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      expect(Redacted.value((yield* credentials.get("github.com", "Owner/Repo")).token)).toBe(
        "settings-token",
      );
      expect(Redacted.value((yield* credentials.get("github.com")).token)).toBe("settings-token");
      expect(calls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("selects and caches different PATs for the same login by repository", () => {
    const { layer, calls } = harness();
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const first = yield* credentials.get("GitHub.com", "OwnerA/Repo.git");
      const second = yield* credentials.get("github.com", "OwnerB/Repo");
      expect(first.fingerprint).not.toBe(second.fingerprint);
      expect(first.source).toBe("git");
      expect(first.repository).toBe("ownera/repo");
      expect(Redacted.value(first.token)).toBe("fake-1");
      expect(Redacted.value(second.token)).toBe("fake-2");
      expect((yield* credentials.get("github.com", "ownera/repo")).fingerprint).toBe(
        first.fingerprint,
      );
      yield* credentials.invalidate("github.com", "OwnerA/Repo");
      expect((yield* credentials.get("github.com", "ownera/repo")).fingerprint).not.toBe(
        first.fingerprint,
      );
      expect((yield* credentials.get("github.com", "OwnerB/Repo")).fingerprint).toBe(
        second.fingerprint,
      );
      expect(calls).toHaveLength(3);
      expect(calls[0]?.stdin).toBe("protocol=https\nhost=github.com\npath=OwnerA/Repo.git\n\n");
      expect(calls[0]?.cwd).toBe("/trusted-server");
      expect(calls[0]?.env).toMatchObject({
        GIT_DIR: "",
        GIT_CONFIG_COUNT: "0",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        SSH_ASKPASS: "",
        GCM_INTERACTIVE: "never",
        GIT_TRACE: "0",
      });
      expect(calls[0]?.args).toEqual(["-c", "credential.interactive=false", "credential", "fill"]);
      expect(calls[0]?.timeoutMs).toBe(10_000);
      expect(calls[0]?.maxOutputBytes).toBe(16_384);
      expect(calls[0]?.outputMode).toBe("error");
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not run helpers for a disabled host or arbitrary host", () => {
    const { layer, calls } = harness({ disabledHost: true });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      expect((yield* credentials.get("github.com", "owner/repo").pipe(Effect.flip))._tag).toBe(
        "GitHubHostDisabledError",
      );
      yield* credentials.get("enterprise.example", "owner/repo");
      expect(calls.every((input) => input.command !== "git")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "uses the default credential without a repository and accepts path-free helper stores",
    () => {
      const { layer, calls } = harness({
        run: () =>
          Effect.succeed(
            output("protocol=https\nhost=github.com\nusername=Chinoman10\npassword=owner-token\n"),
          ),
      });
      return Effect.gen(function* () {
        const credentials = yield* GitHubCredentials.GitHubCredentials;
        expect((yield* credentials.get("github.com")).source).toBe("settings");
        expect(Redacted.value((yield* credentials.get("github.com", "Owner/Repo")).token)).toBe(
          "owner-token",
        );
        expect(calls).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("falls back only on missing credentials", () => {
    const { layer } = harness({
      run: () =>
        Effect.succeed(
          output("", {
            exitCode: ChildProcessSpawner.ExitCode(128),
            stderr:
              "fatal: could not read Username for 'https://github.com/owner/repo.git': terminal prompts disabled\n",
          }),
        ),
    });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      expect((yield* credentials.get("github.com", "owner/repo")).source).toBe("settings");
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects unsafe owner/path selectors before invoking Git", () => {
    const { layer, calls } = harness();
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      for (const repository of [
        "-owner/repo",
        "owner/-repo",
        "owner/..",
        "owner/../repo",
        "owner/repo\npassword=secret",
        "owner/repo\0",
        "owner/repo/extra",
        "https://github.com/owner/repo",
        " owner/repo",
      ]) {
        expect((yield* credentials.get("github.com", repository).pipe(Effect.flip))._tag).toBe(
          "GitHubGitCredentialError",
        );
      }
      expect(calls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    ["wrong host", response("owner/repo.git").replace("host=github.com", "host=evil.example")],
    ["wrong protocol", response("owner/repo.git").replace("protocol=https", "protocol=http")],
    ["wrong path", response("other/repo.git")],
    ["encoded path", response("owner%2Frepo.git")],
    ["duplicate host", `${response("owner/repo.git")}host=github.com\n`],
    ["duplicate password", `${response("owner/repo.git")}password=second\n`],
    ["truncated record", response("owner/repo.git").trimEnd()],
    ["NUL", response("owner/repo.git", "fake\0secret")],
  ] as const)("rejects %s without retaining helper output", ([_name, answer]) => {
    const { layer, calls } = harness({ run: () => Effect.succeed(output(answer)) });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const error = yield* credentials.get("github.com", "owner/repo").pipe(Effect.flip);
      expect(error._tag).toBe("GitHubGitCredentialError");
      expect(JSON.stringify(error)).not.toContain("fake-token");
      expect(calls).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails safely on helper timeout, nonzero failure, and truncated output", () => {
    let attempt = 0;
    const { layer, calls } = harness({
      run: () => {
        attempt++;
        if (attempt === 1)
          return Effect.fail(
            new VcsProcessTimeoutError({
              operation: "git",
              command: "git",
              cwd: "/trusted-server",
              argumentCount: 2,
              timeoutMs: 10_000,
            }),
          );
        if (attempt === 2)
          return Effect.succeed(
            output("", {
              exitCode: ChildProcessSpawner.ExitCode(1),
              stderr: "fake-secret helper failed",
            }),
          );
        return Effect.succeed(output(response("owner/repo.git"), { stdoutTruncated: true }));
      },
    });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      for (let i = 0; i < 3; i++) {
        const error = yield* credentials.get("github.com", "owner/repo").pipe(Effect.flip);
        expect(error._tag).toBe("GitHubGitCredentialError");
        expect(JSON.stringify(error)).not.toContain("fake-secret");
      }
      expect(calls).toHaveLength(3);
    }).pipe(Effect.provide(layer));
  });
  it.effect("refreshes positive helper results after five minutes", () => {
    const { layer, calls } = harness();
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      yield* credentials.get("github.com", "Owner/Repo");
      yield* TestClock.adjust("4 minutes");
      yield* credentials.get("github.com", "Owner/Repo");
      expect(calls).toHaveLength(1);
      yield* TestClock.adjust("1 minute");
      yield* credentials.get("github.com", "Owner/Repo");
      expect(calls).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("caches normal helper misses for ten seconds only", () => {
    const { layer, calls } = harness({ run: () => Effect.succeed(output("")) });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      yield* credentials.get("github.com", "Owner/Repo");
      yield* credentials.get("github.com", "Owner/Repo");
      expect(calls).toHaveLength(1);
      yield* TestClock.adjust("10 seconds");
      yield* credentials.get("github.com", "Owner/Repo");
      expect(calls).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });
  it.effect.each(["stdoutInvalidUtf8", "stderrInvalidUtf8", "stderrTruncated"] as const)(
    "rejects %s without retaining helper output",
    (flag) => {
      const { layer } = harness({
        run: () =>
          Effect.succeed(output(response("owner/repo.git", "fake-secret"), { [flag]: true })),
      });
      return Effect.gen(function* () {
        const credentials = yield* GitHubCredentials.GitHubCredentials;
        const error = yield* credentials.get("github.com", "owner/repo").pipe(Effect.flip);
        expect(error._tag).toBe("GitHubGitCredentialError");
        expect(JSON.stringify(error)).not.toContain("fake-secret");
      }).pipe(Effect.provide(layer));
    },
  );
});
